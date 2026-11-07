/**
 * Left pane: Today, the inbox, and the vault's folders (PRODUCT.md §4.1, ADR 0005). Nothing
 * here knows PARA: top-level folders without an agent become sections (Projects, Areas…),
 * and any folder or page with an agent shows its avatar. The layout decides the rest.
 */
import { h, replace } from "../lib/dom.ts";
import { icon } from "../lib/icons.ts";
import { api } from "../lib/api.ts";
import {
  botById, fail, go, isMobile, loadState, loadTree, openThread, persist, selectBot, setTheme, store, toast, toggleFolder,
} from "../state.ts";
import type { TreeNode } from "../types.ts";
import { avatar, confirmDialog, openMenu, promptDialog, statusDot } from "./common.ts";
import { openPalette } from "./palette.ts";

export function mountTree(pane: HTMLElement): void {
  const scroll = h("div", { class: "tree-scroll" });
  const rail = h("div", { class: "rail" },
    h("button", { class: "icon-btn", title: "Show sidebar (⌘\\)", "aria-label": "Show sidebar", onclick: () => toggleTreePane() }, icon("sidebarLeft", 18)),
    h("button", { class: "icon-btn", title: "Search (⌘K)", "aria-label": "Search", onclick: () => openPalette() }, icon("search", 18)),
    h("button", { class: "icon-btn", title: "Today", "aria-label": "Today", onclick: () => go({ view: "today" }) }, icon("today", 18)));
  const top = h("div", { class: "tree-top" },
    h("div", { class: "brand" }, h("span", { class: "brand-mark" }, icon("layers", 14)), h("span", { class: "brand-name" }, "Peers")),
    h("button", { class: "icon-btn", title: "Hide sidebar (⌘\\)", "aria-label": "Hide sidebar", onclick: () => toggleTreePane() }, icon("sidebarLeft", 17)));
  const search = h("button", { class: "search-btn", onclick: () => openPalette() },
    icon("search", 15), h("span", null, "Search vault"), h("span", { class: "kbd" }, "⌘K"));
  const themeBtn = h("button", { class: "icon-btn", "aria-label": "Theme", title: "Theme: system, day, night" });
  const foot = h("div", { class: "tree-foot" },
    h("button", { class: "icon-btn", title: "Settings", "aria-label": "Settings", onclick: () => go({ view: "settings" }) }, icon("settings", 17)),
    themeBtn);
  themeBtn.addEventListener("click", () => {
    const order = ["system", "day", "night"] as const;
    const next = order[(order.indexOf(store.get().theme) + 1) % order.length]!;
    setTheme(next);
    toast(`Theme: ${next === "system" ? "match the system" : next}`);
  });
  pane.append(rail, top, search, scroll, foot);

  const render = (): void => {
    const s = store.get();
    replace(themeBtn, icon(s.theme === "night" ? "moon" : s.theme === "day" ? "sun" : "contrast", 17));
    replace(scroll, renderTree());
  };
  store.on(["tree", "bots", "expanded", "route", "changed", "theme", "today", "owners", "fronts"], render);
  render();
}

export function toggleTreePane(): void {
  if (matchMedia("(max-width: 1180px) and (min-width: 820px)").matches) {
    store.set({ treeOpen: !store.get().treeOpen });
    return;
  }
  const v = !store.get().treeCollapsed;
  store.set({ treeCollapsed: v });
  persist("treeCollapsed", v ? "1" : "0");
}

