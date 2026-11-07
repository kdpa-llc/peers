/** Pairing screen: a device without a session types a one-time code (TECHNICAL.md §13). */
import { h } from "../lib/dom.ts";
import { icon } from "../lib/icons.ts";

export function showPairing(onPaired: () => void): void {
  if (document.querySelector(".pair-screen")) return;
  const input = h("input", {
    class: "code", maxlength: 6, autocomplete: "one-time-code", autocapitalize: "characters", spellcheck: "false",
    inputmode: "text", "aria-label": "Pairing code", placeholder: "······",
  }) as HTMLInputElement;
  const error = h("div", { class: "error", role: "alert" });
  const button = h("button", { class: "btn primary", type: "submit" }, "Pair this device") as HTMLButtonElement;
  const form = h("form", {
    onsubmit: async (e: Event) => {
      e.preventDefault();
      button.disabled = true;
      error.textContent = "";
      try {
        const name = /iPhone/.test(navigator.userAgent) ? "iPhone" : /iPad/.test(navigator.userAgent) ? "iPad"
          : /Android/.test(navigator.userAgent) ? "Android" : /Mac/.test(navigator.userAgent) ? "Mac browser" : "Browser";
        const res = await fetch("/api/pair", {
          method: "POST", credentials: "same-origin",
          headers: { "Content-Type": "application/json", "X-Peers": "1" },
          body: JSON.stringify({ code: input.value, name }),
        });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "pairing failed");
        screen.remove();
        onPaired();
      } catch (err) {
        error.textContent = err instanceof Error ? err.message : String(err);
        button.disabled = false;
        input.select();
      }
    },
  }, input, button, error);
  const screen = h("div", { class: "pair-screen" }, h("div", { class: "pair-card" },
    h("div", { class: "brand-mark" }, icon("layers", 24)),
    h("h1", null, "Pair this device"),
    h("p", null, "On the computer running Peers, run `peers pair` (or open Settings on a paired device) and type the 6-character code."),
    form));
  document.body.append(screen);
  input.focus();
}
