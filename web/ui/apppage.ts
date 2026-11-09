/**
 * Middle pane for an app (ADR 0006): the app in a sandboxed frame with an opaque origin, a
 * header that says what it can read and reach, and the owner's answer to what it asks for.
 *
 * The frame loads by URL from a capability path the API mints for this device. It never gets
 * `allow-same-origin`, and the page builds no HTML from it (CONTRACT_TESTS #3, #6). It can only
 * ask, through postMessage, to open a vault page or to send its folder's agent a message, which
 * the owner confirms here.
 */
import { h, replace } from "../lib/dom.ts";
import { icon } from "../lib/icons.ts";
import { api } from "../lib/api.ts";
import { botById, fail, go, isMobile, selectBot, sendMessage, store, toast } from "../state.ts";
import type { AppOpen, AppServerInfo, PageData } from "../types.ts";
import { confirmDialog, openModal } from "./common.ts";

const SANDBOX = "allow-scripts allow-forms allow-modals allow-downloads";

type FrameContext = { path: string; root: string; owner: string; name: string };
/** Frames this page made, by their window: messages from anything else are ignored. */
const frames = new WeakMap<Window, FrameContext>();
let listening = false;
let asking = false;
/** The app on screen, so changes to its files reload it. */
let current: { path: string; root: string; reload: () => void } | undefined;
let reloadTimer: number | undefined;
/** What the app may read and reach, and its controls: shown in the page header, next to its name. */
export const appHeaderSlot = h("span", { class: "app-head" });

export function renderApp(page: PageData): Node {
  listen();
  const chips = h("span", { class: "app-chips" });
  const actions = h("span", { class: "app-actions" });
  replace(appHeaderSlot, chips, actions);
  const ask = h("div", { class: "app-ask hidden", role: "status" });
  const frame = h("iframe", {
    class: "app-frame", title: page.path, sandbox: SANDBOX, referrerpolicy: "no-referrer", allow: "",
  }) as HTMLIFrameElement;
  const view = h("div", { class: "app-view", dataset: { app: page.path } }, ask, frame);

  const load = async (): Promise<void> => {
    let opened: AppOpen;
    try {
      opened = await api.post<AppOpen>("/api/apps/open", { path: page.path });
    } catch (err) {
      replace(view, h("div", { class: "today" }, h("h1", null, "This app can't open"),
        h("p", { class: "sub" }, err instanceof Error ? err.message : String(err))));
      return;
    }
    const app = opened.app;
    const serverChip = h("button", { class: "app-chip server hidden" }) as HTMLButtonElement;
    const ctx: FrameContext = { path: page.path, root: app.root, owner: opened.owner, name: app.name };
    if (current?.path === page.path) current.root = app.root;
    replace(chips,
      h("span", { class: "app-chip", title: [app.root || "the vault", ...app.reads].join("\n") },
        icon("eye", 12), app.reads.length ? `Reads its folder and ${app.reads.length} more` : "Reads its folder"),
      h("span", { class: ["app-chip", app.network.length ? "online" : "offline"], title: app.network.join("\n") || "It cannot reach the internet" },
        icon(app.network.length ? "link" : "lock", 12), app.network.length ? `Online: ${app.network.map(host).join(", ")}` : "No internet access"),
      serverChip);
    if (app.server?.allowed) {
      showServerState(serverChip, app.server);
      serverChip.onclick = () => showServer(app.root, app.name, () => void load());
      void followServer(serverChip, app.root, view);
    }
    replace(actions,
      h("button", { class: "icon-btn", title: "Reload the app", "aria-label": "Reload the app", onclick: () => void load() }, icon("refresh", 15)),
      app.network.length || app.server?.allowed ? h("button", {
        class: "icon-btn", title: "Take back what it was allowed", "aria-label": "Take back what it was allowed",
        onclick: async () => {
          const what = [app.network.length ? `reaching ${app.network.join(", ")}` : "", app.server?.allowed ? "running its server" : ""].filter(Boolean).join(" and ");
          if (!await confirmDialog("Take back what this app was allowed?", `${app.name} will stop ${what} until you allow it again.`, "Take back")) return;
          try { await api.post("/api/apps/revoke", { root: app.root }); await load(); } catch (err) { fail(err); }
        },
      }, icon("lock", 15)) : null);
    const asksServer = !!app.server?.asks;
    if (app.asks.length || asksServer) {
      ask.classList.remove("hidden");
      const wants = [
        app.asks.length ? `to reach ${app.asks.join(", ")}` : "",
        asksServer ? `to run its server (${app.server!.file}) in a sandbox on the computer running Peers, with internet access` : "",
      ].filter(Boolean).join(", and ");
      replace(ask,
        icon("alert", 14),
        h("span", null, `${app.name} asks ${wants}. It can send what it reads${asksServer ? " and store data in its folder" : " there"}.`),
        h("button", {
          class: "btn primary",
          onclick: async () => {
            try {
              await api.post("/api/apps/grant", { root: app.root, network: [...app.network, ...app.asks], server: asksServer || !!app.server?.allowed });
              await load();
            } catch (err) { fail(err); }
          },
        }, "Allow"));
    } else {
      ask.classList.add("hidden");
      replace(ask);
    }
    frame.src = `${opened.url}#theme=${document.documentElement.dataset.theme === "night" ? "night" : "day"}`;
    const register = (): void => { if (frame.contentWindow) frames.set(frame.contentWindow, ctx); };
    register();
    frame.addEventListener("load", register, { once: true });
  };
  current = { path: page.path, root: "", reload: () => void load() };
  void load();
  return view;
}

