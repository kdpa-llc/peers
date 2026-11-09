/** Peers web client: shell, boot, live updates, global keys. */
import { h, isTyping, mod, replace } from "./lib/dom.ts";
import { icon } from "./lib/icons.ts";
import { setUnauthorizedHandler } from "./lib/api.ts";
import { connect } from "./lib/events.ts";
import {
  applyRoute, applyTheme, botById, fail, go, loadBotsSoon, loadConversation, loadNotes, loadState, loadThreads, loadToday, loadTree,
  persist, refreshPage, routeFromHash, selectBot, setToast, store,
} from "./state.ts";
import { appFilesChanged } from "./ui/apppage.ts";
import { mountBot, toggleBotPane } from "./ui/bot.ts";
import { avatar, showToast } from "./ui/common.ts";
import { handlePageKeys } from "./ui/notes.ts";
import { mountPage } from "./ui/page.ts";
import { showPairing } from "./ui/pair.ts";
import { openPalette } from "./ui/palette.ts";
import { mountTree, toggleTreePane } from "./ui/tree.ts";

setToast(showToast);
applyTheme(store.get().theme);
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => applyTheme(store.get().theme));

function shell(): HTMLElement {
  const root = h("div", { class: "app", id: "app" });
  const banner = h("div", { class: "banner" });
  const tree = h("aside", { class: "pane tree-pane", "aria-label": "Vault" });
  const page = h("main", { class: "pane page-pane", "aria-label": "Page" });
  const bot = h("aside", { class: "pane bot-pane", "aria-label": "Bot" });
  const r1 = h("div", { class: "resizer", dataset: { for: "tree" }, role: "separator", "aria-label": "Resize sidebar" });
  const r2 = h("div", { class: "resizer", dataset: { for: "bot" }, role: "separator", "aria-label": "Resize chat pane" });
  const tabbar = h("nav", { class: "tabbar", "aria-label": "Sections" });
  root.append(banner, tree, r1, page, r2, bot, tabbar);
  mountTree(tree);
  mountPage(page);
  mountBot(bot);
  resizable(r1, "--tree-w", 200, 360, "treeW", 1);
  resizable(r2, "--bot-w", 320, 560, "botW", -1);

  const renderLayout = (): void => {
    const s = store.get();
    root.classList.toggle("tree-collapsed", s.treeCollapsed);
    root.classList.toggle("bot-collapsed", s.botCollapsed);
    root.classList.toggle("tree-open", s.treeOpen);
    root.dataset.tab = s.tab;
    replace(banner, h("div", { class: "banner-inner" },
      s.demo && !s.demoHidden ? h("div", { class: "demo-banner", role: "note" },
        h("span", { class: "demo-pill" }, "Demo"),
        h("span", { class: "demo-text" },
          h("span", { class: "demo-long" }, "Agents are scripted, and nothing leaves this computer. Start Peers without --scripted to run them on Claude or Codex."),
          h("span", { class: "demo-short" }, "Agents are scripted")),
        h("button", { class: "link", onclick: () => go({ view: "settings" }) }, "Set up agents"),
        h("button", { class: "icon-btn", title: "Hide this notice", "aria-label": "Hide the demo notice", onclick: () => closeDemoNotice(banner) }, icon("x", 13))) : null,
      s.connection === "offline" ? h("div", { class: "conn-banner" }, "Offline. Reconnecting…") : null));
    const needs = s.bots.reduce((n, b) => n + b.unread, 0) + (s.today?.needs_you?.failures?.length ?? 0);
    const current = botById(s.botId);
    replace(tabbar,
      tab("vault", icon("layers", 20), "Vault", needs > 0),
      tab("page", icon(s.route.view === "today" ? "today" : "file", 20), s.route.view === "today" ? "Today" : "Page", false),
      // The chat tab shows whose chat it is with the agent's avatar.
      tab("bot", current ? tabAvatar(current) : icon("bot", 20), "Chat", (current?.unread ?? 0) > 0));
  };
  const tabAvatar = (bot: NonNullable<ReturnType<typeof botById>>): HTMLElement => {
    const a = avatar(bot, 22);
    a.classList.add("tab-avatar");
    return a;
  };
  const tab = (id: "vault" | "page" | "bot", glyph: Node, label: string, dot: boolean): HTMLElement =>
    h("button", {
      class: store.get().tab === id ? "active" : undefined, "aria-current": store.get().tab === id ? "page" : undefined,
      onclick: () => {
        store.set({ tab: id });
        if (id === "bot" && store.get().botId) void loadThreads(store.get().botId!).catch(() => {});
      },
    }, glyph, h("span", null, label), dot ? h("span", { class: "dot attention tab-dot" }) : null);
  store.on(["treeCollapsed", "botCollapsed", "treeOpen", "tab", "demo", "demoHidden", "connection", "bots", "botId", "today", "route"], renderLayout);
  renderLayout();
  root.addEventListener("click", (e) => {
    // Tablet: tapping outside the tree overlay closes it.
    if (store.get().treeOpen && !(e.target as Element).closest(".tree-pane, .tree-toggle-inline")) store.set({ treeOpen: false });
  });
  return root;
}

/** The demo notice folds away, then stays hidden (MOTION.md: banner). */
function closeDemoNotice(banner: HTMLElement): void {
  if (banner.classList.contains("closing")) return;
  banner.classList.add("closing");
  // The fold's own end (or the fade's, under Reduce Motion), not a transition inside the notice.
  const done = (e: TransitionEvent): void => {
    if (e.target !== banner || (e.propertyName !== "grid-template-rows" && e.propertyName !== "opacity")) return;
    banner.removeEventListener("transitionend", done);
    persist("demoHidden", "1");
    store.set({ demoHidden: true });
    banner.classList.remove("closing");
  };
  banner.addEventListener("transitionend", done);
}

