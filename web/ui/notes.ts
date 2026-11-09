/**
 * Marking pages (PRODUCT.md §4.2, TECHNICAL.md §8): the ink layer, what a mark points at,
 * snapshots of marked regions, the note popover, numbered pins, the tool pill, and the
 * phone's bot sheet.
 *
 * One sending rule everywhere: Enter sends this note with the queued ones; ⌥Enter (or "Add
 * to batch") queues it. Drafts live on the server from the moment a mark exists.
 */
import { h, isTyping, onOutside, replace, s as svgEl } from "../lib/dom.ts";
import { icon } from "../lib/icons.ts";
import { api, newKey } from "../lib/api.ts";
import { botById, fail, isMobile, loadNotes, openThread, selectBot, sendMessage, store, toast, type Tool } from "../state.ts";
import type { Note, PageData, Quote, Target } from "../types.ts";
import { avatar } from "./common.ts";

type Pt = { x: number; y: number };
type Rect = { x: number; y: number; w: number; h: number };

type Ctx = {
  frame: HTMLElement;
  body: HTMLElement;
  page: PageData;
  svg: SVGSVGElement;
  pins: HTMLElement;
  hl: HTMLElement;
};

let ctx: Ctx | undefined;

/** True while a mark is being drawn or its note is open; page refreshes wait for it. */
export function markingBusy(): boolean {
  return !!collecting || !!popover || !!bubble;
}
let popover: { el: HTMLElement; key: string; close: () => void } | undefined;
let collecting: { strokes: Pt[][]; paths: SVGPathElement[]; group: SVGGElement; timer?: number } | undefined;

const FINAL = new Set(["applied", "answered", "declined", "done"]);
const QUICK = ["Rewrite", "Shorten", "Expand", "Make a table", "Delete this", "Check facts"];
const QUICK_BINARY = ["What is this?", "Summarize", "Extract to notes"];

// ------------------------------------------------------------------ attach to a rendered page

export function attachInk(frame: HTMLElement, body: HTMLElement, page: PageData): void {
  closePopover();
  const svg = svgEl("svg", { class: "ink-layer", "aria-hidden": "true" });
  const pins = h("div", { class: "pins" });
  const hl = h("div", { class: "target-hl hidden" });
  frame.append(svg, pins, hl);
  ctx = { frame, body, page, svg, pins, hl };
  const size = (): void => {
    svg.setAttribute("width", String(frame.scrollWidth));
    svg.setAttribute("height", String(frame.scrollHeight));
  };
  new ResizeObserver(() => { size(); renderMarks(); }).observe(frame);
  size();
  applyTool(store.get().tool);

  svg.addEventListener("pointerdown", onPointerDown);
  body.addEventListener("pointerup", () => setTimeout(onSelection, 10));
  body.addEventListener("keyup", (e) => { if (e.shiftKey || e.key.startsWith("Arrow")) setTimeout(onSelection, 10); });
  // Images and PDF pages draw lazily; marks are positioned once they have a size.
  body.querySelectorAll("img").forEach((img) => img.addEventListener("load", () => { size(); renderMarks(); }, { once: true }));
  requestAnimationFrame(() => renderMarks());
}

store.on(["notes"], () => renderMarks());
store.on(["tool"], (s) => applyTool(s.tool));

function applyTool(tool: Tool): void {
  if (!ctx) return;
  ctx.frame.classList.toggle("drawing", tool === "pen" || tool === "arrow");
  ctx.frame.classList.toggle("erasing", tool === "eraser");
  if (tool !== "read") { window.getSelection()?.removeAllRanges(); closeBubble(); }
  renderPill();
}

function local(e: { clientX: number; clientY: number }): Pt {
  const r = ctx!.frame.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function rectOf(el: Element): Rect {
  const r = el.getBoundingClientRect();
  const f = ctx!.frame.getBoundingClientRect();
  return { x: r.left - f.left, y: r.top - f.top, w: r.width, h: r.height };
}

function bbox(points: Pt[]): Rect {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of points) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
}

// ------------------------------------------------------------------ drawing

