/**
 * Client for a T3 Code server (orchestration protocol 2), the bots' backend (ADR 0003).
 *
 * Reads go over HTTP (`/api/orchestration/shell`, `/threads/:id/bounded`); commands and live
 * subscriptions go over the WebSocket RPC at `/ws`, the same path the T3 app uses. The socket
 * reconnects on its own and re-opens its subscriptions; a request in flight when it drops
 * fails and the caller decides whether to retry.
 */

export type ModelSelection = { instanceId: string; model: string; options?: { id: string; value: string | boolean }[] };

export type T3Project = {
  id: string;
  title: string;
  workspaceRoot: string;
  archivedAt?: string | null;
  deletedAt?: string | null;
};

export type T3ThreadSummary = {
  id: string;
  projectId: string;
  title: string;
  status?: string;
  activeRunId?: string | null;
  latestRunId?: string | null;
  latestRunCompletedAt?: string | null;
  lastError?: string | null;
  pendingRuntimeRequest?: { kind?: string } | null;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string | null;
  deletedAt?: string | null;
  modelSelection?: ModelSelection;
};

export type T3Message = {
  id: string;
  role: string;
  text?: string | null;
  streaming?: boolean;
  createdAt: string;
  runId?: string | null;
};

export type T3Run = { id: string; status: string; ordinal?: number; completedAt?: string | null };

export type T3Projection = {
  thread: { id: string; projectId: string; title: string; createdAt: string; updatedAt: string };
  runs: T3Run[];
  messages: T3Message[];
};

export type T3Shell = { projects: T3Project[]; threads: T3ThreadSummary[] };

export type ShellEvent =
  | { kind: "snapshot"; snapshot: { projects?: T3Project[]; threads?: T3ThreadSummary[] } }
  | { kind: "thread.updated"; thread: T3ThreadSummary }
  | { kind: string; [key: string]: unknown };

export class T3Error extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "T3Error";
    this.status = status;
  }
}

const PROTOCOL = "2";

/** The human-readable reason inside an Effect RPC failure. */
export function failureMessage(exit: unknown): string {
  const seen = new Set<unknown>();
  const find = (x: unknown): string | undefined => {
    if (!x || typeof x !== "object" || seen.has(x)) return undefined;
    seen.add(x);
    const o = x as Record<string, unknown>;
    if (typeof o.message === "string" && o.message) {
      const deeper = find(o.cause);
      return deeper && deeper !== o.message ? `${o.message}: ${deeper}` : o.message;
    }
    for (const v of Object.values(o)) {
      const m = Array.isArray(v) ? v.map(find).find(Boolean) : find(v);
      if (m) return m;
    }
    return undefined;
  };
  return find(exit) ?? "T3 refused the request";
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };
type Stream = { tag: string; payload: unknown; onValues: (values: unknown[]) => void; id?: string };

export class T3Client {
  readonly baseUrl: string;
  private readonly token: () => Promise<string>;
  private ws?: WebSocket;
  private connecting?: Promise<WebSocket>;
  private nextId = 1;
  private readonly pending = new Map<string, Pending>();
  private readonly streams = new Set<Stream>();
  private closed = false;
  private retryMs = 500;

