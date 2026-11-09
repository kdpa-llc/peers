/** Middle pane: the page a bot wrote, its changes, and the views that share the pane. */
import { parseMarkdown, plainText } from "../../src/vault/markdown.ts";
import { isOrgPath, parseOrg } from "../../src/vault/org.ts";
import { h, replace } from "../lib/dom.ts";
import { icon } from "../lib/icons.ts";
import { renderBlocks } from "../lib/md-dom.ts";
import { api, q } from "../lib/api.ts";
import { ago } from "../lib/time.ts";
import {
  botById, fail, go, isMobile, rawUrl, refreshPage, resolveRelative, resolveWiki, selectBot, store, toast,
} from "../state.ts";
import type { PageData } from "../types.ts";
import { avatar, openMenu } from "./common.ts";
import { attachInk, markingBusy, mountPeek, mountToolPill } from "./notes.ts";
import { renderSettings } from "./settings.ts";
import { renderBotSettings } from "./botsettings.ts";
import { renderToday } from "./today.ts";
import { appHeaderSlot, renderApp } from "./apppage.ts";
import { toggleTreePane } from "./tree.ts";

let lastRendered = "";
/** The route whose content has faded in, so live updates of it do not fade again. */
let entered = "";
/** The app page on screen, as path@hash. */
let appShown = "";

export function mountPage(pane: HTMLElement): void {
  const head = h("header", { class: "page-head" });
  const scroll = h("div", { class: "page-scroll" });
  scroll.addEventListener("scroll", () => head.classList.toggle("scrolled", scroll.scrollTop > 4), { passive: true });
  pane.append(head, scroll, mountToolPill(), mountPeek());

  let deferred: number | undefined;
  const render = (): void => {
    const s = store.get();
    const key = s.route.view === "page" ? `page:${s.route.path}` : s.route.view === "bot" ? `bot:${s.route.id}` : s.route.view;
    // A content refresh of the same page waits until the mark in progress is finished.
    clearTimeout(deferred);
    if (key === lastRendered && s.route.view === "page" && markingBusy()) {
      deferred = window.setTimeout(render, 600);
      return;
    }
    // An app keeps its frame (and whatever is going on in it) until its page changes.
    if (s.route.view === "page" && s.page?.kind === "app" && key === lastRendered && appShown === `${s.page.path}@${s.page.hash}` &&
      scroll.querySelector(".app-view")) {
      replace(head, header());
      return;
    }
    const keepScroll = key === lastRendered ? scroll.scrollTop : 0;
    lastRendered = key;
    appShown = "";
    head.classList.toggle("is-today", s.route.view === "today");
    replace(head, header());
    if (s.route.view === "today") replace(scroll, renderToday());
    else if (s.route.view === "settings") replace(scroll, renderSettings());
    else if (s.route.view === "bot") replace(scroll, renderBotSettings(s.route.id));
    else if (s.pageError) replace(scroll, h("div", { class: "today" }, h("h1", null, "Can't open this page"), h("p", { class: "sub" }, s.pageError)));
    // Until the page for this route arrives, a placeholder the size of a page (not the last one).
    else if (!s.page || (s.route.view === "page" && s.page.path !== s.route.path)) replace(scroll, pageSkeleton());
    else if (s.page.kind === "app") {
      appShown = `${s.page.path}@${s.page.hash}`;
      replace(scroll, renderApp(s.page));
    } else replace(scroll, renderPage(s.page));
    scroll.classList.toggle("app-mode", s.route.view === "page" && s.page?.kind === "app");
    // Content fades in once per route, when it is ready (MOTION.md: content); apps load in their frame.
    const ready = s.route.view === "today" ? !!s.today
      : s.route.view === "page" ? !!s.pageError || (!!s.page && s.page.path === s.route.path && s.page.kind !== "app")
      : true;
    if (ready && entered !== key) {
      (scroll.firstElementChild as HTMLElement | null)?.classList.add("enter");
      entered = key;
    }
    if (!ready && entered === key) entered = "";
    scroll.scrollTop = keepScroll;
  };
  store.on(["route", "page", "pageError", "layoutTick", "today", "bots"], (s, changed) => {
    // Bot status ticks only matter here for the Today view and the meta line.
    if (changed.size === 1 && changed.has("bots") && s.route.view === "page") {
      replace(head, header());
      return;
    }
    if (changed.size === 1 && changed.has("today") && s.route.view !== "today") return;
    // The settings pages hold forms (a sign-in code, instructions being edited): they redraw
    // when you open them, not on live updates or resizes.
    if ((s.route.view === "settings" || s.route.view === "bot") && !changed.has("route")) return;
    render();
  });
  render();
}