function onPointerDown(e: PointerEvent): void {
  if (!ctx || e.button > 0) return;
  const tool = store.get().tool;
  if (tool === "eraser") {
    const mark = (e.target as Element).closest?.("[data-key]") as SVGGElement | null;
    if (mark) void erase(mark.dataset.key!);
    return;
  }
  if (tool !== "pen" && tool !== "arrow") return;
  e.preventDefault();
  closePopover();
  const svg = ctx.svg;
  svg.setPointerCapture(e.pointerId);
  store.set({ marking: true });
  const start = local(e);
  const width = e.pointerType === "pen" && e.pressure > 0 ? 1.6 + e.pressure * 2.4 : 2.6;

  if (tool === "arrow") {
    const group = svgEl("g", { class: "mark draft" });
    const line = svgEl("path", { d: `M${start.x} ${start.y}` });
    const head = svgEl("path", { class: "arrowhead", d: "" });
    group.append(line, head);
    svg.append(group);
    let end = start;
    const move = (ev: PointerEvent): void => {
      end = local(ev);
      line.setAttribute("d", `M${start.x} ${start.y} L${end.x} ${end.y}`);
      head.setAttribute("d", arrowHead(start, end));
    };
    const up = (): void => {
      svg.removeEventListener("pointermove", move);
      svg.removeEventListener("pointerup", up);
      svg.removeEventListener("pointercancel", up);
      store.set({ marking: false });
      if (Math.hypot(end.x - start.x, end.y - start.y) < 14) { group.remove(); return; }
      void finishArrow(group, start, end);
    };
    svg.addEventListener("pointermove", move);
    svg.addEventListener("pointerup", up);
    svg.addEventListener("pointercancel", up);
    return;
  }

  if (collecting?.timer) clearTimeout(collecting.timer);
  if (!collecting) {
    const group = svgEl("g", { class: "mark draft" });
    svg.append(group);
    collecting = { strokes: [], paths: [], group };
  }
  const points: Pt[] = [start];
  const path = svgEl("path", { d: `M${start.x} ${start.y}`, style: { strokeWidth: String(width) } });
  collecting.group.append(path);
  collecting.paths.push(path);
  const move = (ev: PointerEvent): void => {
    const events = typeof ev.getCoalescedEvents === "function" ? ev.getCoalescedEvents() : [ev];
    for (const c of events.length ? events : [ev]) points.push(local(c));
    path.setAttribute("d", smooth(points));
  };
  const up = (): void => {
    svg.removeEventListener("pointermove", move);
    svg.removeEventListener("pointerup", up);
    svg.removeEventListener("pointercancel", up);
    const simple = simplify(points, 1.2);
    path.setAttribute("d", smooth(simple));
    collecting!.strokes.push(simple);
    // Strokes made within 700 ms of each other form one mark.
    collecting!.timer = window.setTimeout(() => { store.set({ marking: false }); void finishPen(); }, 700);
  };
  svg.addEventListener("pointermove", move);
  svg.addEventListener("pointerup", up);
  svg.addEventListener("pointercancel", up);
}

function arrowHead(a: Pt, b: Pt): string {
  const ang = Math.atan2(b.y - a.y, b.x - a.x);
  const len = 12;
  const p1 = { x: b.x - len * Math.cos(ang - 0.45), y: b.y - len * Math.sin(ang - 0.45) };
  const p2 = { x: b.x - len * Math.cos(ang + 0.45), y: b.y - len * Math.sin(ang + 0.45) };
  return `M${b.x} ${b.y} L${p1.x.toFixed(1)} ${p1.y.toFixed(1)} L${p2.x.toFixed(1)} ${p2.y.toFixed(1)} Z`;
}

/** Quadratic smoothing through midpoints: cheap and good-looking for handwriting. */
function smooth(points: Pt[]): string {
  if (points.length < 3) return points.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
  let d = `M${points[0]!.x.toFixed(1)} ${points[0]!.y.toFixed(1)}`;
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i]!;
    const n = points[i + 1]!;
    d += ` Q${p.x.toFixed(1)} ${p.y.toFixed(1)} ${((p.x + n.x) / 2).toFixed(1)} ${((p.y + n.y) / 2).toFixed(1)}`;
  }
  const last = points[points.length - 1]!;
  return `${d} L${last.x.toFixed(1)} ${last.y.toFixed(1)}`;
}

/** Ramer-Douglas-Peucker. */
function simplify(points: Pt[], eps: number): Pt[] {
  if (points.length < 3) return points;
  const dist = (p: Pt, a: Pt, b: Pt): number => {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    return Math.abs(dy * p.x - dx * p.y + b.x * a.y - b.y * a.x) / len;
  };
  let max = 0, idx = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const d = dist(points[i]!, points[0]!, points[points.length - 1]!);
    if (d > max) { max = d; idx = i; }
  }
  if (max <= eps) return [points[0]!, points[points.length - 1]!];
  return [...simplify(points.slice(0, idx + 1), eps).slice(0, -1), ...simplify(points.slice(idx), eps)];
}

// ------------------------------------------------------------------ what a mark points at

type Block = { el: HTMLElement; a: number; b: number; r: Rect };

function blocks(): Block[] {
  return [...ctx!.body.querySelectorAll<HTMLElement>("[data-line]")].map((el) => {
    const [a, b] = (el.dataset.line ?? "1-1").split("-").map(Number) as [number, number];
    return { el, a, b, r: rectOf(el) };
  });
}

function overlap(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const hgt = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && hgt > 0 ? w * hgt : 0;
}

