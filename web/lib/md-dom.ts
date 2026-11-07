/**
 * Markdown node tree → DOM. Text goes in through text nodes and attributes only; there is no
 * HTML parsing anywhere on this path (CONTRACT_TESTS #3). Every block element carries
 * `data-line="start-end"` so marks map back to source lines.
 */
import type { MdBlock, MdInline } from "../../src/vault/markdown.ts";
import { h } from "./dom.ts";
import { icon } from "./icons.ts";

export type RenderHooks = {
  /** Resolve a wikilink target to a vault path, or undefined when it does not exist. */
  resolveWiki(target: string): string | undefined;
  /** Resolve a relative vault link or image path against the page's folder. */
  resolveVault(href: string): string;
  /** Open a vault path (and optional heading). */
  open(path: string, heading?: string): void;
  /** URL that serves raw bytes of a vault file. */
  rawUrl(path: string): string;
};

const lineAttr = (line: [number, number]): string => `${line[0]}-${line[1]}`;

export function renderBlocks(blocks: MdBlock[], hooks: RenderHooks): DocumentFragment {
  const f = document.createDocumentFragment();
  for (const b of blocks) f.appendChild(renderBlock(b, hooks));
  return f;
}

function renderBlock(b: MdBlock, hooks: RenderHooks): HTMLElement {
  const data = { line: lineAttr(b.line) };
  switch (b.t) {
    case "heading": {
      const tag = (`h${Math.min(6, Math.max(1, b.level))}`) as "h1";
      // Org headings carry a task state, a priority and tags.
      return h(tag, { class: ["md-block", b.todo && "task-heading", b.done && "task-done"], id: `h-${b.id}`, dataset: data },
        b.todo ? h("span", { class: ["todo-kw", `todo-${b.todo.toLowerCase()}`, b.done && "done"] }, b.todo) : null,
        b.priority ? h("span", { class: "todo-pri" }, `#${b.priority}`) : null,
        inline(b.c, hooks),
        b.tags?.length ? h("span", { class: "heading-tags" }, b.tags.map((t) => h("span", { class: "tag" }, t))) : null);
    }
    case "drawer":
      return h("details", { class: "md-block org-drawer", dataset: data },
        h("summary", null, `${b.name === "PROPERTIES" ? "Properties" : b.name.charAt(0) + b.name.slice(1).toLowerCase()} · ${b.props.length}`),
        h("div", { class: "props" }, b.props.map(([k, v]) => h("span", { class: "prop" },
          k ? h("span", { class: "prop-k" }, k.toLowerCase()) : null, h("span", { class: "prop-v" }, v)))));
    case "planning":
      return h("div", { class: "md-block planning", dataset: data }, b.items.map((p) => h("span", { class: ["plan", `plan-${p.kind.toLowerCase()}`] },
        h("span", { class: "plan-k" }, p.kind === "SCHEDULED" ? "Scheduled" : p.kind === "DEADLINE" ? "Deadline" : "Closed"),
        h("span", { class: "plan-v" }, p.date))));
    case "para":
      return h("p", { class: "md-block", dataset: data }, inline(b.c, hooks));
    case "code":
      return h("div", { class: "md-block md-code", dataset: data },
        b.lang ? h("div", { class: "md-code-lang" }, b.lang) : null,
        h("pre", null, h("code", null, b.v)));
    case "quote":
      return h("blockquote", { class: "md-block", dataset: data }, renderBlocks(b.c, hooks));
    case "callout":
      return h("div", { class: ["md-block", "callout", `callout-${calloutTone(b.kind)}`], dataset: { ...data, kind: b.kind } },
        h("div", { class: "callout-title" }, icon(calloutIcon(b.kind), 15), h("span", null, inline(b.title, hooks))),
        b.c.length ? h("div", { class: "callout-body" }, renderBlocks(b.c, hooks)) : null);
    case "list": {
      const tag = b.ordered ? "ol" : "ul";
      const el = h(tag, {
        class: ["md-block", b.items.some((i) => i.task !== null) && "task-list"],
        dataset: data,
        ...(b.ordered && b.start !== 1 ? { start: b.start } : {}),
      });
      for (const item of b.items) {
        const li = h("li", { class: ["md-block", item.task !== null && "task"], dataset: { line: lineAttr(item.line) } });
        if (item.task !== null) {
          li.appendChild(h("span", {
            class: ["task-box", item.task && "done"], role: "img",
            "aria-label": item.task ? "done" : "not done",
          }, item.task ? icon("check", 12) : null));
        }
        const body = h("div", { class: "li-body" });
        // A single paragraph item renders inline, like a tight list.
        if (item.c.length === 1 && item.c[0]!.t === "para") {
          body.appendChild(h("span", { class: "md-block", dataset: { line: lineAttr(item.c[0]!.line) } }, inline(item.c[0]!.c, hooks)));
        } else {
          body.appendChild(renderBlocks(item.c, hooks));
        }
        li.appendChild(body);
        el.appendChild(li);
      }
      return el;
    }
    case "table":
      return h("div", { class: "md-block md-table", dataset: data },
        h("table", null,
          h("thead", null, h("tr", null, b.head.map((cell, i) =>
            h("th", { style: { textAlign: b.align[i] ?? undefined } }, inline(cell, hooks))))),
          h("tbody", null, b.rows.map((row) => h("tr", null, row.map((cell, i) =>
            h("td", { style: { textAlign: b.align[i] ?? undefined } }, inline(cell, hooks))))))));
    case "hr":
      return h("hr", { class: "md-block", dataset: data });
    case "frontmatter":
      return h("div", { class: "md-block props", dataset: data },
        b.props.map(([k, v]) => h("span", { class: "prop" }, h("span", { class: "prop-k" }, k), h("span", { class: "prop-v" }, v))));
  }
}

