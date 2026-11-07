/**
 * Where bots run (ADR 0003). A bot is a T3 project rooted at its folder; each conversation is
 * a T3 thread, run by Claude Code or Codex. The vault app talks to that through this small
 * interface so tests, the demo and the end-to-end suite can use a deterministic stand-in.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { T3Client, type ModelSelection, type T3ThreadSummary } from "./t3/client.ts";
import { T3Runtime, type AgentHomes } from "./t3/runtime.ts";
import { parseNotesMessage } from "./messages.ts";
import { applyNotes } from "./scripted.ts";
import { writeJsonAtomic } from "./state.ts";

export type Provider = "claude" | "codex";
export type Thinking = "low" | "medium" | "high" | "xhigh" | "max";
export type BotModel = { provider?: Provider; model?: string; thinking?: Thinking };

export type ThreadState = "working" | "idle" | "failed" | "waiting";

export type EngineThread = {
  id: string;
  projectId: string;
  title: string;
  state: ThreadState;
  error?: string;
  createdAt: string;
  updatedAt: string;
  /** When the latest run finished; a reply newer than the owner's last look is unread. */
  lastRunAt?: string;
  archived: boolean;
  model?: { provider: string; model: string };
};

export type EngineMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  streaming: boolean;
  createdAt: string;
};

export type ModelChoice = {
  provider: Provider;
  model: string;
  label: string;
  isDefault: boolean;
  efforts: { id: string; label: string }[];
};

export type ProviderStatus = { provider: Provider; ready: boolean; message?: string };

export interface BotEngine {
  readonly kind: "t3" | "demo";
  start(): Promise<void>;
  stop(): Promise<void>;
  /** The T3 project for a folder, created when missing. `known` is the id used last time. */
  ensureProject(path: string, title: string, known?: string): Promise<string>;
  launch(args: { projectId: string; title: string; model: BotModel; text: string }): Promise<string>;
  send(threadId: string, text: string): Promise<void>;
  interrupt(threadId: string): Promise<void>;
  archive(threadId: string): Promise<void>;
  threads(): EngineThread[];
  thread(id: string): EngineThread | undefined;
  messages(threadId: string): Promise<EngineMessage[]>;
  onThread(fn: (t: EngineThread) => void): () => void;
  models(): Promise<ModelChoice[]>;
  providers(): Promise<ProviderStatus[]>;
}

const INSTANCE: Record<Provider, string> = { claude: "claudeAgent", codex: "codex" };
const EFFORT_OPTION: Record<Provider, string> = { claude: "effort", codex: "reasoningEffort" };
export const FALLBACK_MODEL: Record<Provider, string> = { claude: "claude-sonnet-5-5", codex: "gpt-6-astra" };

export function stateOf(status: string | undefined, pending: unknown, error: string | null | undefined): ThreadState {
  if (pending) return "waiting";
  const s = (status ?? "").toLowerCase();
  if (["running", "starting", "queued", "requested", "pending", "streaming", "active"].includes(s)) return "working";
  if (["failed", "error", "errored"].includes(s) || (error && s !== "completed")) return "failed";
  return "idle";
}

export function fromSummary(t: Partial<T3ThreadSummary> & { id: string }, prev?: EngineThread): EngineThread {
  const sel = t.modelSelection ?? undefined;
  const provider = sel?.instanceId === "codex" ? "codex" : sel?.instanceId === "claudeAgent" ? "claude" : sel?.instanceId;
  const error = t.lastError === undefined ? prev?.error : t.lastError ?? undefined;
  return {
    id: t.id,
    projectId: t.projectId ?? prev?.projectId ?? "",
    title: t.title ?? prev?.title ?? "Conversation",
    state: t.status === undefined && prev ? prev.state : stateOf(t.status, t.pendingRuntimeRequest, t.lastError),
    ...(error ? { error } : {}),
    createdAt: t.createdAt ?? prev?.createdAt ?? t.updatedAt ?? new Date().toISOString(),
    updatedAt: t.updatedAt ?? prev?.updatedAt ?? new Date().toISOString(),
    ...((t.latestRunCompletedAt ?? prev?.lastRunAt) ? { lastRunAt: (t.latestRunCompletedAt ?? prev?.lastRunAt)! } : {}),
    archived: t.archivedAt !== undefined ? !!t.archivedAt || !!t.deletedAt : prev?.archived ?? false,
    ...(provider && sel?.model ? { model: { provider, model: sel.model } } : prev?.model ? { model: prev.model } : {}),
  };
}