/** The deepest blocks a region covers enough of. */
function blocksIn(region: Rect): Block[] {
  const all = blocks();
  const hit = all.filter((b) => {
    const o = overlap(region, b.r);
    if (!o) return false;
    return o >= 0.3 * Math.min(region.w * region.h, b.r.w * b.r.h) || o >= 0.5 * b.r.w * b.r.h;
  });
  const leaves = hit.filter((x) => !hit.some((y) => y !== x && x.el.contains(y.el)));
  if (leaves.length) return leaves;
  // Fall back to the nearest block vertically.
  const cy = region.y + region.h / 2;
  const nearest = all.filter((x) => !all.some((y) => y !== x && x.el.contains(y.el)))
    .sort((p, q) => Math.abs(p.r.y + p.r.h / 2 - cy) - Math.abs(q.r.y + q.r.h / 2 - cy))[0];
  return nearest ? [nearest] : [];
}

function blockText(el: Element): string {
  return (el.textContent ?? "").replace(/\s+/g, " ").trim();
}

function quoteIn(el: Element, exact: string): Quote {
  const text = blockText(el);
  const e = exact.replace(/\s+/g, " ").trim();
  const i = text.indexOf(e);
  if (i < 0) return { exact: e };
  return { exact: e, prefix: text.slice(Math.max(0, i - 32), i), suffix: text.slice(i + e.length, i + e.length + 32) };
}

function caretAt(x: number, y: number): { node: Node; offset: number } | undefined {
  const d = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  if (d.caretPositionFromPoint) {
    const p = d.caretPositionFromPoint(x, y);
    return p ? { node: p.offsetNode, offset: p.offset } : undefined;
  }
  const r = d.caretRangeFromPoint?.(x, y);
  return r ? { node: r.startContainer, offset: r.startOffset } : undefined;
}

/** A word-level quote for a small mark, by sampling caret positions inside it. */
function wordsIn(region: Rect): { range: Range; block: Element } | undefined {
  const f = ctx!.frame.getBoundingClientRect();
  const hits: { node: Node; offset: number }[] = [];
  for (let gy = 0.2; gy <= 0.8; gy += 0.3) {
    for (let gx = 0.1; gx <= 0.9; gx += 0.2) {
      const c = caretAt(f.left + region.x + region.w * gx, f.top + region.y + region.h * gy);
      if (c && c.node.nodeType === Node.TEXT_NODE && ctx!.body.contains(c.node)) hits.push(c);
    }
  }
  if (!hits.length) return undefined;
  const cmp = (a: { node: Node; offset: number }, b: { node: Node; offset: number }): number => {
    if (a.node === b.node) return a.offset - b.offset;
    return a.node.compareDocumentPosition(b.node) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  };
  hits.sort(cmp);
  const range = document.createRange();
  const first = hits[0]!;
  const last = hits[hits.length - 1]!;
  // Extend to whole words.
  const startText = first.node.textContent ?? "";
  let s = first.offset;
  while (s > 0 && /\S/.test(startText[s - 1]!)) s--;
  const endText = last.node.textContent ?? "";
  let e = last.offset;
  while (e < endText.length && /\S/.test(endText[e]!)) e++;
  range.setStart(first.node, s);
  range.setEnd(last.node, e);
  const block = (first.node.parentElement?.closest("[data-line]") ?? null) as Element | null;
  if (!block || range.toString().trim().length < 2) return undefined;
  return { range, block };
}

function targetLabel(t: Target): string {
  const where = t.lines ? (t.lines[0] === t.lines[1] ? `Line ${t.lines[0]}` : `Lines ${t.lines[0]}-${t.lines[1]}`) : "";
  const q = t.quote?.exact ?? "";
  return [where, q ? `"${q.length > 50 ? `${q.slice(0, 47)}…` : q}"` : ""].filter(Boolean).join(" · ");
}

function targetForRegion(region: Rect): Target & { page?: number; region?: [number, number, number, number] } {
  const page = ctx!.page;
  if (page.kind === "image" || page.kind === "svg") {
    const img = ctx!.body.querySelector("img");
    if (img) return { region: normalized(region, rectOf(img)), label: "Region of the image" };
  }
  if (page.kind === "pdf") {
    const cy = region.y + region.h / 2;
    const pages = [...ctx!.body.querySelectorAll<HTMLElement>(".pdf-page")];
    const box = pages.find((p) => { const r = rectOf(p); return cy >= r.y && cy <= r.y + r.h; }) ?? pages[0];
    if (box) {
      const n = Number(box.dataset.page);
      return { page: n, region: normalized(region, rectOf(box)), label: `Page ${n}` };
    }
  }
  const small = region.h < 70 && region.w < 520;
  if (small) {
    const words = wordsIn(region);
    if (words) {
      const [a, b] = ((words.block as HTMLElement).dataset.line ?? "1-1").split("-").map(Number) as [number, number];
      const t: Target = { lines: [a, b], quote: quoteIn(words.block, words.range.toString()) };
      return { ...t, label: targetLabel(t) };
    }
  }
  const hit = blocksIn(region);
  if (!hit.length) return { label: "Whole page" };
  const lines: [number, number] = [Math.min(...hit.map((x) => x.a)), Math.max(...hit.map((x) => x.b))];
  const text = hit.map((x) => blockText(x.el)).join(" ").slice(0, 2000);
  const t: Target = { lines, quote: hit.length === 1 ? quoteIn(hit[0]!.el, text) : { exact: text } };
  const tag = hit.length === 1 ? hit[0]!.el.tagName.toLowerCase() : "";
  const kind = !tag ? `${hit.length} blocks` : tag === "span" && hit[0]!.el.closest("li") ? "li" : tag;
  const label = `${targetLabel({ lines })} · ${kind === "p" ? "paragraph" : kind === "li" ? "list item" : kind === "table" || kind === "div" ? "block" : kind.startsWith("h") && kind.length === 2 ? "heading" : kind}`;
  return { ...t, label };
}

