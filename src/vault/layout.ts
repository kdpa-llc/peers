/**
 * Layouts: which folders and pages have their own agent (ADR 0005).
 *
 * Peers has no built-in organising method. A vault's `.peers/layout.json` lists, as path
 * patterns, the folders or single pages that get an agent, which are paused (an archive),
 * which page or folder is the inbox, which content is generated (agents must not edit it),
 * and what to hide from the tree. PARA, one agent per top-level folder, and a wiki are only
 * presets Peers suggests from what it finds on disk.
 *
 * Patterns are vault-relative: `*` matches within one path segment, `**` any depth. A
 * pattern ending in a page extension (`*.md`, `*.org`) matches pages; any other pattern
 * matches folders.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { rootKindOf, visibleName } from "./paths.ts";

export type Layout = {
  preset?: "para" | "folders" | "wiki" | "custom";
  /** Folders (or pages) that get their own agent. */
  agents: string[];
  /** Exact paths a pattern in `agents` would match that should not have an agent. */
  exclude: string[];
  /** Paths whose agents do nothing on their own, and are not asked about pages (an archive). */
  paused: string[];
  /** The page or folder the vault agent triages. */
  inbox?: string;
  /** Where "Move to archive" puts a folder or page. */
  archive?: string;
  /** Generated content: shown with a note, never edited by agents. */
  readonly: string[];
  /** Kept out of the tree (still searchable and readable by agents). */
  hidden: string[];
  /** Files with standing rules for every agent (AGENTS.md, house rules). */
  rules: string[];
};

export const PAGE_EXT = /\.(md|markdown|org)$/i;
const FRONT_NAMES = ["index", "readme", "main", "overview"];

export function emptyLayout(): Layout {
  return { agents: [], exclude: [], paused: [], readonly: [], hidden: [], rules: [] };
}

// ------------------------------------------------------------------ patterns

function segmentRegex(seg: string): string {
  return seg.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]");
}

/** Compile a path pattern. `**` matches any number of segments, including none. */
export function patternRegex(pattern: string): RegExp {
  const segs = pattern.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
  let re = "";
  let leadingStars = false;
  segs.forEach((seg, i) => {
    const last = i === segs.length - 1;
    if (seg === "**") {
      if (i === 0) {
        re += last ? ".*" : "(?:[^/]+/)*";
        leadingStars = !last;
      } else {
        re += "(?:/[^/]+)*";
      }
      return;
    }
    re += (i === 0 || (i === 1 && leadingStars) ? "" : "/") + segmentRegex(seg);
  });
  return new RegExp(`^${re}$`, "i");
}

export function matches(path: string, pattern: string): boolean {
  return patternRegex(pattern).test(path);
}

/** True when the path or one of its parent folders matches (for paused, readonly, hidden). */
export function within(path: string, patterns: string[]): boolean {
  if (!patterns.length) return false;
  const parts = path.split("/");
  for (let i = parts.length; i > 0; i--) {
    const p = parts.slice(0, i).join("/");
    if (patterns.some((pat) => matches(p, pat))) return true;
  }
  return false;
}

export function isPagePattern(pattern: string): boolean {
  return PAGE_EXT.test(pattern);
}

// ------------------------------------------------------------------ front pages

/**
 * A folder's front page: `index`, `README`, `main` or `Overview`, or the folder note `<folder>/<folder>`,
 * as `.md`, `.markdown` or `.org`. Undefined when there is none.
 */
export function frontPage(root: string, folder: string): string | undefined {
  let names: string[];
  try { names = readdirSync(join(root, folder)); } catch { return undefined; }
  const base = folder.split("/").pop()?.toLowerCase() ?? "";
  const pages = names.filter((n) => PAGE_EXT.test(n) && visibleName(n));
  const stem = (n: string): string => n.replace(PAGE_EXT, "").toLowerCase();
  for (const want of [...FRONT_NAMES, ...(base ? [base] : [])]) {
    const hit = pages.find((n) => stem(n) === want);
    if (hit) return folder ? `${folder}/${hit}` : hit;
  }
  return undefined;
}

/** Whether a page is its folder's front page (it never becomes an agent of its own). */
export function isFrontPage(path: string): boolean {
  const parts = path.split("/");
  const name = parts.pop()!;
  if (!PAGE_EXT.test(name)) return false;
  const stem = name.replace(PAGE_EXT, "").toLowerCase();
  return FRONT_NAMES.includes(stem) || (parts.length > 0 && stem === parts[parts.length - 1]!.toLowerCase());
}

// ------------------------------------------------------------------ loading

export function layoutFile(root: string): string {
  return join(root, ".peers", "layout.json");
}

const strings = (v: unknown, max = 200): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= 300 && !x.includes("..")).slice(0, max) : [];