export function selectionFor(m: BotModel, choices: ModelChoice[] = []): ModelSelection {
  const provider: Provider = m.provider ?? "claude";
  const listed = choices.filter((c) => c.provider === provider);
  const model = m.model ?? listed.find((c) => c.isDefault)?.model ?? listed[0]?.model ?? FALLBACK_MODEL[provider];
  const efforts = listed.find((c) => c.model === model)?.efforts.map((e) => e.id);
  let effort: string | undefined = m.thinking;
  if (effort && efforts?.length && !efforts.includes(effort)) effort = efforts.includes("high") ? "high" : efforts[0];
  return {
    instanceId: INSTANCE[provider],
    model,
    ...(effort ? { options: [{ id: EFFORT_OPTION[provider], value: effort }] } : {}),
  };
}

/** The model list a T3 server reports (`server.getConfig`). */
export function modelsFromConfig(config: unknown): { models: ModelChoice[]; providers: ProviderStatus[] } {
  const v = ((config as { value?: unknown })?.value ?? config) as { providers?: Record<string, any>[] };
  const models: ModelChoice[] = [];
  const providers: ProviderStatus[] = [];
  for (const p of v?.providers ?? []) {
    const provider: Provider | undefined = p.instanceId === "claudeAgent" ? "claude" : p.instanceId === "codex" ? "codex" : undefined;
    if (!provider) continue;
    providers.push({
      provider,
      ready: !!p.enabled && p.status !== "error" && p.status !== "disabled" && p.auth?.status !== "unauthenticated",
      ...(typeof p.message === "string" && p.message ? { message: p.message } : {}),
    });
    for (const m of (p.models ?? []) as Record<string, any>[]) {
      if (typeof m.slug !== "string") continue;
      const descriptor = (m.capabilities?.optionDescriptors ?? []).find((d: { id: string }) => d.id === EFFORT_OPTION[provider]);
      models.push({
        provider,
        model: m.slug,
        label: String(m.name ?? m.slug),
        isDefault: !!m.isDefault,
        efforts: ((descriptor?.options ?? []) as { id: string; label?: string }[])
          .filter((o) => ["low", "medium", "high", "xhigh", "max"].includes(o.id))
          .map((o) => ({ id: o.id, label: String(o.label ?? o.id) })),
      });
    }
  }
  return { models, providers };
}

// ------------------------------------------------------------------ T3

export class T3Engine implements BotEngine {
  readonly kind = "t3" as const;
  readonly runtime: T3Runtime;
  private client?: T3Client;
  private readonly cache = new Map<string, EngineThread>();
  private readonly listeners = new Set<(t: EngineThread) => void>();
  private unsubscribe?: () => void;
  private config?: { at: number; models: ModelChoice[]; providers: ProviderStatus[] };

  constructor(opts: { baseDir: string; vaultRoot: string; homes: AgentHomes; bin?: string; log?: (l: string) => void }) {
    this.runtime = new T3Runtime(opts);
  }

  private get c(): T3Client {
    if (!this.client) throw new Error("the bot engine is not running");
    return this.client;
  }

  async start(): Promise<void> {
    await this.runtime.start();
    this.client = new T3Client({ baseUrl: this.runtime.baseUrl, token: () => this.runtime.token() });
    const shell = await this.client.shell();
    for (const t of shell.threads) this.cache.set(t.id, fromSummary(t));
    this.unsubscribe = this.client.subscribeShell((e) => {
      if (e.kind === "snapshot") {
        const snap = (e as { snapshot?: { threads?: T3ThreadSummary[] } }).snapshot;
        for (const t of snap?.threads ?? []) this.update(t);
      } else if (e.kind === "thread.updated") {
        const ev = e as { thread?: T3ThreadSummary; location?: string };
        if (ev.thread) this.update({ ...ev.thread, ...(ev.location === "archived" && !ev.thread.archivedAt ? { archivedAt: ev.thread.updatedAt } : {}) });
      }
    });
  }

