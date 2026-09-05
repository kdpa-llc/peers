/**
 * Local-process sandbox backend — the test/dev backend (roadmap Phase 4).
 *
 * Isolation here is filesystem confinement plus an explicit command allowlist, not kernel
 * isolation; a container backend implements the same interface for real execution. The
 * path rules are enforced here because SECURITY_AND_PERMISSIONS requires every backend to
 * inherit them.
 */
import { execFile } from "node:child_process";
import {
  copyFile,
  lstat,
  mkdtemp,
  mkdir,
  open,
  readdir,
  realpath,
  rm,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep, isAbsolute } from "node:path";
import { promisify } from "node:util";
import type { Artifact, Permission, PermissionKind } from "../../domain/types.ts";
import { validGrants } from "../../control-plane/permissions.ts";
import type { ExecResult, Sandbox, SandboxHandle, SandboxSpec } from "./adapter.ts";
import { PathEscape } from "./adapter.ts";

const run = promisify(execFile);

const MAX_COMMAND_OUTPUT_BYTES = 128 * 1024;
const MAX_ARTIFACT_BYTES = 1024 * 1024;
const MAX_WRITE_BYTES = 256 * 1024;

/** Files that are credentials or local platform state are never imported by this backend. */
const SENSITIVE_NAMES = new Set([
  ".git", ".npmrc", ".pypirc", ".netrc", "credentials.json", "service-account.json",
  ".git-credentials", ".gitconfig", ".ssh", ".gnupg", ".aws",
  "id_rsa", "id_ed25519", ".peers.db", ".peers-artifacts",
  ".ai-peers.db", ".ai-peers-artifacts",
]);

function sensitiveMountEntry(path: string): boolean {
  const name = basename(path).toLowerCase();
  return SENSITIVE_NAMES.has(name)
    || name.startsWith(".env")
    || /^credentials.*\.json$/.test(name)
    || /^service-account.*\.json$/.test(name)
    || /\.(?:pem|key|p12|pfx|jks|keystore|sqlite|sqlite3|db)$/.test(name);
}

/** Commands a worker may execute. A blocklist would not be sufficient. */
const ALLOWED_COMMANDS = new Set(["ls", "cat", "grep", "wc", "head", "tail", "echo"]);

type SandboxState = {
  root: string;
  outputDir: string;
  grants: SandboxSpec["grants"];
  timeoutMs: number;
};

type ReadableMount = SandboxSpec["mounts"][number] & {
  sourceRoot: string;
  /** True when this is only a grant-selected subtree of the declared mount. */
  narrowed: boolean;
};

/**
 * Copy a mount without preserving symbolic links. Links that resolve within the declared
 * source are copied as regular files/directories; links outside it are rejected. This keeps
 * ordinary repository links usable without importing a host reference into the sandbox.
 */
async function copyMount(
  source: string,
  target: string,
  sourceRoot: string,
  scopeRoot: string,
  ancestors: ReadonlySet<string> = new Set(),
): Promise<void> {
  if (sensitiveMountEntry(source)) return;
  const canonical = await realpath(source);
  confine(sourceRoot, canonical);
  // A symlink inside a granted subtree must not smuggle in a sibling that the fs.read
  // scope excluded, even when both paths live under the wider declared mount.
  confine(scopeRoot, canonical);
  if (sensitiveMountEntry(canonical)) return;
  const st = await lstat(canonical);
  if (st.isDirectory()) {
    if (ancestors.has(canonical)) throw new PathEscape(source, sourceRoot);
    await mkdir(target, { recursive: true });
    const nextAncestors = new Set(ancestors).add(canonical);
    for (const entry of await readdir(source)) {
      await copyMount(join(source, entry), join(target, entry), sourceRoot, scopeRoot, nextAncestors);
    }
    return;
  }
  if (!st.isFile()) throw new Error(`mount source '${source}' is not a regular file or directory`);
  await copyFile(canonical, target);
}