/** Validate a layout from disk or the API. Throws on anything malformed. */
export function validateLayout(raw: unknown): Layout {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("layout must be an object");
  const r = raw as Record<string, unknown>;
  const allowed = new Set(["preset", "agents", "exclude", "paused", "inbox", "archive", "readonly", "hidden", "rules"]);
  for (const k of Object.keys(r)) if (!allowed.has(k)) throw new Error(`unknown layout field '${k}'`);
  for (const k of ["agents", "exclude", "paused", "readonly", "hidden", "rules"]) {
    if (r[k] !== undefined && !Array.isArray(r[k])) throw new Error(`${k} must be a list of paths`);
  }
  const one = (k: string): string | undefined => {
    const v = r[k];
    if (v === undefined || v === null || v === "") return undefined;
    if (typeof v !== "string" || v.includes("..") || v.startsWith("/")) throw new Error(`invalid ${k}`);
    return v.replace(/\/+$/, "");
  };
  const preset = r.preset;
  if (preset !== undefined && !["para", "folders", "wiki", "custom"].includes(String(preset))) throw new Error("invalid preset");
  return {
    ...(preset ? { preset: preset as Layout["preset"] } : {}),
    agents: strings(r.agents),
    exclude: strings(r.exclude, 1000),
    paused: strings(r.paused),
    readonly: strings(r.readonly),
    hidden: strings(r.hidden),
    rules: strings(r.rules, 20),
    ...(one("inbox") ? { inbox: one("inbox")! } : {}),
    ...(one("archive") ? { archive: one("archive")! } : {}),
  };
}

export function readLayout(root: string): Layout | undefined {
  const file = layoutFile(root);
  if (!existsSync(file)) return undefined;
  return validateLayout(JSON.parse(readFileSync(file, "utf8")));
}

// ------------------------------------------------------------------ presets

type Entry = { name: string; dir: boolean };

function entries(root: string, rel: string): Entry[] {
  try {
    return readdirSync(join(root, rel), { withFileTypes: true })
      .filter((e) => visibleName(e.name) && !e.isSymbolicLink())
      .map((e) => ({ name: e.name, dir: e.isDirectory() }));
  } catch {
    return [];
  }
}

function countFiles(root: string, rel: string, limit: number): number {
  let n = 0;
  const walk = (r: string): void => {
    for (const e of entries(root, r)) {
      if (n >= limit) return;
      if (e.dir) walk(`${r}/${e.name}`);
      else n++;
    }
  };
  walk(rel);
  return n;
}

/**
 * Suggest a layout from what is on disk:
 * - PARA when there are Projects or Areas folders: their folders and pages get agents, an
 *   Archive is paused, and an Inbox folder or page is the inbox;
 * - otherwise one agent per top-level folder;
 * - and, either way, folders that say they are generated are read-only, very large source
 *   folders and tool folders are hidden, and AGENTS.md or CLAUDE.md at the root are rules.
 */
export function suggestLayout(root: string): Layout {
  const top = entries(root, "");
  const dirs = top.filter((e) => e.dir).map((e) => e.name);
  const kind = (n: string) => rootKindOf(n);
  const projects = dirs.filter((d) => kind(d) === "projects");
  const areas = dirs.filter((d) => kind(d) === "areas");
  const archive = dirs.find((d) => kind(d) === "archive");
  const inboxDir = dirs.find((d) => kind(d) === "inbox");
  const inboxPage = top.find((e) => !e.dir && /^inbox\.(md|org)$/i.test(e.name))?.name;
  const layout = emptyLayout();
  if (projects.length || areas.length) {
    layout.preset = "para";
    // Archived projects and areas keep their agent, paused. The archive folder is created
    // the first time something is archived.
    const arch = archive ?? "Archive";
    for (const d of [...projects, ...areas, arch]) layout.agents.push(`${d}/*`, `${d}/*.md`, `${d}/*.org`);
    layout.paused.push(`${arch}/**`);
    layout.archive = arch;
  } else if (dirs.length) {
    layout.preset = "folders";
    for (const d of dirs) if (!isToolFolder(d)) layout.agents.push(d);
  } else {
    layout.preset = "para";
  }
  if (inboxDir) layout.inbox = inboxDir;
  else if (inboxPage) layout.inbox = inboxPage;
  for (const d of dirs) {
    if (isToolFolder(d)) { layout.hidden.push(d); continue; }
    const fp = frontPage(root, d);
    let text = "";
    try { text = fp ? readFileSync(join(root, fp), "utf8").slice(0, 2000) : ""; } catch { text = ""; }
    if (/generated/i.test(text) && /(do not|don't) (hand-)?edit/i.test(text)) layout.readonly.push(`${d}/**`);
    else if (/^(raw|sources?|originals)$/i.test(d) || countFiles(root, d, 1001) > 1000) layout.hidden.push(d);
  }
  for (const e of top) if (!e.dir && /^(AGENTS|CLAUDE)\.md$/i.test(e.name)) layout.rules.push(e.name);
  layout.agents = layout.agents.filter((p) => !layout.hidden.includes(p));
  return layout;
}

function isToolFolder(name: string): boolean {
  return /^(scripts?|tests?|node_modules|emacs|bin|tools|\.?venv)$/i.test(name);
}

/** The folders a fresh PARA vault starts with. */
export const PARA_FOLDERS = ["Inbox", "Projects", "Areas", "Resources", "Archive"];

export function paraLayout(): Layout {
  return {
    preset: "para",
    agents: ["Projects/*", "Projects/*.md", "Projects/*.org", "Areas/*", "Areas/*.md", "Areas/*.org", "Archive/*", "Archive/*.md", "Archive/*.org"],
    exclude: [],
    paused: ["Archive/**"],
    inbox: "Inbox",
    archive: "Archive",
    readonly: [],
    hidden: [],
    rules: [],
  };
}
