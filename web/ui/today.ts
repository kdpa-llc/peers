/** Home: what needs you, what changed since you looked, what's coming, and the agents (PRODUCT.md §7). */
import { h } from "../lib/dom.ts";
import { icon } from "../lib/icons.ts";
import { api } from "../lib/api.ts";
import { ago, clock } from "../lib/time.ts";
import { botById, fail, go, loadToday, openThread, selectBot, store, toast } from "../state.ts";
import type { BotStatus } from "../types.ts";
import { avatar, statePill, whereText } from "./common.ts";

const PAGE_EXT = /\.(md|markdown|org|html?)$/i;

export function renderToday(): Node {
  const s = store.get();
  const t = s.today;
  const now = new Date();
  const hour = now.getHours();
  const greeting = hour >= 5 && hour < 12 ? "Good morning" : hour >= 12 && hour < 18 ? "Good afternoon" : "Good evening";
  const head = (sub: string): Node[] => [
    h("p", { class: "today-date" }, now.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })),
    h("h1", null, `${greeting}${s.vault?.owner ? `, ${s.vault.owner}` : ""}`),
    h("p", { class: "sub" }, sub),
  ];
  if (!t) {
    void loadToday().catch(fail);
    return h("div", { class: "today" }, ...head("Catching up…"),
      h("div", { class: "skeleton", "aria-hidden": "true" }, h("div", { class: "bar" }), h("div", { class: "bar short" }), h("div", { class: "bar" })));
  }

  const n = t.needs_you;
  const openChat = (botId: string, threadId: string): void => {
    openThread(botId, threadId);
    store.set({ tab: "bot", botCollapsed: false });
  };
  const chev = (): Node => h("span", { class: "chev" }, icon("chevronRight", 14));
  const row = (o: { lead: Node; title: string; text?: string; files?: string; side?: string; tone?: "warn" | "bad"; onclick?: () => void }): HTMLElement =>
    h(o.onclick ? "button" : "div", { class: ["row-card", o.tone], ...(o.onclick ? { onclick: o.onclick } : {}) },
      o.lead,
      h("div", { class: "body" },
        h("div", { class: "title" }, o.title),
        o.text ? h("div", { class: "text" }, o.text) : null,
        o.files ? h("div", { class: "files" }, o.files) : null),
      o.side !== undefined || o.onclick ? h("div", { class: "side" }, o.side ? h("span", null, o.side) : null, o.onclick ? chev() : null) : null);

  const needs: HTMLElement[] = [];
  for (const r of n.replies) {
    needs.push(row({ lead: avatar(botById(r.bot_id), 28), title: `${r.bot} replied`, text: r.title, side: r.at ? ago(r.at) : "", onclick: () => openChat(r.bot_id, r.thread_id) }));
  }
  for (const w of n.waiting) {
    needs.push(row({ lead: icon("alert", 18), tone: "warn", title: `${w.bot} is waiting for an approval`, text: `${w.title} · approve it in the agents' T3`, onclick: () => openChat(w.bot_id, w.thread_id) }));
  }
  for (const f of n.failures) {
    needs.push(row({ lead: avatar(botById(f.bot_id), 28), tone: "bad", title: `${f.bot}: a run failed`, text: `${f.title}${f.detail ? ` · ${f.detail}` : ""}`, side: ago(f.at), onclick: () => openChat(f.bot_id, f.thread_id) }));
  }
  for (const note of n.notes) {
    needs.push(row({
      lead: icon("pen", 18), tone: "warn", title: note.status === "unresolved" ? "A note lost its place" : "A note failed",
      text: `${note.instruction || "(no instruction)"} · ${note.path}`, ...(note.reason ? { files: note.reason } : {}),
      onclick: () => go({ view: "page", path: note.path }),
    }));
  }
  for (const o of n.outside_scope) {
    needs.push(row({ lead: avatar(botById(o.bot_id), 28), tone: "warn", title: `${o.bot} changed a page outside its folder`, text: o.path, side: ago(o.at), onclick: () => go({ view: "page", path: o.path }) }));
  }
  for (const r of n.review) {
    needs.push(row({ lead: icon("alert", 18), tone: "warn", title: `Review ${r.bot}`, text: "Its triggers or write access changed outside Peers. Confirm them in its settings.", onclick: () => go({ view: "bot", id: r.bot_id }) }));
  }
  for (const l of n.lost ?? []) {
    needs.push(row({ lead: icon("alert", 18), tone: "warn", title: `${l.bot} lost what it looks after`, text: `${l.path} is gone. Give the moved folder or page an agent again, or edit the layout.`, onclick: () => go({ view: "settings" }) }));
  }
  for (const inv of n.invalid) {
    needs.push(row({ lead: icon("alert", 18), tone: "bad", title: `An agent definition can't be read in ${inv.folder}`, text: inv.reason }));
  }

  // Pages that changed since you last looked; opening one marks it seen.
  const changes = t.changes.map((c: any) => {
    const by = c.author === "external" ? "outside Peers" : c.author === "human" ? "by you" : `by ${c.author_name}`;
    const folder = c.path.split("/").slice(0, -1).join("/") || "Vault";
    return row({
      lead: c.author === "external" || c.author === "human" ? icon("file", 18) : avatar(botById(c.author), 28),
      title: c.path.split("/").pop().replace(PAGE_EXT, ""),
      files: `${c.created ? "New" : "Changed"} ${by} · ${folder}`,
      side: ago(c.at),
      onclick: () => go({ view: "page", path: c.path }),
    });
  });

  const coming = t.coming_up.map((c: any) => row({
    lead: avatar(botById(c.bot_id), 28), title: `${c.bot} · ${c.label}`, text: c.prompt, side: clock(c.at),
  }));

  const tile = (b: BotStatus): HTMLElement => {
    const pill = statePill(b);
    return h("button", {
      class: ["bot-tile", pill && "has-state"], title: `Chat with ${b.name}`,
      onclick: () => { selectBot(b.id, { pin: true }); store.set({ tab: "bot", botCollapsed: false }); },
    }, avatar(b, 32),
    h("div", { class: "tile-text" }, h("div", { class: "n" }, b.name), h("div", { class: "s", title: whereText(b) }, whereText(b))),
    pill);
  };
  const active = (t.bots as BotStatus[]).filter((b) => !b.archived);
  const archived = (t.bots as BotStatus[]).filter((b) => b.archived);

  const replies = n.replies.length;
  const others = needs.length - replies;
  const working = s.bots.filter((b) => b.state === "working").length;
  const parts = [
    replies ? `${replies} new ${replies === 1 ? "reply" : "replies"}` : "",
    others ? `${others} ${others === 1 ? "thing needs" : "things need"} you` : "",
    changes.length ? `${changes.length} ${changes.length === 1 ? "page" : "pages"} changed since you looked` : "",
    working ? `${working} ${working === 1 ? "agent" : "agents"} working` : "",
  ].filter(Boolean);
  const summary = parts.length
    ? `${parts.join(" · ")}.`.replace(/^./, (c) => c.toUpperCase())
    : `All quiet. ${active.length} ${active.length === 1 ? "agent is" : "agents are"} looking after your vault.`;

  const count = (k: number): Node | null => (k ? h("span", { class: "count" }, String(k)) : null);
  return h("div", { class: "today" },
    ...head(summary),
    // Empty sections stay out of the way: the line above already says when all is quiet.
    needs.length ? h("section", null, h("h2", null, "Needs you", count(needs.length)), h("div", { class: "list" }, needs)) : null,
    changes.length ? h("section", null, h("h2", null, "Changed since you looked", count(changes.length),
      h("button", { class: "btn small", onclick: () => void act("/api/seen/all", "Marked everything as seen") }, icon("check", 13), "Mark all seen")),
    h("div", { class: "list" }, changes)) : null,
    !needs.length && !changes.length ? h("div", { class: "all-clear" }, h("span", { class: "ok" }, icon("check", 15)),
      h("span", null, "Nothing needs you, and nothing changed since you last looked.")) : null,
    coming.length ? h("section", null, h("h2", null, "Coming up", count(coming.length)), h("div", { class: "list" }, coming)) : null,
    h("section", null, h("h2", null, "Agents", count(active.length)),
      h("div", { class: "bot-grid" }, active.map(tile)),
      archived.length ? h("details", { class: "archived-agents" },
        h("summary", null, icon("chevronRight", 12), `Archived (${archived.length})`),
        h("div", { class: "bot-grid" }, archived.map(tile))) : null));
}

async function act(path: string, msg: string): Promise<void> {
  try {
    await api.post(path);
    toast(msg);
    await loadToday();
  } catch (err) { fail(err); }
}