function normalized(region: Rect, box: Rect): [number, number, number, number] {
  const c = (v: number): number => Math.max(0, Math.min(1, v));
  const x = c((region.x - box.x) / box.w);
  const y = c((region.y - box.y) / box.h);
  return [x, y, c((region.x + region.w - box.x) / box.w) - x, c((region.y + region.h - box.y) / box.h) - y];
}

function showTarget(region: Rect | undefined): void {
  if (!ctx) return;
  if (!region) { ctx.hl.classList.add("hidden"); return; }
  Object.assign(ctx.hl.style, { left: `${region.x - 4}px`, top: `${region.y - 2}px`, width: `${region.w + 8}px`, height: `${region.h + 4}px` });
  ctx.hl.classList.remove("hidden");
}

// ------------------------------------------------------------------ snapshots

async function snapshot(region: Rect, inkPaths: string[]): Promise<Blob | undefined> {
  if (!ctx) return undefined;
  const fr = ctx.frame;
  const m = Math.max(16, Math.max(region.w, region.h) * 0.1);
  const r: Rect = {
    x: Math.max(0, region.x - m), y: Math.max(0, region.y - m),
    w: Math.min(fr.scrollWidth, region.x + region.w + m) - Math.max(0, region.x - m),
    h: Math.min(fr.scrollHeight, region.y + region.h + m) - Math.max(0, region.y - m),
  };
  if (r.w < 4 || r.h < 4) return undefined;
  const scale = Math.min(2, 1024 / Math.max(r.w, r.h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(r.w * scale);
  canvas.height = Math.round(r.h * scale);
  const g = canvas.getContext("2d");
  if (!g) return undefined;
  g.scale(scale, scale);
  g.translate(-r.x, -r.y);
  const css = getComputedStyle(document.documentElement);
  g.fillStyle = css.getPropertyValue("--bg").trim() || "#fff";
  g.fillRect(r.x, r.y, r.w, r.h);
  // Images, PDF pages and pictures in the region.
  for (const el of ctx.body.querySelectorAll<HTMLImageElement | HTMLCanvasElement>("img, canvas")) {
    const er = rectOf(el);
    if (!overlap(er, r)) continue;
    try { g.drawImage(el, er.x, er.y, er.w, er.h); } catch { /* not drawable */ }
  }
  // Text, word by word, at its rendered position.
  const walker = document.createTreeWalker(ctx.body, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = n.textContent ?? "";
    if (!text.trim()) continue;
    const parent = n.parentElement!;
    const st = getComputedStyle(parent);
    g.font = `${st.fontStyle} ${st.fontWeight} ${st.fontSize} ${st.fontFamily}`;
    g.fillStyle = st.color;
    g.textBaseline = "alphabetic";
    const re = /\S+/g;
    for (let mm = re.exec(text); mm; mm = re.exec(text)) {
      range.setStart(n, mm.index);
      range.setEnd(n, mm.index + mm[0].length);
      const rects = range.getClientRects();
      const box = rects[0];
      if (!box) continue;
      const f = fr.getBoundingClientRect();
      const wr: Rect = { x: box.left - f.left, y: box.top - f.top, w: box.width, h: box.height };
      if (!overlap(wr, r)) continue;
      g.fillText(mm[0], wr.x, wr.y + wr.h * 0.78);
    }
  }
  g.strokeStyle = css.getPropertyValue("--ink").trim() || "#0E7C7B";
  g.lineWidth = 2.6;
  g.lineCap = "round";
  g.lineJoin = "round";
  for (const d of inkPaths) g.stroke(new Path2D(d));
  return new Promise((ok) => canvas.toBlob((b) => ok(b ?? undefined), "image/png"));
}

async function uploadSnapshot(region: Rect, paths: string[]): Promise<string | null> {
  try {
    const blob = await snapshot(region, paths);
    if (!blob) return null;
    const r = await api.upload<{ attachment_id: string }>("/api/attachments", new Blob([blob], { type: "image/png" }));
    return r.attachment_id;
  } catch {
    return null; // a note without a picture is still a note
  }
}

// ------------------------------------------------------------------ finishing marks

async function finishPen(): Promise<void> {
  const c = collecting;
  collecting = undefined;
  if (!c || !ctx || !c.strokes.length) { c?.group.remove(); return; }
  const all = c.strokes.flat();
  const region = bbox(all);
  const target = targetForRegion(region);
  const paths = c.paths.map((p) => p.getAttribute("d") ?? "");
  const key = newKey("note");
  c.group.dataset.key = key;
  showTarget(region);
  openPopover({ key, region, label: target.label ?? "", binary: ctx.page.kind !== "page" });
  const attachment = await uploadSnapshot(region, paths);
  await saveDraft({
    client_key: key, tool: "pen", anchor: stripLabel(target), attachment_id: attachment,
    ink: { paths, frame: { width: ctx.frame.scrollWidth, height: ctx.frame.scrollHeight } },
  });
}

async function finishArrow(group: SVGGElement, a: Pt, b: Pt): Promise<void> {
  if (!ctx) return;
  const from = targetForRegion({ x: a.x - 20, y: a.y - 10, w: 40, h: 20 });
  const to = targetForRegion({ x: b.x - 20, y: b.y - 10, w: 40, h: 20 });
  const key = newKey("note");
  group.dataset.key = key;
  const region = bbox([a, b]);
  const label = `${from.label ?? "here"} → ${to.label ?? "there"}`;
  openPopover({ key, region, label, binary: ctx.page.kind !== "page" });
  const paths = [...group.querySelectorAll("path")].map((p) => p.getAttribute("d") ?? "");
  const attachment = await uploadSnapshot(region, paths);
  const fromT = stripLabel(from);
  await saveDraft({
    client_key: key, tool: "arrow",
    anchor: { ...fromT, to: stripLabel(to) as Target },
    attachment_id: attachment,
    ink: { paths, frame: { width: ctx.frame.scrollWidth, height: ctx.frame.scrollHeight } },
  });
}

function stripLabel<T extends { label?: string }>(t: T): T {
  return { ...t };
}

async function saveDraft(fields: Partial<Note> & { client_key: string }): Promise<Note | undefined> {
  if (!ctx) return undefined;
  try {
    const note = await api.post<Note>("/api/annotations", { path: ctx.page.path, doc_blob: ctx.page.hash, ...fields });
    const notes = store.get().notes.filter((n) => n.client_key !== note.client_key);
    store.set({ notes: [...notes, note] });
    return note;
  } catch (err) {
    fail(err);
    return undefined;
  }
}

async function erase(key: string): Promise<void> {
  const note = store.get().notes.find((n) => n.client_key === key);
  if (note && !["draft", "unresolved", ...FINAL, "failed"].includes(note.status)) {
    toast("That note was already sent");
    return;
  }
  ctx?.svg.querySelector(`[data-key="${CSS.escape(key)}"]`)?.remove();
  if (note) {
    await api.del(`/api/annotations/${note.annotation_id}`).catch(fail);
    store.set({ notes: store.get().notes.filter((n) => n.client_key !== key) });
  }
}

// ------------------------------------------------------------------ popover and bubble

function openPopover(args: { key: string; region: Rect; label: string; binary: boolean; text?: string; fromSelection?: { quote: Quote; lines: [number, number] } }): void {
  if (!ctx) return;
  closePopover();
  closeBubble();
  const bot = botById(ctx.page.owner);
  const area = h("textarea", {
    rows: 2, placeholder: `Tell ${bot?.name ?? "the agent"} what to change…`, "aria-label": "Instruction",
  }) as HTMLTextAreaElement;
  area.value = args.text ?? "";
  let saveTimer: number | undefined;
  const persistText = (): void => {
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      if (!args.fromSelection) void saveDraft({ client_key: args.key, instruction: area.value });
    }, 350);
  };
  const grow = (): void => { area.style.height = "auto"; area.style.height = `${Math.min(180, area.scrollHeight)}px`; };
  area.addEventListener("input", () => { grow(); persistText(); });
  const queue = async (): Promise<void> => {
    clearTimeout(saveTimer);
    const text = area.value;
    // Close this popover now, not after the save: a mark started meanwhile must keep its own.
    if (popover?.key === args.key) closePopover();
    if (args.fromSelection) await saveSelection(args.key, args.fromSelection, text);
    else await saveDraft({ client_key: args.key, instruction: text });
  };
  const send = async (): Promise<void> => {
    await queue();
    await sendDrafts();
  };
  area.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void (e.altKey ? queue() : send());
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelMark(args.key);
    }
  });
  const chips = (args.binary ? QUICK_BINARY : QUICK).map((c) => h("button", {
    class: "chip", type: "button",
    onclick: () => { area.value = area.value ? `${area.value} ${c.toLowerCase()}` : c; grow(); persistText(); area.focus(); },
  }, c));
  const el = h("div", { class: "popover", role: "dialog", "aria-label": "Note" },
    h("div", { class: "target" }, icon("pin", 13), h("strong", null, args.label || "Mark"),
      h("span", null, `→ ${bot?.name ?? "owner"}`)),
    area,
    h("div", { class: "chips" }, chips),
    h("div", { class: "actions" },
      h("button", { class: "btn", type: "button", title: "⌥Enter", onclick: () => void queue() }, "Add to batch"),
      h("button", { class: "btn primary", type: "button", title: "Enter", onclick: () => void send() }, icon("send", 14), "Send")));
  // On a phone the note is a bottom sheet; it lives on <body> so no scroll container can
  // layer it under the tool pill or the tab bar (WebKit composites scrollers separately).
  if (isMobile()) { document.body.append(el); document.body.classList.add("note-open"); }
  else ctx.frame.append(el);
  const x = Math.min(args.region.x + args.region.w + 12, ctx.frame.clientWidth - 352);
  const y = args.region.y + args.region.h + 10;
  el.style.left = `${Math.max(8, x)}px`;
  el.style.top = `${y}px`;
  const stopOutside = onOutside(el, () => { void queue(); });
  popover = {
    el, key: args.key,
    close: () => {
      stopOutside();
      clearTimeout(saveTimer);
      el.remove();
      document.body.classList.remove("note-open");
      showTarget(undefined);
    },
  };
  requestAnimationFrame(() => { area.focus({ preventScroll: true }); grow(); });
}