function renderTree(): Node {
  const s = store.get();
  const tree = s.tree;
  const frag = document.createDocumentFragment();
  const route = s.route;
  const current = route.view === "page" ? route.path : "";
  const needs = s.today ? countNeeds(s.today) : 0;
  frag.append(
    h("button", { class: ["nav-item", route.view === "today" && "selected"], onclick: () => { go({ view: "today" }); if (isMobile()) store.set({ tab: "page" }); } },
      icon("today", 16), h("span", null, "Today"), needs ? h("span", { class: "count" }, String(needs)) : null),
  );
  if (!tree) return frag;
  const top = tree.children ?? [];
  // The inbox: a folder (expandable, with a count) or a single page.
  const inbox = s.inbox ? top.find((c) => c.path === s.inbox) : undefined;
  if (inbox?.type === "dir") {
    const count = (inbox.children ?? []).filter((c) => c.type === "file").length;
    const open = s.expanded[inbox.path];
    frag.append(h("button", {
      class: ["nav-item", current.startsWith(`${inbox.path}/`) && !open && "selected"],
      onclick: () => toggleFolder(inbox.path),
    }, icon("inbox", 16), h("span", null, inbox.name), count ? h("span", { class: "count" }, String(count)) : null));
    if (open) frag.append(h("div", { class: "tree-children" }, (inbox.children ?? []).map((c) => node(c, current, 1))));
  } else if (inbox) {
    frag.append(h("button", { class: ["nav-item", current === inbox.path && "selected"], onclick: () => go({ view: "page", path: inbox.path }) },
      icon("inbox", 16), h("span", null, inbox.name.replace(/\.(md|markdown|org)$/i, ""))));
  }
  // Top-level folders without an agent are sections; everything else is listed under the vault.
  const loose: TreeNode[] = [];
  for (const c of top) {
    if (c === inbox) continue;
    if (c.type === "dir" && !s.owners[c.path]) {
      const isArchive = c.path === s.archive;
      const open = !isArchive || s.expanded[c.path];
      const front = s.fronts[c.path];
      frag.append(h("div", { class: "section-head", oncontextmenu: (e: MouseEvent) => { e.preventDefault(); folderMenu(c, undefined, { x: e.clientX, y: e.clientY }); } },
        // A section with a front page (projects.org, README.md) opens it.
        front
          ? h("a", { href: "#", class: "section-link", title: `Open ${front}`, onclick: (e: Event) => { e.preventDefault(); go({ view: "page", path: front }); } }, c.name)
          : h("span", { title: c.path }, c.name),
        isArchive
          ? h("button", { "aria-label": open ? `Collapse ${c.name}` : `Expand ${c.name}`, onclick: () => toggleFolder(c.path) }, icon(open ? "chevronDown" : "chevronRight", 14))
          : h("button", { title: `New folder in ${c.name}`, "aria-label": `New folder in ${c.name}`, onclick: () => newFolder(c.path) }, icon("plus", 14))));
      if (open) for (const child of c.children ?? []) frag.append(node(child, current, 0));
    } else {
      loose.push(c);
    }
  }
  if (loose.length) {
    frag.append(h("div", { class: "section-head" }, h("span", null, "Vault"),
      h("button", { title: "New folder", "aria-label": "New folder", onclick: () => newFolder("") }, icon("plus", 14))));
    for (const c of loose) frag.append(node(c, current, 0));
  }
  return frag;
}

function isReadonly(path: string): boolean {
  return store.get().readonly.some((r) => path === r || path.startsWith(`${r}/`));
}

function countNeeds(t: any): number {
  const n = t.needs_you;
  return (n.replies?.length ?? 0) + (n.waiting?.length ?? 0) + (n.notes?.length ?? 0) + (n.failures?.length ?? 0) +
    (n.review?.length ?? 0) + (n.outside_scope?.length ?? 0) + (t.changes?.length ?? 0);
}

