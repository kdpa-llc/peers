import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { rewriteDeclarationText } from "./fix-declaration-imports.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

const declarationFixture = [
  'export { One } from "./one.ts";',
  'import "./side-effect.ts";',
  'type Lazy = typeof import("./lazy.ts");',
  'type Required = typeof require("./required.ts");',
  'export type { Declaration } from "./declaration.d.ts";',
].join("\n");
const rewrittenFixture = rewriteDeclarationText(declarationFixture, "package smoke fixture");
for (const specifier of ["one.js", "side-effect.js", "lazy.js", "required.js"]) {
  assert.match(rewrittenFixture, new RegExp(specifier.replace(".", "\\.")));
}
assert.match(rewrittenFixture, /declaration\.d\.ts/);
assert.doesNotMatch(rewrittenFixture, /declaration\.d\.js/);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} exited ${result.status}\n${result.stdout}${result.stderr}`,
    );
  }
  return result.stdout;
}

function packResult(output) {
  // npm 10 prints an array of results; npm 12 prints an object keyed by package name.
  const first = Math.min(...["[", "{"].map((c) => output.indexOf(c)).filter((i) => i >= 0));
  const parsed = JSON.parse(output.slice(first));
  const results = Array.isArray(parsed) ? parsed : Object.values(parsed);
  assert.equal(results.length, 1, "npm pack should create exactly one tarball");
  return results[0];
}

const temporaryRoot = await mkdtemp(join(tmpdir(), "peers-package-smoke-"));
const cache = join(temporaryRoot, "npm-cache");
const installRoot = join(temporaryRoot, "consumer");

try {
  const packed = packResult(run(npm, [
    "pack", "--json", "--pack-destination", temporaryRoot, "--cache", cache,
  ], { cwd: root }));

  const paths = new Set(packed.files.map(({ path }) => path));
  for (const expected of [
    "bin/peers.js",
    "dist/cli/main.js",
    "dist/vault/server.js",
    "dist/vault/markdown.js",
    "dist/vault/org.js",
    "web/index.html",
    "web/app.ts",
    "web/styles/app.css",
    "examples/vault/Welcome.md",
    "container/Containerfile",
    "docs/specs/layout.schema.json",
    "LICENSE",
    "README.md",
  ]) {
    assert.ok(paths.has(expected), `packed artifact is missing ${expected}`);
  }
  // The web client ships as TypeScript modules the server strips at request time (ADR 0002);
  // the Node sources and tests stay out.
  assert.ok(![...paths].some((p) => p.startsWith("src/") || p.startsWith("tests/")),
    "packed artifact must not contain Node TypeScript sources or tests");

  await mkdir(installRoot, { recursive: true });
  await writeFile(join(installRoot, "package.json"), JSON.stringify({ name: "consumer", private: true, type: "module" }));
  run(npm, ["install", "--cache", cache, "--no-audit", "--no-fund", join(temporaryRoot, packed.filename)], { cwd: installRoot });
  const executable = join(installRoot, "node_modules", ".bin", process.platform === "win32" ? "peers.cmd" : "peers");

  const help = run(executable, ["--help"], { cwd: installRoot });
  assert.match(help, /peers up \[dir\]/);
  assert.match(run(executable, ["--version"], { cwd: installRoot }).trim(), /^\d+\.\d+\.\d+/);

  // The installed package serves a vault with demo agents: the shell, a client module
  // stripped of types, and the shared parsers compiled to JavaScript.
  const vaultDir = join(temporaryRoot, "vault");
  const port = 5600 + Math.floor(Math.random() * 300);
  const vault = spawn(executable, ["serve", vaultDir, "--demo", "--scripted", "--no-watch", "--port", String(port),
    "--state-dir", join(temporaryRoot, "vault-state")], { cwd: installRoot, stdio: ["ignore", "pipe", "pipe"] });
  let vaultLog = "";
  vault.stdout.on("data", (d) => { vaultLog += d; });
  vault.stderr.on("data", (d) => { vaultLog += d; });
  try {
    for (let i = 0; i < 100 && !/\?pair=/.test(vaultLog); i++) await new Promise((r) => setTimeout(r, 100));
    assert.match(vaultLog, /\?pair=/, `vault did not start:\n${vaultLog}`);
    for (const [path, type] of [["/", /text\/html/], ["/web/app.ts", /javascript/], ["/src/vault/markdown.ts", /javascript/],
      ["/src/vault/org.ts", /javascript/], ["/src/vault/markdown.js", /javascript/]]) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`);
      assert.equal(res.status, 200, `${path} from the installed package`);
      assert.match(String(res.headers.get("content-type")), type);
    }
  } finally {
    vault.kill("SIGTERM");
  }

  console.log(`Package smoke passed: ${packed.filename} (${packed.size} bytes)`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
