/**
 * The end-to-end acceptance test: one task, delegated, completed, observable.
 *
 * It runs the full 13-step scenario against the deterministic adapter and asserts the
 * architectural claims — including the ones that are easy to claim and hard to
 * check: bounded context, worker isolation, observer-not-source-of-truth, and the absence
 * of a hard-coded orchestration graph.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildHarness, seed, MANAGER_ID } from "../../src/scripted/scenario.ts";
import type { Task, WorkerResult } from "../../src/domain/types.ts";

describe("end-to-end vertical slice", () => {
  test("the full scenario runs and satisfies every architectural claim", async () => {
    const { cp, observer, store, model } = await buildHarness();

    // 1–3. A durable agent owns a responsibility and receives a maintenance task.
    const { managerTaskId } = seed(cp);
    const manager = store.getAgent(MANAGER_ID)!;
    assert.equal(manager.lifecycle_state, "active");
    assert.match(manager.responsibility, /checkout-service/);

    // 4–10. Drive the organization to quiescence.
    const executions = await cp.drain();
    assert.ok(executions >= 3, `expected manager+worker+manager executions, got ${executions}`);

    // --- Criterion 1: the durable agent survives multiple executions ---
    const managerExecutions = store.listExecutions(MANAGER_ID);
    assert.ok(managerExecutions.length >= 2, "the manager ran more than once");
    assert.ok(managerExecutions.every((e) => e.status === "completed"));
    assert.equal(store.getAgent(MANAGER_ID)!.agent_id, MANAGER_ID, "identity is stable across them");

    // --- Criterion 2: its prompt context stays bounded and is never a transcript ---
    for (const call of model.calls.filter((c) => c.agent_id === MANAGER_ID)) {
      const tokens = Math.ceil(call.prompt.length / 4);
      assert.ok(tokens < 100_000, `context ${tokens} tokens exceeds the per-execution target`);
      // The context is reconstructed from records, not replayed conversation.
      assert.ok(!call.prompt.includes("assistant:"), "no raw transcript in context");
      assert.ok(call.prompt.includes("Responsibility:"), "identity is rebuilt each time");
    }
    // Later executions do not simply accumulate the earlier ones.
    const [first, second] = model.calls.filter((c) => c.agent_id === MANAGER_ID);
    assert.ok(second && first && !second.prompt.includes(first.prompt),
      "the second context is not the first plus more");

    // --- Criterion 3: a worker was spawned without polluting manager context ---
    const child = store.listTasks().find((t) => !!t.delegation)!;
    assert.ok(child, "a delegated child task exists");
    assert.equal(child.parent_task_id, managerTaskId, "parent/child correlation (ADR 0012)");
    assert.ok(child.delegation!.delegation_id);

    const workerCalls = model.calls.filter((c) => c.agent_id === child.recipient_id);
    assert.equal(workerCalls.length, 1, "the worker ran once");
    assert.ok(workerCalls[0]!.prompt.includes("You are an ephemeral worker"));
    // The worker's own investigation detail never entered the manager's prompt.
    const managerPrompts = model.calls.filter((c) => c.agent_id === MANAGER_ID).map((c) => c.prompt).join("\n");
    assert.ok(!managerPrompts.includes("Exceeded timeout of 2000 ms"),
      "raw worker evidence did not leak into manager context — only its summary did");

    // Worker permissions were strictly narrower than the manager's.
    const workerPermissions = child.delegation!.granted_permissions ?? [];
    const workerGrants = workerPermissions.map((p) => p.kind);
    assert.deepEqual(
      workerPermissions.find((p) => p.kind === "fs.write")?.scope?.paths,
      ["/outputs"],
      "the worker may write artifacts, but not modify its workspace snapshot",
    );
    assert.ok(!workerGrants.includes("agent.delegate"));

    // --- Criterion 4: events are sufficient to reconstruct what happened ---
    const types = store.events().map((e) => e.event_type);
    for (const required of [
      "agent.created", "task.created", "execution.started", "delegation.created",
      "tool.invoked", "artifact.created", "delegation.completed", "memory.revised",
      "task.completed", "execution.completed", "agent.retired",
    ]) {
      assert.ok(types.includes(required), `missing event type: ${required}`);
    }

    // --- Criterion 5: the observer summarizes without controlling ---
    const timeline = observer.timeline({ limit: 50 });
    assert.ok(timeline.length >= 8, "the timeline is legible");
    const eventIds = new Set(store.events().map((e) => e.event_id));
    for (const entry of timeline) {
      assert.ok(eventIds.has(entry.event_id), "every line traces back to a real event");
    }
    const org = observer.organization();
    assert.equal(org.length, 1, "ephemeral workers do not clutter the org view");
    assert.equal(org[0]!.agent_id, MANAGER_ID);

    // --- Criterion 8: a human can intervene at any time ---
    cp.inbox.deliverMessage({ sender_id: "human:test", recipient_id: MANAGER_ID }, "status?");
    assert.ok(cp.eligible().some((e) => e.agent.agent_id === MANAGER_ID),
      "a human message makes the agent eligible to run again");

    // 11. A durable learning was persisted with provenance.
    const memories = store.activeMemories(MANAGER_ID);
    assert.equal(memories.length, 1);
    assert.match(memories[0]!.content, /2000ms default timeout/);
    const revision = store.memoryRevisions(memories[0]!.memory_id)[0]!;
    assert.equal(revision.actor_agent_id, MANAGER_ID);
    assert.ok(revision.rationale.length > 0, "the learning records why it was kept");
    assert.ok(revision.source_execution, "and which execution produced it");

    // 9. The worker returned structured evidence and an artifact that exists on disk.
    const resultItem = store.inboxFor(MANAGER_ID).find((i) => i.kind === "delegation_result")!;
    const result = resultItem.payload as unknown as WorkerResult;
    assert.equal(result.status, "completed");
    assert.ok((result.evidence ?? []).length > 0);
    assert.ok((result.proposed_learnings ?? []).length > 0, "workers return proposed learnings");

    const artifact = store.listArtifacts()[0]!;
    assert.ok(artifact, "the worker produced an artifact");
    const contents = await readFile(artifact.uri, "utf8");
    assert.match(contents, /Root cause/);

    // 12. The manager's own task is complete.
    const root = store.getTask(managerTaskId)!;
    assert.equal(root.status, "completed");

    // The worker was retired; the manager was not.
    assert.equal(store.getAgent(child.recipient_id)!.lifecycle_state, "retired");
    assert.equal(store.getAgent(MANAGER_ID)!.lifecycle_state, "active");

    store.close();
  });

  test("criterion 7: no hard-coded orchestration graph", async () => {
    // The control plane must not branch on who the agent is or what the task says.
    // Swapping only the script changes the organization's behavior entirely.
    const { cp, store } = await buildHarness();
    seed(cp);
    await cp.drain();
    const delegatedByDefaultScript = store.listTasks().filter((t) => !!t.delegation).length;
    assert.equal(delegatedByDefaultScript, 1);
    store.close();

    // Same platform, same seed, a script that decides *not* to delegate.
    const { buildHarness: _b } = await import("../../src/scripted/scenario.ts");
    const h2 = await _b();
    // Replace the model's script by constructing a fresh control plane around a
    // no-delegation script via the shared test helper.
    const { makeCP, makeManager, stepFor } = await import("../helpers.ts");
    const alt = makeCP([
      stepFor("mgr", "handle it directly", (req) => [
        { type: "mark_task_complete", task_id: req.task_id ?? "", summary: "handled without delegating" },
      ]),
    ]);
    makeManager(alt.cp);
    const t = alt.cp.assignTask({
      sender_id: "human:test", recipient_id: "mgr",
      objective: "Inspect the repository and identify one high-priority maintenance issue.",
    });
    await alt.cp.drain();

    assert.equal(alt.store.listTasks().filter((x) => !!x.delegation).length, 0,
      "no delegation happened — the decision lives in the agent, not the platform");
    assert.equal(alt.store.getTask(t.task_id)!.status, "completed");
    h2.store.close();
    alt.store.close();
  });

  test("the control plane source contains no agent-specific branching", async () => {
    // A structural check backing criterion 7: the composition root must not name a
    // concrete agent or task string anywhere in its logic.
    const source = await readFile(new URL("../../src/control-plane/controlPlane.ts", import.meta.url), "utf8");
    assert.ok(!source.includes("repo-maintainer"), "no agent id is hard-coded");
    assert.ok(!source.includes("checkout"), "no task content is hard-coded");
    assert.ok(!/agent_id\s*===\s*["']/.test(source), "no equality branch on a specific agent id");
  });
});