function node(n: TreeNode, current: string, depth: number): Node {
  const s = store.get();
  const botId = s.owners[n.path];
  const bot = botById(botId);
  if (n.type === "file") {
    const changed = s.changed.includes(n.path);
    return h("button", {
      class: ["tree-row", current === n.path && "selected"],
      dataset: { path: n.path },
      title: n.path,
      onclick: () => go({ view: "page", path: n.path }),
      oncontextmenu: (e: MouseEvent) => { e.preventDefault(); fileMenu(n, botId, { x: e.clientX, y: e.clientY }); },
    },
      h("span", { class: "twisty" }),
      // A page with its own agent shows the agent.
      bot ? avatar(bot, 18) : h("span", { class: "file-icon" }, icon(n.kind === "pdf" ? "pdf" : n.kind === "image" || n.kind === "svg" ? "image" : "file", 15)),
      // A page agent is shown by its name ("Personal website"), not its file name.
      h("span", { class: "label", title: n.path }, bot ? bot.name : n.name.replace(/\.(md|markdown|org)$/i, "")),
      isReadonly(n.path) ? h("span", { class: "tree-tag", title: "Generated: edit the source note" }, icon("lock", 11)) : null,
      bot ? statusDot(bot) : null,
      changed ? h("span", { class: "dot changed", title: "Changed since you last looked" }) : null);
  }
  const open = !!s.expanded[n.path];
  const row = h("button", {
    class: ["tree-row", bot && s.botId === bot.id && s.pinned && "selected"],
    dataset: { path: n.path },
    title: n.path,
    "aria-expanded": open ? "true" : "false",
    onclick: () => {
      toggleFolder(n.path);
      if (bot && !s.pinned) selectBot(bot.id);
      // Opening a folder shows its front page (index, README, main, or the folder note).
      const front = s.fronts[n.path];
      if (!open && front) go({ view: "page", path: front });
    },
    oncontextmenu: (e: MouseEvent) => { e.preventDefault(); folderMenu(n, botId, { x: e.clientX, y: e.clientY }); },
  },
    h("span", { class: "twisty" }, icon(open ? "chevronDown" : "chevronRight", 12)),
    bot ? avatar(bot, 18) : h("span", { class: "file-icon" }, icon("folder", 15)),
    h("span", { class: "label" }, n.name),
    isReadonly(n.path) ? h("span", { class: "tree-tag", title: "Generated: edit the source note" }, icon("lock", 11)) : null,
    statusDot(bot));
  attachLongPress(row, (pt) => folderMenu(n, botId, pt));
  return h("div", null, row, open ? h("div", { class: "tree-children" }, (n.children ?? []).map((c) => node(c, current, depth + 1))) : null);
}

function attachLongPress(el: HTMLElement, fn: (pt: { x: number; y: number }) => void): void {
  let timer: number | undefined;
  el.addEventListener("touchstart", (e) => {
    const t = e.touches[0]!;
    timer = window.setTimeout(() => fn({ x: t.clientX, y: t.clientY }), 550);
  }, { passive: true });
  for (const ev of ["touchend", "touchmove", "touchcancel"]) el.addEventListener(ev, () => clearTimeout(timer), { passive: true });
}

function agentItems(n: TreeNode, botId: string | undefined): import("./common.ts").MenuItem[] {
  const s = store.get();
  const bot = botById(botId);
  if (!bot) {
    return [{ label: n.type === "dir" ? "Give this folder an agent" : "Give this page an agent", icon: "bot", run: () => addAgent(n.path) }];
  }
  return [
    { label: `Chat with ${bot.name}`, icon: "comment", run: () => { selectBot(bot.id, { pin: true }); store.set({ tab: "bot", botCollapsed: false }); } },
    { label: "Run now", icon: "play", run: () => { api.post<{ thread_id: string }>(`/api/bots/${bot.id}/run`).then((r) => { toast(`${bot.name} is on it`); openThread(bot.id, r.thread_id); }).catch(fail); } },
    { label: "Agent settings", icon: "sliders", run: () => go({ view: "bot", id: bot.id }) },
    ...(s.archive && !bot.archived ? [{ label: `Move to ${s.archive}`, icon: "archive", run: () => archive(n.path) }] : []),
    ...(bot.archived ? [{ label: "Restore", icon: "restore", run: () => restore(n.path) }] : []),
    { label: "Remove agent", icon: "x", run: () => removeAgent(bot.id, bot.name) },
  ];
}

function folderMenu(n: TreeNode, botId: string | undefined, at: { x: number; y: number }): void {
  const bot = botById(botId);
  openMenu([
    ...(bot ? [{ label: "New page…", icon: "plus", run: () => newPage(bot.id, n.path) }] : []),
    { label: "New folder…", icon: "folder", run: () => newFolder(n.path) },
    "divider" as const,
    ...agentItems(n, botId),
  ], at);
}

