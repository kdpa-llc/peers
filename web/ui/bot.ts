/**
 * Right pane: the bot that owns what you are looking at, and your conversations with it
 * (PRODUCT.md §4.3, ADR 0003). A bot can have many conversations; the bar under its name
 * switches between them or starts a new one. Writing @Name sends the message to that bot
 * too. Settings (instructions, model, memory, triggers) live on their own page.
 */
import { parseMarkdown } from "../../src/vault/markdown.ts";
import { h, replace } from "../lib/dom.ts";
import { icon } from "../lib/icons.ts";
import { renderBlocks } from "../lib/md-dom.ts";
import { api } from "../lib/api.ts";
import { ago, clock } from "../lib/time.ts";
import {
  botById, COLOR_VAR, fail, go, loadState, loadThreads, newConversation, openThread, persist, rawUrl,
  resolveRelative, resolveWiki, sendMessage, store, toast,
} from "../state.ts";
import type { BotDetail, BotStatus, Message, ModelChoice, ThreadView, Trigger } from "../types.ts";
import { avatar, openMenu, statusText } from "./common.ts";

let detailCache: { id: string; data: BotDetail } | undefined;

export function mountBot(pane: HTMLElement): void {
  const rail = h("div", { class: "rail" },
    h("button", { class: "icon-btn", title: "Show bot (⌘⇧\\)", "aria-label": "Show bot", onclick: () => toggleBotPane() }, icon("sidebarRight", 18)));
  const head = h("div", { class: "bot-head" });
  const bar = h("div", { class: "conv-bar" });
  const body = h("div", { class: "bot-body" });
  pane.append(rail, head, bar, body);

  const renderHead = (): void => {
    const s = store.get();
    const bot = botById(s.botId);
    if (!bot) { replace(head); return; }
    const running = bot.state === "working";
    replace(head,
      h("div", { class: "bot-id" },
        avatar(bot, 36),
        h("div", { class: "who" },
          h("div", { class: "name" }, h("span", null, bot.name),
            bot.needs_review ? h("span", { class: "badge" }, "Review") : null,
            s.pinned ? h("span", { class: "badge pinned" }, "Pinned") : null),
          h("div", { class: "status", title: statusText(bot, s.activity[bot.id]) }, statusText(bot, s.activity[bot.id]))),
        running
          ? h("button", { class: "icon-btn", title: "Stop", "aria-label": "Stop", onclick: () => stop(bot) }, icon("pause", 16))
          : h("button", { class: "icon-btn", title: "Run now", "aria-label": "Run now", onclick: () => runNow(bot) }, icon("play", 16)),
        h("button", {
          class: ["icon-btn", s.pinned && "active"], title: s.pinned ? "Unpin (follow the page)" : "Pin this bot",
          "aria-label": s.pinned ? "Unpin" : "Pin", onclick: () => store.set({ pinned: !s.pinned }),
        }, icon("pin", 16)),
        // Memory, triggers and setup are used rarely, so they live on their own page.
        h("button", { class: "icon-btn", title: "Bot settings: instructions, memory, triggers", "aria-label": "Bot settings", onclick: () => go({ view: "bot", id: bot.id }) }, icon("settings", 16)),
        h("button", { class: "icon-btn", title: "Hide (⌘⇧\\)", "aria-label": "Hide bot pane", onclick: () => toggleBotPane() }, icon("sidebarRight", 16))));
  };

  const renderBar = (): void => {
    const s = store.get();
    const bot = botById(s.botId);
    if (!bot) { replace(bar); return; }
    const current = s.threads.find((t) => t.id === s.threadId);
    const others = s.threads.filter((t) => t.id !== s.threadId && t.unread).length;
    replace(bar,
      h("button", {
        class: ["conv-current", s.showThreads && "open"], "aria-expanded": s.showThreads ? "true" : "false",
        title: "Conversations", onclick: () => store.set({ showThreads: !s.showThreads }),
      },
        icon(current ? originIcon(current) : "comment", 14),
        h("span", { class: "conv-title" }, s.threadId === "new" || !current ? "New conversation" : current.title),
        others ? h("span", { class: "count", title: `${others} other conversation${others === 1 ? "" : "s"} with new replies` }, String(others)) : null,
        h("span", { class: "conv-caret" }, icon("chevronDown", 13))),
      h("button", { class: "btn small", title: "New conversation", "aria-label": "New conversation", onclick: () => { newConversation(); focusComposer(); } },
        icon("plus", 13), "New"));
  };

  const renderBody = (): void => {
    const s = store.get();
    const bot = botById(s.botId);
    if (!bot) { chatRefs = undefined; replace(body, h("div", { class: "thread" }, h("div", { class: "thread-empty" }, "Open a page to talk to its bot."))); return; }
    if (s.showThreads) { chatRefs = undefined; replace(body, threadList(bot)); return; }
    if (!chatRefs || chatRefs.botId !== bot.id || !chatRefs.thread.isConnected) replace(body, chatView(bot));
    else updateChat();
  };

  store.on(["botId", "bots", "pinned", "activity"], renderHead);
  store.on(["botId", "threads", "threadId", "showThreads"], renderBar);
  store.on(["botId", "showThreads"], () => { detailCache = undefined; chatRefs = undefined; renderBody(); });
  store.on(["threads", "threadId"], () => { if (store.get().showThreads) renderBody(); });
  store.on(["conversation", "threadId", "page", "selection", "bots"], () => updateChat());
  renderHead();
  renderBar();
  renderBody();
}

