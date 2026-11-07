/**
 * Path policy for the vault (TECHNICAL.md §4.4, CONTRACT_TESTS #1).
 *
 * One function decides whether a vault-relative path may be used, and every caller — bot
 * tools, the HTTP file API, restore and undo — goes through it. The rules are deliberately
 * blunt: no dot components, no sensitive names, and no symbolic link anywhere on the path,
 * because a link inside the vault can alias another bot's folder or app state while every
 * lexical check still passes.
 */
import { lstatSync } from "node:fs";
import { join } from "node:path";

export class PolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyError";
  }
}

export const PARA_ROOTS = ["inbox", "projects", "areas", "resources", "archive"] as const;
export type RootKind = (typeof PARA_ROOTS)[number];

/** Which PARA root a top-level folder name is, accepting numbered variants. */
export function rootKindOf(name: string): RootKind | undefined {
  const base = name.replace(/^\d+\s*[.\-_ ]\s*/, "").trim().toLowerCase();
  if (base === "archives") return "archive";
  return (PARA_ROOTS as readonly string[]).includes(base) ? (base as RootKind) : undefined;
}

const SENSITIVE = /^(\.env.*|credentials.*\.json|service-account.*\.json|id_rsa.*|id_ed25519.*|.*\.(pem|key|p12|pfx|jks|keystore|sqlite|sqlite3|db|db-wal|db-shm))$/i;

/** Text page types a bot may write. */
export const PAGE_EXTENSIONS = new Set([".md", ".markdown", ".org", ".txt", ".csv"]);

export const MAX_PATH_BYTES = 512;

export function extname(rel: string): string {
  const base = rel.slice(rel.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot).toLowerCase() : "";
}

export function basename(rel: string): string {
  return rel.slice(rel.lastIndexOf("/") + 1);
}

export function dirname(rel: string): string {
  const i = rel.lastIndexOf("/");
  return i < 0 ? "" : rel.slice(0, i);
}

/**
 * Normalise a vault-relative path, or throw. Accepts `/vault/x`, `/x` and `x`. The empty
 * string means the vault root and is allowed only where a folder is expected.
 */
export function normalize(input: string, opts: { allowRoot?: boolean } = {}): string {
  if (typeof input !== "string") throw new PolicyError("path must be a string");
  // Control characters (including NUL) never belong in a vault path.
  if (/[\u0000-\u001f\u007f]/.test(input)) throw new PolicyError("path contains control characters");
  let p = input.replaceAll("\\", "/").trim();
  if (p === "/vault" || p.startsWith("/vault/")) p = p.slice("/vault".length);
  const parts: string[] = [];
  for (const part of p.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") throw new PolicyError("path may not contain '..'");
    if (part.startsWith(".")) throw new PolicyError(`'${part}' is hidden and not available`);
    if (SENSITIVE.test(part)) throw new PolicyError(`'${part}' looks like a credential or database and is not available`);
    parts.push(part);
  }
  const rel = parts.join("/");
  if (!rel && !opts.allowRoot) throw new PolicyError("a file path is required");
  if (Buffer.byteLength(rel, "utf8") > MAX_PATH_BYTES) throw new PolicyError("path is too long");
  return rel;
}

/** Throw when any existing component of `rel` under `root` is a symbolic link. */
export function assertNoSymlink(root: string, rel: string): void {
  if (!rel) return;
  let current = root;
  for (const part of rel.split("/")) {
    current = join(current, part);
    let st;
    try {
      st = lstatSync(current);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return; // the rest does not exist yet
      throw err;
    }
    if (st.isSymbolicLink()) throw new PolicyError(`'${rel}' goes through a symbolic link and is not available`);
  }
}

/** The whole policy for reading or listing. Returns the normalised path. */
export function checkRead(root: string, input: string, opts: { allowRoot?: boolean } = {}): string {
  const rel = normalize(input, opts);
  assertNoSymlink(root, rel);
  return rel;
}

/** Policy for a bot writing text: everything in `checkRead` plus a page extension. */
export function checkBotWrite(root: string, input: string): string {
  const rel = checkRead(root, input);
  if (!PAGE_EXTENSIONS.has(extname(rel))) {
    throw new PolicyError(`bots can only write text pages (${[...PAGE_EXTENSIONS].join(", ")}); '${rel}' is not one`);
  }
  return rel;
}

/** Whether a vault path should appear in listings at all. */
export function visibleName(name: string): boolean {
  return !name.startsWith(".") && !SENSITIVE.test(name) && name !== "node_modules";
}