function fileMenu(n: TreeNode, botId: string | undefined, at: { x: number; y: number }): void {
  openMenu([
    { label: "Open", icon: "file", run: () => go({ view: "page", path: n.path }) },
    ...(/\.(md|markdown|org)$/i.test(n.path) ? ["divider" as const, ...agentItems(n, botId)] : []),
    "divider",
    { label: "Move to…", icon: "external", run: () => moveFile(n.path) },
    { label: "Delete", icon: "trash", danger: true, run: () => deleteFile(n.path) },
  ], at);
}

async function addAgent(path: string): Promise<void> {
  try {
    const bot = await api.post<{ id: string; name: string }>("/api/bots", { path });
    await Promise.all([loadTree(), loadState()]);
    selectBot(bot.id, { pin: false });
    store.set({ tab: "bot", botCollapsed: false });
    toast(`${bot.name} now looks after ${path}`);
  } catch (err) { fail(err); }
}

async function removeAgent(id: string, name: string): Promise<void> {
  if (!(await confirmDialog(`Remove ${name}?`, "The folder stays as it is. Its conversations and memory are kept, and come back if you give it an agent again.", "Remove"))) return;
  try {
    await api.del(`/api/bots/${id}`);
    await Promise.all([loadTree(), loadState()]);
    // The pane was showing the agent that is gone: show the vault agent instead.
    if (store.get().botId === id) {
      const vault = store.get().bots.find((b) => b.kind === "vault");
      if (vault) selectBot(vault.id, { pin: false });
    }
    toast(`${name} removed`);
  } catch (err) { fail(err); }
}

async function newFolder(parent: string): Promise<void> {
  const v = await promptDialog(parent ? `New folder in ${parent.split("/").pop()}` : "New folder", "A folder with its own agent. The agent writes its front page from your sentence.", [
    { name: "name", label: "Name", placeholder: "Garden beds" },
    { name: "brief", label: "What is it about?", placeholder: "One sentence is enough", multiline: true },
  ], "Create");
  if (!v?.name?.trim()) return;
  try {
    const r = await api.post("/api/folders", { parent, name: v.name, brief: v.brief });
    await Promise.all([loadTree(), loadState()]);
    if (r.bot_id) {
      selectBot(r.bot_id, { pin: false });
      store.set({ tab: "bot", botCollapsed: false });
    }
    toast(`${v.name} created`);
  } catch (err) { fail(err); }
}

async function newPage(botId: string, folder: string): Promise<void> {
  const v = await promptDialog("New page", "Describe the page; the agent writes it.", [
    { name: "brief", label: "What should this page be?", placeholder: "A packing list for the trip", multiline: true },
  ], "Ask the agent");
  if (!v?.brief?.trim()) return;
  const { sendMessage } = await import("../state.ts");
  await sendMessage(botId, `Create a new page in ${folder}: ${v.brief.trim()}`, { path: folder }).catch(fail);
  selectBot(botId);
  store.set({ tab: "bot" });
}

async function archive(path: string): Promise<void> {
  if (!(await confirmDialog("Archive this?", `It moves to ${store.get().archive ?? "the archive"} and its agent pauses. You can restore it later.`, "Archive"))) return;
  try {
    await api.post("/api/folders/archive", { path });
    await loadTree();
    toast("Archived");
  } catch (err) { fail(err); }
}

async function restore(path: string): Promise<void> {
  try {
    const r = await api.post("/api/folders/restore", { path });
    await loadTree();
    toast(`Restored to ${r.folder}`);
  } catch (err) { fail(err); }
}

async function moveFile(path: string): Promise<void> {
  const v = await promptDialog("Move file", `Move ${path} to a new path.`, [{ name: "to", label: "New path", placeholder: path }], "Move");
  if (!v?.to?.trim()) return;
  try {
    await api.post("/api/files/move", { from: path, to: v.to.trim() });
    await loadTree();
    go({ view: "page", path: v.to.trim() });
  } catch (err) { fail(err); }
}

async function deleteFile(path: string): Promise<void> {
  if (!(await confirmDialog("Delete this file?", `${path} is deleted from the vault folder. Peers keeps no copy.`, "Delete", true))) return;
  try {
    await api.post("/api/files/delete", { path });
    await loadTree();
    go({ view: "today" });
  } catch (err) { fail(err); }
}