function closePopover(): void {
  popover?.close();
  popover = undefined;
}

function cancelMark(key: string): void {
  closePopover();
  void erase(key);
}

let bubble: HTMLElement | undefined;

function closeBubble(): void {
  bubble?.remove();
  bubble = undefined;
}

/** Text selected in Read mode: offer the Ask bubble and share it with the chat composer. */
function onSelection(): void {
  if (!ctx || store.get().tool !== "read") return;
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) { store.set({ selection: null }); closeBubble(); return; }
  const range = sel.getRangeAt(0);
  if (!ctx.body.contains(range.commonAncestorContainer)) return;
  const text = sel.toString().trim();
  if (text.length < 2) return;
  const startBlock = (range.startContainer.parentElement?.closest("[data-line]") ?? null) as HTMLElement | null;
  const endBlock = (range.endContainer.parentElement?.closest("[data-line]") ?? null) as HTMLElement | null;
  if (!startBlock || !endBlock) return;
  const a = Number((startBlock.dataset.line ?? "1-1").split("-")[0]);
  const b = Number((endBlock.dataset.line ?? "1-1").split("-")[1]);
  const lines: [number, number] = [Math.min(a, b), Math.max(a, b)];
  const quote = startBlock === endBlock ? quoteIn(startBlock, text) : { exact: text.replace(/\s+/g, " ").slice(0, 4000) };
  store.set({ selection: { text: text.slice(0, 4000), path: ctx.page.path } });
  const rect = range.getBoundingClientRect();
  const f = ctx.frame.getBoundingClientRect();
  const region: Rect = { x: rect.left - f.left, y: rect.top - f.top, w: rect.width, h: rect.height };
  closeBubble();
  const bot = botById(ctx.page.owner);
  const input = h("textarea", { rows: 1, placeholder: `Ask ${bot?.name ?? "the agent"} to…`, "aria-label": "Ask about the selection" }) as HTMLTextAreaElement;
  const key = newKey("note");
  const target = { quote, lines };
  const go = async (queueOnly: boolean): Promise<void> => {
    const instruction = input.value.trim();
    if (!instruction) return;
    await saveSelection(key, target, instruction);
    closeBubble();
    window.getSelection()?.removeAllRanges();
    if (!queueOnly) await sendDrafts();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void go(e.altKey); }
    if (e.key === "Escape") closeBubble();
  });
  bubble = h("div", { class: "popover ask-bubble", role: "dialog", "aria-label": "Ask about the selection" },
    h("div", { class: "target" }, icon("comment", 13), h("strong", null, targetLabel(target))),
    input,
    h("div", { class: "chips" }, ["Rewrite", "Shorten", "Explain"].map((c) => h("button", {
      class: "chip", type: "button", onclick: () => { input.value = c; void go(false); },
    }, c))),
    h("div", { class: "actions" },
      h("button", { class: "btn small", type: "button", onclick: () => void go(true) }, "Add to batch"),
      h("button", { class: "btn small primary", type: "button", onclick: () => void go(false) }, "Send")));
  if (isMobile()) document.body.append(bubble);
  else ctx.frame.append(bubble);
  bubble.style.left = `${Math.max(8, Math.min(region.x, ctx.frame.clientWidth - 330))}px`;
  bubble.style.top = `${region.y + region.h + 8}px`;
  bubble.addEventListener("pointerdown", (e) => e.stopPropagation());
}

