/**
 * Markdown parser for vault pages.
 *
 * Bots write the pages, so page content is untrusted. This parser never produces HTML: it
 * returns a small node tree that the web client turns into DOM with `textContent` and
 * `setAttribute` only (CONTRACT_TESTS #3). Raw HTML in a page is kept as literal text.
 *
 * It has no DOM or Node imports so the server tests and the browser share it. Every block
 * carries its 1-based source line range, which is how a mark on the rendered page maps back
 * to the lines a bot has to change.
 *
 * Supported: front matter, ATX and setext headings, paragraphs, fenced code, block quotes,
 * Obsidian callouts, nested ordered/unordered/task lists, GFM tables, thematic breaks,
 * emphasis, strong, strikethrough, ==highlight==, inline code, links, images, autolinks,
 * bare URLs, [[wikilinks]], ![[embeds]], #tags, hard breaks and backslash escapes.
 */

export type LinkKind = "url" | "vault" | "anchor";

export type MdInline =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "em" | "strong" | "del" | "mark"; c: MdInline[] }
  | { t: "link"; href: string; kind: LinkKind; c: MdInline[] }
  | { t: "wikilink"; target: string; heading?: string; label: string }
  | { t: "img"; src: string; kind: LinkKind; alt: string }
  | { t: "embed"; target: string; label?: string }
  | { t: "tag"; v: string }
  | { t: "br" };

/** Inclusive 1-based source line range. */
export type Lines = [number, number];

export type MdListItem = { task: boolean | null; c: MdBlock[]; line: Lines };

export type MdBlock =
  /** `todo`, `priority` and `tags` come from Org headings (`* NEXT [#A] Call the bank :admin:`). */
  | { t: "heading"; level: number; c: MdInline[]; id: string; line: Lines; todo?: string; done?: boolean; priority?: string; tags?: string[] }
  | { t: "para"; c: MdInline[]; line: Lines }
  | { t: "code"; lang: string; v: string; line: Lines }
  | { t: "quote"; c: MdBlock[]; line: Lines }
  | { t: "callout"; kind: string; title: MdInline[]; fold: "" | "+" | "-"; c: MdBlock[]; line: Lines }
  | { t: "list"; ordered: boolean; start: number; items: MdListItem[]; line: Lines }
  | {
      t: "table";
      align: ("left" | "center" | "right" | null)[];
      head: MdInline[][];
      rows: MdInline[][][];
      line: Lines;
    }
  | { t: "hr"; line: Lines }
  | { t: "frontmatter"; props: [string, string][]; line: Lines }
  /** Org drawers (`:PROPERTIES:` … `:END:`), shown folded. */
  | { t: "drawer"; name: string; props: [string, string][]; line: Lines }
  /** Org planning lines: SCHEDULED, DEADLINE, CLOSED. */
  | { t: "planning"; items: { kind: string; date: string }[]; line: Lines };

export type MdDocument = { blocks: MdBlock[]; title?: string; tags?: string[] };

const FENCE = /^( {0,3})(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/;
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const LIST = /^( {0,3})([-*+]|\d{1,9}[.)])(?:([ \t]+)(.*))?$/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
const TABLE_DELIM = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const CALLOUT = /^\[!([A-Za-z][\w-]*)\]([+-]?)[ \t]*(.*)$/;

/** Parse a whole page. Line numbers in the result are 1-based. */
export function parseMarkdown(source: string): MdDocument {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks = parseBlocks(lines, 1, true);
  const firstHeading = blocks.find((b) => b.t === "heading" && b.level === 1);
  const title = firstHeading && firstHeading.t === "heading" ? plainText(firstHeading.c) : undefined;
  return { blocks, title };
}

/** Text content of inline nodes, for titles, ids and quotes. */
export function plainText(nodes: MdInline[]): string {
  let out = "";
  for (const n of nodes) {
    switch (n.t) {
      case "text": case "code": case "tag": out += n.t === "tag" ? `#${n.v}` : n.v; break;
      case "br": out += "\n"; break;
      case "wikilink": out += n.label; break;
      case "img": out += n.alt; break;
      case "embed": out += n.label ?? n.target; break;
      default: out += plainText(n.c);
    }
  }
  return out;
}

export function slugify(text: string): string {
  return text.toLowerCase().trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-") || "section";
}