export function toggleBotPane(): void {
  const v = !store.get().botCollapsed;
  store.set({ botCollapsed: v });
  persist("botCollapsed", v ? "1" : "0");
}

function focusComposer(): void {
  setTimeout(() => chatRefs?.input.focus(), 30);
}

async function runNow(bot: BotStatus): Promise<void> {
  try {
    const r = await api.post<{ thread_id: string }>(`/api/bots/${bot.id}/run`);
    toast(`${bot.name} is on it`);
    openThread(bot.id, r.thread_id);
  } catch (err) { fail(err); }
}

async function stop(bot: BotStatus): Promise<void> {
  try {
    await api.post(`/api/bots/${bot.id}/stop`);
    toast(`Stopped ${bot.name}`);
  } catch (err) { fail(err); }
}

async function detail(id: string): Promise<BotDetail> {
  if (detailCache?.id === id) return detailCache.data;
  const data = await api.get<BotDetail>(`/api/bots/${id}`);
  detailCache = { id, data };
  return data;
}

// ------------------------------------------------------------------ conversation list

function originIcon(t: ThreadView): string {
  return t.origin === "trigger" ? "clock" : t.origin === "notes" ? "pen" : t.origin === "mention" ? "at" : t.origin === "manual" ? "play" : "comment";
}

function threadList(bot: BotStatus): Node {
  const s = store.get();
  const rows = s.threads.map((t) => h("div", { class: ["conv-row", t.id === s.threadId && "current", t.unread && "unread"] },
    h("button", { class: "conv-open", onclick: () => openThread(bot.id, t.id) },
      icon(originIcon(t), 15),
      h("div", { class: "conv-text" },
        h("div", { class: "conv-name" }, t.title),
        h("div", { class: "conv-meta" },
          t.state === "working" ? "Working… · " : t.state === "failed" ? "Failed · " : t.state === "waiting" ? "Waiting for approval · " : "",
          t.origin === "trigger" ? "Trigger · " : t.origin === "mention" ? "Mentioned · " : t.origin === "notes" ? "Notes · " : "",
          ago(t.updated_at))),
      t.unread ? h("span", { class: "dot changed", "aria-label": "new reply" }) : null),
    h("button", {
      class: "icon-btn", "aria-label": `More for ${t.title}`,
      onclick: (e: MouseEvent) => openMenu([
        { label: "Archive", icon: "archive", run: () => void archive(bot, t) },
      ], { x: e.clientX - 140, y: e.clientY + 8 }),
    }, icon("more", 14))));
  return h("div", { class: "conv-list", role: "list" },
    h("button", { class: "conv-row new", onclick: () => { newConversation(); focusComposer(); } },
      icon("plus", 15), h("span", null, `New conversation with ${bot.name}`)),
    rows.length ? rows : h("p", { class: "muted", style: { padding: "12px 16px" } }, "No conversations yet."));
}

async function archive(bot: BotStatus, t: ThreadView): Promise<void> {
  try {
    await api.post(`/api/threads/${encodeURIComponent(t.id)}/archive`);
    toast("Archived");
    await loadThreads(bot.id);
  } catch (err) { fail(err); }
}

// ------------------------------------------------------------------ chat

