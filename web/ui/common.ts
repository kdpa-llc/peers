/** Small shared pieces: avatars, status dots, menus, dialogs, toasts. */
import { h, onOutside, type Child } from "../lib/dom.ts";
import { icon } from "../lib/icons.ts";
import { COLOR_VAR } from "../state.ts";
import type { BotStatus } from "../types.ts";

export function avatar(bot: Pick<BotStatus, "name" | "color" | "kind"> | undefined, size = 24): HTMLElement {
  const initial = (bot?.name || "?").trim().charAt(0).toUpperCase() || "?";
  return h("span", {
    class: ["avatar", bot?.kind ?? "project"],
    style: { width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.44)}px`, "--bot-color": COLOR_VAR[bot?.color ?? "teal"] },
    "aria-hidden": "true",
  }, initial);
}

/** One status mark for a bot: working, needs you, failed, paused, or nothing. */
export function statusDot(bot: BotStatus | undefined): HTMLElement | null {
  if (!bot) return null;
  if (bot.state === "working") return h("span", { class: "dot working", title: "Working", role: "img", "aria-label": "working" });
  if (bot.state === "waiting" || bot.needs_review) return h("span", { class: "dot attention", title: "Needs you", role: "img", "aria-label": "needs you" });
  if (bot.last_error) return h("span", { class: "dot error", title: `Last run failed: ${bot.last_error}`, role: "img", "aria-label": "last run failed" });
  if (bot.paused || bot.archived || bot.state === "paused") return h("span", { class: "dot paused", title: "Paused", role: "img", "aria-label": "paused" });
  if (bot.unread > 0) return h("span", { class: "dot changed", title: `${bot.unread} unread`, role: "img", "aria-label": "unread messages" });
  return null;
}

/** What an agent looks after, in a few words: its folder or page, or the whole vault. */
export function whereText(bot: Pick<BotStatus, "kind" | "path">): string {
  return bot.kind === "vault" || !bot.path ? "The whole vault" : bot.path;
}

/** An agent's state in a few words: Idle, Working…, Paused, Last run failed. */
export function stateText(bot: BotStatus, activity?: string): string {
  if (bot.needs_review) return "New definition: review it in its settings";
  if (bot.archived) return "Archived";
  if (bot.paused || bot.state === "paused") return "Paused";
  if (bot.state === "working") return `Working${activity ? ` · ${activity}` : "…"}`;
  if (bot.state === "waiting") return "Waiting for an approval in T3";
  if (bot.last_error) return "Last run failed";
  return `Idle${bot.next_run ? ` · next run ${new Date(bot.next_run.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}` : ""}`;
}

/** How it is doing, then where it works, for one status line (the state survives truncation). */
export function statusText(bot: BotStatus, activity?: string): string {
  if (bot.state === "working") return stateText(bot, activity);
  return `${stateText(bot, activity)} · ${whereText(bot)}`;
}

/** A small pill for what is worth noticing about an agent; nothing when it is simply idle. */
export function statePill(bot: BotStatus): HTMLElement | null {
  if (bot.state === "working") return h("span", { class: "state-pill working" }, h("span", { class: "dot working" }), "Working");
  if (bot.needs_review || bot.state === "waiting") return h("span", { class: "state-pill attention" }, "Needs you");
  if (bot.last_error) return h("span", { class: "state-pill error", title: bot.last_error }, "Failed");
  if (bot.unread > 0) return h("span", { class: "state-pill unread" }, `${bot.unread} new`);
  if (bot.paused || bot.state === "paused") return h("span", { class: "state-pill" }, "Paused");
  return null;
}

export type MenuItem = { label: string; icon?: string; danger?: boolean; run: () => void } | "divider";

let closeMenu: (() => void) | undefined;

export function openMenu(items: MenuItem[], at: { x: number; y: number }): void {
  closeMenu?.();
  const el = h("div", { class: "menu", role: "menu" });
  for (const item of items) {
    if (item === "divider") { el.appendChild(h("hr")); continue; }
    el.appendChild(h("button", {
      role: "menuitem", class: item.danger ? "danger" : undefined,
      onclick: () => { close(); item.run(); },
    }, item.icon ? icon(item.icon, 15) : null, item.label));
  }
  document.body.appendChild(el);
  const rect = el.getBoundingClientRect();
  el.style.left = `${Math.max(8, Math.min(at.x, innerWidth - rect.width - 8))}px`;
  el.style.top = `${Math.max(8, Math.min(at.y, innerHeight - rect.height - 8))}px`;
  const stop = onOutside(el, () => close());
  const onKey = (e: KeyboardEvent): void => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  function close(): void {
    stop();
    document.removeEventListener("keydown", onKey);
    el.remove();
    closeMenu = undefined;
  }
  closeMenu = close;
  (el.querySelector("button") as HTMLButtonElement | null)?.focus();
}

export function openModal(build: (close: () => void) => Child, opts: { label: string }): () => void {
  const scrim = h("div", { class: "scrim" });
  const box = h("div", { class: "modal", role: "dialog", "aria-modal": "true", "aria-label": opts.label });
  const previous = document.activeElement as HTMLElement | null;
  const close = (): void => {
    scrim.remove();
    box.remove();
    document.removeEventListener("keydown", onKey);
    previous?.focus?.();
  };
  const onKey = (e: KeyboardEvent): void => { if (e.key === "Escape") close(); };
  scrim.addEventListener("click", close);
  document.addEventListener("keydown", onKey);
  const content = build(close);
  if (content instanceof Node) box.appendChild(content);
  document.body.append(scrim, box);
  (box.querySelector("input, textarea, button.primary, button") as HTMLElement | null)?.focus();
  return close;
}

export function confirmDialog(title: string, text: string, confirm: string, danger = false): Promise<boolean> {
  return new Promise((resolve) => {
    openModal((close) => h("div", null,
      h("h3", null, title),
      h("p", null, text),
      h("div", { class: "actions" },
        h("button", { class: "btn", onclick: () => { close(); resolve(false); } }, "Cancel"),
        h("button", { class: ["btn", danger ? "danger" : "primary"], onclick: () => { close(); resolve(true); } }, confirm)),
    ), { label: title });
  });
}

export function promptDialog(title: string, text: string, fields: { name: string; label: string; placeholder?: string; multiline?: boolean }[], confirm: string): Promise<Record<string, string> | undefined> {
  return new Promise((resolve) => {
    openModal((close) => {
      const inputs = new Map<string, HTMLInputElement | HTMLTextAreaElement>();
      const submit = (): void => {
        const out: Record<string, string> = {};
        for (const [k, el] of inputs) out[k] = el.value;
        close();
        resolve(out);
      };
      return h("form", { onsubmit: (e: Event) => { e.preventDefault(); submit(); } },
        h("h3", null, title),
        h("p", null, text),
        fields.map((f) => {
          const input = f.multiline
            ? h("textarea", { rows: 3, placeholder: f.placeholder ?? "", "aria-label": f.label })
            : h("input", { placeholder: f.placeholder ?? "", "aria-label": f.label });
          inputs.set(f.name, input);
          return h("div", { class: "field" }, h("label", null, f.label), input);
        }),
        h("div", { class: "actions" },
          h("button", { class: "btn", type: "button", onclick: () => { close(); resolve(undefined); } }, "Cancel"),
          h("button", { class: "btn primary", type: "submit" }, confirm)));
    }, { label: title });
  });
}

let toastHost: HTMLElement | undefined;

/**
 * A short confirmation at the bottom (MOTION.md: toast). It rises in with @starting-style,
 * sinks out with a transition, and leaves the DOM when that transition ends. At most three
 * show at once; the oldest goes first.
 */
export function showToast(text: string, opts: { error?: boolean; action?: { label: string; run: () => void } } = {}): void {
  toastHost ??= document.body.appendChild(h("div", { class: "toasts", role: "status", "aria-live": "polite" }));
  const el = h("div", { class: ["toast", opts.error && "error"] },
    h("span", { class: "toast-icon", "aria-hidden": "true" }, icon(opts.error ? "alert" : "check", 14)),
    h("span", null, text),
    opts.action ? h("button", { onclick: () => { dismissToast(el); opts.action!.run(); } }, opts.action.label) : null);
  toastHost.appendChild(el);
  const live = [...toastHost.querySelectorAll<HTMLElement>(".toast:not(.out)")];
  // One at a time: the previous one leaves above the new one, which does not move.
  while (live.length > 1) dismissToast(live.shift()!);
  setTimeout(() => dismissToast(el), opts.action ? 7000 : opts.error ? 6000 : 3500);
}

function dismissToast(el: HTMLElement): void {
  if (!el.isConnected || el.classList.contains("out")) return;
  el.classList.add("out");
  // Only the end of this exit removes it: an entrance that just finished can still report its end.
  const done = (e: TransitionEvent): void => {
    if (e.target !== el || e.propertyName !== "opacity" || Number(getComputedStyle(el).opacity) > 0.01) return;
    el.removeEventListener("transitionend", done);
    el.remove();
  };
  el.addEventListener("transitionend", done);
}
