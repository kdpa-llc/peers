/**
 * CONTRACT_TESTS #6–#9: single execution per agent, terminal-record immutability,
 * orphan recovery, and wait cancellation/timeout (ADR 0007, ADR 0009).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { makeCP, makeManager, stepFor } from "../helpers.ts";

describe("execution lifecycle invariants", () => {
  test("#6 a durable agent cannot run two executions concurrently", async () => {
    const { cp, store } = makeCP([
      stepFor("mgr", "noop", () => [{ type: "note", text: "thinking" }], { repeatable: true }),
    ]);
    makeManager(cp);
    cp.assignTask({ sender_id: "human:test", recipient_id: "mgr", objective: "one" });
    cp.assignTask({ sender_id: "human:test", recipient_id: "mgr", objective: "two" });

    // Two items are pending, but eligibility yields the agent at most once per tick.
    assert.equal(store.pendingInbox("mgr").length, 2);
    assert.equal(cp.eligible().length, 1);

    await cp.tick();
    // Nothing is left running after a tick, and each execution handled one item.
    assert.equal(store.runningExecutions("mgr").length, 0);
    await cp.drain();
    assert.equal(store.listExecutions("mgr").length, 2, "serialized, not concurrent");
  });

  test("#6 starting a second execution while one runs is rejected", async () => {
    const { cp, store } = makeCP([]);
    makeManager(cp);
    // Simulate an execution in flight.
    store.putExecution({
      execution_id: "exec-inflight", agent_id: "mgr",
      trigger: { type: "human" }, status: "running", started_at: "2026-08-17T12:00:00.000Z",
    });
    await assert.rejects(
      () => cp.runExecution("mgr", { type: "human" }),
      /already has an execution in flight/,
    );
  });

  test("#7 a terminal execution is never mutated; a retry is a new record", async () => {
    const { cp, store } = makeCP([
      stepFor("mgr", "boom", () => { throw new Error("kaboom"); }),
    ]);
    makeManager(cp);
    cp.assignTask({ sender_id: "human:test", recipient_id: "mgr", objective: "will fail" });
    await cp.drain();

    const failed = store.listExecutions("mgr").find((e) => e.status === "failed")!;
    assert.equal(failed.error?.reason, "runtime_error");
    const before = JSON.stringify(failed);

    const retried = await cp.retry(failed.execution_id);
    assert.ok(retried, "a retry was created");
    assert.notEqual(retried!.execution_id, failed.execution_id, "new record");
    assert.equal(retried!.retry_of, failed.execution_id);
    assert.equal(retried!.trigger.type, "retry");

    const after = JSON.stringify(store.getExecution(failed.execution_id));
    assert.equal(after, before, "the original record is untouched");
  });

  test("#7 retry policy caps attempts", async () => {
    const { cp, store } = makeCP([
      stepFor("mgr", "boom", () => { throw new Error("kaboom"); }),
    ]);
    makeManager(cp);
    cp.assignTask({ sender_id: "human:test", recipient_id: "mgr", objective: "will fail" });
    await cp.drain();
    const failed = store.listExecutions("mgr").find((e) => e.status === "failed")!;

    assert.ok(await cp.retry(failed.execution_id, { maxRetries: 2 }));
    assert.ok(await cp.retry(failed.execution_id, { maxRetries: 2 }));
    assert.equal(await cp.retry(failed.execution_id, { maxRetries: 2 }), undefined, "capped");
  });

  test("#8 orphaned executions are recovered and become retry-eligible", () => {
    const { cp, store } = makeCP([]);
    makeManager(cp);
    store.putExecution({
      execution_id: "exec-orphan", agent_id: "mgr",
      trigger: { type: "inbox" }, status: "running", started_at: "2026-08-17T12:00:00.000Z",
    });

    const orphans = cp.recoverOrphans();
    assert.equal(orphans.length, 1);
    const recovered = store.getExecution("exec-orphan")!;
    assert.equal(recovered.status, "failed");
    assert.equal(recovered.error?.reason, "orphaned");
    assert.ok(cp.retryable().some((e) => e.execution_id === "exec-orphan"));
    assert.ok(store.events().some((e) => (e.summary ?? "").includes("orphaned")));
  });

  test("#8 an orphaned worker still yields a terminal result to its manager", async () => {
    const { cp, store } = makeCP([
      stepFor("mgr", "delegate", () => [{
        type: "delegate_task", objective: "analyze", output_contract: "x",
        granted_permissions: [
          { kind: "fs.read", scope: { paths: ["/"] } },
          { kind: "model.invoke", scope: { budget_usd_per_day: 1 } },
        ],
        budget: { timeout_seconds: 60 },
      }]),
      {
        // The worker never returns: its execution is left running, as after a crash.
        label: "worker hangs",
        when: (r) => r.prompt.includes("ephemeral worker"),
        then: () => [{ type: "note", text: "…" }],
      },
    ]);
    makeManager(cp);
    cp.assignTask({ sender_id: "human:test", recipient_id: "mgr", objective: "root" });
    await cp.drain();

    const child = store.listTasks().find((t) => !!t.delegation)!;
    // Simulate the control plane dying mid-worker-execution.
    store.putExecution({
      execution_id: "exec-crashed", agent_id: child.recipient_id,
      trigger: { type: "inbox" }, status: "running", started_at: "2026-08-17T12:00:00.000Z",
    });
    store.putTask({ ...child, status: "running" });

    cp.recoverOrphans();
    assert.equal(store.countDelegationResults(child.task_id), 1, "manager is not stranded");
  });

  test("#9 waits require a timeout and are cancelled when their task ends", async () => {
    const { cp, store } = makeCP([]);
    makeManager(cp);
    const task = cp.assignTask({ sender_id: "human:test", recipient_id: "mgr", objective: "t" });

    assert.throws(
      () => cp.waits.register({ agent_id: "mgr", kind: "reply", timeout_seconds: 0 }),
      /positive timeout_seconds/,
    );

    cp.waits.register({ agent_id: "mgr", task_id: task.task_id, kind: "reply", timeout_seconds: 60 });
    assert.equal(store.activeWaits().length, 1);

    cp.assignTask({ sender_id: "mgr", recipient_id: "mgr", objective: "unrelated" });
    cp.waits.cancelForTask(task.task_id);
    assert.equal(store.activeWaits().length, 0);
    assert.equal(store.listWaits().find((w) => w.task_id === task.task_id)!.status, "cancelled");
  });

  test("#9 a timed-out wait wakes its agent with a timeout outcome", async () => {
    const { cp, store, clock } = makeCP([
      stepFor("mgr", "run", () => [{ type: "note", text: "ok" }], { repeatable: true }),
    ]);
    makeManager(cp);
    cp.waits.register({ agent_id: "mgr", kind: "reply", timeout_seconds: 30 });

    assert.equal(cp.waits.sweepTimeouts().length, 0, "not yet due");
    clock.advance!(31_000);
    const fired = cp.waits.sweepTimeouts();

    assert.equal(fired.length, 1);
    assert.equal(store.listWaits()[0]!.status, "timeout");
    assert.ok(store.events().some((e) => e.event_type === "wait.timeout"));
  });
});