let chatRefs: { thread: HTMLElement; ctxChips: HTMLElement; input: HTMLTextAreaElement; live: HTMLElement; botId: string } | undefined;
let dropPage = false;
let dropSelection = false;

function chatView(bot: BotStatus): Node {
  const thread = h("div", { class: "thread", role: "log", "aria-live": "polite" });
  const live = h("div", { class: "live-line hidden" });
  const ctxChips = h("div", { class: "ctx-chips" });
  const input = h("textarea", { rows: 1, placeholder: `Ask ${bot.name}… @ to mention a bot`, "aria-label": `Message ${bot.name}` }) as HTMLTextAreaElement;
  const sendBtn = h("button", { class: "send-btn", "aria-label": "Send", disabled: true }, icon("send", 16)) as HTMLButtonElement;
  const mentions = h("div", { class: "menu mention-list hidden", role: "listbox" });
  const grow = (): void => { input.style.height = "auto"; input.style.height = `${Math.min(180, input.scrollHeight)}px`; };
  const send = async (): Promise<void> => {
    const text = input.value.trim();
    if (!text) return;
    const s = store.get();
    const context = {
      ...(s.page && !dropPage ? { path: s.page.path } : {}),
      ...(s.selection && !dropSelection ? { selection: s.selection.text } : {}),
    };
    input.value = "";
    grow();
    sendBtn.disabled = true;
    dropSelection = false;
    try { await sendMessage(bot.id, text, Object.keys(context).length ? context : undefined); } catch (err) { fail(err); input.value = text; grow(); }
  };
  input.addEventListener("input", () => {
    grow();
    sendBtn.disabled = !input.value.trim();
    const m = /@([\w -]{0,20})$/.exec(input.value.slice(0, input.selectionStart ?? input.value.length));
    if (m) showMentions(mentions, input, m[1]!);
    else mentions.classList.add("hidden");
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      if (!mentions.classList.contains("hidden")) {
        e.preventDefault();
        (mentions.querySelector("button") as HTMLButtonElement | null)?.click();
        return;
      }
      e.preventDefault();
      void send();
    }
    if (e.key === "Escape") mentions.classList.add("hidden");
  });
  sendBtn.addEventListener("click", () => void send());
  const composer = h("div", { class: "composer", style: { position: "relative" } }, mentions, ctxChips,
    h("div", { class: "composer-row" }, input, sendBtn));
  chatRefs = { thread, ctxChips, input, live, botId: bot.id };
  updateChat();
  return h("div", { class: "bot-body" }, thread, live, composer);
}

function showMentions(list: HTMLElement, input: HTMLTextAreaElement, prefix: string): void {
  const bots = store.get().bots.filter((b) => b.id !== store.get().botId && !b.archived && b.name.toLowerCase().startsWith(prefix.toLowerCase())).slice(0, 6);
  if (!bots.length) { list.classList.add("hidden"); return; }
  replace(list, bots.map((b) => h("button", {
    role: "option",
    onclick: () => {
      const pos = input.selectionStart ?? input.value.length;
      const before = input.value.slice(0, pos).replace(/@[\w -]{0,20}$/, `@${b.name} `);
      input.value = before + input.value.slice(pos);
      list.classList.add("hidden");
      input.focus();
    },
  }, avatar(b, 18), b.name, h("span", { class: "muted", style: { marginLeft: "auto", fontSize: "11.5px" } }, "also gets this"))));
  list.classList.remove("hidden");
}

