/**
 * CONTRACT_TESTS #17: sandbox path confinement (SECURITY_AND_PERMISSIONS sandbox rules).
 * These are the bug classes found in the sibling kdpa-llc repositories, so they get direct
 * coverage rather than being left to the backend.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, readdir, writeFile, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { LocalSandbox, confine, assertArgConfined } from "../../src/data-plane/sandbox/local.ts";
import { PathEscape } from "../../src/data-plane/sandbox/adapter.ts";

const runHostCommand = promisify(execFile);

describe("sandbox path confinement", () => {
  test("#17 traversal, symlink escape, and absolute escape are rejected", async () => {
    const root = await mkdtemp(join(tmpdir(), "confine-"));
    await mkdir(join(root, "sub"), { recursive: true });

    // Inside the root: fine.
    assert.equal(confine(root, "sub/file.txt"), join(root, "sub", "file.txt"));
    assert.equal(confine(root, "."), root);

    // Traversal out.
    assert.throws(() => confine(root, "../escape"), PathEscape);
    assert.throws(() => confine(root, "sub/../../escape"), PathEscape);
    // Absolute path elsewhere.
    assert.throws(() => confine(root, "/etc/passwd"), PathEscape);

    // A symlink pointing outside resolves outside, so the resolved target is rejected.
    const outside = await mkdtemp(join(tmpdir(), "outside-"));
    await writeFile(join(outside, "secret.txt"), "s3cret", "utf8");
    await symlink(outside, join(root, "link"));
    assert.throws(() => confine(root, join(root, "link", "..", "..", "etc")), PathEscape);
  });

  test("#17 command arguments are validated without being rewritten", async () => {
    const root = await mkdtemp(join(tmpdir(), "args-"));
    // A grep pattern is not a path and must survive untouched.
    assert.doesNotThrow(() => assertArgConfined(root, "TIMEOUT_MS"));
    assert.doesNotThrow(() => assertArgConfined(root, "workspace/src/app.js"));
    // Traversal and absolute escapes still rejected.
    assert.throws(() => assertArgConfined(root, "../../etc/passwd"), PathEscape);
    assert.throws(() => assertArgConfined(root, "/etc/passwd"), PathEscape);
  });

  test("#17 the sandbox refuses commands outside its allowlist", async () => {
    const sandbox = new LocalSandbox();
    const handle = await sandbox.create({
      execution_id: "e1", agent_id: "a1", mounts: [], grants: [], timeout_seconds: 10,
    });
    const result = await sandbox.exec(handle, ["curl", "https://example.com"]);
    assert.equal(result.code, 126);
    assert.match(result.stderr, /allowlist/);
    await sandbox.destroy(handle);
  });

  test("timeout and output-limit failures return numeric exit codes", async () => {
    const sandbox = new LocalSandbox();
    const handle = await sandbox.create({
      execution_id: "e-limits", agent_id: "a1", mounts: [],
      grants: [{ kind: "fs.read", scope: { paths: ["/"] } }],
      timeout_seconds: 0.05,
    });

    const fifo = join(handle.root, "blocking-fifo");
    await runHostCommand("mkfifo", [fifo]);
    const timedOut = await sandbox.exec(handle, ["cat", "blocking-fifo"]);
    assert.equal(timedOut.code, 124);
    assert.equal(typeof timedOut.code, "number");

    await writeFile(join(handle.root, "large.txt"), "x".repeat(140 * 1024), "utf8");
    const tooLarge = await sandbox.exec(handle, ["cat", "large.txt"]);
    assert.equal(tooLarge.code, 1);
    assert.equal(typeof tooLarge.code, "number");
    await sandbox.destroy(handle);
  });

  test("#17 a command attempting traversal is rejected before running", async () => {
    const sandbox = new LocalSandbox();
    const handle = await sandbox.create({
      execution_id: "e2", agent_id: "a1", mounts: [], grants: [], timeout_seconds: 10,
    });
    await assert.rejects(
      () => sandbox.exec(handle, ["cat", "../../../etc/passwd"]),
      PathEscape,
    );
    await sandbox.destroy(handle);
  });

  test("#17 interpreters and file-bearing utility options cannot read host files", async () => {
    const sandbox = new LocalSandbox();
    const handle = await sandbox.create({
      execution_id: "e-flags", agent_id: "a1", mounts: [], grants: [], timeout_seconds: 10,
    });

    for (const command of [
      ["node", "-e", "console.log(require('node:fs').readFileSync('/etc/passwd','utf8'))"],
      ["find", ".", "-exec", "cat", "/etc/passwd", ";"],
      ["grep", "--file=/etc/passwd", "anything", "."],
      ["wc", "--files0-from=/etc/passwd"],
    ]) {
      const result = await sandbox.exec(handle, command);
      assert.equal(result.code, 126, command.join(" "));
      assert.doesNotMatch(result.stdout, /root:/);
    }
    await sandbox.destroy(handle);
  });

  test("#17 command operands cannot dereference a symlink outside the sandbox", async () => {
    const outside = await mkdtemp(join(tmpdir(), "outside-exec-"));
    await writeFile(join(outside, "secret.txt"), "host secret", "utf8");
    const sandbox = new LocalSandbox();
    const handle = await sandbox.create({
      execution_id: "e-symlink", agent_id: "a1", mounts: [], grants: [], timeout_seconds: 10,
    });
    await symlink(outside, join(handle.root, "escape"));
    await assert.rejects(() => sandbox.exec(handle, ["cat", "escape/secret.txt"]), PathEscape);
    await sandbox.destroy(handle);
  });

  test("#17 mounts reject symlinks instead of importing host references", async () => {
    const source = await mkdtemp(join(tmpdir(), "src-link-"));
    const outside = await mkdtemp(join(tmpdir(), "outside-mount-"));
    await writeFile(join(outside, "secret.txt"), "host secret", "utf8");
    await symlink(join(outside, "secret.txt"), join(source, "secret-link"));
    const sandbox = new LocalSandbox();
    await assert.rejects(
      () => sandbox.create({
        execution_id: "e-mount-link", agent_id: "a1",
        mounts: [{ source, target: "workspace" }],
        grants: [{ kind: "fs.read", scope: { paths: ["/"] } }], timeout_seconds: 10,
      }),
      PathEscape,
    );

    await assert.rejects(
      () => sandbox.create({
        execution_id: "e-narrow-mount-link", agent_id: "a1",
        mounts: [{ source, target: "workspace" }],
        grants: [{ kind: "fs.read", scope: { paths: ["/workspace/secret-link"] } }],
        timeout_seconds: 10,
      }),
      PathEscape,
      "narrowing a mount to the link must not reset its confinement root",
    );

    const scoped = await mkdtemp(join(tmpdir(), "src-scoped-link-"));
    await mkdir(join(scoped, "public"), { recursive: true });
    await mkdir(join(scoped, "private"), { recursive: true });
    await writeFile(join(scoped, "private", "secret.txt"), "scope secret", "utf8");
    await symlink("../private/secret.txt", join(scoped, "public", "innocent.txt"));
    await assert.rejects(
      () => sandbox.create({
        execution_id: "e-cross-scope-link", agent_id: "a1",
        mounts: [{ source: scoped, target: "workspace" }],
        grants: [{ kind: "fs.read", scope: { paths: ["/workspace/public"] } }],
        timeout_seconds: 10,
      }),
      PathEscape,
      "an internal symlink cannot import data from outside its granted subtree",
    );
  });

  test("a failed create and destroy both remove their temporary workspace", async () => {
    const source = await mkdtemp(join(tmpdir(), "src-cleanup-"));
    const outside = await mkdtemp(join(tmpdir(), "outside-cleanup-"));
    await symlink(outside, join(source, "escape"));
    const sandbox = new LocalSandbox();
    const failedId = `cleanup-failed-${process.pid}-${Date.now()}`;
    await assert.rejects(
      () => sandbox.create({
        execution_id: failedId, agent_id: "a1",
        mounts: [{ source, target: "workspace" }],
        grants: [{ kind: "fs.read", scope: { paths: ["/"] } }], timeout_seconds: 10,
      }),
      PathEscape,
    );
    assert.equal(
      (await readdir(tmpdir())).some((name) => name.startsWith(`peers-${failedId}-`)),
      false,
    );

    const handle = await sandbox.create({
      execution_id: `cleanup-destroy-${process.pid}-${Date.now()}`,
      agent_id: "a1", mounts: [], grants: [], timeout_seconds: 10,
    });
    await sandbox.destroy(handle);
    await assert.rejects(() => access(handle.root), { code: "ENOENT" });
  });

  test("only files under the per-execution output directory are collected", async () => {
    const sandbox = new LocalSandbox();
    const handle = await sandbox.create({
      execution_id: "e3", agent_id: "a1", mounts: [], grants: [], timeout_seconds: 10,
    });
    // A file outside outputs/ must not be collected.
    await writeFile(join(handle.root, "scratch.txt"), "ignore me", "utf8");
    await LocalSandbox.writeOutput(handle, "report.md", "# findings");

    const artifacts = await sandbox.collectArtifacts(handle);
    assert.equal(artifacts.length, 1);
    assert.match(artifacts[0]!.uri, /outputs\/report\.md$/);
    assert.ok(artifacts[0]!.content_hash, "artifacts are hashed");
    await sandbox.destroy(handle);
    assert.equal(
      await readFile(artifacts[0]!.uri, "utf8"),
      "# findings",
      "collected artifacts survive execution-root cleanup",
    );
  });

  test("artifact collection rejects a symlink to a host file", async () => {
    const outside = await mkdtemp(join(tmpdir(), "outside-artifact-"));
    const secret = join(outside, "secret.txt");
    await writeFile(secret, "host secret", "utf8");
    const sandbox = new LocalSandbox();
    const handle = await sandbox.create({
      execution_id: "e-artifact-link", agent_id: "a1", mounts: [], grants: [], timeout_seconds: 10,
    });
    await symlink(secret, join(handle.outputDir, "leak.txt"));
    await assert.rejects(() => sandbox.collectArtifacts(handle), PathEscape);
    await sandbox.destroy(handle);
  });

  test("failed artifact collection leaves no partial durable files", async () => {
    const outside = await mkdtemp(join(tmpdir(), "outside-artifact-atomic-"));
    const artifactRoot = await mkdtemp(join(tmpdir(), "durable-artifact-atomic-"));
    const sandbox = new LocalSandbox({ artifactRoot });
    const handle = await sandbox.create({
      execution_id: "e-artifact-atomic", agent_id: "a1", mounts: [], grants: [], timeout_seconds: 10,
    });
    await LocalSandbox.writeOutput(handle, "a-valid.txt", "must not survive a failed collection");
    await writeFile(join(outside, "secret.txt"), "host secret", "utf8");
    await symlink(join(outside, "secret.txt"), join(handle.outputDir, "z-invalid.txt"));

    await assert.rejects(() => sandbox.collectArtifacts(handle), PathEscape);
    assert.deepEqual(await readdir(artifactRoot), []);
    await sandbox.destroy(handle);
  });

  test("write_file is confined to outputs and requires fs.write", async () => {
    const sandbox = new LocalSandbox();
    const readOnly = await sandbox.create({
      execution_id: "e-write-denied", agent_id: "a1", mounts: [], grants: [], timeout_seconds: 10,
    });
    const denied = await sandbox.exec(readOnly, ["write_file", "outputs/x.txt", "nope"]);
    assert.equal(denied.code, 126);
    await sandbox.destroy(readOnly);

    const writable = await sandbox.create({
      execution_id: "e-write", agent_id: "a1", mounts: [],
      grants: [{ kind: "fs.write", scope: { paths: ["/"] } }], timeout_seconds: 10,
    });
    const written = await sandbox.exec(writable, ["write_file", "outputs/x.txt", "safe output"]);
    assert.equal(written.code, 0);
    assert.equal(await readFile(join(writable.outputDir, "x.txt"), "utf8"), "safe output");
    await assert.rejects(
      () => sandbox.exec(writable, ["write_file", "../outside.txt", "escape"]),
      PathEscape,
    );

    const outside = await mkdtemp(join(tmpdir(), "outside-write-"));
    const victim = join(outside, "victim.txt");
    await writeFile(victim, "unchanged", "utf8");
    await symlink(victim, join(writable.outputDir, "link.txt"));
    await assert.rejects(
      () => sandbox.exec(writable, ["write_file", "outputs/link.txt", "overwrite"]),
      PathEscape,
    );
    assert.equal(await readFile(victim, "utf8"), "unchanged");
    await sandbox.destroy(writable);
  });

  test("mounted inputs are readable inside the sandbox", async () => {
    const source = await mkdtemp(join(tmpdir(), "src-"));
    await writeFile(join(source, "data.txt"), "hello from the mount", "utf8");
    await symlink("data.txt", join(source, "internal-link.txt"));

    const sandbox = new LocalSandbox();
    const handle = await sandbox.create({
      execution_id: "e4", agent_id: "a1",
      mounts: [{ source, target: "workspace" }],
      grants: [{ kind: "fs.read", scope: { paths: ["/"] } }], timeout_seconds: 10,
    });
    const out = await sandbox.exec(handle, ["cat", "workspace/data.txt"]);
    assert.equal(out.code, 0);
    assert.match(out.stdout, /hello from the mount/);
    const linked = await sandbox.exec(handle, ["cat", "workspace/internal-link.txt"]);
    assert.equal(linked.code, 0);
    assert.match(linked.stdout, /hello from the mount/);
    await sandbox.destroy(handle);
  });

  test("filesystem grants are enforced at virtual sandbox paths", async () => {
    const source = await mkdtemp(join(tmpdir(), "src-scoped-"));
    await mkdir(join(source, "src"), { recursive: true });
    await writeFile(join(source, "src", "allowed.txt"), "allowed", "utf8");
    await writeFile(join(source, "sibling.txt"), "denied", "utf8");

    const sandbox = new LocalSandbox();
    const handle = await sandbox.create({
      execution_id: "e-scoped", agent_id: "a1",
      mounts: [{ source, target: "workspace" }],
      grants: [{ kind: "fs.read", scope: { paths: ["/workspace/src"] } }],
      timeout_seconds: 10,
    });

    assert.equal((await sandbox.exec(handle, ["cat", "workspace/src/allowed.txt"])).code, 0);
    const denied = await sandbox.exec(handle, ["cat", "workspace/sibling.txt"]);
    assert.equal(denied.code, 126);
    assert.match(denied.stderr, /fs\.read is not granted/);
    await sandbox.destroy(handle);
  });

  test("mount snapshots omit common credential and local-state files", async () => {
    const source = await mkdtemp(join(tmpdir(), "src-secrets-"));
    await writeFile(join(source, "public.txt"), "public", "utf8");
    await writeFile(join(source, ".env"), "TOKEN=secret", "utf8");
    await writeFile(join(source, ".envrc"), "TOKEN=secret", "utf8");
    await writeFile(join(source, ".env-production"), "TOKEN=secret", "utf8");
    await symlink(".env", join(source, "innocent-name.txt"));
    await writeFile(join(source, ".npmrc"), "//registry/:_authToken=secret", "utf8");
    await writeFile(join(source, "private.pem"), "secret", "utf8");
    await mkdir(join(source, ".git"), { recursive: true });
    await writeFile(join(source, ".git", "config"), "credential = secret", "utf8");

    const sandbox = new LocalSandbox();
    const handle = await sandbox.create({
      execution_id: "e-secrets", agent_id: "a1",
      mounts: [{ source, target: "workspace" }],
      grants: [{ kind: "fs.read", scope: { paths: ["/"] } }], timeout_seconds: 10,
    });

    assert.equal((await sandbox.exec(handle, ["cat", "workspace/public.txt"])).code, 0);
    for (const name of [
      ".env", ".envrc", ".env-production", "innocent-name.txt", ".npmrc", "private.pem", ".git",
    ]) {
      await assert.rejects(() => access(join(handle.root, "workspace", name)), /ENOENT/);
    }
    await sandbox.destroy(handle);
  });

  test("a sandbox without fs.read receives no workspace snapshot", async () => {
    const source = await mkdtemp(join(tmpdir(), "src-no-read-"));
    await writeFile(join(source, "data.txt"), "not mounted", "utf8");
    const sandbox = new LocalSandbox();
    const handle = await sandbox.create({
      execution_id: "e-no-read", agent_id: "a1",
      mounts: [{ source, target: "workspace" }], grants: [], timeout_seconds: 10,
    });
    await assert.rejects(() => access(join(handle.root, "workspace")), /ENOENT/);
    await sandbox.destroy(handle);
  });
});