  private update(t: T3ThreadSummary): void {
    const next = fromSummary(t, this.cache.get(t.id));
    const prev = this.cache.get(t.id);
    this.cache.set(t.id, next);
    if (prev && JSON.stringify(prev) === JSON.stringify(next)) return;
    for (const l of this.listeners) {
      try { l(next); } catch { /* a listener never breaks the engine */ }
    }
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.client?.close();
    await this.runtime.stop();
  }

  async ensureProject(path: string, title: string, known?: string): Promise<string> {
    const shell = await this.c.shell();
    const live = shell.projects.filter((p) => !p.deletedAt && !p.archivedAt);
    if (known && live.some((p) => p.id === known && p.workspaceRoot === path)) return known;
    const same = live.find((p) => p.workspaceRoot === path);
    if (same) return same.id;
    return this.runtime.addProject(path, title);
  }

  async launch(args: { projectId: string; title: string; model: BotModel; text: string }): Promise<string> {
    const choices = (await this.loadConfig()).models;
    const id = await this.c.launchThread({
      projectId: args.projectId, title: args.title, modelSelection: selectionFor(args.model, choices),
      runtimeMode: "auto", text: args.text,
    });
    if (!this.cache.has(id)) {
      const now = new Date().toISOString();
      this.cache.set(id, { id, projectId: args.projectId, title: args.title, state: "working", createdAt: now, updatedAt: now, archived: false });
    }
    return id;
  }

  async send(threadId: string, text: string): Promise<void> {
    await this.c.sendMessage(threadId, text);
  }

  async interrupt(threadId: string): Promise<void> {
    const shell = await this.c.shell();
    const t = shell.threads.find((x) => x.id === threadId);
    if (t?.activeRunId) await this.c.interrupt(threadId, t.activeRunId);
  }

  async archive(threadId: string): Promise<void> {
    await this.c.archive(threadId);
    const t = this.cache.get(threadId);
    if (t) this.update({ ...toSummary(t), archivedAt: new Date().toISOString() });
  }

  threads(): EngineThread[] { return [...this.cache.values()]; }
  thread(id: string): EngineThread | undefined { return this.cache.get(id); }

  async messages(threadId: string): Promise<EngineMessage[]> {
    const p = await this.c.projection(threadId);
    return p.messages.map((m) => ({
      id: m.id,
      role: m.role === "assistant" ? "assistant" : m.role === "user" ? "user" : "system",
      text: String(m.text ?? ""),
      streaming: !!m.streaming,
      createdAt: m.createdAt,
    }));
  }

  onThread(fn: (t: EngineThread) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private async loadConfig(): Promise<{ models: ModelChoice[]; providers: ProviderStatus[] }> {
    if (this.config && Date.now() - this.config.at < 5 * 60_000) return this.config;
    try {
      this.config = { at: Date.now(), ...modelsFromConfig(await this.c.config()) };
    } catch {
      this.config = { at: Date.now() - 4 * 60_000, models: [], providers: [] };
    }
    return this.config;
  }

  async models(): Promise<ModelChoice[]> { return (await this.loadConfig()).models; }
  async providers(): Promise<ProviderStatus[]> { return (await this.loadConfig()).providers; }
}

function toSummary(t: EngineThread): T3ThreadSummary {
  return {
    id: t.id, projectId: t.projectId, title: t.title, createdAt: t.createdAt, updatedAt: t.updatedAt,
    status: t.state === "working" ? "running" : t.state === "failed" ? "failed" : "completed",
    lastError: t.error ?? null, latestRunCompletedAt: t.lastRunAt ?? null,
  };
}

// ------------------------------------------------------------------ demo

type DemoThread = EngineThread & { messages: EngineMessage[] };
type DemoState = { projects: { id: string; path: string; title: string }[]; threads: DemoThread[] };

/**
 * A deterministic engine for demo mode, tests and the end-to-end suite. It answers notes
 * with recognisable scripted edits, remembers "remember …" lines in the bot's memory file,
 * and otherwise replies honestly that it is a demo. No network, no cost.
 */
export class DemoEngine implements BotEngine {
  readonly kind = "demo" as const;
  private readonly root: string;
  private readonly file?: string;
  private readonly delayMs: number;
  private state: DemoState = { projects: [], threads: [] };
  private readonly listeners = new Set<(t: EngineThread) => void>();
  private readonly running = new Set<Promise<void>>();
  /** Per conversation: runs still queued, and a generation bumped by Stop. */
  private readonly queue = new Map<string, { pending: number; gen: number }>();
  private seq = 0;
  private readonly clock: () => Date;
  /** Tests make the next reply fail with this message. */
  failNext?: string;