/** Patch the open chat in place: the composer keeps its text while messages update. */
function updateChat(): void {
  const s = store.get();
  if (!chatRefs || chatRefs.botId !== s.botId || !chatRefs.thread.isConnected) return;
  const { thread, ctxChips, live, input } = chatRefs;
  const bot = botById(s.botId);
  if (!bot) return;
  const atBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 80;
  const conv = s.conversation && (s.conversation.thread.id === s.threadId || s.conversation.thread.id === "new") ? s.conversation : null;
  const items = conv?.messages ?? [];
  input.placeholder = s.threadId === "new" || !conv ? `Start a new conversation with ${bot.name}… @ to mention` : `Message ${bot.name}… @ to mention a bot`;
  const intro: Node[] = [];
  if (conv?.thread.from_thread) {
    const from = conv.thread.from_thread;
    intro.push(h("div", { class: "card peer" },
      h("div", { class: "card-head" }, icon("at", 14), h("span", null, "You mentioned this bot in another conversation")),
      h("button", { class: "action-chip", style: { marginTop: "6px" }, onclick: () => void openFrom(from) }, icon("comment", 12), "Open that conversation")));
  }
  replace(thread, items.length
    ? [...intro, ...items.map((m, idx) => renderMessage(m, bot, items[idx - 1]))]
    : h("div", { class: "thread-empty" }, avatar(bot, 40),
      h("p", null, s.threads.length ? `New conversation with ${bot.name}.` : `${bot.name} hasn't said anything yet.`),
      h("p", { class: "muted" }, bot.kind === "vault" ? "Ask about anything in the vault." : `It looks after ${bot.path}. Ask it to write or change a page, or mark a page and send notes.`)));
  if (conv?.thread.state === "failed" && conv.thread.error) {
    thread.append(h("div", { class: "request-flag" }, icon("alert", 12), `The run failed: ${conv.thread.error}`));
  }
  if (atBottom || items.some((i) => i.pending)) thread.scrollTop = thread.scrollHeight;
  const working = conv?.thread.state === "working";
  live.classList.toggle("hidden", !working);
  replace(live, h("span", { class: "dot working" }), "Working…");
  // Context chips: the open page and the current selection.
  const chips: Node[] = [];
  if (s.page && !dropPage) {
    chips.push(h("span", { class: "ctx-chip" }, icon("file", 12), h("span", null, s.page.path.split("/").pop()!),
      h("button", { "aria-label": "Remove page from context", onclick: () => { dropPage = true; updateChat(); } }, icon("x", 11))));
  } else if (s.page) {
    chips.push(h("button", { class: "chip", onclick: () => { dropPage = false; updateChat(); } }, "+ page"));
  }
  if (s.selection && !dropSelection) {
    chips.push(h("span", { class: "ctx-chip" }, icon("highlighter", 12), h("span", null, `"${s.selection.text.slice(0, 40)}${s.selection.text.length > 40 ? "…" : ""}"`),
      h("button", { "aria-label": "Remove selection from context", onclick: () => { dropSelection = true; updateChat(); } }, icon("x", 11))));
  }
  replace(ctxChips, chips);
  ctxChips.classList.toggle("hidden", chips.length === 0);
}

async function openFrom(threadId: string): Promise<void> {
  try {
    const c = await api.get<{ thread: ThreadView }>(`/api/threads/${encodeURIComponent(threadId)}`);
    openThread(c.thread.bot_id, threadId);
  } catch (err) { fail(err); }
}

function md(text: string, fromPath = ""): Node {
  const el = h("div", { class: "md" });
  el.append(renderBlocks(parseMarkdown(text).blocks, {
    resolveWiki: (t) => resolveWiki(t, fromPath),
    resolveVault: (href) => resolveRelative(href, fromPath),
    open: (path) => go({ view: "page", path }),
    rawUrl,
  }));
  return el;
}

function renderMessage(m: Message, bot: BotStatus, prev?: Message): Node {
  const time = h("div", { class: "meta", title: m.at }, m.pending ? "Sending…" : clock(m.at));
  if (m.role === "trigger") {
    return h("div", { class: "card" },
      h("div", { class: "card-head" }, icon("clock", 14), h("span", null, "Trigger")),
      h("div", { class: "card-body" }, m.text.slice(0, 400)), time);
  }
  if (m.role === "system") return h("div", { class: "sys-line" }, m.text);
  if (m.role === "owner") {
    if (m.notes) {
      const path = m.notes.path;
      return h("div", { class: "card" },
        h("div", { class: "card-head" }, icon("pen", 14), h("span", null, `${m.notes.count} note${m.notes.count === 1 ? "" : "s"} on ${path.split("/").pop()!.replace(/\.(md|markdown)$/i, "")}`)),
        h("button", { class: "action-chip", style: { marginTop: "6px" }, onclick: () => go({ view: "page", path }) }, icon("file", 12), "Open page"),
        time);
    }
    return h("div", { class: ["msg mine", m.pending && "pending"] }, h("div", null,
      h("div", { class: "bubble" }, m.text),
      m.context ? h("div", { class: "ctx", style: { justifyContent: "flex-end" }, title: m.context }, icon("file", 11), contextLabel(m.context)) : null,
      h("div", { class: "meta", style: { textAlign: "right" } }, m.pending ? "Sending…" : clock(m.at))));
  }
  const showAvatar = !prev || prev.role !== "bot";
  return h("div", { class: "msg" },
    showAvatar ? avatar(bot, 24) : h("span", { style: { width: "24px", flex: "none" } }),
    h("div", { class: "bot-text" },
      md(m.text, store.get().page?.path ?? ""),
      m.streaming ? h("div", { class: "meta" }, "Writing…") : time));
}

