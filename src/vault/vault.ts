/**
 * The vault folder: the tree and file kinds (TECHNICAL.md §3). Read-only views of the disk.
 * Folders named like PARA roots are only sorted first in the tree; which folders have agents
 * is the layout's business (layout.ts).
 */
import { lstatSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { extname, rootKindOf, visibleName, type RootKind } from "./paths.ts";

export type Roots = Partial<Record<RootKind, string>>;
export type FileKind = "page" | "image" | "svg" | "pdf" | "text" | "other";

export type TreeNode = {
  name: string;
  path: string;
  type: "dir" | "file";
  kind?: FileKind;
  size?: number;
  mtime?: number;
  root?: RootKind;
  children?: TreeNode[];
};

const ROOT_ORDER: RootKind[] = ["inbox", "projects", "areas", "resources", "archive"];
const MAX_FILE_BYTES = 20 * 1024 * 1024;

export function kindOf(rel: string): FileKind {
  const ext = extname(rel);
  if (ext === ".md" || ext === ".markdown" || ext === ".org") return "page";
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(ext)) return "image";
  if (ext === ".svg") return "svg";
  if (ext === ".pdf") return "pdf";
  if ([".txt", ".csv", ".json"].includes(ext)) return "text";
  return "other";
}

export class Vault {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  /** Top-level folders that are PARA roots. First match in sort order wins. */
  roots(): Roots {
    const roots: Roots = {};
    for (const name of this.dirNames("")) {
      const kind = rootKindOf(name);
      if (kind && !roots[kind]) roots[kind] = name;
    }
    return roots;
  }

  /** Visible, non-link child folders of a folder. */
  dirNames(rel: string): string[] {
    let entries;
    try {
      entries = readdirSync(join(this.root, rel), { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((e) => e.isDirectory() && !e.isSymbolicLink() && visibleName(e.name))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));
  }

  isDir(rel: string): boolean {
    try {
      const st = lstatSync(join(this.root, rel));
      return st.isDirectory() && !st.isSymbolicLink();
    } catch {
      return false;
    }
  }

  isFile(rel: string): boolean {
    try {
      const st = lstatSync(join(this.root, rel));
      return st.isFile();
    } catch {
      return false;
    }
  }

  /** The whole visible tree. Links, dot entries and oversized files are left out. */
  tree(): TreeNode {
    const roots = this.roots();
    const rootOf = new Map(Object.entries(roots).map(([k, v]) => [v, k as RootKind]));
    const walk = (rel: string, depth: number): TreeNode[] => {
      let entries;
      try {
        entries = readdirSync(join(this.root, rel), { withFileTypes: true });
      } catch {
        return [];
      }
      const nodes: TreeNode[] = [];
      for (const e of entries) {
        if (!visibleName(e.name) || e.isSymbolicLink()) continue;
        const path = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (depth > 12) continue;
          nodes.push({
            name: e.name, path, type: "dir",
            ...(depth === 0 && rootOf.has(e.name) ? { root: rootOf.get(e.name) } : {}),
            children: walk(path, depth + 1),
          });
        } else if (e.isFile()) {
          let st;
          try { st = statSync(join(this.root, path)); } catch { continue; }
          if (st.size > MAX_FILE_BYTES) continue;
          if (path.endsWith(".peers-tmp")) continue;
          nodes.push({ name: e.name, path, type: "file", kind: kindOf(path), size: st.size, mtime: st.mtimeMs });
        }
      }
      nodes.sort((a, b) => {
        if (depth === 0) {
          const ra = a.root ? ROOT_ORDER.indexOf(a.root) : 99;
          const rb = b.root ? ROOT_ORDER.indexOf(b.root) : 99;
          if (ra !== rb) return ra - rb;
        }
        if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, { numeric: true });
      });
      return nodes;
    };
    return { name: "", path: "", type: "dir", children: walk("", 0) };
  }

  /** Every visible file path, for scans. */
  files(): { path: string; size: number; mtime: number }[] {
    const out: { path: string; size: number; mtime: number }[] = [];
    const visit = (node: TreeNode): void => {
      if (node.type === "file") out.push({ path: node.path, size: node.size ?? 0, mtime: node.mtime ?? 0 });
      for (const c of node.children ?? []) visit(c);
    };
    visit(this.tree());
    return out;
  }
}
