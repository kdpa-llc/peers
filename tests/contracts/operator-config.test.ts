/** Operator creation input is validated before it becomes durable state. */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  agentSpecFromArgs, loadAgentManifest, parseAgentManifest, parseTaskManifest,
  taskSpecFromArgs,
} from "../../src/cli/config.ts";
import { Store } from "../../src/control-plane/store.ts";

const run = promisify(execFile);

describe("operator creation manifests", () => {
  test("the checked-in agent example is executable configuration", async () => {
    const path = resolve("examples/agent.json");
    const agent = await loadAgentManifest(path);
    assert.equal(agent.agent_id, "repo-maintainer");
    assert.deepEqual(
      agent.permissions?.find((permission) => permission.kind === "fs.read")?.scope?.paths,
      ["/workspace"],
    );
  });

  test("system fields and misspelled fields are rejected instead of silently stored", () => {
    const base = {
      agent_id: "maintainer",
      name: "Maintainer",
      responsibility: "Own repository health.",
      mission: "Keep the repository healthy.",
    };
    assert.throws(
      () => parseAgentManifest({ ...base, created_at: "2026-09-05T00:00:00Z" }),
      /unknown field: created_at/,
    );
    assert.throws(
      () => parseAgentManifest({ ...base, responsiblity: "typo" }),
      /unknown field: responsiblity/,
    );
  });

  test("permissions, lifecycle values, and RFC 3339 deadlines are checked", () => {
    const base = {
      agent_id: "maintainer",
      name: "Maintainer",
      responsibility: "Own repository health.",
      mission: "Keep the repository healthy.",
    };
    assert.throws(
      () => parseAgentManifest({ ...base, permissions: [{ kind: "repo.admin" }] }),
      /not a supported permission/,
    );
    assert.throws(
      () => parseAgentManifest({ ...base, lifecycle_state: "running" }),
      /lifecycle_state is not supported/,
    );
    assert.throws(
      () => parseTaskManifest({ recipient_id: "maintainer", objective: "Review", deadline: "tomorrow" }),
      /RFC 3339/,
    );
    assert.throws(
      () => parseTaskManifest({
        recipient_id: "maintainer", objective: "Review", deadline: "2026-02-30T12:00:00Z",
      }),
      /RFC 3339/,
    );
  });

  test("inline CLI fields create the same typed inputs and default to the CLI human", async () => {
    const agent = await agentSpecFromArgs([
      "--id", "maintainer",
      "--name", "Maintainer",
      "--responsibility", "Own repository health.",
      "--mission", "Keep the repository healthy.",
      "--permission", "model.invoke",
      "--permission", "memory.write_own",
    ]);
    assert.deepEqual(agent.permissions?.map((permission) => permission.kind), [
      "model.invoke", "memory.write_own",
    ]);

    const task = await taskSpecFromArgs([
      "--recipient", "maintainer", "--objective", "Review dependencies", "--priority", "3",
      "--constraint", "Do not publish", "--constraint", "Cite evidence",
    ]);
    assert.equal(task.sender_id, "human:cli");
    assert.equal(task.priority, 3);
    assert.deepEqual(task.constraints, ["Do not publish", "Cite evidence"]);
  });

  test("the CLI persists a manifest agent and an inline task in one restartable database", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "peers-config-test-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const db = join(root, "organization.db");
    const nodeArgs = ["--experimental-strip-types", "--no-warnings", "src/cli/main.ts", "--scripted"];
    const env = { ...process.env, PEERS_DB: db };

    await run(process.execPath, [
      ...nodeArgs, "agent", "create", "--file", resolve("examples/agent.json"),
    ], { cwd: process.cwd(), env });
    await assert.rejects(
      () => run(process.execPath, [
        ...nodeArgs, "agent", "create", "--file", resolve("examples/agent.json"),
      ], { cwd: process.cwd(), env }),
      (error: unknown) => {
        const failure = error as { code?: number; stderr?: string };
        return failure.code === 2 && /already exists/.test(failure.stderr ?? "");
      },
    );
    const result = await run(process.execPath, [
      ...nodeArgs, "task", "create", "--recipient", "repo-maintainer",
      "--objective", "Review repository health", "--priority", "4",
    ], { cwd: process.cwd(), env });
    assert.match(result.stdout, /created task task-/);

    const store = new Store(db);
    try {
      assert.equal(store.getAgent("repo-maintainer")?.name, "Repository Maintainer");
      assert.equal(store.getAgent("repo-maintainer")?.revision, 1, "duplicate create did not replace it");
      const [task] = store.listTasks();
      assert.equal(task?.recipient_id, "repo-maintainer");
      assert.equal(task?.sender_id, "human:cli");
      assert.equal(task?.priority, 4);
    } finally {
      store.close();
    }
  });

  test("file and inline fields cannot be mixed", async () => {
    await assert.rejects(
      () => agentSpecFromArgs(["--file", "examples/agent.json", "--id", "other"]),
      /cannot be combined/,
    );
    await assert.rejects(
      () => taskSpecFromArgs(["--file", "examples/task.json", "--priority", "5"]),
      /cannot be combined/,
    );
  });

  test("JSON examples do not contain control-plane-assigned fields", async () => {
    for (const file of ["examples/agent.json", "examples/task.json"]) {
      const value = JSON.parse(await readFile(resolve(file), "utf8")) as Record<string, unknown>;
      for (const key of ["created_at", "updated_at", "revision", "runtime_state", "status", "task_id"]) {
        assert.equal(key in value, false, `${file} must omit ${key}`);
      }
    }
  });
});