async function saveSelection(key: string, target: { quote: Quote; lines: [number, number] }, instruction: string): Promise<void> {
  await saveDraft({ client_key: key, tool: "select", anchor: { lines: target.lines, quote: target.quote }, instruction });
}

// ------------------------------------------------------------------ sending

export async function sendDrafts(): Promise<void> {
  if (!ctx) return;
  const page = ctx.page;
  const drafts = store.get().notes.filter((n) => n.status === "draft" || n.status === "unresolved");
  if (!drafts.length) return;
  try {
    const r = await api.post<{ thread_id?: string; recipient: string; sent: Note[]; unresolved: Note[] }>("/api/annotations/send", {
      path: page.path, keys: drafts.map((n) => n.client_key), idempotency_key: newKey("send"),
    });
    const bot = botById(r.recipient);
    if (r.sent.length) {
      toast(`Sent ${r.sent.length} note${r.sent.length === 1 ? "" : "s"} to ${bot?.name ?? "the agent"}`);
      // The notes start a conversation of their own: show it.
      if (!store.get().pinned && r.thread_id) openThread(r.recipient, r.thread_id);
    }
    if (r.unresolved.length) {
      toast(`${r.unresolved.length} note${r.unresolved.length === 1 ? "" : "s"} no longer point at one place; redraw ${r.unresolved.length === 1 ? "it" : "them"}`, { error: true });
    }
    store.set({ tool: "read" });
    await loadNotes();
  } catch (err) {
    fail(err);
  }
}

