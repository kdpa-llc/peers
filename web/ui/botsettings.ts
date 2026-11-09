/**
 * A bot's settings page: instructions, model, access, memory and triggers. Opened from the
 * gear in the bot pane, the tree menu or Today, and shown in the middle pane so the chat
 * keeps the whole right side.
 */
import { h } from "../lib/dom.ts";
import { icon } from "../lib/icons.ts";
import { botById, selectBot, store } from "../state.ts";
import { clearBotDetail, memoryView, setupView, triggersView } from "./bot.ts";
import { avatar, statusText } from "./common.ts";

export function renderBotSettings(id: string): Node {
  const bot = botById(id);
  if (!bot) return h("div", { class: "today" }, h("h1", null, "Agent not found"), h("p", { class: "sub" }, id));
  clearBotDetail();
  const s = store.get();
  const section = (anchor: string, title: string, intro: string, body: Node): HTMLElement =>
    h("section", { class: "settings-section", id: `bot-${anchor}` },
      h("h2", null, title), h("p", { class: "muted" }, intro), body);
  return h("div", { class: "settings bot-settings" },
    h("div", { class: "bot-settings-head" },
      avatar(bot, 44),
      h("div", { style: { flex: "1", minWidth: "0" } },
        h("h1", null, bot.name),
        h("div", { class: "muted" }, `${statusText(bot, s.activity[bot.id])} · `,
          h("span", { class: "nowrap" }, `${bot.conversations} conversation${bot.conversations === 1 ? "" : "s"}`))),
      h("button", {
        class: "btn", onclick: () => {
          selectBot(bot.id, { pin: true });
          store.set({ tab: "bot", botCollapsed: false });
        },
      }, icon("comment", 14), "Chat")),
    // Jump links to the sections below (they scroll; they do not switch anything).
    h("nav", { class: "section-links", "aria-label": "Sections" },
      [["setup", "Instructions and model"], ["memory", "Memory"], ["triggers", "Triggers"]].map(([a, label]) => h("a", {
        href: `#bot-${a}`, onclick: (e: Event) => { e.preventDefault(); document.getElementById(`bot-${a}`)?.scrollIntoView({ behavior: "smooth" }); },
      }, label))),
    section("setup", "Instructions and model", "How this agent works, which model it thinks with, and where it may write.", setupView(bot)),
    section("memory", "Memory", "What this agent carries from one conversation to the next: a page in its folder that it reads and adds to.", memoryView(bot)),
    section("triggers", "Triggers", "When this agent works without you. Triggers start switched off.", triggersView(bot)));
}