/** Resolve `p` under `root`, rejecting anything that escapes. */
export function confine(root: string, p: string): string {
  const base = resolve(root);
  const target = isAbsolute(p) ? resolve(p) : resolve(base, p);
  if (target !== base && !target.startsWith(base.endsWith(sep) ? base : base + sep)) {
    throw new PathEscape(p, base);
  }
  return target;
}

/**
 * Validate a command argument without rewriting it.
 *
 * Rewriting every non-flag argument to an absolute path corrupts arguments that are not
 * paths at all, such as a grep pattern. Since the child process runs with cwd set to the
 * sandbox root, relative paths already resolve inside it. Lexical escapes are rejected
 * here; existing operands receive a separate canonical/symlink check before execution.
 */
export function assertArgConfined(root: string, arg: string): void {
  if (arg.split(/[/\\]/).includes("..")) throw new PathEscape(arg, resolve(root));
  if (isAbsolute(arg)) confine(root, arg);
}

/** Resolve an existing command operand, including symlinks, and verify its final target. */
async function assertPathOperandConfined(root: string, operand: string): Promise<void> {
  assertArgConfined(root, operand);
  const lexical = confine(root, operand);
  try {
    confine(root, await realpath(lexical));
  } catch (err) {
    const e = err as { code?: string };
    // Preserve normal command behavior for a missing operand. Every existing target,
    // including one reached through a symlink, must canonicalize inside the root.
    if (e.code !== "ENOENT") throw err;
  }
}

class UnsupportedOption extends Error {}

function unsupportedOption(bin: string, arg: string): UnsupportedOption {
  return new UnsupportedOption(`command '${bin}' option '${arg}' is not allowed by the sandbox`);
}

/**
 * Return the filesystem operands of a supported utility. Only options with no file-bearing
 * values are accepted: flags such as grep --file, wc --files0-from and find -exec otherwise
 * turn an apparently confined argument vector into arbitrary host access.
 */
function validatedCommand(bin: string, args: string[]): { args: string[]; paths: string[] } {
  if (bin === "echo") return { args, paths: [] };

  if (bin === "ls" || bin === "cat" || bin === "wc") {
    const safe = bin === "ls" ? /^-[alA1dF]+$/ : bin === "cat" ? /^-[nbsvET]+$/ : /^-[clmwL]+$/;
    const flags: string[] = [];
    const paths: string[] = [];
    let options = true;
    for (const arg of args) {
      if (options && arg === "--") { options = false; continue; }
      if (options && arg.startsWith("-")) {
        if (!safe.test(arg)) throw unsupportedOption(bin, arg);
        flags.push(arg);
        continue;
      }
      options = false;
      paths.push(arg);
    }
    return { args: paths.length ? [...flags, "--", ...paths] : flags, paths };
  }

  if (bin === "grep") {
    const flags: string[] = [];
    const paths: string[] = [];
    let options = true;
    let pattern: string | undefined;
    for (const arg of args) {
      if (options && arg === "--") { options = false; continue; }
      if (options && pattern === undefined && arg.startsWith("-")) {
        if (!/^-[nivHhEF]+$/.test(arg)) throw unsupportedOption(bin, arg);
        flags.push(arg);
        continue;
      }
      if (pattern === undefined) { pattern = arg; options = false; continue; }
      paths.push(arg);
    }
    if (pattern === undefined) return { args: flags, paths: [] };
    return { args: [...flags, "--", pattern, ...paths], paths };
  }

  // head/tail: permit only bounded byte/line counts. File-bearing and streaming options
  // are deliberately unavailable in the local backend.
  const paths: string[] = [];
  const flags: string[] = [];
  let options = true;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (options && arg === "--") { options = false; continue; }
    if (options && (arg === "-n" || arg === "-c")) {
      const count = args[++i];
      if (count === undefined || !/^[+-]?\d+$/.test(count)) throw unsupportedOption(bin, arg);
      flags.push(arg, count);
      continue;
    }
    if (options && (/^-[nc][+-]?\d+$/.test(arg) || /^-\d+$/.test(arg))) {
      flags.push(arg);
      continue;
    }
    if (options && arg.startsWith("-")) throw unsupportedOption(bin, arg);
    options = false;
    paths.push(arg);
  }
  return { args: paths.length ? [...flags, "--", ...paths] : flags, paths };
}