function resizable(handle: HTMLElement, cssVar: string, min: number, max: number, key: string, dir: 1 | -1): void {
  const savedWidth = Number(localStorage.getItem(`peers.${key}`));
  if (savedWidth >= min && savedWidth <= max) document.documentElement.style.setProperty(cssVar, `${savedWidth}px`);
  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add("dragging");
    const startX = e.clientX;
    const start = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(cssVar)) || (cssVar === "--tree-w" ? 248 : 380);
    let width = start;
    const move = (ev: PointerEvent): void => {
      width = Math.max(min, Math.min(max, start + dir * (ev.clientX - startX)));
      document.documentElement.style.setProperty(cssVar, `${width}px`);
    };
    const up = (): void => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.classList.remove("dragging");
      persist(key, String(Math.round(width)));
      store.set({ layoutTick: store.get().layoutTick + 1 });
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  });
}

// ------------------------------------------------------------------ live updates

let pageTimer: number | undefined;
let todayTimer: number | undefined;
let treeTimer: number | undefined;
let threadsTimer: number | undefined;

function onLive(type: string, data: any): void {
  const s = store.get();
  switch (type) {
    case "file.changed": {
      const paths: string[] = data.paths ?? [];
      if (s.page && paths.includes(s.page.path)) {
        clearTimeout(pageTimer);
        pageTimer = window.setTimeout(() => void refreshPage(), 120);
      }
      if (s.page?.kind === "app") appFilesChanged(paths);
      clearTimeout(treeTimer);
      treeTimer = window.setTimeout(() => void loadTree().catch(() => {}), 200);
      break;
    }
    case "tree.changed":
      clearTimeout(treeTimer);
      treeTimer = window.setTimeout(() => void loadTree().catch(() => {}), 150);
      break;
    case "thread.updated":
      // A conversation started, changed state, or got a reply.
      if (data.bot_id === s.botId) {
        clearTimeout(threadsTimer);
        threadsTimer = window.setTimeout(() => void loadThreads(data.bot_id).catch(() => {}), 120);
        if (data.thread_id === s.threadId) void loadConversation(data.thread_id).catch(() => {});
      }
      loadBotsSoon();
      break;
    case "seen.changed":
      clearTimeout(treeTimer);
      treeTimer = window.setTimeout(() => void loadTree().catch(() => {}), 200);
      break;
    case "annotation.updated":
      if (s.page && data.path === s.page.path) void loadNotes().catch(() => {});
      break;
    case "bot.changed":
    case "bots.changed":
    case "state.changed":
      loadBotsSoon();
      break;
  }
  if (["today.changed", "thread.updated", "annotation.updated", "bots.changed", "seen.changed"].includes(type) && s.route.view === "today") {
    clearTimeout(todayTimer);
    todayTimer = window.setTimeout(() => void loadToday().catch(() => {}), 250);
  } else if (type === "today.changed") {
    clearTimeout(todayTimer);
    todayTimer = window.setTimeout(() => void loadToday().catch(() => {}), 400);
  }
}

async function resync(): Promise<void> {
  try {
    if (!(await loadState())) return;
    await loadTree();
    const s = store.get();
    if (s.route.view === "page") await refreshPage();
    else if (s.route.view === "today") await loadToday();
    if (s.botId) await loadThreads(s.botId);
  } catch { /* the next event or foregrounding tries again */ }
}

// ------------------------------------------------------------------ keys

function onKey(e: KeyboardEvent): void {
  if (mod(e) && e.key.toLowerCase() === "k") { e.preventDefault(); openPalette(); return; }
  if (mod(e) && e.key === "\\") { e.preventDefault(); if (e.shiftKey) toggleBotPane(); else toggleTreePane(); return; }
  if (mod(e) && e.key.toLowerCase() === "j") {
    e.preventDefault();
    store.set({ botCollapsed: false, tab: "bot" });
    setTimeout(() => (document.querySelector(".composer textarea") as HTMLTextAreaElement | null)?.focus(), 30);
    return;
  }
  if (handlePageKeys(e)) { e.preventDefault(); return; }
  if (!isTyping(e.target) && e.key === "g") {
    const next = (ev: KeyboardEvent): void => {
      document.removeEventListener("keydown", next, true);
      if (ev.key === "t") { ev.preventDefault(); go({ view: "today" }); }
    };
    document.addEventListener("keydown", next, true);
  }
}

// ------------------------------------------------------------------ boot

async function boot(): Promise<void> {
  const root = document.getElementById("root")!;
  setUnauthorizedHandler(() => {
    store.set({ needsPairing: true });
    showPairing(() => void start());
  });
  const start = async (): Promise<void> => {
    try {
      if (!(await loadState())) { showPairing(() => void start()); return; }
      if (!document.getElementById("app")) replace(root, shell());
      await loadTree();
      const vaultBot = store.get().bots.find((b) => b.kind === "vault");
      if (vaultBot) selectBot(vaultBot.id);
      await applyRoute(routeFromHash());
      connect({
        onEvent: onLive,
        onResync: () => void resync(),
        onStatus: (connection) => store.set({ connection }),
      });
    } catch (err) {
      fail(err);
    }
  };
  addEventListener("hashchange", () => void applyRoute(routeFromHash()));
  document.addEventListener("keydown", onKey);
  addEventListener("resize", () => store.set({ layoutTick: store.get().layoutTick + 1 }));
  await start();
  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "127.0.0.1" || location.hostname === "localhost")) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }
}

void boot();
