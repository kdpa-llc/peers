/**
 * CONTRACT_TESTS #1–#3: routing equality, result correlation, exactly-one terminal result.
 * These are the invariants JSON Schema structurally cannot express (ADR 0010, ADR 0007).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Inbox } from "../../src/control-plane/inbox.ts";
import { makeCP, makeManager, MANAGER, stepFor } from "../helpers.ts";
import type { InboxItem, Task, WorkerResult } from "../../src/domain/types.ts";

describe("delivery invariants", () => {
  test("#1 envelope routing fields are derived from the Task, so they always match", () => {
    const { cp, store } = makeCP([]);
    makeManager(cp);
    cp.assignTask({
      sender_id: "human:test", recipient_id: "mgr",
      objective: "do the thing", priority: 7, deadline: "2026-09-01T00:00:00.000Z",
    });

    const items = store.inboxFor("mgr").filter((i) => i.kind === "task");
    assert.equal(items.length, 1);
    const item = items[0]!;
    const task = item.payload as unknown as Task;

    assert.equal(item.sender_id, task.sender_id);
    assert.equal(item.recipient_id, task.recipient_id);
    assert.equal(item.correlation_id, task.correlation_id);
    assert.equal(item.priority, task.priority);
    assert.equal(item.deadline, task.deadline);
    assert.deepEqual(Inbox.routingMatchesTask(item), { ok: true });
  });

  test("#1 a contradicting envelope is detected by the audit check", () => {
    const { cp, store } = makeCP([]);
    makeManager(cp);
    cp.assignTask({ sender_id: "human:test", recipient_id: "mgr", objective: "x", priority: 3 });
    const item = store.inboxFor("mgr").find((i) => i.kind === "task")!;

    // Hand-construct the conflict the write path makes impossible.
    const tampered: InboxItem = { ...item, priority: 99 };
    const verdict = Inbox.routingMatchesTask(tampered);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.field, "priority");
  });

  test("#2 a worker result names both its task and its delegation", async () => {
    const { cp, store } = makeCP([
      stepFor("mgr", "delegate", () => [{
        type: "delegate_task",
        objective: "analyze",
        output_contract: "finding: string",
        granted_permissions: [
          { kind: "fs.read", scope: { paths: ["/"] } },
          { kind: "model.invoke", scope: { budget_usd_per_day: 1 } },
        ],
        budget: { timeout_seconds: 60 },
      }]),
      {
        label: "worker returns",
        when: (r) => r.prompt.includes("ephemeral worker"),
        then: () => [{ type: "return_worker_result", result: { status: "completed", summary: "done" } }],
      },
    ]);
    makeManager(cp);
    cp.assignTask({ sender_id: "human:test", recipient_id: "mgr", objective: "root task" });
    await cp.drain();

    const child = store.listTasks().find((t) => !!t.delegation)!;
    const resultItem = store.inboxFor("mgr").find((i) => i.kind === "delegation_result")!;
    const result = resultItem.payload as unknown as WorkerResult;

    assert.equal(result.task_id, child.task_id);
    assert.equal(result.delegation_id, child.delegation!.delegation_id);
  });

  test("#3 a second terminal result for the same task is rejected", async () => {
    const { cp, store } = makeCP([
      stepFor("mgr", "delegate", () => [{
        type: "delegate_task",
        objective: "analyze",
        output_contract: "finding: string",
        granted_permissions: [
          { kind: "fs.read", scope: { paths: ["/"] } },
          { kind: "model.invoke", scope: { budget_usd_per_day: 1 } },
        ],
        budget: { timeout_seconds: 60 },
      }]),
      {
        label: "worker returns",
        when: (r) => r.prompt.includes("ephemeral worker"),
        then: () => [{ type: "return_worker_result", result: { status: "completed", summary: "done" } }],
      },
    ]);
    makeManager(cp);
    cp.assignTask({ sender_id: "human:test", recipient_id: "mgr", objective: "root task" });
    await cp.drain();

    const child = store.listTasks().find((t) => !!t.delegation)!;
    assert.equal(store.countDelegationResults(child.task_id), 1);

    assert.throws(
      () => cp.inbox.deliverDelegationResult(
        { sender_id: child.recipient_id, recipient_id: "mgr" },
        { task_id: child.task_id, delegation_id: child.delegation!.delegation_id,
          status: "completed", summary: "duplicate" },
      ),
      /exactly one terminal result/,
    );
  });

  test("#3 a worker that crashes still yields exactly one terminal result", async () => {
    const { cp, store } = makeCP([
      stepFor("mgr", "delegate", () => [{
        type: "delegate_task",
        objective: "analyze",
        output_contract: "finding: string",
        granted_permissions: [
          { kind: "fs.read", scope: { paths: ["/"] } },
          { kind: "model.invoke", scope: { budget_usd_per_day: 1 } },
        ],
        budget: { timeout_seconds: 60 },
      }]),
      {
        label: "worker explodes",
        when: (r) => r.prompt.includes("ephemeral worker"),
        then: () => { throw new Error("worker blew up"); },
      },
    ]);
    makeManager(cp);
    cp.assignTask({ sender_id: "human:test", recipient_id: "mgr", objective: "root task" });
    await cp.drain();

    const child = store.listTasks().find((t) => !!t.delegation)!;
    assert.equal(store.countDelegationResults(child.task_id), 1);

    const result = store.inboxFor("mgr")
      .find((i) => i.kind === "delegation_result")!.payload as unknown as WorkerResult;
    assert.equal(result.status, "failed");
    assert.equal(child.status !== "running", true);

    // The manager is not left waiting on a dead worker.
    const stillWaiting = store.listWaits().filter((w) => w.agent_id === "mgr" && w.status === "active");
    assert.equal(stillWaiting.length, 0);
  });

  test("subscriptions gate wake-up without dropping delivery (ADR 0008)", async () => {
    const { cp, store } = makeCP([]);
    cp.createAgent({
      agent_id: "picky",
      name: "Picky",
      responsibility: "only cares about tasks",
      mission: "m",
      permissions: MANAGER,
      subscriptions: { kinds: ["task"], min_priority: 5 },
    });

    cp.inbox.deliverMessage({ sender_id: "human:test", recipient_id: "picky" }, "just chatter");
    cp.assignTask({ sender_id: "human:test", recipient_id: "picky", objective: "low", priority: 1 });

    assert.equal(store.inboxFor("picky").length, 2, "both delivered");
    assert.equal(cp.eligible().length, 0, "neither wakes the agent");

    cp.assignTask({ sender_id: "human:test", recipient_id: "picky", objective: "urgent", priority: 9 });
    assert.equal(cp.eligible().length, 1, "a matching item wakes it");
  });
});