/** Changes to the app's own files (not its data/ folder) reload it. */
export function appFilesChanged(paths: string[]): void {
  const c = current;
  if (!c || store.get().page?.path !== c.path || paths.includes(c.path)) return;
  const inside = (p: string): boolean => (c.root === "" || p.startsWith(`${c.root}/`)) && !p.startsWith(c.root ? `${c.root}/data/` : "data/");
  if (!paths.some(inside)) return;
  clearTimeout(reloadTimer);
  reloadTimer = window.setTimeout(() => c.reload(), 300);
}

function showServerState(chip: HTMLElement, s: Pick<AppServerInfo, "state" | "message"> & { file?: string }): void {
  chip.className = `app-chip server ${s.state}`;
  chip.title = s.message ?? "Show its output";
  replace(chip, icon("zap", 12), serverLabel(s));
}

/** While the server starts, follow it until it runs or stops (the chip is drawn before it is up). */
async function followServer(chip: HTMLElement, root: string, view: HTMLElement): Promise<void> {
  for (let i = 0; i < 40 && view.isConnected && chip.isConnected; i++) {
    await new Promise((ok) => setTimeout(ok, i < 10 ? 500 : 1500));
    try {
      const s = await api.get<AppServerInfo>(`/api/apps/server?root=${encodeURIComponent(root)}`);
      showServerState(chip, s);
      if (s.state !== "starting" && s.state !== "stopped") return;
    } catch {
      return;
    }
  }
}

function serverLabel(s: Pick<AppServerInfo, "state">): string {
  return s.state === "running" ? "Server running" : s.state === "starting" ? "Server starting"
    : s.state === "crashed" ? "Server stopped with an error" : s.state === "unavailable" ? "Server unavailable here" : "Server idle";
}

/** The server's state and recent output, with Restart and Stop. */
function showServer(root: string, name: string, reload: () => void): void {
  openModal((close) => {
    const state = h("p", { class: "sub" }, "Loading…");
    const log = h("pre", { class: "app-log" });
    const refresh = async (): Promise<void> => {
      try {
        const s = await api.get<AppServerInfo & { log: string; log_file: string }>(`/api/apps/server?root=${encodeURIComponent(root)}`);
        replace(state, `${serverLabel(s)}${s.message ? `: ${s.message}` : ""}. Full log: ${s.log_file}`);
        replace(log, s.log.trim() || "No output yet.");
        log.scrollTop = log.scrollHeight;
      } catch (err) { fail(err); }
    };
    const act = (what: "restart" | "stop") => async (): Promise<void> => {
      replace(state, what === "restart" ? "Restarting…" : "Stopping…");
      try { await api.post(`/api/apps/server/${what}`, { root }); } catch (err) { fail(err); }
      await refresh();
      reload();
    };
    void refresh();
    return h("div", { class: "app-server" },
      h("h3", null, `${name}: server`), state, log,
      h("div", { class: "actions" },
        h("button", { class: "btn", onclick: act("stop") }, "Stop"),
        h("button", { class: "btn", onclick: act("restart") }, "Restart"),
        h("button", { class: "btn primary", onclick: close }, "Close")));
  }, { label: `${name} server` });
}

function host(origin: string): string {
  return origin.replace(/^https:\/\//, "");
}

function listen(): void {
  if (listening) return;
  listening = true;
  window.addEventListener("message", (e) => void onMessage(e));
  // The app follows Peers' theme while it is open.
  // (setTheme updates the store before it applies the theme, hence the wait.)
  store.on(["theme"], () => setTimeout(() => {
    const frame = document.querySelector<HTMLIFrameElement>(".app-view .app-frame");
    const theme = document.documentElement.dataset.theme === "night" ? "night" : "day";
    frame?.contentWindow?.postMessage({ peers: 1, type: "theme", theme }, "*");
  }, 0));
}

async function onMessage(e: MessageEvent): Promise<void> {
  const source = e.source as Window | null;
  const ctx = source ? frames.get(source) : undefined;
  // Only our frames, and only while they are opaque: a frame that somehow got our origin is not an app.
  if (!ctx || e.origin !== "null") return;
  const d = e.data as { peers?: number; type?: string; path?: unknown; text?: unknown } | null;
  if (!d || typeof d !== "object" || d.peers !== 1) return;
  if (d.type === "open" && typeof d.path === "string" && d.path && d.path.length < 600) {
    go({ view: "page", path: d.path.replace(/^\/+/, "") });
    return;
  }
  if (d.type === "ask" && typeof d.text === "string" && d.text.trim()) {
    if (asking) return;
    asking = true;
    const text = d.text.trim().slice(0, 2000);
    const bot = botById(ctx.owner);
    try {
      // The app's words go in as text content, never as markup (CONTRACT_TESTS #3).
      const body = document.createElement("span");
      body.textContent = `${ctx.name} asks to send: “${text}”`;
      const yes = await confirmDialog(`Send this to ${bot?.name ?? "its agent"}?`, body, "Send");
      if (!yes) return;
      await sendMessage(ctx.owner, text, { path: ctx.path });
      selectBot(ctx.owner);
      if (isMobile()) store.set({ tab: "bot" });
      else store.set({ botCollapsed: false });
      toast(`Sent to ${bot?.name ?? "the agent"}`);
    } catch (err) {
      fail(err);
    } finally {
      asking = false;
    }
  }
}
