/**
 * Client state and the actions that change it. UI modules read the store and call these;
 * nothing else talks to the server.
 */
import { api, newKey, q } from "./lib/api.ts";
import { Store } from "./lib/store.ts";
import type { BotStatus, Conversation, Layout, Mentioned, Message, Note, PageData, Route, ThreadView, TreeNode } from "./types.ts";

export type Theme = "system" | "day" | "night";
export type Tool = "read" | "pen" | "arrow" | "eraser";

export type State = {
  ready: boolean;
  needsPairing: boolean;
  vault: { id: string; name: string; owner: string; tz: string } | null;
  layout: Layout | null;
  demo: boolean;
  engine: { kind: string; providers: { provider: string; ready: boolean; message?: string }[] } | null;
  defaultModel: { provider?: string; model?: string; thinking?: string } | null;
  bots: BotStatus[];
  tree: TreeNode | null;
  /** Folder or page path → the agent that looks after it. */
  owners: Record<string, string>;
  /** Folder path → its front page (an app folder's: the page its app opens). */
  fronts: Record<string, string>;
  /** App folders (ADR 0006). */
  apps: string[];
  /** Generated content, edited only through its source. */
  readonly: string[];
  inbox: string | null;
  archive: string | null;
  changed: string[];
  expanded: Record<string, boolean>;
  route: Route;
  page: PageData | null;
  pageError: string | null;
  notes: Note[];
  botId: string | null;
  pinned: boolean;
  /** The bot's conversations, newest first, and which bot they belong to. */
  threads: ThreadView[];
  threadsBot: string | null;
  /** The open conversation: an id, "new" while writing the first message of one, or null. */
  threadId: string | null;
  conversation: Conversation | null;
  showThreads: boolean;
  activity: Record<string, string>;
  tool: Tool;
  theme: Theme;
  treeCollapsed: boolean;
  botCollapsed: boolean;
  treeOpen: boolean;
  tab: "vault" | "page" | "bot";
  connection: "live" | "connecting" | "offline";
  today: any | null;
  selection: { text: string; path: string } | null;
  marking: boolean;
  /** Bumped when the page must re-render even if its data did not change (resize, theme). */
  layoutTick: number;
  /** The owner closed the demo-mode notice (a "Demo" pill by the brand stays). */
  demoHidden: boolean;
};

const saved = (key: string, fallback: string): string => {
  try { return localStorage.getItem(`peers.${key}`) ?? fallback; } catch { return fallback; }
};
export const persist = (key: string, value: string): void => {
  try { localStorage.setItem(`peers.${key}`, value); } catch { /* private mode */ }
};

export const store = new Store<State>({
  ready: false,
  needsPairing: false,
  vault: null,
  layout: null,
  demo: false,
  engine: null,
  defaultModel: null,
  bots: [],
  tree: null,
  owners: {},
  fronts: {},
  apps: [],
  readonly: [],
  inbox: null,
  archive: null,
  changed: [],
  expanded: JSON.parse(saved("expanded", "{}")),
  route: { view: "today" },
  page: null,
  pageError: null,
  notes: [],
  botId: null,
  pinned: false,
  threads: [],
  threadsBot: null,
  threadId: null,
  conversation: null,
  showThreads: false,
  activity: {},
  tool: "read",
  theme: saved("theme", "system") as Theme,
  treeCollapsed: saved("treeCollapsed", "0") === "1",
  botCollapsed: saved("botCollapsed", "0") === "1",
  treeOpen: false,
  tab: "page",
  connection: "connecting",
  today: null,
  selection: null,
  marking: false,
  layoutTick: 0,
  demoHidden: saved("demoHidden", "0") === "1",
});

// ------------------------------------------------------------------ toasts

type ToastFn = (text: string, opts?: { error?: boolean; action?: { label: string; run: () => void } }) => void;
let toastImpl: ToastFn = () => {};
export function setToast(fn: ToastFn): void { toastImpl = fn; }
export const toast: ToastFn = (text, opts) => toastImpl(text, opts);
export function fail(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  if (/pair this device/.test(message)) return;
  toast(message, { error: true });
}

// ------------------------------------------------------------------ routing