function calloutTone(kind: string): string {
  if (["warning", "caution", "attention"].includes(kind)) return "warn";
  if (["danger", "error", "bug", "failure", "fail"].includes(kind)) return "danger";
  if (["tip", "hint", "important", "success", "check", "done"].includes(kind)) return "good";
  return "info";
}

function calloutIcon(kind: string): string {
  const tone = calloutTone(kind);
  return tone === "warn" || tone === "danger" ? "alert" : tone === "good" ? "sparkle" : "comment";
}

function inline(nodes: MdInline[], hooks: RenderHooks): Node[] {
  return nodes.map((n) => inlineNode(n, hooks));
}

function inlineNode(n: MdInline, hooks: RenderHooks): Node {
  switch (n.t) {
    case "text": return document.createTextNode(n.v);
    case "br": return h("br");
    case "code": return h("code", null, n.v);
    case "em": return h("em", null, inline(n.c, hooks));
    case "strong": return h("strong", null, inline(n.c, hooks));
    case "del": return h("del", null, inline(n.c, hooks));
    case "mark": return h("mark", null, inline(n.c, hooks));
    case "tag": return h("span", { class: "tag" }, `#${n.v}`);
    case "link": {
      if (n.kind === "url") {
        return h("a", { href: n.href, target: "_blank", rel: "noopener noreferrer nofollow", class: "ext" }, inline(n.c, hooks));
      }
      if (n.kind === "anchor") {
        const id = n.href.slice(1);
        return h("a", {
          href: "#", class: "int",
          onclick: (e: Event) => { e.preventDefault(); document.getElementById(`h-${id}`)?.scrollIntoView({ behavior: "smooth" }); },
        }, inline(n.c, hooks));
      }
      const target = hooks.resolveVault(decodeSafe(n.href));
      return h("a", {
        href: "#", class: "int",
        onclick: (e: Event) => { e.preventDefault(); hooks.open(target); },
      }, inline(n.c, hooks));
    }
    case "wikilink": {
      const path = n.target ? hooks.resolveWiki(n.target) : undefined;
      if (!n.target && n.heading) {
        return h("a", { href: "#", class: "int", onclick: (e: Event) => {
          e.preventDefault();
          document.getElementById(`h-${slug(n.heading!)}`)?.scrollIntoView({ behavior: "smooth" });
        } }, n.label);
      }
      return h("a", {
        href: "#", class: ["int", "wiki", !path && "missing"],
        title: path ? path : `${n.target} (no such page yet)`,
        onclick: (e: Event) => { e.preventDefault(); if (path) hooks.open(path, n.heading); },
      }, n.label);
    }
    case "img":
      return image(n.src, n.kind === "url", n.alt, hooks);
    case "embed": {
      const path = hooks.resolveWiki(n.target);
      if (path && /\.(png|jpe?g|gif|webp|svg)$/i.test(path)) {
        return h("img", { class: "md-img", src: hooks.rawUrl(path), alt: n.label ?? n.target, loading: "lazy" });
      }
      return h("a", {
        href: "#", class: ["int", "wiki", "embed", !path && "missing"],
        onclick: (e: Event) => { e.preventDefault(); if (path) hooks.open(path); },
      }, icon(path?.endsWith(".pdf") ? "pdf" : "file", 14), n.label ?? n.target);
    }
  }
}

function image(src: string, remote: boolean, alt: string, hooks: RenderHooks): Node {
  if (!remote) {
    return h("img", { class: "md-img", src: hooks.rawUrl(hooks.resolveVault(decodeSafe(src))), alt, loading: "lazy" });
  }
  // Remote images stay blocked until asked for: a bot could otherwise leak data through
  // an image URL the moment a page renders.
  const chip: HTMLElement = h("button", {
    class: "remote-img", type: "button", title: src,
    onclick: () => {
      chip.replaceWith(h("img", { class: "md-img", src, alt, referrerpolicy: "no-referrer" }));
    },
  }, icon("image", 14), h("span", null, `Remote image blocked${alt ? ` · ${alt}` : ""}`), h("span", { class: "remote-load" }, "Load"));
  return chip;
}

function decodeSafe(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

function slug(text: string): string {
  return text.toLowerCase().trim().replace(/[^\p{L}\p{N}\s-]/gu, "").replace(/\s+/g, "-").replace(/-+/g, "-");
}