/** Permission paths are virtual sandbox paths rooted at `/`, never host paths. */
function virtualPath(root: string, operand: string): string {
  const confined = confine(root, operand);
  const rel = relative(resolve(root), confined).split(sep).join("/");
  return rel ? `/${rel}` : "/";
}

function pathGranted(grants: Permission[], kind: PermissionKind, path: string): boolean {
  const requested = resolve("/", path);
  return grants.some((grant) => {
    if (grant.kind !== kind) return false;
    return (grant.scope?.paths ?? []).some((root) => {
      const allowed = resolve("/", root);
      return requested === allowed || requested.startsWith(allowed.endsWith(sep) ? allowed : allowed + sep);
    });
  });
}

function virtualWithin(child: string, parent: string): boolean {
  const c = resolve("/", child);
  const p = resolve("/", parent);
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

/** Reduce a declared mount to the portions covered by fs.read scopes. */
function readableMounts(
  mount: SandboxSpec["mounts"][number],
  grants: Permission[],
): ReadableMount[] {
  const target = resolve("/", mount.target);
  const scopes = grants
    .filter((grant) => grant.kind === "fs.read")
    .flatMap((grant) => grant.scope?.paths ?? [])
    .map((path) => resolve("/", path));

  if (scopes.some((scope) => virtualWithin(target, scope))) {
    return [{ ...mount, sourceRoot: mount.source, narrowed: false }];
  }

  const narrowed = scopes
    .filter((scope) => virtualWithin(scope, target))
    .sort((a, b) => a.length - b.length)
    .filter((scope, index, all) => !all.slice(0, index).some((parent) => virtualWithin(scope, parent)))
    .map((scope) => {
      const rel = relative(target, scope);
      return {
        source: confine(mount.source, rel),
        target: join(mount.target, rel),
        sourceRoot: mount.source,
        narrowed: true,
      };
    });
  return narrowed;
}

export class LocalSandbox implements Sandbox {
  readonly name = "local";
  private readonly states = new Map<string, SandboxState>();
  private readonly configuredArtifactRoot?: string;
  private artifactRoot?: Promise<string>;

  constructor(opts: { artifactRoot?: string } = {}) {
    this.configuredArtifactRoot = opts.artifactRoot;
  }

  /** Durable output storage is separate from the execution root that destroy removes. */
  private durableArtifactRoot(): Promise<string> {
    this.artifactRoot ??= this.configuredArtifactRoot
      ? mkdir(this.configuredArtifactRoot, { recursive: true })
        .then(() => realpath(this.configuredArtifactRoot!))
      : mkdtemp(join(tmpdir(), "peers-artifacts-")).then((root) => realpath(root));
    return this.artifactRoot;
  }

  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    const root = await mkdtemp(join(tmpdir(), `peers-${spec.execution_id}-`));
    const real = await realpath(root);
    try {
      // Sandbox is a public backend boundary, so do not assume every caller came through the
      // control plane or CLI validator. Invalid alternatives confer no filesystem authority.
      const grants = validGrants(spec.grants);
      const outputDir = join(real, "outputs");
      await mkdir(outputDir, { recursive: true });

      const mounts = spec.mounts.flatMap((mount) => readableMounts(mount, grants));
      for (const m of mounts) {
        const target = confine(real, m.target);
        await mkdir(dirname(target), { recursive: true });
        const st = await lstat(m.source).catch(() => undefined);
        if (!st) continue;
        // If the grant names a symlink as its subtree root, canonicalizing that link would
        // silently turn its target into the new authority boundary. Reject it instead.
        if (m.narrowed && st.isSymbolicLink()) throw new PathEscape(m.source, m.sourceRoot);
        const sourceRoot = await realpath(m.sourceRoot);
        const scopeRoot = m.narrowed ? await realpath(m.source) : sourceRoot;
        await copyMount(m.source, target, sourceRoot, scopeRoot);
      }

      const handle: SandboxHandle = { id: `sbx-${spec.execution_id}`, root: real, outputDir };
      this.states.set(handle.id, {
        root: real,
        outputDir,
        grants,
        timeoutMs: Math.max(1, Math.min(15_000, spec.timeout_seconds * 1000)),
      });
      return handle;
    } catch (err) {
      await rm(real, { recursive: true, force: true });
      throw err;
    }
  }

  async exec(handle: SandboxHandle, command: string[]): Promise<ExecResult> {
    const [bin, ...args] = command;
    if (!bin) return { code: 1, stdout: "", stderr: "empty command" };
    const state = this.states.get(handle.id);
    if (!state || state.root !== handle.root || state.outputDir !== handle.outputDir) {
      return { code: 126, stdout: "", stderr: "unknown sandbox handle" };
    }

    // Safe replacement for interpreter-based file creation. The operation is deliberately
    // limited to outputs/ and cannot write through a symbolic link.
    if (bin === "write_file") {
      if (args.length !== 2) {
        return { code: 2, stdout: "", stderr: "usage: write_file outputs/<name> <content>" };
      }
      const [name, content] = args as [string, string];
      assertArgConfined(handle.root, name);
      const target = confine(handle.outputDir, confine(handle.root, name));
      if (!pathGranted(state.grants, "fs.write", virtualPath(handle.root, target))) {
        return { code: 126, stdout: "", stderr: `fs.write is not granted for ${virtualPath(handle.root, target)}` };
      }
      if (Buffer.byteLength(content, "utf8") > MAX_WRITE_BYTES) {
        return { code: 126, stdout: "", stderr: `write exceeds ${MAX_WRITE_BYTES} byte limit` };
      }
      const parent = await realpath(dirname(target));
      confine(handle.outputDir, parent);
      try {
        const file = await open(
          target,
          constants.O_CREAT | constants.O_TRUNC | constants.O_WRONLY | constants.O_NOFOLLOW,
          0o600,
        );
        try { await file.writeFile(content, "utf8"); } finally { await file.close(); }
        return { code: 0, stdout: "", stderr: "" };
      } catch (err) {
        const e = err as { code?: string; message?: string };
        if (e.code === "ELOOP") throw new PathEscape(name, handle.outputDir);
        return { code: 1, stdout: "", stderr: e.message ?? "write failed" };
      }
    }

    if (!ALLOWED_COMMANDS.has(bin)) {
      return { code: 126, stdout: "", stderr: `command '${bin}' is not on the sandbox allowlist` };
    }
    try {
      const validated = validatedCommand(bin, args);
      const operands = validated.paths.length > 0
        ? validated.paths
        : bin === "ls" ? ["."] : [];
      for (const operand of operands) {
        await assertPathOperandConfined(handle.root, operand);
        const requested = virtualPath(handle.root, operand);
        if (!pathGranted(state.grants, "fs.read", requested)) {
          return { code: 126, stdout: "", stderr: `fs.read is not granted for ${requested}` };
        }
      }
      args.splice(0, args.length, ...validated.args);
    } catch (err) {
      if (err instanceof UnsupportedOption) {
        return { code: 126, stdout: "", stderr: err.message };
      }
      throw err;
    }
    try {
      const { stdout, stderr } = await run(bin, args, {
        cwd: handle.root,
        timeout: state.timeoutMs,
        maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
        env: { PATH: "/usr/bin:/bin", HOME: handle.root },
      });
      return { code: 0, stdout, stderr };
    } catch (err) {
      const e = err as {
        code?: unknown; killed?: boolean; stdout?: string; stderr?: string; message?: string;
      };
      // execFile uses string/null codes for timeout, maxBuffer, and spawn failures even
      // though the sandbox contract requires a numeric process-style result.
      const code = typeof e.code === "number" ? e.code : e.killed ? 124 : 1;
      return { code, stdout: e.stdout ?? "", stderr: e.stderr ?? e.message ?? "" };
    }
  }

  /** Only files under the per-execution output directory are collected. */
  async collectArtifacts(handle: SandboxHandle): Promise<Artifact[]> {
    const state = this.states.get(handle.id);
    if (!state || state.root !== handle.root || state.outputDir !== handle.outputDir) {
      throw new Error("unknown sandbox handle");
    }
    const names = (await readdir(handle.outputDir).catch(() => [] as string[])).sort();
    const candidates: { name: string; sourcePath: string; bytes: Buffer }[] = [];

    // Validate and read every candidate before making any durable write. Otherwise a bad
    // later entry (for example a symlink) could leave earlier files orphaned in storage
    // even though collection failed as a whole.
    for (const name of names) {
      const p = confine(handle.outputDir, name);
      const st = await lstat(p);
      if (st.isSymbolicLink()) throw new PathEscape(p, handle.outputDir);
      if (!st.isFile()) continue;
      if (st.size > MAX_ARTIFACT_BYTES) {
        throw new Error(`artifact '${name}' exceeds ${MAX_ARTIFACT_BYTES} byte limit`);
      }
      const file = await open(p, constants.O_RDONLY | constants.O_NOFOLLOW);
      const bytes = await file.readFile().finally(() => file.close());
      if (bytes.byteLength > MAX_ARTIFACT_BYTES) {
        throw new Error(`artifact '${name}' exceeds ${MAX_ARTIFACT_BYTES} byte limit`);
      }
      candidates.push({ name, sourcePath: p, bytes });
    }
    if (candidates.length === 0) return [];

    const artifactRoot = await this.durableArtifactRoot();
    const intendedExecutionDir = join(artifactRoot, basename(handle.root));
    const intendedDurableDir = join(intendedExecutionDir, "outputs");
    const out: Artifact[] = [];
    let ownsExecutionDir = false;
    try {
      // Claim a unique directory without `recursive`: a duplicate/concurrent collection
      // must fail without deleting files successfully published by the first collector.
      await mkdir(intendedExecutionDir);
      ownsExecutionDir = true;
      await mkdir(intendedDurableDir);
      const durableDir = await realpath(intendedDurableDir);
      confine(artifactRoot, durableDir);
      for (const candidate of candidates) {
        const durablePath = confine(durableDir, candidate.name);
        const durable = await open(
          durablePath,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
          0o600,
        );
        try { await durable.writeFile(candidate.bytes); } finally { await durable.close(); }
        out.push({
          // Do not truncate this identity: a collision would make the control plane treat
          // a newly persisted file as an existing artifact and leave the new file orphaned.
          artifact_id: `art-${createHash("sha256").update(candidate.sourcePath).digest("hex")}`,
          kind: "file",
          uri: durablePath,
          content_hash: createHash("sha256").update(candidate.bytes).digest("hex"),
          created_at: new Date().toISOString(),
        });
      }
    } catch (err) {
      // The directory name includes mkdtemp entropy and belongs to this execution only.
      if (ownsExecutionDir) {
        await rm(intendedExecutionDir, { recursive: true, force: true }).catch(() => undefined);
      }
      throw err;
    }
    return out;
  }

  async destroy(handle: SandboxHandle): Promise<void> {
    const state = this.states.get(handle.id);
    this.states.delete(handle.id);
    if (state?.root === handle.root) {
      await rm(state.root, { recursive: true, force: true });
    }
  }

  /** Test helper: write a file into the sandbox output dir. */
  static async writeOutput(handle: SandboxHandle, name: string, content: string): Promise<string> {
    const p = confine(handle.outputDir, name);
    const parent = await realpath(dirname(p));
    confine(handle.outputDir, parent);
    const file = await open(
      p,
      constants.O_CREAT | constants.O_TRUNC | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try { await file.writeFile(content, "utf8"); } finally { await file.close(); }
    return p;
  }
}