async function discardDrafts(): Promise<void> {
  const drafts = store.get().notes.filter((n) => n.status === "draft");
  for (const n of drafts) await api.del(`/api/annotations/${n.annotation_id}`).catch(() => {});
  store.set({ notes: store.get().notes.filter((n) => n.status !== "draft") });
}

// ------------------------------------------------------------------ marks and pins

function renderMarks(): void {
  if (!ctx) return;
  const { svg, pins, page, frame } = ctx;
  const notes = store.get().notes.filter((n) => n.path === page.path);
  // Keep the strokes of a mark still being drawn.
  for (const g of [...svg.querySelectorAll<SVGGElement>("g.mark")]) {
    if (collecting?.group === g) continue;
    if (popover && g.dataset.key === popover.key && !notes.some((n) => n.client_key === g.dataset.key)) continue;
    g.remove();
  }
  replace(pins);
  const width = frame.scrollWidth || 1;
  let index = 0;
  for (const n of notes) {
    const stale = n.doc_blob && page.hash && n.doc_blob !== page.hash;
    // Outcomes stay visible while the change they caused is on screen; older ones are done.
    const ofThisChange = !!page.change && !!n.updated_at && n.updated_at >= page.change.at;
    if (FINAL.has(n.status) && stale && !ofThisChange) continue;
    index++;
    let top: number | undefined;
    if (n.ink?.paths?.length && !stale) {
      const k = n.ink.frame.width ? width / n.ink.frame.width : 1;
      const g = svgEl("g", { class: ["mark", n.status === "draft" ? "draft" : FINAL.has(n.status) ? "final" : n.status], dataset: { key: n.client_key } });
      if (k !== 1) g.setAttribute("transform", `scale(${k})`);
      for (const d of n.ink.paths) {
        g.append(svgEl("path", { d, class: n.tool === "arrow" && d.includes("Z") ? "arrowhead" : undefined }));
      }
      svg.append(g);
      try { top = g.getBBox().y * k; } catch { top = undefined; }
    }
    if (top === undefined && n.anchor?.lines) {
      const el = ctx.body.querySelector<HTMLElement>(`[data-line^="${n.anchor.lines[0]}-"]`);
      if (el) top = rectOf(el).y;
    }
    if (top === undefined) top = 0;
    const label = `${index}`;
    pins.append(h("button", {
      class: ["pin", n.status],
      style: { top: `${top}px` },
      title: `${statusWord(n)}${n.instruction ? `: ${n.instruction}` : ""}${n.reason ? ` (${n.reason})` : ""}`,
      "aria-label": `Note ${label}, ${statusWord(n)}`,
      onclick: () => {
        if (n.status === "draft" || n.status === "unresolved") {
          openPopover({ key: n.client_key, region: { x: frame.clientWidth - 360, y: top!, w: 1, h: 1 }, label: n.anchor?.label ?? targetLabel(n.anchor ?? {}), binary: page.kind !== "page", text: n.instruction });
        } else {
          toast(`${statusWord(n)}${n.reason ? `: ${n.reason}` : ""}`);
        }
      },
    }, n.status === "applied" || n.status === "done" ? icon("check", 12) : label));
  }
  renderPill();
}