function pageSkeleton(): Node {
  return h("div", { class: "page-frame" }, h("div", { class: "skeleton", "aria-label": "Loading", role: "status" },
    h("div", { class: "bar title" }), h("div", { class: "bar" }), h("div", { class: "bar" }), h("div", { class: "bar short" }),
    h("div", { class: "bar" }), h("div", { class: "bar short" })));
}

function header(): Node {
  const s = store.get();
  const crumbs = h("nav", { class: "crumbs", "aria-label": "Breadcrumb" });
  const tabletTree = h("button", { class: "icon-btn tree-toggle-inline", "aria-label": "Show vault", onclick: () => toggleTreePane() }, icon("menu", 17));
  if (s.route.view === "page") {
    const parts = s.route.path.split("/");
    // An app's index page is the app folder itself.
    if (s.page?.kind === "app" && parts.length > 1 && /^index\.html?$/i.test(parts[parts.length - 1]!)) parts.pop();
    parts.forEach((p, i) => {
      if (i > 0) crumbs.append(h("span", { class: "sep" }, "/"));
      const isLast = i === parts.length - 1;
      crumbs.append(isLast
        ? h("span", { class: "current" }, p.replace(/\.(md|markdown|org|html?)$/i, ""))
        : h("a", { href: "#", onclick: (e: Event) => { e.preventDefault(); revealFolder(parts.slice(0, i + 1).join("/")); } }, p));
    });
  } else {
    crumbs.append(h("span", { class: "current" }, s.route.view === "settings" ? "Settings"
      : s.route.view === "bot" ? `${botById(s.route.id)?.name ?? "Agent"} · settings` : "Today"));
  }
  const actions = h("div", { style: { display: "flex", gap: "4px" } });
  if (s.route.view === "page" && s.page) {
    const page = s.page;
    actions.append(
      h("button", {
        class: "icon-btn", title: "More", "aria-label": "More",
        onclick: (e: MouseEvent) => openMenu([
          { label: `Chat with ${botById(page.owner)?.name ?? "owner"}`, icon: "comment", run: () => { selectBot(page.owner); store.set({ tab: "bot", botCollapsed: false }); } },
          { label: "Open raw file", icon: "external", run: () => window.open(rawUrl(page.path), "_blank", "noopener") },
          { label: "Reload", icon: "refresh", run: () => void refreshPage() },
        ], { x: e.clientX - 180, y: e.clientY + 12 }),
      }, icon("more", 17)));
  }
  const app = s.route.view === "page" && s.page?.kind === "app" && s.page.path === s.route.path ? appHeaderSlot : null;
  return h("div", { style: { display: "contents" } }, tabletTree, crumbs, app, actions);
}

function revealFolder(folder: string): void {
  const expanded = { ...store.get().expanded, [folder]: true };
  store.set({ expanded });
  if (isMobile()) store.set({ tab: "vault" });
  else if (store.get().treeCollapsed) store.set({ treeCollapsed: false });
}

