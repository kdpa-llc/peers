/**
 * Org-mode parser for vault pages, producing the same block tree as `markdown.ts`, so the
 * page view, marks, notes and change bars work the same on `.org` files (Emacs vaults).
 *
 * Like the Markdown parser it never produces HTML and has no DOM or Node imports; every
 * block carries its 1-based source line range.
 *
 * Supported: `#+TITLE`, `#+FILETAGS` and other `#+KEY:` lines at the top; headings with TODO
 * keywords, priorities and tags; property and other drawers; SCHEDULED, DEADLINE and CLOSED
 * lines; paragraphs; ordered and unordered lists with checkboxes and `term :: description`;
 * tables; `#+BEGIN_SRC`, `EXAMPLE`, `QUOTE`, `VERSE` and other blocks; `:` fixed-width lines;
 * horizontal rules; comments; `*bold*`, `/italic/`, `_underline_`, `+strike+`, `=verbatim=`,
 * `~code~`; `[[link][label]]`, `[[link]]` and bare URLs; `file:` links to vault files and
 * images.
 */
import { classifyHref, plainText, slugify, type Lines, type MdBlock, type MdDocument, type MdInline, type MdListItem } from "./markdown.ts";

/** Keywords that count as tasks. Files may declare more with `#+TODO:`. */
export const DEFAULT_TODO = ["TODO", "NEXT", "WAITING", "HOLD", "STARTED", "SOMEDAY"];
export const DEFAULT_DONE = ["DONE", "CANCELLED", "CANCELED"];

const HEADING = /^(\*+)\s+(.*?)\s*$/;
const KEYWORD = /^#\+([A-Za-z_][\w-]*):\s?(.*)$/;
const BEGIN = /^\s*#\+begin_(\w+)(?:\s+(.*))?$/i;
const DRAWER = /^\s*:([A-Za-z][\w-]*):\s*$/;
const DRAWER_END = /^\s*:end:\s*$/i;
const PLANNING = /^\s*(?:(SCHEDULED|DEADLINE|CLOSED):\s*([<[][^>\]]*[>\]])\s*)+$/;
const LIST = /^(\s*)([-+]|\d+[.)]|\*(?=\s))(?:\s+(.*))?$/;
const TABLE = /^\s*\|/;
const HR = /^\s*-{5,}\s*$/;
const FIXED = /^\s*:(\s|$)/;
const COMMENT = /^\s*#(\s|$)/;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg)$/i;

export function isOrgPath(path: string): boolean {
  return /\.org$/i.test(path);
}

export function parseOrg(source: string): MdDocument {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const todo = [...DEFAULT_TODO];
  const done = [...DEFAULT_DONE];
  const props: [string, string][] = [];
  let title: string | undefined;
  let tags: string[] | undefined;
  let i = 0;
  // File keywords at the top (before the first heading or text).
  while (i < lines.length) {
    const line = lines[i]!;
    const k = KEYWORD.exec(line);
    if (k && !BEGIN.test(line)) {
      const key = k[1]!.toUpperCase();
      const value = k[2]!.trim();
      if (key === "TITLE") title = value;
      else if (key === "FILETAGS") tags = value.split(":").map((t) => t.trim()).filter(Boolean);
      else if (key === "TODO" || key === "SEQ_TODO" || key === "TYP_TODO") {
        const [open, closed] = value.split("|").map((part) => part.trim().split(/\s+/).map((w) => w.replace(/\(.*\)$/, "")).filter(Boolean));
        for (const w of open ?? []) if (!todo.includes(w)) todo.push(w);
        for (const w of closed ?? []) if (!done.includes(w)) done.push(w);
      } else props.push([key.toLowerCase(), value]);
      i++;
      continue;
    }
    if (line.trim() === "" || COMMENT.test(line)) { i++; continue; }
    break;
  }
  const blocks: MdBlock[] = [];
  if (props.length || tags?.length) {
    blocks.push({
      t: "frontmatter",
      props: [...(tags?.length ? [["tags", tags.join(", ")] as [string, string]] : []), ...props],
      line: [1, Math.max(1, i)],
    });
  }
  blocks.push(...new Parser(lines, { todo, done }).blocks(i, lines.length));
  return { blocks, ...(title ? { title } : {}), ...(tags?.length ? { tags } : {}) };
}