function contextLabel(context: string): string {
  const from = /sent to you from the (.+?) chat/.exec(context)?.[1];
  if (from) return `from ${from}`;
  const path = /looking at (.+?)\.(?:\s|$)/.exec(context)?.[1];
  return path ? path.split("/").pop()! : "context";
}

// ------------------------------------------------------------------ memory

export function memoryView(bot: BotStatus): Node {
  const host = h("div", null, h("p", { class: "muted" }, "Loading…"));
  const load = async (): Promise<void> => {
    try {
      const r = await api.get<{ path: string; text: string }>(`/api/bots/${bot.id}/memory`);
      const view = (): void => {
        replace(host,
          h("div", { class: "instructions-view" }, r.text.trim() ? md(r.text) : h("span", { class: "muted" },
            `${bot.name} has not written anything down yet. Say "remember …" in a conversation, or add it here.`)),
          h("div", { style: { display: "flex", gap: "8px", marginTop: "8px", alignItems: "center" } },
            h("button", { class: "btn small", onclick: edit }, icon("edit", 13), "Edit"),
            h("span", { class: "hint" }, `Kept in ${r.path || ".bot/MEMORY.md"}; the bot reads it at the start of every conversation.`)));
      };
      const edit = (): void => {
        const area = h("textarea", { rows: 10, "aria-label": "Memory" }) as HTMLTextAreaElement;
        area.value = r.text || "# Memory\n";
        replace(host, area, h("div", { style: { display: "flex", gap: "8px", justifyContent: "flex-end", marginTop: "6px" } },
          h("button", { class: "btn small", onclick: view }, "Cancel"),
          h("button", {
            class: "btn small primary", onclick: async () => {
              try {
                const saved = await api.put<{ path: string; text: string }>(`/api/bots/${bot.id}/memory`, { text: area.value });
                r.text = saved.text;
                toast("Memory saved");
                view();
              } catch (err) { fail(err); }
            },
          }, "Save")));
        area.focus();
      };
      view();
    } catch (err) { fail(err); }
  };
  void load();
  return h("div", { class: "tab-scroll" }, host);
}

// ------------------------------------------------------------------ triggers

const EVERY_LABEL: Record<string, string> = { minutes: "Every N minutes", hours: "Every N hours", day: "Every day at", weekday: "Every weekday at", week: "Every week on" };

function describe(t: Trigger): string {
  if (t.kind === "file_change") return `When a file changes in ${t.path || "this folder"}`;
  if (t.every === "minutes") return `Every ${t.n ?? 30} minutes`;
  if (t.every === "hours") return (t.n ?? 1) === 1 ? "Every hour" : `Every ${t.n} hours`;
  if (t.every === "week") return `Every ${({ mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday" } as Record<string, string>)[t.day ?? "mon"]} at ${t.at ?? "09:00"}`;
  return `${t.every === "weekday" ? "Every weekday" : "Every day"} at ${t.at ?? "09:00"}`;
}

export function triggersView(bot: BotStatus): Node {
  const host = h("div", { class: "tab-scroll" }, h("p", { class: "muted" }, "Loading…"));
  void (async () => {
    try {
      const d = await detail(bot.id);
      const triggers = d.def.triggers ?? [];
      const save = async (next: Trigger[]): Promise<void> => {
        try {
          const data = await api.patch<BotDetail>(`/api/bots/${bot.id}`, { triggers: next });
          detailCache = { id: bot.id, data };
          await loadState();
          replace(host, ...triggersBody(bot, data, save).childNodes);
        } catch (err) { fail(err); }
      };
      replace(host, ...triggersBody(bot, d, save).childNodes);
    } catch (err) { fail(err); }
  })();
  return host;
}

