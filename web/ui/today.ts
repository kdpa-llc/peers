/** Home: what needs you, what changed since you looked, what's coming, and the bots (PRODUCT.md §7). */
import { h } from "../lib/dom.ts";
import { icon } from "../lib/icons.ts";
import { api } from "../lib/api.ts";
import { ago, clock } from "../lib/time.ts";
import { botById, fail, go, loadToday, openThread, selectBot, store, toast } from "../state.ts";
import { avatar, statusDot, statusText } from "./common.ts";

export function renderToday(): Node {
  const s = store.get();
  const t = s.today;
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  if (!t) {
    void loadToday().catch(fail);
    return h("div", { class: "today" }, h("h1", null, greeting), h("p", { class: "sub" }, "Loading…"));
  }
  const n = t.needs_you;
  const needs: Node[] = [];
  const openChat = (botId: string, threadId: string): void => {
    openThread(botId, threadId);
    store.set({ tab: "bot", botCollapsed: false });
  };
  for (const r of n.replies) {
    needs.push(h("button", { class: "row-card", onclick: () => openChat(r.bot_id, r.thread_id) },
      avatar(botById(r.bot_id), 28),
      h("div", { class: "body" }, h("div", { class: "title" }, `${r.bot} replied`), h("div", { class: "text" }, r.title)),
      h("div", { class: "side" }, h("span", { class: "muted" }, r.at ? ago(r.at) : ""))));
  }
  for (const w of n.waiting) {
    needs.push(h("button", { class: "row-card", onclick: () => openChat(w.bot_id, w.thread_id) },
      icon("alert", 18),
      h("div", { class: "body" }, h("div", { class: "title" }, `${w.bot} is waiting for an approval`),
        h("div", { class: "text" }, `${w.title} · approve it in the bots' T3`))));
  }
  for (const f of n.failures) {
    needs.push(h("button", { class: "row-card", onclick: () => openChat(f.bot_id, f.thread_id) },
      avatar(botById(f.bot_id), 28),
      h("div", { class: "body" }, h("div", { class: "title" }, `${f.bot}: a run failed`),
        h("div", { class: "text" }, `${f.title}${f.detail ? ` · ${f.detail}` : ""}`)),
      h("div", { class: "side" }, h("span", { class: "muted" }, ago(f.at)))));
  }
  for (const note of n.notes) {
    needs.push(h("button", { class: "row-card", onclick: () => go({ view: "page", path: note.path }) },
      icon("pen", 18),
      h("div", { class: "body" },
        h("div", { class: "title" }, note.status === "unresolved" ? "A note lost its place" : "A note failed"),
        h("div", { class: "text" }, `${note.instruction || "(no instruction)"} · ${note.path}`),
        note.reason ? h("div", { class: "files" }, note.reason) : null)));
  }
  for (const o of n.outside_scope) {
    needs.push(h("button", { class: "row-card", onclick: () => go({ view: "page", path: o.path }) },
      avatar(botById(o.bot_id), 28),
      h("div", { class: "body" }, h("div", { class: "title" }, `${o.bot} changed a page outside its folder`),
        h("div", { class: "text" }, o.path)),
      h("div", { class: "side" }, h("span", { class: "muted" }, ago(o.at)))));
  }
  for (const r of n.review) {
    needs.push(h("button", { class: "row-card", onclick: () => go({ view: "bot", id: r.bot_id }) },
      icon("alert", 18), h("div", { class: "body" }, h("div", { class: "title" }, `Review ${r.bot}`),
        h("div", { class: "text" }, "Its triggers or write access changed outside Peers. Confirm them in its settings."))));
  }
  for (const l of n.lost ?? []) {
    needs.push(h("button", { class: "row-card", onclick: () => go({ view: "settings" }) },
      icon("alert", 18), h("div", { class: "body" }, h("div", { class: "title" }, `${l.bot} lost what it looks after`),
        h("div", { class: "text" }, `${l.path} is gone. Give the moved folder or page an agent again, or edit the layout.`))));
  }
  for (const inv of n.invalid) {
    needs.push(h("div", { class: "row-card" }, icon("alert", 18), h("div", { class: "body" },
      h("div", { class: "title" }, `Bot definition can't be read in ${inv.folder}`), h("div", { class: "text" }, inv.reason))));
  }

  // Pages that changed since you last looked; opening one marks it seen.
  const changes = t.changes.map((c: any) => h("button", { class: "row-card", onclick: () => go({ view: "page", path: c.path }) },
    c.author === "external" || c.author === "human" ? icon("file", 18) : avatar(botById(c.author), 28),
    h("div", { class: "body" },
      h("div", { class: "title" }, c.path.split("/").pop().replace(/\.(md|markdown)$/i, "")),
      h("div", { class: "files" }, `${c.created ? "New" : "Changed"} · by ${c.author === "external" ? "outside Peers" : c.author_name} · ${c.path.split("/").slice(0, -1).join("/") || "vault root"}`)),
    h("div", { class: "side" }, h("span", { class: "muted" }, ago(c.at)))));

  const coming = t.coming_up.map((c: any) => h("div", { class: "row-card" },
    avatar(botById(c.bot_id), 28),
    h("div", { class: "body" }, h("div", { class: "title" }, `${c.bot} · ${c.label}`), h("div", { class: "text" }, c.prompt)),
    h("div", { class: "side" }, h("span", { class: "muted" }, clock(c.at)))));

  const bots = t.bots.map((b: any) => h("button", {
    class: "bot-tile",
    onclick: () => { selectBot(b.id, { pin: true }); store.set({ tab: "bot", botCollapsed: false }); },
  }, avatar(b, 28), h("div", { style: { minWidth: "0", flex: "1" } },
    h("div", { class: "n" }, b.name),
    h("div", { class: "s" }, `${statusText(b, s.activity[b.id]).replace(/^(Project|Area|Vault) bot · /, "")}${b.unread ? ` · ${b.unread} new` : ""}`)),
    statusDot(b)));

  return h("div", { class: "today" },
    h("h1", null, `${greeting}${s.vault?.owner ? `, ${s.vault.owner}` : ""}`),
    h("p", { class: "sub" }, s.demo ? "Demo mode: bots are scripted. Start Peers without --scripted to run them on T3 with Claude or Codex." : `${t.bots.length} bots are looking after ${s.vault?.name ?? "your vault"}.`),
    h("section", null, h("h2", null, "Needs you", needs.length ? h("span", { class: "count" }, String(needs.length)) : null),
      needs.length ? needs : h("p", { class: "empty-line" }, "Nothing needs you right now.")),
    h("section", null, h("h2", null, "Changed since you looked", changes.length ? h("span", { class: "count" }, String(changes.length)) : null,
      changes.length ? h("button", { class: "btn small", style: { marginLeft: "auto" }, onclick: () => void act("/api/seen/all", "Marked all as seen") }, icon("check", 13), "Mark all seen") : null),
      changes.length ? changes : h("p", { class: "empty-line" }, "Nothing new since you last looked.")),
    coming.length ? h("section", null, h("h2", null, "Coming up"), coming) : null,
    h("section", null, h("h2", null, "Bots"), h("div", { class: "bot-grid" }, bots)));
}

async function act(path: string, msg: string): Promise<void> {
  try {
    await api.post(path);
    toast(msg);
    await loadToday();
  } catch (err) { fail(err); }
}