  constructor(opts: { vaultRoot: string; file?: string; delayMs?: number; now?: () => Date }) {
    this.root = opts.vaultRoot;
    this.clock = opts.now ?? (() => new Date());
    this.file = opts.file;
    this.delayMs = opts.delayMs ?? 400;
    if (this.file && existsSync(this.file)) {
      try { this.state = JSON.parse(readFileSync(this.file, "utf8")) as DemoState; } catch { /* start fresh */ }
      for (const t of this.state.threads) if (t.state === "working") t.state = "idle";
    }
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> { await this.idle(); this.save(); }

  /** Wait for every scripted run in flight (tests). */
  async idle(): Promise<void> {
    while (this.running.size) await Promise.all([...this.running]);
  }

  private save(): void {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    writeJsonAtomic(this.file, this.state);
  }

  private now(): string {
    // Strictly increasing timestamps keep ordering stable in fast tests.
    const t = Math.max(this.clock().getTime(), this.seq + 1);
    this.seq = t;
    return new Date(t).toISOString();
  }

  private emit(t: DemoThread): void {
    const { messages: _m, ...summary } = t;
    for (const l of this.listeners) {
      try { l({ ...summary }); } catch { /* ignore */ }
    }
  }

  async ensureProject(path: string, title: string, known?: string): Promise<string> {
    const found = this.state.projects.find((p) => p.id === known && p.path === path) ?? this.state.projects.find((p) => p.path === path);
    if (found) return found.id;
    const id = randomUUID();
    this.state.projects.push({ id, path, title });
    this.save();
    return id;
  }

  async launch(args: { projectId: string; title: string; model: BotModel; text: string }): Promise<string> {
    const now = this.now();
    const t: DemoThread = {
      id: randomUUID(), projectId: args.projectId, title: args.title.slice(0, 120), state: "idle",
      createdAt: now, updatedAt: now, archived: false,
      model: { provider: args.model.provider ?? "claude", model: "demo" }, messages: [],
    };
    this.state.threads.push(t);
    this.post(t, args.text);
    return t.id;
  }

  async send(threadId: string, text: string): Promise<void> {
    const t = this.state.threads.find((x) => x.id === threadId);
    if (!t) throw new Error(`no conversation ${threadId}`);
    this.post(t, text);
  }

  private post(t: DemoThread, text: string): void {
    const at = this.now();
    const message: EngineMessage = { id: randomUUID(), role: "user", text, streaming: false, createdAt: at };
    const queued = (this.queue.get(t.id)?.pending ?? 0) > 0;
    // A queued message joins the conversation when its run starts, as in T3's view of it.
    if (!queued) t.messages.push(message);
    t.state = "working";
    t.updatedAt = at;
    delete t.error;
    this.save();
    this.emit(t);
    const q = this.queue.get(t.id) ?? { pending: 0, gen: 0 };
    q.pending++;
    this.queue.set(t.id, q);
    const gen = q.gen;
    // Like T3, a message sent while the bot is working runs after the current run.
    const previous = [...this.running];
    const run = Promise.all(previous).then(() => new Promise<void>((done) => setTimeout(done, this.delayMs))).then(() => {
      if (q.gen !== gen) return;
      if (queued) t.messages.push({ ...message, createdAt: this.now() });
      q.pending--;
      this.reply(t, text, q.pending > 0);
    });
    this.running.add(run);
    void run.finally(() => this.running.delete(run));
  }

  private reply(t: DemoThread, text: string, more = false): void {
    const project = this.state.projects.find((p) => p.id === t.projectId);
    let answer: string;
    if (this.failNext) {
      t.state = "failed";
      t.error = this.failNext;
      this.failNext = undefined;
      t.updatedAt = t.lastRunAt = this.now();
      this.save();
      this.emit(t);
      return;
    }
    const notes = parseNotesMessage(text);
    const remember = /\bremember(?: that)?\s+(.+?)(?:\n|$)/i.exec(text.replace(/\[\[peers:[\s\S]*?\[\[\/peers:\w+\]\]/g, ""))?.[1];
    if (notes) {
      const file = join(this.root, notes.path);
      let applied = 0;
      if (/\.(md|markdown|txt|org)$/i.test(notes.path) && existsSync(file)) {
        const lines = readFileSync(file, "utf8").split("\n");
        const specs = notes.notes.filter((n) => n.lines).map((n) => ({
          id: n.id, tool: n.tool, from: n.lines![0], to: n.lines![1],
          ...(n.toLines ? { toLine: n.toLines[0] } : {}), instruction: n.instruction,
        }));
        applied = specs.length;
        if (applied) writeFileSync(file, applyNotes(lines, specs, /\.org$/i.test(notes.path) ? "org" : "markdown").join("\n"));
      }
      answer = applied
        ? `Done (demo mode): I applied ${applied} note${applied === 1 ? "" : "s"} on ${notes.path} with scripted edits. Start Peers with T3 and a signed-in Claude or Codex for real edits.`
        : `Demo mode: I read your note${notes.notes.length === 1 ? "" : "s"} on ${notes.path}, but I can only make scripted edits to marked lines of a page.`;
    } else if (remember && project) {
      // Like a real agent, it learns where its memory is from the brief that opened the thread.
      const briefText = t.messages.find((m) => m.role === "user" && m.text.includes("[[peers:brief]]"))?.text ?? "";
      const memPath = /Your memory is (\S+?)\.\s/.exec(briefText)?.[1] ?? ".peers/memory.md";
      const mem = join(project.path, memPath);
      mkdirSync(dirname(mem), { recursive: true });
      const prior = existsSync(mem) ? readFileSync(mem, "utf8") : "# Memory\n";
      writeFileSync(mem, `${prior.replace(/\n*$/, "\n")}- ${remember.trim()}\n`);
      answer = `Noted. I will remember: "${remember.trim()}".`;
    } else {
      const body = text.replace(/\[\[peers:(brief|context)\]\][\s\S]*?\[\[\/peers:\1\]\]/g, "").trim();
      answer = `Demo mode: I'm a scripted bot, so I can't reason about "${body.slice(0, 120)}" yet. ` +
        "Start Peers with T3 and a signed-in Claude or Codex and I'll answer for real. Marks and notes on pages still show the full flow.";
    }
    const at = this.now();
    t.messages.push({ id: randomUUID(), role: "assistant", text: answer, streaming: false, createdAt: at });
    t.state = more ? "working" : "idle";
    t.updatedAt = t.lastRunAt = at;
    this.save();
    this.emit(t);
  }

  async interrupt(threadId: string): Promise<void> {
    const t = this.state.threads.find((x) => x.id === threadId);
    if (!t || t.state !== "working") return;
    const q = this.queue.get(t.id);
    if (q) { q.gen++; q.pending = 0; }
    t.state = "idle";
    t.updatedAt = t.lastRunAt = this.now();
    t.messages.push({ id: randomUUID(), role: "system", text: "Stopped.", streaming: false, createdAt: t.updatedAt });
    this.save();
    this.emit(t);
  }

  async archive(threadId: string): Promise<void> {
    const t = this.state.threads.find((x) => x.id === threadId);
    if (!t) return;
    t.archived = true;
    t.updatedAt = this.now();
    this.save();
    this.emit(t);
  }

  threads(): EngineThread[] {
    return this.state.threads.map(({ messages: _m, ...t }) => ({ ...t }));
  }

  thread(id: string): EngineThread | undefined {
    return this.threads().find((t) => t.id === id);
  }

  async messages(threadId: string): Promise<EngineMessage[]> {
    return [...(this.state.threads.find((x) => x.id === threadId)?.messages ?? [])];
  }

  onThread(fn: (t: EngineThread) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  async models(): Promise<ModelChoice[]> {
    const efforts = ["low", "medium", "high", "xhigh", "max"].map((id) => ({ id, label: id }));
    return [
      { provider: "claude", model: "claude-sonnet-5-5", label: "Claude Sonnet 5.5 (demo)", isDefault: true, efforts },
      { provider: "codex", model: "gpt-6-astra", label: "GPT-6-Astra (demo)", isDefault: true, efforts },
    ];
  }

  async providers(): Promise<ProviderStatus[]> {
    return [{ provider: "claude", ready: true, message: "demo" }, { provider: "codex", ready: true, message: "demo" }];
  }
}
