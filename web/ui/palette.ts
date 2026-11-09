/** ⌘K: pages, bots, commands and full-text search in one list (PRODUCT.md §8). */
import { h, replace } from "../lib/dom.ts";
import { icon } from "../lib/icons.ts";
import { api } from "../lib/api.ts";
import { allFiles, botById, fail, go, selectBot, setTheme, store, toast } from "../state.ts";
import { avatar } from "./common.ts";

type Item = { group: string; label: string; sub?: string; icon?: Node; run: () => void };

let open = false;

export function openPalette(initial = ""): void {
  if (open) return;
  open = true;
  const scrim = h("div", { class: "scrim" });
  const input = h("input", { placeholder: "Search pages, agents and commands…", "aria-label": "Search", value: initial }) as HTMLInputElement;
  const results = h("div", { class: "results", role: "listbox" });
  const box = h("div", { class: "palette", role: "dialog", "aria-label": "Search" }, input, results);
  let items: Item[] = [];
  let active = 0;
  let textResults: Item[] = [];
  let searchTimer: number | undefined;
  const close = (): void => { open = false; scrim.remove(); box.remove(); };
  scrim.addEventListener("click", close);

  const commands = (): Item[] => [
    { group: "Commands", label: "Today", icon: icon("today", 16), run: () => go({ view: "today" }) },
    // One "New folder in …" per section the tree shows (Projects, Areas, or whatever the vault has).
    ...[...document.querySelectorAll<HTMLButtonElement>('.section-head button[aria-label^="New folder"]')].map((b) => ({
      group: "Commands", label: b.getAttribute("aria-label")!, icon: icon("plus", 16), run: () => b.click(),
    })),
    { group: "Commands", label: "Theme: Day", icon: icon("sun", 16), run: () => setTheme("day") },
    { group: "Commands", label: "Theme: Night", icon: icon("moon", 16), run: () => setTheme("night") },
    { group: "Commands", label: "Theme: System", icon: icon("contrast", 16), run: () => setTheme("system") },
    { group: "Commands", label: "Settings", icon: icon("settings", 16), run: () => go({ view: "settings" }) },
  ];

  const score = (text: string, query: string): number => {
    const t = text.toLowerCase();
    const qq = query.toLowerCase();
    if (!qq) return 1;
    if (t.includes(qq)) return 100 - t.indexOf(qq) - t.length / 100;
    let i = 0;
    for (const ch of t) if (ch === qq[i]) i++;
    return i === qq.length ? 10 - t.length / 100 : 0;
  };

  const build = (): void => {
    const query = input.value.trim();
    const pages = allFiles()
      .map((f) => ({ f, sc: score(f.path, query) }))
      .filter((x) => x.sc > 0)
      .sort((a, b) => b.sc - a.sc)
      .slice(0, query ? 8 : 6)
      .map(({ f }) => ({
        group: "Pages", label: f.name.replace(/\.(md|markdown)$/i, ""), sub: f.path,
        icon: icon(f.kind === "pdf" ? "pdf" : f.kind === "image" ? "image" : "file", 16),
        run: () => go({ view: "page", path: f.path }),
      }));
    const bots = store.get().bots
      .filter((b) => score(b.name, query) > 0)
      .slice(0, 5)
      .map((b) => ({
        group: "Agents", label: b.name, sub: b.path || "whole vault", icon: avatar(b, 18),
        run: () => { selectBot(b.id, { pin: true }); store.set({ tab: "bot", botCollapsed: false }); },
      }));
    const botSettings = query.length > 1 ? store.get().bots
      .filter((b) => score(`${b.name} settings`, query) > 0 && /set|mem|trig|conf/i.test(query))
      .slice(0, 3)
      .map((b) => ({ group: "Agents", label: `${b.name} settings`, sub: "instructions, memory, triggers", icon: icon("settings", 16), run: () => go({ view: "bot", id: b.id }) }))
      : [];
    const cmds = commands().filter((c) => score(c.label, query) > 0).slice(0, query ? 5 : 3);
    const search: Item[] = query.length > 1
      ? [{ group: "Search", label: `Search text for "${query}"`, icon: icon("search", 16), run: () => runSearch(query) }]
      : [];
    items = [...pages, ...bots, ...botSettings, ...cmds, ...textResults, ...search];
    active = Math.min(active, Math.max(0, items.length - 1));
    render();
    clearTimeout(searchTimer);
    if (query.length > 2) searchTimer = window.setTimeout(() => runSearch(query, true), 220);
  };

  const runSearch = async (query: string, quiet = false): Promise<void> => {
    try {
      const r = await api.get<{ results: any[] }>(`/api/search?q=${encodeURIComponent(query)}`);
      if (input.value.trim() !== query) return;
      textResults = r.results.filter((x) => x.match === "text").slice(0, 8).map((x) => ({
        group: "In pages", label: x.excerpt ?? x.path, sub: `${x.path}:${x.line}`, icon: icon("search", 16),
        run: () => go({ view: "page", path: x.path }),
      }));
      const keep = active;
      build();
      active = keep;
      if (!quiet && !textResults.length) toast("No matches in page text");
    } catch (err) { fail(err); }
  };

  const render = (): void => {
    let lastGroup = "";
    const nodes: Node[] = [];
    items.forEach((it, i) => {
      if (it.group !== lastGroup) { nodes.push(h("div", { class: "group" }, it.group)); lastGroup = it.group; }
      nodes.push(h("button", {
        class: ["item", i === active && "active"], role: "option", "aria-selected": i === active ? "true" : "false",
        onclick: () => { close(); it.run(); },
        onmousemove: () => { if (active !== i) { active = i; render(); } },
      }, it.icon ?? null, h("span", null, it.label), it.sub ? h("span", { class: "sub" }, it.sub) : null));
    });
    replace(results, nodes.length ? nodes : h("div", { class: "group" }, "Nothing found"));
    (results.querySelector(".item.active") as HTMLElement | null)?.scrollIntoView({ block: "nearest" });
  };

  input.addEventListener("input", () => { textResults = []; active = 0; build(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); active = Math.min(items.length - 1, active + 1); render(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); active = Math.max(0, active - 1); render(); }
    else if (e.key === "Enter") { e.preventDefault(); const it = items[active]; if (it) { close(); it.run(); } }
    else if (e.key === "Escape") { e.preventDefault(); close(); }
  });
  document.body.append(scrim, box);
  build();
  input.focus();
  void botById;
}