  constructor(opts: { baseUrl: string; token: () => Promise<string> }) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.token = opts.token;
  }

  // ------------------------------------------------------------------ HTTP

  async http<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      redirect: "error",
      headers: {
        Authorization: `Bearer ${await this.token()}`,
        "x-t3-orchestration-protocol": PROTOCOL,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    if (!res.ok) throw new T3Error(`T3 ${method} ${path} answered ${res.status}: ${text.slice(0, 300)}`, res.status);
    return (text ? JSON.parse(text) : undefined) as T;
  }

  async shell(): Promise<T3Shell> {
    const s = await this.http<{ projects?: T3Project[]; threads?: T3ThreadSummary[]; archivedThreads?: T3ThreadSummary[] }>(
      "GET", "/api/orchestration/shell");
    return { projects: s.projects ?? [], threads: [...(s.threads ?? []), ...(s.archivedThreads ?? [])] };
  }

  async projection(threadId: string): Promise<T3Projection> {
    const r = await this.http<{ projection: T3Projection }>("GET", `/api/orchestration/threads/${encodeURIComponent(threadId)}/bounded`);
    return { ...r.projection, runs: r.projection.runs ?? [], messages: r.projection.messages ?? [] };
  }

  // ------------------------------------------------------------------ WebSocket RPC

  private async socket(): Promise<WebSocket> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return this.ws;
    this.connecting ??= this.open().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }

  private async open(): Promise<WebSocket> {
    const res = await fetch(`${this.baseUrl}/api/auth/websocket-ticket`, {
      method: "POST", redirect: "error",
      headers: { Authorization: `Bearer ${await this.token()}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new T3Error(`T3 websocket ticket answered ${res.status}`, res.status);
    const body = (await res.json()) as Record<string, string>;
    const ticket = body.ticket ?? body.token ?? body.wsTicket;
    const url = `${this.baseUrl.replace(/^http/, "ws")}/ws?orchestrationProtocol=${PROTOCOL}&wsTicket=${encodeURIComponent(ticket ?? "")}`;
    const ws = new WebSocket(url);
    await new Promise<void>((ok, fail) => {
      ws.addEventListener("open", () => ok(), { once: true });
      ws.addEventListener("error", () => fail(new T3Error("could not open the T3 socket")), { once: true });
    });
    ws.addEventListener("message", (ev) => this.onMessage(ws, String(ev.data)));
    ws.addEventListener("close", () => this.onClose(ws));
    this.ws = ws;
    this.retryMs = 500;
    // Subscriptions survive reconnects: re-open each one on the new socket.
    for (const s of this.streams) this.sendStream(ws, s);
    return ws;
  }

  private onMessage(ws: WebSocket, data: string): void {
    for (const line of data.split("\n")) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch { continue; }
      for (const msg of (Array.isArray(parsed) ? parsed : [parsed]) as Record<string, any>[]) {
        if (msg._tag === "Ping") { ws.send(JSON.stringify({ _tag: "Pong" })); continue; }
        if (msg._tag === "Chunk") {
          const s = [...this.streams].find((x) => x.id === msg.requestId);
          if (s) {
            try { s.onValues(msg.values ?? []); } catch { /* a listener never breaks the socket */ }
          }
          ws.send(JSON.stringify({ _tag: "Ack", requestId: msg.requestId }));
          continue;
        }
        if (msg._tag === "Exit") {
          const p = this.pending.get(msg.requestId);
          if (!p) continue;
          this.pending.delete(msg.requestId);
          if (msg.exit?._tag === "Success") p.resolve(msg.exit.value);
          else p.reject(new T3Error(failureMessage(msg.exit)));
          continue;
        }
        if (msg._tag === "Defect" || msg._tag === "ClientProtocolError") {
          const p = msg.requestId ? this.pending.get(msg.requestId) : undefined;
          if (p) { this.pending.delete(msg.requestId); p.reject(new T3Error(failureMessage(msg))); }
        }
      }
    }
  }

  private onClose(ws: WebSocket): void {
    if (this.ws === ws) this.ws = undefined;
    for (const [id, p] of this.pending) {
      p.reject(new T3Error("the T3 socket closed before answering"));
      this.pending.delete(id);
    }
    for (const s of this.streams) s.id = undefined;
    if (this.closed || this.streams.size === 0) return;
    const wait = this.retryMs;
    this.retryMs = Math.min(15_000, this.retryMs * 2);
    setTimeout(() => { if (!this.closed) void this.socket().catch(() => this.onClose(ws)); }, wait).unref?.();
  }

  private sendStream(ws: WebSocket, s: Stream): void {
    s.id = String(this.nextId++);
    ws.send(JSON.stringify({ _tag: "Request", id: s.id, tag: s.tag, payload: s.payload, headers: [] }));
  }

  async request<T = unknown>(tag: string, payload: unknown, timeoutMs = 60_000): Promise<T> {
    const ws = await this.socket();
    const id = String(this.nextId++);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new T3Error(`T3 did not answer ${tag} in time`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v as T); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      ws.send(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }));
    });
  }

  /** Keep a subscription open across reconnects. Returns an unsubscribe. */
  subscribe(tag: string, payload: unknown, onValues: (values: unknown[]) => void): () => void {
    const s: Stream = { tag, payload, onValues };
    this.streams.add(s);
    void this.socket().then((ws) => { if (!s.id) this.sendStream(ws, s); }).catch(() => {});
    return () => {
      this.streams.delete(s);
      if (s.id && this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ _tag: "Interrupt", requestId: s.id }));
    };
  }

  subscribeShell(onEvent: (e: ShellEvent) => void): () => void {
    return this.subscribe("orchestration.subscribeShell", {}, (values) => {
      for (const v of values as ShellEvent[]) onEvent(v);
    });
  }

  dispatch<T = unknown>(command: Record<string, unknown>): Promise<T> {
    return this.request<T>("orchestration.dispatchCommand", { commandId: crypto.randomUUID(), ...command });
  }

  async launchThread(args: {
    threadId?: string; projectId: string; title: string; modelSelection: ModelSelection;
    runtimeMode?: string; text: string;
  }): Promise<string> {
    const threadId = args.threadId ?? crypto.randomUUID();
    const r = await this.request<{ threadId?: string }>("orchestration.launchThread", {
      commandId: crypto.randomUUID(), creationSource: "server", threadId, projectId: args.projectId,
      title: args.title.slice(0, 120), modelSelection: args.modelSelection,
      runtimeMode: args.runtimeMode ?? "auto", interactionMode: "default", workspaceStrategy: { type: "root" },
      initialMessage: { messageId: crypto.randomUUID(), text: args.text, attachments: [] },
    });
    return r?.threadId ?? threadId;
  }

  async sendMessage(threadId: string, text: string): Promise<void> {
    await this.dispatch({
      type: "message.dispatch", threadId, messageId: crypto.randomUUID(), text, attachments: [],
      createdBy: "agent", creationSource: "server", deliveryIntent: "auto",
      dispatchMode: { type: "queue_after_active" },
    });
  }

  async interrupt(threadId: string, runId: string): Promise<void> {
    await this.dispatch({ type: "run.interrupt", threadId, runId });
  }

  async archive(threadId: string): Promise<void> {
    await this.dispatch({ type: "thread.archive", threadId });
  }

  async config(): Promise<Record<string, unknown>> {
    return this.request("server.getConfig", {});
  }

  close(): void {
    this.closed = true;
    this.streams.clear();
    this.ws?.close();
  }
}