function triggersBody(bot: BotStatus, d: BotDetail, save: (t: Trigger[]) => Promise<void>): HTMLElement {
  const triggers = d.def.triggers ?? [];
  const form = h("div", { class: "hidden", style: { marginTop: "12px" } });
  const openForm = (): void => {
    const every = h("select", { "aria-label": "When" },
      Object.entries(EVERY_LABEL).map(([v, l]) => h("option", { value: v }, l)),
      h("option", { value: "file_change" }, "When files change in…")) as HTMLSelectElement;
    const at = h("input", { type: "time", value: "08:00", "aria-label": "Time" }) as HTMLInputElement;
    const n = h("input", { type: "number", min: "1", max: "1440", value: "2", "aria-label": "Interval" }) as HTMLInputElement;
    const day = h("select", { "aria-label": "Day" }, ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((x) => h("option", { value: x }, x))) as HTMLSelectElement;
    const path = h("input", { placeholder: "folder inside this bot's folder (empty = all)", "aria-label": "Folder" }) as HTMLInputElement;
    const prompt = h("textarea", { rows: 2, placeholder: "What should the bot do? e.g. Prepare today's brief in Brief.md" }) as HTMLTextAreaElement;
    const heartbeat = h("input", { type: "checkbox", "aria-label": "Heartbeat" }) as HTMLInputElement;
    const sync = (): void => {
      const v = every.value;
      at.parentElement!.classList.toggle("hidden", !["day", "weekday", "week"].includes(v));
      n.parentElement!.classList.toggle("hidden", !["minutes", "hours"].includes(v));
      day.parentElement!.classList.toggle("hidden", v !== "week");
      path.parentElement!.classList.toggle("hidden", v !== "file_change");
    };
    every.addEventListener("change", sync);
    replace(form,
      h("div", { class: "field" }, h("label", null, "When"), every),
      h("div", { class: "field-row" },
        h("div", { class: "field" }, h("label", null, "At"), at),
        h("div", { class: "field" }, h("label", null, "N"), n),
        h("div", { class: "field" }, h("label", null, "Day"), day)),
      h("div", { class: "field" }, h("label", null, "Folder"), path),
      h("div", { class: "field" }, h("label", null, "Do"), prompt),
      h("label", { class: "field", style: { flexDirection: "row", alignItems: "center", gap: "8px" } }, heartbeat, h("span", null, "Heartbeat (a short checklist, tell me only if something needs me)")),
      h("div", { style: { display: "flex", gap: "8px", justifyContent: "flex-end" } },
        h("button", { class: "btn", onclick: () => form.classList.add("hidden") }, "Cancel"),
        h("button", {
          class: "btn primary", onclick: () => {
            if (!prompt.value.trim()) { toast("Say what the bot should do", { error: true }); return; }
            const id = `t${Date.now().toString(36)}`;
            const t: Trigger = every.value === "file_change"
              ? { id, kind: "file_change", path: path.value.trim(), prompt: prompt.value.trim(), enabled: true }
              : {
                  id, kind: "schedule", every: every.value as never, prompt: prompt.value.trim(), enabled: true,
                  ...(["day", "weekday", "week"].includes(every.value) ? { at: at.value || "08:00" } : {}),
                  ...(["minutes", "hours"].includes(every.value) ? { n: Number(n.value) || 1 } : {}),
                  ...(every.value === "week" ? { day: day.value } : {}),
                  ...(heartbeat.checked ? { heartbeat: true } : {}),
                };
            void save([...triggers, t]);
          },
        }, "Add trigger")));
    sync();
    form.classList.remove("hidden");
    prompt.focus();
  };
  return h("div", null,
    h("p", { class: "tab-intro" }, "When this bot gets to work without you. Each trigger keeps one conversation, so its runs are in one place. Triggers start switched off."),
    triggers.length ? triggers.map((t, idx) => h("div", { class: "trigger-row" },
      icon(t.kind === "file_change" ? "folder" : "clock", 18),
      h("div", { class: "what" },
        h("div", { class: "when" }, describe(t)),
        h("div", { class: "do" }, `${t.kind === "schedule" && t.heartbeat ? "Heartbeat: " : ""}${t.prompt}`),
        t.enabled && bot.next_run && t.kind === "schedule" ? h("div", { class: "next" }, `Next run ${clock(bot.next_run.at)}`) : null),
      h("button", {
        class: ["switch", t.enabled && "on"], role: "switch", "aria-checked": t.enabled ? "true" : "false",
        "aria-label": `Turn ${t.enabled ? "off" : "on"}: ${describe(t)}`,
        onclick: () => void save(triggers.map((x, j) => (j === idx ? { ...x, enabled: !x.enabled } : x))),
      }),
      h("button", { class: "icon-btn", "aria-label": "Delete trigger", onclick: () => void save(triggers.filter((_, j) => j !== idx)) }, icon("trash", 14))))
      : h("p", { class: "muted" }, "No triggers yet."),
    h("button", { class: "btn", style: { marginTop: "12px" }, onclick: openForm }, icon("plus", 14), "Add trigger"),
    form,
    h("div", { class: "perm-line" }, icon("clock", 13), `Times use ${store.get().vault?.tz ?? "your"} time.`));
}