function isBlank(line: string): boolean {
  return /^\s*$/.test(line);
}

function indentOf(line: string): number {
  let n = 0;
  for (const ch of line) {
    if (ch === " ") n += 1;
    else if (ch === "\t") n += 4 - (n % 4);
    else break;
  }
  return n;
}

/** Remove up to `n` columns of leading indentation. */
function dedent(line: string, n: number): string {
  let col = 0;
  let i = 0;
  while (i < line.length && col < n) {
    const ch = line[i];
    if (ch === " ") col += 1;
    else if (ch === "\t") col += 4 - (col % 4);
    else break;
    i++;
  }
  return line.slice(i);
}

function startsBlock(line: string): boolean {
  return FENCE.test(line) || ATX.test(line) || HR.test(line) || QUOTE.test(line) ||
    listStart(line, true) !== undefined;
}

type ListStart = { indent: number; ordered: boolean; marker: string; start: number; contentIndent: number; rest: string };

function listStart(line: string, interruptingParagraph = false): ListStart | undefined {
  const m = LIST.exec(line);
  if (!m) return undefined;
  const indent = m[1]!.length;
  const marker = m[2]!;
  const spacing = m[3] ?? "";
  const rest = m[4] ?? "";
  if (!spacing && rest) return undefined;
  const ordered = /\d/.test(marker[0]!);
  const start = ordered ? Number.parseInt(marker, 10) : 1;
  // CommonMark: only an ordered list starting at 1, and only a non-empty item, may
  // interrupt a paragraph. This keeps "2024. A year" from becoming a list.
  if (interruptingParagraph && (rest === "" || (ordered && start !== 1))) return undefined;
  // `-` followed by more dashes is a thematic break or setext underline, not a list.
  if (HR.test(line)) return undefined;
  const spaceWidth = spacing.length === 0 ? 1 : spacing.length > 4 ? 1 : indentOf(spacing);
  return {
    indent, ordered, marker: ordered ? marker.slice(-1) : marker, start,
    contentIndent: indent + marker.length + spaceWidth, rest,
  };
}