function statusWord(n: Note): string {
  return ({
    draft: "Draft, not sent", sent: "Sent", working: "The agent is working on it", applied: "Applied",
    answered: "Answered in chat", declined: "Declined", done: "Done, no changes", unresolved: "Page changed, redraw this mark",
    failed: "Failed",
  } as Record<string, string>)[n.status] ?? n.status;
}

// ------------------------------------------------------------------ tool pill

let pillEl: HTMLElement | undefined;

export function mountToolPill(): HTMLElement {
  pillEl = h("div", { class: "tool-pill", role: "toolbar", "aria-label": "Page tools" });
  store.on(["route", "page", "notes", "tool", "bots"], renderPill);
  renderPill();
  return pillEl;
}

const TOOLS: { tool: Tool; icon: string; label: string; key: string }[] = [
  { tool: "read", icon: "cursor", label: "Read and select", key: "V" },
  { tool: "pen", icon: "pen", label: "Pen: circle, box, underline", key: "P" },
  { tool: "arrow", icon: "arrow", label: "Arrow: move this there", key: "A" },
  { tool: "eraser", icon: "eraser", label: "Eraser", key: "E" },
];

function renderPill(): void {
  if (!pillEl) return;
  const s = store.get();
  // Apps are not marked up: the pen and the arrow are for pages.
  const show = s.route.view === "page" && !!s.page && s.page.kind !== "app";
  pillEl.classList.toggle("hidden", !show);
  if (!show) return;
  const drafts = s.notes.filter((n) => n.status === "draft" || n.status === "unresolved").length;
  const bot = botById(s.page!.owner);
  replace(pillEl,
    TOOLS.map((t) => h("button", {
      class: ["tool", s.tool === t.tool && "active"], title: `${t.label} (${t.key})`, "aria-label": t.label,
      "aria-pressed": s.tool === t.tool ? "true" : "false",
      onclick: () => store.set({ tool: s.tool === t.tool && t.tool !== "read" ? "read" : t.tool }),
    }, icon(t.icon, 18))),
    drafts ? [
      h("span", { class: "divider" }),
      h("button", { class: "send", onclick: () => void sendDrafts(), title: "Send (⌘Enter)" }, icon("send", 15),
        h("span", null, `Send ${drafts}`, h("span", { class: "send-label-long" }, ` note${drafts === 1 ? "" : "s"} to ${bot?.name ?? "the agent"}`))),
      h("button", { class: "discard", title: "Discard drafts", "aria-label": "Discard drafts", onclick: () => void discardDrafts() }, icon("x", 14)),
    ] : null);
}

// ------------------------------------------------------------------ phone bot sheet

export function mountPeek(): HTMLElement {
  const el = h("div", { class: "peek" });
  const render = (): void => {
    const s = store.get();
    const bot = botById(s.botId);
    const show = s.route.view === "page" && !!s.page && !!bot && isMobile();
    el.classList.toggle("hidden", !show);
    el.classList.toggle("hidden-while-marking", s.marking || s.tool !== "read" || s.notes.some((n) => n.status === "draft"));
    if (!show || !bot) return;
    const input = h("input", { placeholder: `Tell ${bot.name} what to change…`, "aria-label": `Message ${bot.name}`, enterkeyhint: "send" }) as HTMLInputElement;
    const send = (): void => {
      const body = input.value.trim();
      if (!body) return;
      input.value = "";
      void sendMessage(bot.id, body, { path: s.page!.path }).catch(fail);
      toast(`Sent to ${bot.name}`);
    };
    const sendBtn = h("button", { class: "send-btn", "aria-label": "Send", disabled: true, onclick: send }, icon("send", 15)) as HTMLButtonElement;
    input.addEventListener("input", () => { sendBtn.disabled = !input.value.trim(); });
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); send(); sendBtn.disabled = true; } });
    replace(el,
      h("button", { "aria-label": `Open ${bot.name}`, onclick: () => store.set({ tab: "bot" }) }, avatar(bot, 28)),
      input,
      sendBtn);
  };
  store.on(["route", "page", "botId", "bots", "marking", "tool", "notes"], render);
  addEventListener("resize", render);
  render();
  return el;
}

// ------------------------------------------------------------------ keyboard

export function handlePageKeys(e: KeyboardEvent): boolean {
  const s = store.get();
  if (s.route.view !== "page" || isTyping(e.target)) return false;
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { void sendDrafts(); return true; }
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  const map: Record<string, Tool> = { v: "read", p: "pen", a: "arrow", e: "eraser" };
  const tool = map[e.key.toLowerCase()];
  if (tool) { store.set({ tool }); return true; }
  if (e.key === "Escape") { closePopover(); closeBubble(); store.set({ tool: "read" }); return true; }
  return false;
}