class Parser {
  private readonly lines: string[];
  private readonly todo: string[];
  private readonly done: string[];
  private readonly ids = new Map<string, number>();

  constructor(lines: string[], kw: { todo: string[]; done: string[] }) {
    this.lines = lines;
    this.todo = kw.todo;
    this.done = kw.done;
  }

  private id(text: string): string {
    const base = slugify(text);
    const n = this.ids.get(base) ?? 0;
    this.ids.set(base, n + 1);
    return n === 0 ? base : `${base}-${n}`;
  }

  /** Blocks for lines [from, to), 0-based indexes; line numbers in the output are 1-based. */
  blocks(from: number, to: number, inList = false): MdBlock[] {
    const out: MdBlock[] = [];
    const L = this.lines;
    let i = from;
    while (i < to) {
      const line = L[i]!;
      if (line.trim() === "" || COMMENT.test(line) || (KEYWORD.test(line) && !BEGIN.test(line))) { i++; continue; }

      const h = !inList ? HEADING.exec(line) : null;
      if (h) {
        out.push(this.heading(h[1]!.length, h[2]!, i));
        i++;
        continue;
      }

      if (PLANNING.test(line)) {
        const items = [...line.matchAll(/(SCHEDULED|DEADLINE|CLOSED):\s*([<[][^>\]]*[>\]])/g)].map((m) => ({ kind: m[1]!, date: m[2]!.slice(1, -1) }));
        out.push({ t: "planning", items, line: [i + 1, i + 1] });
        i++;
        continue;
      }

      const d = DRAWER.exec(line);
      if (d) {
        const end = this.find(i + 1, to, (l) => DRAWER_END.test(l));
        if (end >= 0) {
          const props: [string, string][] = [];
          for (const raw of L.slice(i + 1, end)) {
            const m = /^\s*:([^:\s][^:]*):\s*(.*)$/.exec(raw);
            if (m) props.push([m[1]!, m[2]!.trim()]);
            else if (raw.trim()) props.push(["", raw.trim()]);
          }
          out.push({ t: "drawer", name: d[1]!.toUpperCase(), props, line: [i + 1, end + 1] });
          i = end + 1;
          continue;
        }
      }

      const b = BEGIN.exec(line);
      if (b) {
        const kind = b[1]!.toLowerCase();
        const end = this.find(i + 1, to, (l) => new RegExp(`^\\s*#\\+end_${kind}\\s*$`, "i").test(l));
        const stop = end >= 0 ? end : to;
        const body = L.slice(i + 1, stop);
        if (kind === "quote" || kind === "verse" || kind === "center") {
          out.push({ t: "quote", c: this.blocksOf(body, i + 1), line: [i + 1, Math.min(stop + 1, to)] });
        } else {
          const lang = kind === "src" ? (b[2] ?? "").trim().split(/\s+/)[0] ?? "" : kind === "example" ? "" : kind;
          out.push({ t: "code", lang, v: dedent(body).join("\n"), line: [i + 1, Math.min(stop + 1, to)] });
        }
        i = stop + 1;
        continue;
      }

      if (HR.test(line)) { out.push({ t: "hr", line: [i + 1, i + 1] }); i++; continue; }

      if (FIXED.test(line)) {
        let j = i;
        while (j < to && FIXED.test(L[j]!)) j++;
        out.push({ t: "code", lang: "", v: L.slice(i, j).map((l) => l.replace(/^\s*:\s?/, "")).join("\n"), line: [i + 1, j] });
        i = j;
        continue;
      }

      if (TABLE.test(line)) {
        let j = i;
        while (j < to && TABLE.test(L[j]!)) j++;
        out.push(this.table(i, j));
        i = j;
        continue;
      }

      const li = LIST.exec(line);
      if (li && !(li[2] === "*" && li[1] === "")) {
        const j = this.listEnd(i, to, li[1]!.length);
        out.push(this.list(i, j, li[1]!.length));
        i = j;
        continue;
      }

      // Paragraph: until a blank line or anything that starts another block.
      let j = i + 1;
      while (j < to && L[j]!.trim() !== "" && !this.startsBlock(L[j]!, inList)) j++;
      const text = L.slice(i, j).map((l) => l.trim()).join("\n");
      out.push({ t: "para", c: parseOrgInline(text), line: [i + 1, j] });
      i = j;
    }
    return out;
  }

  private blocksOf(lines: string[], offset: number): MdBlock[] {
    const sub = new Parser(lines, { todo: this.todo, done: this.done });
    return sub.blocks(0, lines.length).map((b) => shift(b, offset));
  }

  private startsBlock(line: string, inList: boolean): boolean {
    return (!inList && HEADING.test(line)) || BEGIN.test(line) || DRAWER.test(line) || PLANNING.test(line) ||
      TABLE.test(line) || HR.test(line) || FIXED.test(line) || (LIST.test(line) && !/^\*/.test(line));
  }

  private find(from: number, to: number, test: (l: string) => boolean): number {
    for (let j = from; j < to; j++) if (test(this.lines[j]!)) return j;
    return -1;
  }

  private heading(level: number, rest: string, i: number): MdBlock {
    let text = rest;
    let todo: string | undefined;
    let done = false;
    const first = /^(\S+)(?:\s+(.*))?$/.exec(text);
    if (first && (this.todo.includes(first[1]!) || this.done.includes(first[1]!))) {
      todo = first[1]!;
      done = this.done.includes(todo);
      text = first[2] ?? "";
    }
    let priority: string | undefined;
    const pr = /^\[#([A-Z0-9])\]\s*(.*)$/.exec(text);
    if (pr) { priority = pr[1]; text = pr[2]!; }
    let tags: string[] | undefined;
    const tg = /^(.*?)\s+(:[\w@#%:]+:)\s*$/.exec(text);
    if (tg) { text = tg[1]!; tags = tg[2]!.split(":").filter(Boolean); }
    const c = parseOrgInline(text);
    return {
      t: "heading", level: Math.min(6, level), c, id: this.id(plainText(c)), line: [i + 1, i + 1],
      ...(todo ? { todo, done } : {}), ...(priority ? { priority } : {}), ...(tags ? { tags } : {}),
    };
  }

  private table(from: number, to: number): MdBlock {
    const rows = this.lines.slice(from, to);
    const cells = (l: string): string[] => l.trim().replace(/^\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());
    const isRule = (l: string): boolean => /^\s*\|[-+:\s|]*$/.test(l) && l.includes("-");
    const dataRows = rows.filter((l) => !isRule(l));
    const hasHead = rows.length > 1 && isRule(rows[1]!);
    const head = hasHead ? cells(rows[0]!) : [];
    const body = (hasHead ? dataRows.slice(1) : dataRows).map(cells);
    const width = Math.max(head.length, ...body.map((r) => r.length));
    const pad = (r: string[]): string[] => [...r, ...Array(Math.max(0, width - r.length)).fill("")];
    return {
      t: "table",
      align: Array(width).fill(null),
      head: hasHead ? pad(head).map(parseOrgInline) : [],
      rows: body.map((r) => pad(r).map(parseOrgInline)),
      line: [from + 1, to],
    };
  }

  /** A list continues while lines are blank, deeper, or items at the same indent. */
  private listEnd(from: number, to: number, indent: number): number {
    let j = from + 1;
    let lastContent = from;
    while (j < to) {
      const l = this.lines[j]!;
      if (l.trim() === "") { j++; continue; }
      const ind = l.length - l.trimStart().length;
      if (HEADING.test(l)) break;
      const item = LIST.exec(l);
      if (ind > indent || (ind === indent && item && !(item[2] === "*" && item[1] === ""))) { lastContent = j; j++; continue; }
      break;
    }
    return lastContent + 1;
  }

  private list(from: number, to: number, indent: number): MdBlock {
    const items: MdListItem[] = [];
    const first = LIST.exec(this.lines[from]!)!;
    const ordered = /\d/.test(first[2]!);
    let j = from;
    while (j < to) {
      const m = LIST.exec(this.lines[j]!);
      const ind = this.lines[j]!.length - this.lines[j]!.trimStart().length;
      if (!m || ind !== indent) { j++; continue; }
      // The item runs until the next item at this indent.
      let k = j + 1;
      while (k < to) {
        const n = LIST.exec(this.lines[k]!);
        const nind = this.lines[k]!.length - this.lines[k]!.trimStart().length;
        if (n && nind === indent && this.lines[k]!.trim() !== "") break;
        k++;
      }
      let rest = m[3] ?? "";
      let task: boolean | null = null;
      const box = /^\[([ Xx-])\]\s*(.*)$/.exec(rest);
      if (box) { task = box[1] === "X" || box[1] === "x"; rest = box[2]!; }
      const desc = /^(.*?)\s+::\s+(.*)$/.exec(rest);
      const head: MdInline[] = desc
        ? [{ t: "strong", c: parseOrgInline(desc[1]!) }, { t: "text", v: " — " }, ...parseOrgInline(desc[2]!)]
        : parseOrgInline(rest);
      // Continuation lines of the item's first paragraph, then nested blocks.
      let p = j + 1;
      const more: string[] = [];
      while (p < k && this.lines[p]!.trim() !== "" && !LIST.test(this.lines[p]!) && !this.startsBlock(this.lines[p]!, true)) {
        more.push(this.lines[p]!.trim());
        p++;
      }
      const c: MdBlock[] = [{
        t: "para",
        c: more.length ? [...head, { t: "text", v: " " }, ...parseOrgInline(more.join("\n"))] : head,
        line: [j + 1, p],
      }];
      if (p < k) c.push(...this.blocks(p, k, true));
      items.push({ task, c, line: [j + 1, lastNonBlank(this.lines, j, k) + 1] });
      j = k;
    }
    return { t: "list", ordered, start: ordered ? Number.parseInt(first[2]!, 10) || 1 : 1, items, line: [from + 1, to] };
  }
}

function lastNonBlank(lines: string[], from: number, to: number): number {
  for (let j = to - 1; j > from; j--) if (lines[j]!.trim() !== "") return j;
  return from;
}

function dedent(lines: string[]): string[] {
  const indents = lines.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length);
  const n = indents.length ? Math.min(...indents) : 0;
  return lines.map((l) => l.slice(n));
}

function shift(b: MdBlock, offset: number): MdBlock {
  const line: Lines = [b.line[0] + offset, b.line[1] + offset];
  if (b.t === "quote" || b.t === "callout") return { ...b, line, c: b.c.map((x) => shift(x, offset)) };
  if (b.t === "list") {
    return { ...b, line, items: b.items.map((it) => ({ ...it, line: [it.line[0] + offset, it.line[1] + offset] as Lines, c: it.c.map((x) => shift(x, offset)) })) };
  }
  return { ...b, line };
}

// ------------------------------------------------------------------ inline

const EMPHASIS: Record<string, "strong" | "em" | "del" | "code" | "u"> = {
  "*": "strong", "/": "em", "+": "del", "=": "code", "~": "code", "_": "u",
};
const PRE = /[\s('"{\-]/;
const POST = /[\s\-.,;:!?'")}\]]/;

/** A link target as the page view understands it. */
export function orgLinkTarget(raw: string): { href: string; kind: "url" | "vault" | "anchor" } | undefined {
  const t = raw.trim();
  if (/^(https?|mailto):/i.test(t)) return { href: t, kind: "url" };
  if (/^file:/i.test(t)) {
    const path = t.slice(5).replace(/::.*$/, "");
    // Absolute and home paths point outside the vault.
    if (/^[/~]/.test(path)) return undefined;
    return classifyHref(path) === "vault" ? { href: path, kind: "vault" } : undefined;
  }
  if (t.startsWith("*") || t.startsWith("#")) return { href: `#${slugify(t.replace(/^[*#]\s*/, ""))}`, kind: "anchor" };
  if (/^[a-z][\w+.-]*:/i.test(t)) return undefined; // id:, elisp:, shell: and other schemes are not followed
  if (/^[/~]/.test(t)) return undefined;
  if (/^\.{1,2}\//.test(t) || /\.\w{1,5}$/.test(t)) return classifyHref(t) === "vault" ? { href: t, kind: "vault" } : undefined;
  return { href: `#${slugify(t)}`, kind: "anchor" };
}

export function parseOrgInline(src: string): MdInline[] {
  const out: MdInline[] = [];
  let text = "";
  const flush = (): void => { if (text) { out.push({ t: "text", v: text }); text = ""; } };
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === "\n") { text += " "; i++; continue; }
    if (src.startsWith("\\\\", i) && (src[i + 2] === "\n" || i + 2 === src.length)) { flush(); out.push({ t: "br" }); i += 2; continue; }
    if (src.startsWith("[[", i)) {
      const close = src.indexOf("]]", i + 2);
      if (close > 0) {
        const inner = src.slice(i + 2, close);
        const sep = inner.indexOf("][");
        const target = sep >= 0 ? inner.slice(0, sep) : inner;
        const label = sep >= 0 ? inner.slice(sep + 2) : "";
        const link = orgLinkTarget(target);
        flush();
        if (link && !label && link.kind !== "anchor" && IMAGE_EXT.test(link.href)) {
          out.push({ t: "img", src: link.href, kind: link.kind, alt: link.href.split("/").pop()! });
        } else if (link) {
          const shown = label || target.replace(/^file:/i, "").replace(/^[*#]\s*/, "");
          out.push({ t: "link", href: link.href, kind: link.kind, c: label ? parseOrgInline(label) : [{ t: "text", v: shown }] });
        } else {
          out.push({ t: "text", v: label || target });
        }
        i = close + 2;
        continue;
      }
    }
    if (ch === "h" && /^https?:\/\/[^\s<>\]]+/.test(src.slice(i)) && (i === 0 || /[\s(]/.test(src[i - 1]!))) {
      const m = /^https?:\/\/[^\s<>\]]+/.exec(src.slice(i))!;
      let url = m[0];
      while (/[.,;:!?)]$/.test(url)) url = url.slice(0, -1);
      flush();
      out.push({ t: "link", href: url, kind: "url", c: [{ t: "text", v: url }] });
      i += url.length;
      continue;
    }
    const kind = EMPHASIS[ch];
    if (kind && (i === 0 || PRE.test(src[i - 1]!)) && src[i + 1] && !/\s/.test(src[i + 1]!)) {
      // The closing marker: same character, not after whitespace, followed by a boundary.
      let j = i + 1;
      let found = -1;
      while (j < src.length && j - i < 400) {
        if (src[j] === ch && !/\s/.test(src[j - 1]!) && (j + 1 === src.length || POST.test(src[j + 1]!))) { found = j; break; }
        if (src[j] === "\n" && src[j + 1] === "\n") break;
        j++;
      }
      if (found > i + 1) {
        const inner = src.slice(i + 1, found);
        flush();
        if (kind === "code") out.push({ t: "code", v: inner });
        else if (kind === "u") out.push({ t: "em", c: parseOrgInline(inner) });
        else out.push({ t: kind, c: parseOrgInline(inner) });
        i = found + 1;
        continue;
      }
    }
    text += ch;
    i++;
  }
  flush();
  return out;
}

/** Org's task keywords in a page: what Today lists as next actions (follow-up). */
export function orgTasks(source: string): { line: number; level: number; todo: string; done: boolean; title: string }[] {
  const doc = parseOrg(source);
  const out: { line: number; level: number; todo: string; done: boolean; title: string }[] = [];
  for (const b of doc.blocks) {
    if (b.t === "heading" && b.todo) out.push({ line: b.line[0], level: b.level, todo: b.todo, done: !!b.done, title: plainText(b.c) });
  }
  return out;
}

// ------------------------------------------------------------------ anchoring

/**
 * Which characters of an Org source the page view does not show (heading stars, list
 * markers, checkboxes, link targets and brackets, emphasis markers, tag colons, table rules,
 * `#+KEY:` prefixes). Notes use it to find a quote taken from the rendered page in the source.
 */
export function orgHidden(source: string): Uint8Array {
  const hide = new Uint8Array(source.length);
  let off = 0;
  for (const line of source.split("\n")) {
    const mark = (a: number, b: number): void => { for (let k = a; k < b; k++) hide[off + k] = 1; };
    let m: RegExpExecArray | null;
    if (/^\s*\|[-+:\s|]*$/.test(line) && line.includes("-")) mark(0, line.length);
    else if ((m = /^#\+\w+:\s?/.exec(line))) mark(0, m[0].length);
    else if ((m = /^(\*+\s+)(?:\S+\s+)?(\[#[A-Z0-9]\]\s*)?/.exec(line)) && /^\*+\s/.test(line)) {
      mark(0, m[1]!.length);
      if (m[2]) { const at = line.indexOf(m[2]); mark(at, at + m[2].length); }
      const tags = /\s+(:[\w@#%:]+:)\s*$/.exec(line);
      if (tags) { const at = line.length - tags[0].length; for (let k = at; k < line.length; k++) if (line[k] === ":") hide[off + k] = 1; }
    } else if ((m = /^(\s*(?:[-+]|\d+[.)]|\*(?=\s))\s+)(\[[ Xx-]\]\s+)?/.exec(line)) && !/^\*/.test(line)) {
      mark(0, m[0].length);
    } else if ((m = /^(\s*:)[A-Za-z][\w-]*:/.exec(line))) {
      for (let k = 0; k < line.length && k < 40; k++) if (line[k] === ":") hide[off + k] = 1;
    }
    if (/^\s*\|/.test(line)) for (let k = 0; k < line.length; k++) if (line[k] === "|") hide[off + k] = 1;
    // Links: [[target][label]] shows the label; [[target]] shows the target without "file:".
    for (const lk of line.matchAll(/\[\[([^\]]*?)(?:\]\[([^\]]*))?\]\]/g)) {
      const at = lk.index!;
      if (lk[2] !== undefined) {
        mark(at, at + 2 + lk[1]!.length + 2);
        mark(at + lk[0].length - 2, at + lk[0].length);
      } else {
        const prefix = /^file:/i.test(lk[1]!) ? 5 : 0;
        mark(at, at + 2 + prefix);
        mark(at + lk[0].length - 2, at + lk[0].length);
      }
    }
    // Emphasis markers, by the same boundary rules as the inline parser.
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!;
      if (!EMPHASIS[ch] || (i > 0 && !PRE.test(line[i - 1]!)) || !line[i + 1] || /\s/.test(line[i + 1]!)) continue;
      for (let j = i + 2; j < line.length && j - i < 400; j++) {
        if (line[j] === ch && !/\s/.test(line[j - 1]!) && (j + 1 === line.length || POST.test(line[j + 1]!))) {
          hide[off + i] = 1;
          hide[off + j] = 1;
          break;
        }
      }
    }
    off += line.length + 1;
  }
  return hide;
}