function parseBlocks(lines: string[], firstLine: number, allowFrontmatter: boolean): MdBlock[] {
  const blocks: MdBlock[] = [];
  const usedIds = new Map<string, number>();
  const uniqueId = (text: string): string => {
    const base = slugify(text);
    const n = usedIds.get(base) ?? 0;
    usedIds.set(base, n + 1);
    return n === 0 ? base : `${base}-${n}`;
  };
  let i = 0;
  const ln = (idx: number): number => firstLine + idx;

  if (allowFrontmatter && lines[0] === "---") {
    const end = lines.findIndex((l, idx) => idx > 0 && (l === "---" || l === "..."));
    if (end > 0) {
      const props: [string, string][] = [];
      for (const raw of lines.slice(1, end)) {
        const m = /^([\w .-]+?):\s*(.*)$/.exec(raw);
        if (m) props.push([m[1]!.trim(), m[2]!.trim().replace(/^["']|["']$/g, "")]);
        else if (/^\s+-\s+/.test(raw) && props.length > 0) {
          const last = props[props.length - 1]!;
          last[1] = [last[1], raw.replace(/^\s+-\s+/, "").trim()].filter(Boolean).join(", ");
        }
      }
      blocks.push({ t: "frontmatter", props, line: [ln(0), ln(end)] });
      i = end + 1;
    }
  }

  while (i < lines.length) {
    const line = lines[i]!;
    if (isBlank(line)) { i++; continue; }

    // Fenced code.
    const fence = FENCE.exec(line);
    if (fence) {
      const indent = fence[1]!.length;
      const marker = fence[2]!;
      const lang = fence[3] ?? "";
      const body: string[] = [];
      let j = i + 1;
      const close = new RegExp(`^ {0,3}${marker[0] === "`" ? "`" : "~"}{${marker.length},}\\s*$`);
      while (j < lines.length && !close.test(lines[j]!)) {
        body.push(dedent(lines[j]!, indent));
        j++;
      }
      const end = Math.min(j, lines.length - 1);
      blocks.push({ t: "code", lang, v: body.join("\n"), line: [ln(i), ln(end)] });
      i = j + 1;
      continue;
    }

    // ATX heading.
    const atx = ATX.exec(line);
    if (atx) {
      const inline = parseInline(atx[2] ?? "");
      blocks.push({
        t: "heading", level: atx[1]!.length, c: inline, id: uniqueId(plainText(inline)),
        line: [ln(i), ln(i)],
      });
      i++;
      continue;
    }

    if (HR.test(line)) {
      blocks.push({ t: "hr", line: [ln(i), ln(i)] });
      i++;
      continue;
    }

    // Block quote or callout. Only explicit `>` lines continue it.
    if (QUOTE.test(line)) {
      const inner: string[] = [];
      let j = i;
      while (j < lines.length && QUOTE.test(lines[j]!)) {
        inner.push(QUOTE.exec(lines[j]!)![1]!);
        j++;
      }
      const callout = CALLOUT.exec(inner[0] ?? "");
      if (callout) {
        blocks.push({
          t: "callout",
          kind: callout[1]!.toLowerCase(),
          fold: (callout[2] ?? "") as "" | "+" | "-",
          title: parseInline(callout[3] || capitalize(callout[1]!)),
          c: parseBlocks(inner.slice(1), ln(i) + 1, false),
          line: [ln(i), ln(j - 1)],
        });
      } else {
        blocks.push({ t: "quote", c: parseBlocks(inner, ln(i), false), line: [ln(i), ln(j - 1)] });
      }
      i = j;
      continue;
    }

    // Lists.
    const ls = listStart(line);
    if (ls) {
      const { block, next } = parseList(lines, i, ls, firstLine);
      blocks.push(block);
      i = next;
      continue;
    }

    // GFM table: a row with a pipe followed by a delimiter row.
    if (line.includes("|") && i + 1 < lines.length && TABLE_DELIM.test(lines[i + 1]!) &&
        lines[i + 1]!.includes("-")) {
      const head = splitRow(line);
      const align = splitRow(lines[i + 1]!).map((cell) => {
        const c = cell.trim();
        if (c.startsWith(":") && c.endsWith(":")) return "center" as const;
        if (c.endsWith(":")) return "right" as const;
        if (c.startsWith(":")) return "left" as const;
        return null;
      });
      if (align.length === head.length) {
        const rows: MdInline[][][] = [];
        let j = i + 2;
        while (j < lines.length && !isBlank(lines[j]!) && lines[j]!.includes("|") && !startsBlock(lines[j]!)) {
          const cells = splitRow(lines[j]!);
          rows.push(head.map((_, k) => parseInline((cells[k] ?? "").trim())));
          j++;
        }
        blocks.push({
          t: "table", align, head: head.map((cell) => parseInline(cell.trim())), rows,
          line: [ln(i), ln(j - 1)],
        });
        i = j;
        continue;
      }
    }

    // Paragraph, possibly a setext heading.
    const para: string[] = [line];
    let j = i + 1;
    let setext: number | undefined;
    while (j < lines.length) {
      const next = lines[j]!;
      if (isBlank(next)) break;
      const st = SETEXT.exec(next);
      if (st) { setext = st[1]![0] === "=" ? 1 : 2; break; }
      if (startsBlock(next)) break;
      if (next.includes("|") && j + 1 < lines.length && TABLE_DELIM.test(lines[j + 1]!)) break;
      para.push(next);
      j++;
    }
    const text = para.map((l) => l.replace(/^[ \t]+/, "")).join("\n");
    if (setext) {
      const inline = parseInline(text);
      blocks.push({
        t: "heading", level: setext, c: inline, id: uniqueId(plainText(inline)), line: [ln(i), ln(j)],
      });
      i = j + 1;
    } else {
      blocks.push({ t: "para", c: parseInline(text), line: [ln(i), ln(j - 1)] });
      i = j;
    }
  }
  return blocks;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function splitRow(row: string): string[] {
  let s = row.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  let inCode = false;
  for (let k = 0; k < s.length; k++) {
    const ch = s[k]!;
    if (ch === "\\" && s[k + 1] === "|") { cur += "|"; k++; continue; }
    if (ch === "`") inCode = !inCode;
    if (ch === "|" && !inCode) { cells.push(cur); cur = ""; continue; }
    cur += ch;
  }
  cells.push(cur);
  return cells;
}

function parseList(
  lines: string[],
  startIdx: number,
  first: ListStart,
  firstLine: number,
): { block: MdBlock; next: number } {
  const items: MdListItem[] = [];
  let i = startIdx;
  let current: ListStart | undefined = first;
  while (current) {
    const itemStart = i;
    const content: string[] = [current.rest];
    let j = i + 1;
    let sawBlank = false;
    while (j < lines.length) {
      const l = lines[j]!;
      if (isBlank(l)) { sawBlank = true; content.push(""); j++; continue; }
      const ind = indentOf(l);
      if (ind >= current.contentIndent) {
        content.push(dedent(l, current.contentIndent));
        sawBlank = false;
        j++;
        continue;
      }
      const sibling = listStart(l);
      if (sibling) break;
      // Lazy continuation: an unindented line continues the item's paragraph.
      if (!sawBlank && !startsBlock(l)) {
        content.push(l.trim());
        j++;
        continue;
      }
      break;
    }
    // Trailing blank lines belong to the gap between items, not to this item.
    while (content.length > 1 && isBlank(content[content.length - 1]!)) content.pop();
    let lastContent = j - 1;
    while (lastContent > itemStart && isBlank(lines[lastContent]!)) lastContent--;

    let task: boolean | null = null;
    const head = content[0] ?? "";
    const taskMatch = /^\[([ xX])\](?:[ \t]+|$)(.*)$/.exec(head);
    if (taskMatch) {
      task = taskMatch[1] !== " ";
      content[0] = taskMatch[2] ?? "";
    }
    items.push({
      task,
      c: parseBlocks(content, firstLine + itemStart, false),
      line: [firstLine + itemStart, firstLine + lastContent],
    });

    // Find the next sibling, allowing blank lines between items.
    let k = lastContent + 1;
    while (k < lines.length && isBlank(lines[k]!)) k++;
    const next = k < lines.length ? listStart(lines[k]!) : undefined;
    if (next && next.ordered === first.ordered && next.marker === first.marker &&
        next.indent < first.contentIndent) {
      i = k;
      current = next;
    } else {
      i = lastContent + 1;
      current = undefined;
    }
  }
  const lastItem = items[items.length - 1]!;
  return {
    block: {
      t: "list", ordered: first.ordered, start: first.start, items,
      line: [items[0]!.line[0], lastItem.line[1]],
    },
    next: i,
  };
}

// ---------------------------------------------------------------- inline

const PUNCT = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** Classify a link target. Anything with a scheme other than http(s)/mailto is unsafe. */
export function classifyHref(href: string): LinkKind | "unsafe" {
  const h = href.trim();
  if (/^(https?:|mailto:)/i.test(h)) return "url";
  if (h.startsWith("#")) return "anchor";
  // Control characters and whitespace-obfuscated schemes ("java\nscript:") are rejected.
  if (/[\u0000-\u001f\u007f]/.test(h)) return "unsafe";
  if (SCHEME.test(h.replace(/\s+/g, ""))) return "unsafe";
  if (h.startsWith("//")) return "unsafe";
  return "vault";
}

export function parseInline(src: string): MdInline[] {
  const out: MdInline[] = [];
  let text = "";
  const flush = (): void => {
    if (text) { out.push({ t: "text", v: text }); text = ""; }
  };
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;

    // Backslash escapes and backslash hard breaks.
    if (ch === "\\") {
      const next = src[i + 1];
      if (next === "\n") { flush(); out.push({ t: "br" }); i += 2; continue; }
      if (next && PUNCT.test(next)) { text += next; i += 2; continue; }
      text += ch; i++; continue;
    }

    // Hard break from two trailing spaces; soft break otherwise.
    if (ch === "\n") {
      if (text.endsWith("  ")) {
        text = text.replace(/ +$/, "");
        flush();
        out.push({ t: "br" });
      } else {
        text = text.replace(/ +$/, "") + "\n";
      }
      i++;
      continue;
    }

    // Code span.
    if (ch === "`") {
      let run = 1;
      while (src[i + run] === "`") run++;
      const fence = "`".repeat(run);
      const close = findCodeClose(src, i + run, run);
      if (close >= 0) {
        flush();
        let v = src.slice(i + run, close).replace(/\n/g, " ");
        if (v.length > 2 && v.startsWith(" ") && v.endsWith(" ") && v.trim()) v = v.slice(1, -1);
        out.push({ t: "code", v });
        i = close + run;
        continue;
      }
      text += fence;
      i += run;
      continue;
    }

    // Embeds and wikilinks.
    if (src.startsWith("![[", i) || src.startsWith("[[", i)) {
      const embed = src[i] === "!";
      const open = i + (embed ? 3 : 2);
      const close = src.indexOf("]]", open);
      const inner = close >= 0 ? src.slice(open, close) : "";
      if (close >= 0 && inner && !inner.includes("\n") && !inner.includes("[")) {
        flush();
        const [targetPart, label] = splitOnce(inner, "|");
        const [target, heading] = splitOnce(targetPart.trim(), "#");
        if (embed) {
          out.push({ t: "embed", target: target.trim(), ...(label ? { label: label.trim() } : {}) });
        } else {
          out.push({
            t: "wikilink",
            target: target.trim(),
            ...(heading ? { heading: heading.trim() } : {}),
            label: (label ?? (heading && !target ? heading : targetPart)).trim(),
          });
        }
        i = close + 2;
        continue;
      }
    }

    // Images and links.
    if ((ch === "!" && src[i + 1] === "[") || ch === "[") {
      const isImg = ch === "!";
      const labelStart = i + (isImg ? 2 : 1);
      const labelEnd = findBracketClose(src, labelStart);
      if (labelEnd >= 0 && src[labelEnd + 1] === "(") {
        const dest = parseDestination(src, labelEnd + 2);
        if (dest) {
          const label = src.slice(labelStart, labelEnd);
          const kind = classifyHref(dest.href);
          flush();
          if (kind === "unsafe") {
            // Keep the words, drop the target: an unsafe link becomes plain text.
            if (isImg) out.push({ t: "text", v: label });
            else out.push(...parseInline(label));
          } else if (isImg) {
            out.push({ t: "img", src: dest.href, kind, alt: label });
          } else {
            out.push({ t: "link", href: dest.href, kind, c: parseInline(label) });
          }
          i = dest.end;
          continue;
        }
      }
    }

    // Autolinks <https://…>.
    if (ch === "<") {
      const m = /^<((?:https?:\/\/|mailto:)[^\s<>]+)>/i.exec(src.slice(i));
      if (m) {
        flush();
        out.push({ t: "link", href: m[1]!, kind: "url", c: [{ t: "text", v: m[1]! }] });
        i += m[0].length;
        continue;
      }
    }

    // Bare URLs.
    if ((ch === "h" || ch === "H") && /^https?:\/\//i.test(src.slice(i, i + 8)) &&
        (i === 0 || /[\s(]/.test(src[i - 1]!))) {
      const m = /^https?:\/\/[^\s<>]+/i.exec(src.slice(i))!;
      let url = m[0];
      // Trailing punctuation usually ends the sentence, not the URL.
      while (/[.,;:!?)]$/.test(url)) {
        if (url.endsWith(")") && (url.match(/\(/g)?.length ?? 0) >= (url.match(/\)/g)?.length ?? 0)) break;
        url = url.slice(0, -1);
      }
      flush();
      out.push({ t: "link", href: url, kind: "url", c: [{ t: "text", v: url }] });
      i += url.length;
      continue;
    }

    // Tags.
    if (ch === "#" && (i === 0 || /\s/.test(src[i - 1]!))) {
      const m = /^#([\p{L}_][\p{L}\p{N}_/-]*)/u.exec(src.slice(i));
      if (m) {
        flush();
        out.push({ t: "tag", v: m[1]! });
        i += m[0].length;
        continue;
      }
    }

    // Emphasis family.
    const delim = delimiterAt(src, i);
    if (delim) {
      const close = findDelimClose(src, i + delim.length, delim);
      if (close >= 0) {
        flush();
        const inner = parseInline(src.slice(i + delim.length, close));
        const t = delim === "**" || delim === "__" ? "strong"
          : delim === "~~" ? "del"
          : delim === "==" ? "mark"
          : "em";
        if (delim === "***" || delim === "___") {
          out.push({ t: "strong", c: [{ t: "em", c: inner }] });
        } else {
          out.push({ t, c: inner });
        }
        i = close + delim.length;
        continue;
      }
    }

    text += ch;
    i++;
  }
  flush();
  return out;
}

function splitOnce(s: string, sep: string): [string, string | undefined] {
  const k = s.indexOf(sep);
  return k < 0 ? [s, undefined] : [s.slice(0, k), s.slice(k + 1)];
}

function findCodeClose(src: string, from: number, run: number): number {
  let k = from;
  while (k < src.length) {
    const at = src.indexOf("`", k);
    if (at < 0) return -1;
    let n = 1;
    while (src[at + n] === "`") n++;
    if (n === run) return at;
    k = at + n;
  }
  return -1;
}

function findBracketClose(src: string, from: number): number {
  let depth = 0;
  for (let k = from; k < src.length; k++) {
    const ch = src[k];
    if (ch === "\\") { k++; continue; }
    if (ch === "`") {
      let run = 1;
      while (src[k + run] === "`") run++;
      const close = findCodeClose(src, k + run, run);
      if (close >= 0) { k = close + run - 1; continue; }
    }
    if (ch === "[") depth++;
    else if (ch === "]") {
      if (depth === 0) return k;
      depth--;
    }
  }
  return -1;
}

function parseDestination(src: string, from: number): { href: string; end: number } | undefined {
  let k = from;
  while (src[k] === " ") k++;
  let href = "";
  if (src[k] === "<") {
    const close = src.indexOf(">", k);
    if (close < 0) return undefined;
    href = src.slice(k + 1, close);
    k = close + 1;
  } else {
    let depth = 0;
    const start = k;
    while (k < src.length) {
      const ch = src[k]!;
      if (ch === "\\" && k + 1 < src.length) { k += 2; continue; }
      if (ch === "(") depth++;
      else if (ch === ")") {
        if (depth === 0) break;
        depth--;
      } else if (/\s/.test(ch)) break;
      k++;
    }
    href = src.slice(start, k);
  }
  while (src[k] === " ") k++;
  // Optional title, which we accept and ignore.
  if (src[k] === '"' || src[k] === "'") {
    const q = src[k]!;
    const close = src.indexOf(q, k + 1);
    if (close < 0) return undefined;
    k = close + 1;
    while (src[k] === " ") k++;
  }
  if (src[k] !== ")") return undefined;
  return { href: href.trim(), end: k + 1 };
}

function delimiterAt(src: string, i: number): string | undefined {
  for (const d of ["***", "___", "**", "__", "~~", "==", "*", "_"]) {
    if (!src.startsWith(d, i)) continue;
    const after = src[i + d.length];
    if (!after || /\s/.test(after)) return undefined;
    // Underscore emphasis may not open inside a word (snake_case stays text).
    if (d[0] === "_" && i > 0 && /[\p{L}\p{N}]/u.test(src[i - 1]!)) return undefined;
    return d;
  }
  return undefined;
}

function findDelimClose(src: string, from: number, delim: string): number {
  let k = from;
  while (k < src.length) {
    const ch = src[k]!;
    if (ch === "\\") { k += 2; continue; }
    if (ch === "`") {
      let run = 1;
      while (src[k + run] === "`") run++;
      const close = findCodeClose(src, k + run, run);
      if (close >= 0) { k = close + run; continue; }
      k += run;
      continue;
    }
    if (ch === "[" && src[k + 1] === "[") {
      const close = src.indexOf("]]", k);
      if (close >= 0) { k = close + 2; continue; }
    }
    if (src.startsWith(delim, k)) {
      const before = src[k - 1];
      const after = src[k + delim.length];
      const longer = delim.length === 1 && src[k + 1] === delim;
      if (before && !/\s/.test(before) && !longer &&
          !(delim[0] === "_" && after && /[\p{L}\p{N}]/u.test(after))) {
        return k;
      }
      if (longer) { k += 2; continue; }
    }
    k++;
  }
  return -1;
}

/** Source lines of a page with numbers, as bots see them. */
export function numberLines(source: string, from = 1, to?: number): string {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const end = Math.min(to ?? lines.length, lines.length);
  const width = String(end).length;
  const out: string[] = [];
  for (let k = Math.max(1, from); k <= end; k++) {
    out.push(`${String(k).padStart(width, " ")}│ ${lines[k - 1]}`);
  }
  return out.join("\n");
}
