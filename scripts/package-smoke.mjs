import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
  const start = output.lastIndexOf("\n[");
  const json = start >= 0 ? output.slice(start + 1) : output.slice(output.indexOf("["));
  const parsed = JSON.parse(json);
  assert.equal(parsed.length, 1, "npm pack should create exactly one tarball");
  return parsed[0];
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
    "dist/index.d.ts",
    "dist/index.js",
    "docs/specs/agent.schema.json",
    "examples/agent.json",
    "examples/task.json",
    "LICENSE",
    "package.json",
    "README.md",
  ]) {
    assert(paths.has(expected), `packed artifact is missing ${expected}`);
  }
  assert(
    [...paths].every((path) => !path.startsWith("src/") && !path.startsWith("tests/")),
    "packed artifact must not contain TypeScript sources or tests",
  );

  await mkdir(installRoot);
  await writeFile(
    join(installRoot, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  const tarball = join(temporaryRoot, packed.filename);
  run(npm, [
    "install", "--ignore-scripts", "--no-audit", "--no-fund", "--cache", cache, tarball,
  ], { cwd: installRoot });

  const importOutput = run(process.execPath, [
    "--input-type=module",
    "--eval",
    [
      'import { AgentRuntime, ControlPlane, LocalSandbox, Observer, Store } from "@kdpa-llc/peers";',
      "for (const value of [AgentRuntime, ControlPlane, LocalSandbox, Observer, Store]) {",
      '  if (typeof value !== "function") throw new Error("public API export is missing");',
      "}",
      'if (!import.meta.resolve("@kdpa-llc/peers/schemas/agent.schema.json")) {',
      '  throw new Error("schema export is missing");',
      "}",
      'console.log("public API loaded");',
    ].join("\n"),
  ], { cwd: installRoot });
  assert.match(importOutput, /public API loaded/);

  const typeProbe = join(installRoot, "consumer.mts");
  await writeFile(typeProbe, [
    'import { Scheduler, Store, type Agent } from "@kdpa-llc/peers";',
    "const store: Store = new Store();",
    "const agent: Agent | undefined = store.listAgents()[0];",
    "void agent;",
    "void new Scheduler({ drain: async () => 0 });",
    "store.close();",
  ].join("\n"));
  run(process.execPath, [
    join(root, "node_modules", "typescript", "bin", "tsc"),
    "--noEmit",
    "--strict",
    "--target", "ES2023",
    "--module", "NodeNext",
    "--moduleResolution", "NodeNext",
    "--typeRoots", join(root, "node_modules", "@types"),
    typeProbe,
  ], { cwd: installRoot });

  const executable = process.platform === "win32"
    ? join(installRoot, "node_modules", ".bin", "peers.cmd")
    : join(installRoot, "node_modules", ".bin", "peers");
  const cliEnvironment = {
    ...process.env,
    PEERS_ARTIFACTS: join(temporaryRoot, "artifacts"),
    PEERS_DB: join(temporaryRoot, "smoke.db"),
  };
  const helpOutput = run(executable, ["--help"], { cwd: installRoot, env: cliEnvironment });
  assert.match(helpOutput, /Usage:/);
  assert.match(helpOutput, /agent create/);
  assert.equal(
    run(executable, ["--version"], { cwd: installRoot, env: cliEnvironment }).trim(),
    packed.version,
  );
  const cliOutput = run(executable, ["--scripted", "org"], {
    cwd: installRoot,
    env: cliEnvironment,
  });
  assert.match(cliOutput, /no agents yet/);
  assert.doesNotMatch(cliOutput, /\[(?:0|1|2)m/, "non-TTY output must not contain ANSI fragments");

  const installedManifest = JSON.parse(
    await readFile(join(installRoot, "node_modules", "@kdpa-llc", "peers", "package.json"), "utf8"),
  );
  assert.equal(installedManifest.private, true, "publishing must remain disabled until launch approval");
  console.log(`Package smoke passed: ${packed.filename} (${packed.size} bytes)`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
