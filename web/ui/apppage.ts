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
import type { AppOpen, PageData } from "../types.ts";
import { confirmDialog } from "./common.ts";

const SANDBOX = "allow-scripts allow-forms allow-modals allow-downloads";

type FrameContext = { path: string; root: string; owner: string; name: string };
/** Frames this page made, by their window: messages from anything else are ignored. */
const frames = new WeakMap<Window, FrameContext>();
let listening = false;
let asking = false;
/** The app on screen, so changes to its files reload it. */
let current: { path: string; root: string; reload: () => void } | undefined;
let reloadTimer: number | undefined;

export function renderApp(page: PageData): Node {
  listen();
  const name = h("span", { class: "app-name" }, page.path.split("/").pop()!.replace(/\.html?$/i, ""));
  const chips = h("span", { class: "app-chips" });
  const actions = h("span", { class: "app-actions" });
  const bar = h("div", { class: "app-bar" }, h("span", { class: "app-icon" }, icon("app", 15)), name, chips, actions);
  const ask = h("div", { class: "app-ask hidden", role: "status" });
  const frame = h("iframe", {
    class: "app-frame", title: page.path, sandbox: SANDBOX, referrerpolicy: "no-referrer", allow: "",
  }) as HTMLIFrameElement;
  const view = h("div", { class: "app-view", dataset: { app: page.path } }, bar, ask, frame);

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
    const ctx: FrameContext = { path: page.path, root: app.root, owner: opened.owner, name: app.name };
    if (current?.path === page.path) current.root = app.root;
    replace(name, app.name);
    replace(chips,
      h("span", { class: "app-chip", title: [app.root || "the vault", ...app.reads].join("\n") },
        icon("eye", 12), app.reads.length ? `Reads its folder and ${app.reads.length} more` : "Reads its folder"),
      h("span", { class: ["app-chip", app.network.length ? "online" : "offline"], title: app.network.join("\n") || "No internet" },
        icon("link", 12), app.network.length ? `Online: ${app.network.map(host).join(", ")}` : "Offline"));
    replace(actions,
      h("button", { class: "icon-btn", title: "Reload the app", "aria-label": "Reload the app", onclick: () => void load() }, icon("refresh", 15)),
      app.network.length ? h("button", {
        class: "icon-btn", title: "Turn its internet off", "aria-label": "Turn its internet off",
        onclick: async () => {
          if (!await confirmDialog("Turn this app's internet off?", `${app.name} will stop reaching ${app.network.join(", ")} until you allow it again.`, "Turn off")) return;
          try { await api.post("/api/apps/revoke", { root: app.root }); await load(); } catch (err) { fail(err); }
        },
      }, icon("lock", 15)) : null);
    if (app.asks.length) {
      ask.classList.remove("hidden");
      replace(ask,
        icon("alert", 14),
        h("span", null, `${app.name} asks to reach ${app.asks.join(", ")}. It can send what it reads there.`),
        h("button", {
          class: "btn primary",
          onclick: async () => {
            try {
              await api.post("/api/apps/grant", { root: app.root, network: [...app.network, ...app.asks] });
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
      const yes = await confirmDialog(`Send this to ${bot?.name ?? "its agent"}?`, `${ctx.name} asks to send: “${text}”`, "Send");
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