function renderPage(page: PageData): Node {
  const s = store.get();
  // PDFs and images are white paper in both themes: marks on them keep the day ink.
  const frame = h("div", { class: ["page-frame", (page.kind === "pdf" || page.kind === "image" || page.kind === "svg") && "on-paper"] });
  const author = botById(page.author);
  let title = page.path.split("/").pop()!.replace(/\.(md|markdown|org)$/i, "");
  const meta = h("div", { class: "page-meta" },
    author ? avatar(author, 18) : null,
    h("span", null, page.author === "external" ? "Changed outside Peers" : page.author === "human" ? "Changed by you" : `Written by ${page.author_name}`),
    h("span", null, "·"), h("span", { title: page.updated_at }, ago(page.updated_at)));
  const body = h("article", { class: "md page-body", lang: "en" });

  if (page.kind === "page" && page.content !== undefined) {
    // Markdown and Obsidian pages, or Emacs Org files.
    const doc = isOrgPath(page.path) ? parseOrg(page.content) : parseMarkdown(page.content);
    let blocks = doc.blocks;
    const firstContent = blocks.findIndex((b) => b.t !== "frontmatter");
    const first = blocks[firstContent];
    // The page's own first heading becomes its title, shown once.
    const firstH1 = first && first.t === "heading" && first.level === 1 && !first.todo ? plainText(first.c) : undefined;
    title = doc.title ?? firstH1 ?? title;
    if (firstH1 !== undefined && firstH1.trim().toLowerCase() === title.trim().toLowerCase()) {
      blocks = blocks.filter((_, i) => i !== firstContent);
    }
    // An Org file's top headings are its sections (its title is #+TITLE): one size down, like
    // Markdown's ##, so a list of tasks does not read as a stack of page titles.
    if (isOrgPath(page.path)) blocks = blocks.map((b) => (b.t === "heading" ? { ...b, level: Math.min(6, b.level + 1) } : b));
    body.append(renderBlocks(blocks, {
      resolveWiki: (t) => resolveWiki(t, page.path),
      resolveVault: (href) => resolveRelative(href, page.path),
      open: (path, heading) => {
        go({ view: "page", path });
        if (heading) setTimeout(() => document.getElementById(`h-${heading.toLowerCase().replace(/\s+/g, "-")}`)?.scrollIntoView(), 300);
      },
      rawUrl,
    }));
    // A page new since you looked is all new: the chip says so, without marking every line.
    if (page.change && !page.change.created) markChanges(body, page);
  } else if (page.kind === "image" || page.kind === "svg") {
    body.classList.add("image-view");
    body.append(h("img", { src: rawUrl(page.path), alt: title, draggable: "false", class: "image-target" }));
  } else if (page.kind === "pdf") {
    body.append(renderPdf(page.path));
  } else if (page.kind === "text" && page.content !== undefined) {
    body.append(h("pre", { class: "plain-text" }, page.content));
  } else {
    body.append(h("div", { class: "file-card" }, icon("file", 22),
      h("div", null, h("div", null, page.path.split("/").pop()), h("a", { href: rawUrl(page.path) }, "Download"))));
  }

  frame.append(h("h1", { class: "page-title" }, title), meta);
  if (page.readonly) {
    frame.append(h("div", { class: "readonly-chip", role: "note" }, icon("lock", 12), "Generated. Agents change the source note, not this page."));
  }
  if (page.change) {
    // What changed since you last looked. Opening the page counts as looking, so the marks
    // show this time and not the next; "Hide" clears them now.
    const c = page.change;
    const by = c.author === "external" ? "outside Peers" : c.author === "human" ? "you" : c.author_name;
    const chip = h("div", { class: "change-chip", role: "status" },
      icon("sparkle", 14),
      // Who and when are in the line above; this says what to look for.
      h("span", { title: `by ${by} · ${ago(c.at)}` }, `${c.created ? "New" : "Changed"} since you last looked`),
      c.outside_scope ? h("span", { class: "warn-tag", title: "Outside the folders this agent is asked to write in" }, "outside its folder") : null,
      page.kind === "page" && c.hunks.length ? h("button", {
        onclick: () => {
          frame.querySelectorAll(".changed").forEach((el) => el.classList.remove("changed"));
          frame.querySelectorAll(".removed-mark, .change-bars").forEach((el) => el.remove());
          chip.remove();
        },
      }, "Hide") : null);
    frame.append(chip);
  }
  frame.append(body);
  if (page.change && !page.change.created && page.kind === "page") {
    const bars = h("div", { class: "change-bars", "aria-hidden": "true" });
    frame.append(bars);
    const draw = (): void => drawChangeBars(frame, body, bars);
    requestAnimationFrame(draw);
    new ResizeObserver(draw).observe(body);
  }
  attachInk(frame, body, page);
  void s;
  return frame;
}