// ------------------------------------------------------------------ setup

export function setupView(bot: BotStatus): Node {
  const host = h("div", { class: "tab-scroll" }, h("p", { class: "muted" }, "Loading…"));
  void (async () => {
    try {
      const [d, models] = await Promise.all([
        detail(bot.id),
        api.get<{ models: ModelChoice[] }>("/api/models").catch(() => ({ models: [] as ModelChoice[] })),
      ]);
      replace(host, ...setupBody(bot, d, models.models).childNodes);
    } catch (err) { fail(err); }
  })();
  return host;
}

const PROVIDER_LABEL: Record<string, string> = { claude: "Claude (Claude Code)", codex: "Codex (ChatGPT)" };

function setupBody(bot: BotStatus, d: BotDetail, models: ModelChoice[]): HTMLElement {
  const def = d.def;
  const patch = async (p: Record<string, unknown>, msg = "Saved"): Promise<void> => {
    try {
      const data = await api.patch<BotDetail>(`/api/bots/${bot.id}`, p);
      detailCache = { id: bot.id, data };
      await loadState();
      toast(msg);
    } catch (err) { fail(err); }
  };
  const name = h("input", { value: def.name, "aria-label": "Name" }) as HTMLInputElement;
  name.addEventListener("change", () => void patch({ name: name.value.trim() || def.name }));
  let editing = false;
  const instr = h("div", null);
  const renderInstr = (): void => {
    if (editing) {
      const area = h("textarea", { rows: 8, "aria-label": "Instructions" }) as HTMLTextAreaElement;
      area.value = def.instructions ?? "";
      replace(instr, area, h("div", { style: { display: "flex", gap: "8px", justifyContent: "flex-end", marginTop: "6px" } },
        h("button", { class: "btn small", onclick: () => { editing = false; renderInstr(); } }, "Cancel"),
        h("button", { class: "btn small primary", onclick: async () => { def.instructions = area.value; editing = false; renderInstr(); await patch({ instructions: area.value }, "Instructions saved"); } }, "Save")));
      area.focus();
    } else {
      replace(instr, h("div", { class: "instructions-view" }, def.instructions?.trim() ? md(def.instructions) : h("span", { class: "muted" }, "No instructions yet. The bot follows its folder's purpose.")),
        h("button", { class: "btn small", style: { marginTop: "6px" }, onclick: () => { editing = true; renderInstr(); } }, icon("edit", 13), "Edit"));
    }
  };
  renderInstr();

  // Model: the providers and models the bots' T3 reports, with each model's effort levels.
  const vaultDefault = store.get().defaultModel;
  const provider = h("select", { "aria-label": "Provider" },
    h("option", { value: "" }, `Vault default (${PROVIDER_LABEL[vaultDefault?.provider ?? "claude"] ?? vaultDefault?.provider ?? "Claude"})`),
    ["claude", "codex"].map((v) => h("option", { value: v }, PROVIDER_LABEL[v]))) as HTMLSelectElement;
  provider.value = def.model?.provider ?? "";
  const model = h("select", { "aria-label": "Model" }) as HTMLSelectElement;
  const thinking = h("select", { "aria-label": "Effort" }) as HTMLSelectElement;
  const fill = (): void => {
    const p = provider.value || vaultDefault?.provider || "claude";
    const list = models.filter((m) => m.provider === p);
    replace(model, h("option", { value: "" }, "Default model"), list.map((m) => h("option", { value: m.model }, m.label)));
    model.value = def.model?.provider === provider.value && list.some((m) => m.model === def.model?.model) ? def.model!.model! : "";
    const chosen = list.find((m) => m.model === model.value) ?? list.find((m) => m.isDefault) ?? list[0];
    const efforts = chosen?.efforts.length ? chosen.efforts : ["low", "medium", "high", "xhigh", "max"].map((id) => ({ id, label: id }));
    replace(thinking, h("option", { value: "" }, "Default effort"), efforts.map((e) => h("option", { value: e.id }, e.label)));
    thinking.value = efforts.some((e) => e.id === def.model?.thinking) ? def.model!.thinking! : "";
  };
  fill();
  const saveModel = (): void => {
    const m: Record<string, string> = {};
    if (provider.value) m.provider = provider.value;
    if (provider.value && model.value) m.model = model.value;
    if (thinking.value) m.thinking = thinking.value;
    def.model = Object.keys(m).length ? m : undefined;
    void patch({ model: Object.keys(m).length ? m : null }, "Model saved");
  };
  provider.addEventListener("change", () => { def.model = provider.value ? { provider: provider.value } : undefined; fill(); saveModel(); });
  for (const el of [model, thinking]) el.addEventListener("change", saveModel);

  const scope = h("select", { "aria-label": "Can write" },
    h("option", { value: "folder" }, bot.kind === "vault" ? "What no other agent looks after" : bot.kind === "page" ? "This page" : "This folder"),
    h("option", { value: "vault" }, "Whole vault")) as HTMLSelectElement;
  scope.value = def.write_scope === "vault" ? "vault" : "folder";
  scope.addEventListener("change", () => void patch({ write_scope: scope.value }));
  return h("div", null,
    def.needs_review ? h("div", { class: "card", style: { marginBottom: "14px" } },
      h("div", { class: "card-head" }, icon("alert", 14), "This bot's definition changed outside Peers, or arrived with automation"),
      h("div", { class: "card-body" }, "Check its triggers and write scope, then confirm to switch them on."),
      h("button", { class: "btn small primary", style: { marginTop: "8px" }, onclick: () => void patch({ needs_review: false }, "Confirmed") }, "Confirm")) : null,
    h("div", { class: "field" }, h("label", null, "Name"), name,
      h("span", { class: "hint" }, "Write @ and this name in any chat to send that message to this bot too.")),
    h("div", { class: "field" }, h("span", { class: "label" }, "Colour"),
      h("div", { class: "colors" }, Object.keys(COLOR_VAR).map((c) => h("button", {
        class: (def.color ?? "teal") === c ? "on" : undefined, style: { "--bot-color": COLOR_VAR[c] }, "aria-label": c,
        onclick: () => void patch({ color: c }),
      })))),
    h("div", { class: "field" }, h("span", { class: "label" }, "Instructions"), instr,
      h("span", { class: "hint" }, "Given to the bot at the start of every conversation.")),
    h("div", { class: "field" }, h("label", null, "Model"), provider,
      h("div", { class: "field-row" }, model, thinking),
      h("span", { class: "hint" }, "Runs on the bots' own Claude Code or Codex sign-in, through Peers' built-in T3. New conversations use the new choice.")),
    h("div", { class: "field" }, h("label", null, "Can write"), scope,
      h("span", { class: "hint" }, "The bot is told to stay inside these folders. Changes it makes elsewhere are flagged on Today.")),
    h("div", { class: "field" },
      h("button", { class: "btn", onclick: () => void patch({ paused: !def.paused }, def.paused ? "Resumed" : "Paused") },
        icon(def.paused ? "play" : "pause", 14), def.paused ? "Resume triggers" : "Pause triggers")),
    h("div", { class: "perm-line" }, icon("eye", 13), `Can read: whole vault · Can write: ${scope.selectedOptions[0]?.textContent ?? ""}`),
    h("div", { class: "perm-line" }, icon(bot.kind === "page" ? "file" : "folder", 13),
      bot.kind === "vault" ? "Looks after: everything no other agent looks after" : `Looks after: ${bot.path}${bot.kind === "folder" ? "/" : ""}`),
    bot.front ? h("div", { class: "perm-line" }, icon("file", 13), "Front page: ",
      h("a", { href: "#", onclick: (e: Event) => { e.preventDefault(); go({ view: "page", path: bot.front! }); } }, bot.front)) : null,
    h("button", {
      class: "btn small", style: { marginTop: "6px" },
      onclick: (e: MouseEvent) => openMenu([
        { label: "Copy bot id", icon: "link", run: () => { void navigator.clipboard?.writeText(bot.id); toast("Copied"); } },
      ], { x: e.clientX, y: e.clientY }),
    }, icon("more", 13), "More"));
}

/** Forget cached bot details, so a settings page reload shows fresh values. */
export function clearBotDetail(): void {
  detailCache = undefined;
}