export function routeFromHash(): Route {
  const h = decodeURIComponent(location.hash.replace(/^#\/?/, ""));
  if (h.startsWith("p/")) return { view: "page", path: h.slice(2) };
  if (h.startsWith("bot/")) return { view: "bot", id: h.slice(4) };
  if (h === "settings") return { view: "settings" };
  return { view: "today" };
}

export function go(route: Route): void {
  const hash = route.view === "page" ? `#/p/${encodeURI(route.path)}`
    : route.view === "bot" ? `#/bot/${encodeURIComponent(route.id)}`
    : route.view === "settings" ? "#/settings" : "#/today";
  if (location.hash !== hash) location.hash = hash;
  else void applyRoute(route);
}

export async function applyRoute(route: Route): Promise<void> {
  store.set({ route, selection: null });
  if (route.view === "page") {
    store.set({ tab: "page", treeOpen: false });
    await openPage(route.path);
  } else if (route.view === "bot") {
    store.set({ page: null, notes: [], pageError: null, tool: "read", tab: "page" });
    selectBot(route.id);
  } else {
    store.set({ page: null, notes: [], pageError: null, tool: "read" });
    if (route.view === "today") {
      await loadToday();
      if (!store.get().pinned) {
        const vb = store.get().bots.find((b) => b.kind === "vault");
        if (vb) selectBot(vb.id);
      }
    }
  }
}

// ------------------------------------------------------------------ loaders

export async function loadState(): Promise<boolean> {
  try {
    const s = await api.get("/api/state");
    store.set({
      vault: s.vault, layout: s.layout ?? null, demo: s.demo, engine: s.engine ?? null, bots: s.bots, defaultModel: s.settings.default_model,
      needsPairing: false, ready: true,
    });
    return true;
  } catch (err) {
    if ((err as { status?: number }).status === 401) {
      store.set({ needsPairing: true, ready: true });
      return false;
    }
    throw err;
  }
}

let botsTimer: number | undefined;
export function loadBotsSoon(): void {
  clearTimeout(botsTimer);
  botsTimer = window.setTimeout(() => { void loadState().catch(fail); }, 150);
}

export async function loadTree(): Promise<void> {
  const t = await api.get("/api/tree");
  store.set({
    tree: t.tree, owners: t.owners, fronts: t.fronts ?? {}, apps: t.apps ?? [], readonly: t.readonly ?? [],
    inbox: t.inbox ?? null, archive: t.archive ?? null, changed: t.changed,
  });
}

export async function loadToday(): Promise<void> {
  const t = await api.get("/api/today");
  store.set({ today: t });
}

export async function openPage(path: string, opts: { keepScroll?: boolean } = {}): Promise<void> {
  try {
    const [page, notes] = await Promise.all([
      api.get<PageData>(`/api/file?path=${q(path)}`),
      api.get<{ notes: Note[] }>(`/api/annotations?path=${q(path)}`).catch(() => ({ notes: [] })),
    ]);
    if (store.get().route.view !== "page" || (store.get().route as { path: string }).path !== path) return;
    const current = store.get().page;
    if (opts.keepScroll && current && current.path === page.path && current.hash === page.hash) {
      // Same content: keep the rendered page, its change marks and any mark in progress.
      store.set({ notes: notes.notes, pageError: null });
      return;
    }
    store.set({ page, notes: notes.notes, pageError: null, ...(opts.keepScroll ? {} : { tool: "read" as Tool }) });
    expandTo(path);
    if (!store.get().pinned) selectBot(page.owner);
    // Opening a page is looking at it: what changed stays marked on screen, and is not
    // marked again next time.
    if (page.change && page.hash) void markSeen(page.path, page.hash);
  } catch (err) {
    store.set({ page: null, notes: [], pageError: err instanceof Error ? err.message : String(err) });
  }
}

export async function refreshPage(): Promise<void> {
  const r = store.get().route;
  if (r.view === "page") await openPage(r.path, { keepScroll: true });
}

export async function loadNotes(): Promise<void> {
  const page = store.get().page;
  if (!page) return;
  const notes = await api.get<{ notes: Note[] }>(`/api/annotations?path=${q(page.path)}`);
  store.set({ notes: notes.notes });
}

export function expandTo(path: string): void {
  const parts = path.split("/");
  const expanded = { ...store.get().expanded };
  let changed = false;
  for (let i = 1; i < parts.length; i++) {
    const folder = parts.slice(0, i).join("/");
    if (!expanded[folder]) { expanded[folder] = true; changed = true; }
  }
  if (changed) {
    store.set({ expanded });
    persist("expanded", JSON.stringify(expanded));
  }
}

export function toggleFolder(path: string): void {
  const expanded = { ...store.get().expanded, [path]: !store.get().expanded[path] };
  store.set({ expanded });
  persist("expanded", JSON.stringify(expanded));
}

export async function markSeen(path: string, hash: string): Promise<void> {
  try {
    await api.post("/api/seen", { path, hash });
    store.set({ changed: store.get().changed.filter((p) => p !== path) });
  } catch { /* the mark comes back next time; nothing lost */ }
}

// ------------------------------------------------------------------ bots and conversations

/** The conversation last open with each bot, so switching bots and back keeps your place. */
const lastThread = new Map<string, string>();

export function selectBot(id: string, opts: { pin?: boolean; threadId?: string } = {}): void {
  const s = store.get();
  if (opts.pin !== undefined) store.set({ pinned: opts.pin });
  if (s.botId === id && !opts.threadId && s.threadsBot === id) return;
  const threadId = opts.threadId ?? (s.botId === id ? s.threadId : lastThread.get(id) ?? null);
  store.set({ botId: id, threadId, ...(s.botId !== id ? { conversation: null, threads: [], threadsBot: null, showThreads: false } : {}) });
  void loadThreads(id);
}

export async function loadThreads(botId: string): Promise<void> {
  const r = await api.get<{ threads: ThreadView[] }>(`/api/bots/${botId}/threads`);
  if (store.get().botId !== botId) return;
  let threadId = store.get().threadId;
  // No choice yet, or the open one is gone: the newest conversation.
  if (threadId !== "new" && (!threadId || !r.threads.some((t) => t.id === threadId))) threadId = r.threads[0]?.id ?? "new";
  store.set({ threads: r.threads, threadsBot: botId, threadId });
  if (threadId === "new") store.set({ conversation: null });
  else await loadConversation(threadId);
}

let pollTimer: number | undefined;

export async function loadConversation(threadId: string): Promise<void> {
  clearTimeout(pollTimer);
  const c = await api.get<Conversation>(`/api/threads/${encodeURIComponent(threadId)}`);
  if (store.get().threadId !== threadId) return;
  const pending = (store.get().conversation?.thread.id === threadId ? store.get().conversation!.messages : [])
    .filter((m) => m.pending && !c.messages.some((x) => x.role === "owner" && x.text === m.text));
  store.set({ conversation: { ...c, messages: [...c.messages, ...pending] } });
  lastThread.set(c.thread.bot_id, threadId);
  if (c.thread.unread && document.visibilityState === "visible") {
    void api.post(`/api/threads/${encodeURIComponent(threadId)}/read`).then(() => loadBotsSoon()).catch(() => {});
  }
  // A working bot's reply streams in: look again shortly.
  if (c.thread.state === "working") pollTimer = window.setTimeout(() => void loadConversation(threadId).catch(() => {}), 1500);
}

export function openThread(botId: string, threadId: string): void {
  selectBot(botId, { threadId });
  if (store.get().botId === botId) {
    store.set({ threadId, showThreads: false });
    void loadConversation(threadId).catch(fail);
  }
}

export function newConversation(): void {
  clearTimeout(pollTimer);
  store.set({ threadId: "new", conversation: null, showThreads: false });
}

/**
 * Send to the open conversation with the bot (or start one). Bots named with @ get the
 * message too, each in a conversation of its own.
 */
export async function sendMessage(botId: string, text: string, context?: { path?: string; selection?: string }): Promise<Mentioned[]> {
  const s = store.get();
  const into = s.botId === botId && s.threadId && s.threadId !== "new" ? s.threadId : undefined;
  const client_key = newKey("msg");
  const optimistic: Message = { id: client_key, role: "owner", text, at: new Date().toISOString(), streaming: false, pending: true };
  if (s.conversation && into && s.conversation.thread.id === into) {
    store.set({ conversation: { ...s.conversation, messages: [...s.conversation.messages, optimistic] } });
  } else if (s.botId === botId && !into) {
    // The first message of a new conversation shows at once, before the server answers.
    const now = optimistic.at;
    store.set({ conversation: {
      thread: { id: "new", bot_id: botId, title: text.slice(0, 60), origin: "chat", state: "working", created_at: now, updated_at: now, unread: false, archived: false },
      messages: [optimistic], notes: [],
    } });
  }
  let r: { thread_id: string; mentioned: Mentioned[] };
  try {
    r = await api.post(`/api/bots/${botId}/messages`, { text, client_key, context, ...(into ? { thread_id: into } : {}) });
  } catch (err) {
    const c = store.get().conversation;
    if (c) store.set({ conversation: { ...c, messages: c.messages.filter((m) => m.id !== client_key) } });
    throw err;
  }
  if (store.get().botId === botId) {
    store.set({ threadId: r.thread_id });
    await loadThreads(botId);
  }
  for (const m of r.mentioned) {
    toast(`Also sent to ${m.name}`, { action: { label: "Open", run: () => openThread(m.bot_id, m.thread_id) } });
  }
  return r.mentioned;
}

// ------------------------------------------------------------------ theme

export function applyTheme(theme: Theme): void {
  const night = theme === "night" || (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = night ? "night" : "day";
  const meta = document.querySelector('meta[name="theme-color"]');
  meta?.setAttribute("content", night ? "#0F1216" : "#FAF9F6");
}

export function setTheme(theme: Theme): void {
  store.set({ theme });
  persist("theme", theme);
  applyTheme(theme);
  store.set({ layoutTick: store.get().layoutTick + 1 });
}

// ------------------------------------------------------------------ helpers

export function botById(id: string | null | undefined): BotStatus | undefined {
  return id ? store.get().bots.find((b) => b.id === id) : undefined;
}

export function isMobile(): boolean {
  return matchMedia("(max-width: 819px)").matches;
}

export function allFiles(): TreeNode[] {
  const out: TreeNode[] = [];
  const walk = (n: TreeNode | null): void => {
    if (!n) return;
    if (n.type === "file") out.push(n);
    for (const c of n.children ?? []) walk(c);
  };
  walk(store.get().tree);
  return out;
}

/** Obsidian-style resolution: exact path, path + .md, then shortest path ending in the name. */
export function resolveWiki(target: string, fromPath?: string): string | undefined {
  const files = allFiles().map((f) => f.path);
  const t = target.replace(/^\/+/, "");
  const candidates = [t, `${t}.md`];
  if (fromPath) {
    const dir = fromPath.split("/").slice(0, -1).join("/");
    if (dir) candidates.unshift(`${dir}/${t}`, `${dir}/${t}.md`);
  }
  for (const c of candidates) if (files.includes(c)) return c;
  const name = t.split("/").pop()!.toLowerCase();
  const matches = files.filter((f) => {
    const base = f.split("/").pop()!.toLowerCase();
    return base === name || base === `${name}.md` || f.toLowerCase().endsWith(`/${t.toLowerCase()}`) || f.toLowerCase().endsWith(`/${t.toLowerCase()}.md`);
  });
  matches.sort((a, b) => a.length - b.length);
  return matches[0];
}

export function resolveRelative(href: string, fromPath: string): string {
  if (href.startsWith("/")) return href.replace(/^\/+/, "");
  const parts = fromPath.split("/").slice(0, -1);
  for (const seg of href.split("/")) {
    if (seg === "." || seg === "") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}

export const rawUrl = (path: string): string => `/api/raw?path=${q(path)}`;

export const COLOR_VAR: Record<string, string> = {
  teal: "var(--hue-teal)", indigo: "var(--hue-indigo)", amber: "var(--hue-amber)", rose: "var(--hue-rose)",
  green: "var(--hue-green)", violet: "var(--hue-violet)", slate: "var(--hue-slate)", orange: "var(--hue-orange)",
};