function markChanges(body: HTMLElement, page: PageData): void {
  const blocks = [...body.querySelectorAll<HTMLElement>("[data-line]")].map((el) => {
    const [a, b] = (el.dataset.line ?? "0-0").split("-").map(Number) as [number, number];
    return { el, a, b };
  });
  const leafOf = (list: typeof blocks): typeof blocks => list.filter((x) => !list.some((y) => y !== x && x.el.contains(y.el)));
  for (const hunk of page.change!.hunks) {
    if (hunk.bEnd >= hunk.bStart) {
      const hit = leafOf(blocks.filter((x) => x.a <= hunk.bEnd && x.b >= hunk.bStart));
      for (const x of hit) (x.el.tagName === "SPAN" ? x.el.closest("li") ?? x.el : x.el).classList.add("changed");
    } else {
      const removed = hunk.aEnd - hunk.aStart + 1;
      const next = blocks.find((x) => x.a >= hunk.bStart && !blocks.some((y) => y !== x && y.el.contains(x.el) && y.a >= hunk.bStart));
      const mark = h("div", { class: "removed-mark", role: "note", "aria-label": `${removed} line${removed === 1 ? "" : "s"} removed`, dataset: { removed: String(removed) } });
      if (next) next.el.before(mark);
      else body.append(mark);
    }
  }
}

/** Bars in the left margin, aligned for every kind of block. */
function drawChangeBars(frame: HTMLElement, body: HTMLElement, bars: HTMLElement): void {
  if (!bars.isConnected) return;
  replace(bars);
  const f = frame.getBoundingClientRect();
  const left = body.getBoundingClientRect().left - f.left - 18;
  for (const el of body.querySelectorAll<HTMLElement>(".changed")) {
    const r = el.getBoundingClientRect();
    bars.append(h("div", { class: "change-bar", style: { left: `${left}px`, top: `${r.top - f.top + 2}px`, height: `${Math.max(6, r.height - 4)}px` } }));
  }
  for (const el of body.querySelectorAll<HTMLElement>(".removed-mark")) {
    const r = el.getBoundingClientRect();
    const n = Number(el.dataset.removed ?? "1");
    bars.append(h("div", {
      class: "change-bar removed", title: `${n} line${n === 1 ? "" : "s"} removed`,
      style: { left: `${left}px`, top: `${r.top - f.top - 6}px` },
    }));
  }
}

// ------------------------------------------------------------------ PDF

type PdfJs = {
  GlobalWorkerOptions: { workerSrc: string };
  getDocument(opts: Record<string, unknown>): { promise: Promise<any> };
};
let pdfjs: Promise<PdfJs> | undefined;

function loadPdfJs(): Promise<PdfJs> {
  const url = "/vendor/pdfjs/build/pdf.min.mjs";
  pdfjs ??= (import(url) as Promise<PdfJs>).then((mod) => {
    mod.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/build/pdf.worker.min.mjs";
    return mod;
  });
  return pdfjs;
}

function renderPdf(path: string): Node {
  const host = h("div", { class: "pdf-pages", dataset: { pdf: path } }, h("p", { class: "muted" }, "Opening PDF…"));
  void (async () => {
    try {
      const lib = await loadPdfJs();
      const doc = await lib.getDocument({
        url: rawUrl(path), isEvalSupported: false, withCredentials: true,
        standardFontDataUrl: "/vendor/pdfjs/standard_fonts/", cMapUrl: "/vendor/pdfjs/cmaps/", cMapPacked: true,
      }).promise;
      replace(host);
      const observer = new IntersectionObserver((entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          observer.unobserve(e.target);
          void drawPage(doc, e.target as HTMLElement);
        }
      }, { rootMargin: "600px 0px" });
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const vp = page.getViewport({ scale: 1 });
        const box = h("div", { class: "pdf-page", dataset: { page: String(i) }, style: { aspectRatio: `${vp.width} / ${vp.height}` } },
          h("canvas", { class: "pdf-canvas" }), h("span", { class: "page-num" }, `${i} / ${doc.numPages}`));
        host.append(box);
        observer.observe(box);
      }
    } catch (err) {
      replace(host, h("div", { class: "file-card" }, icon("pdf", 22),
        h("div", null, h("div", null, "This PDF could not be shown here."), h("a", { href: rawUrl(path) }, "Download"),
          h("div", { class: "muted" }, String((err as Error).message ?? err)))));
    }
  })();
  return host;
}

async function drawPage(doc: any, box: HTMLElement): Promise<void> {
  const n = Number(box.dataset.page);
  const page = await doc.getPage(n);
  const canvas = box.querySelector("canvas")!;
  const width = box.clientWidth || 700;
  const base = page.getViewport({ scale: 1 });
  const scale = (width * Math.min(2, devicePixelRatio || 1)) / base.width;
  const vp = page.getViewport({ scale });
  canvas.width = Math.floor(vp.width);
  canvas.height = Math.floor(vp.height);
  await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
}

export { q };
