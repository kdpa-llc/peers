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

export function statusText(bot: BotStatus, activity?: string): string {
  const kind = bot.kind === "vault" ? "Vault agent" : bot.kind === "page" ? "Page agent" : "Folder agent";
  if (bot.needs_review) return `${kind} · New definition, review in its settings`;
  if (bot.archived) return `${kind} · Archived`;
  if (bot.paused || bot.state === "paused") return `${kind} · Paused`;
  if (bot.state === "working") return `Working${activity ? ` · ${activity}` : "…"}`;
  if (bot.state === "waiting") return `${kind} · Waiting for approval in T3`;
  if (bot.last_error) return `${kind} · Last run failed`;
  return `${kind} · Idle${bot.next_run ? ` · next run ${new Date(bot.next_run.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}` : ""}`;
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

export function showToast(text: string, opts: { error?: boolean; action?: { label: string; run: () => void } } = {}): void {
  toastHost ??= document.body.appendChild(h("div", { class: "toasts", role: "status", "aria-live": "polite" }));
  const el = h("div", { class: ["toast", opts.error && "error"] }, h("span", null, text),
    opts.action ? h("button", { onclick: () => { el.remove(); opts.action!.run(); } }, opts.action.label) : null);
  toastHost.appendChild(el);
  setTimeout(() => el.remove(), opts.action ? 7000 : 4000);
}
