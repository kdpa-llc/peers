/**
 * CONTRACT_TESTS #10–#16: budget enforcement at three scopes, usage recording, causation
 * integrity, registered event types, the memory revision chain, and the approval gate
 * (ADR 0008, ADR 0006, ADR 0003, Constitution §16).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { EVENT_TYPES, redactForAudience } from "../../src/control-plane/events.ts";
import { makeCP, makeManager, stepFor } from "../helpers.ts";
import type { Permission } from "../../src/domain/types.ts";

describe("budget invariants", () => {
  test("#10 an exhausted budget blocks the agent and flags human attention", async () => {
    const { cp, store } = makeCP(
      [stepFor("mgr", "work", () => [{ type: "note", text: "x" }], { repeatable: true })],
      { budgets: { org_usd: 0.001 } },
    );
    makeManager(cp);
    cp.assignTask({ sender_id: "human:test", recipient_id: "mgr", objective: "expensive" });
    await cp.drain();

    const exec = store.listExecutions("mgr")[0]!;
    assert.equal(exec.status, "failed");
    assert.equal(exec.error?.reason, "budget_exhausted");
    assert.equal(store.getAgent("mgr")!.runtime_state, "BLOCKED");

    const alarm = store.events().find((e) => e.event_type === "budget.exhausted")!;
    assert.ok(alarm, "an exhaustion event is emitted");
    assert.equal(alarm.payload?.needs_human_attention, true);
    assert.equal(alarm.visibility, "user", "it reaches the human, not just the audit log");
  });

  test("#10 the per-agent daily scope comes from the agent's own model.invoke grant", async () => {
    const tiny: Permission[] = [
      { kind: "model.invoke", scope: { budget_usd_per_day: 0.001 } },
      { kind: "memory.write_own" },
    ];
    const { cp, store } = makeCP(
      [stepFor("mgr", "work", () => [{ type: "note", text: "x" }], { repeatable: true })],
      { budgets: { org_usd: 1000 } },
    );
    makeManager(cp, tiny);
    cp.assignTask({ sender_id: "human:test", recipient_id: "mgr", objective: "expensive" });
    await cp.drain();

    const exec = store.listExecutions("mgr")[0]!;
    assert.equal(exec.error?.reason, "budget_exhausted");
    assert.match(exec.error!.detail!, /agent_day/);
  });

  test("#11 every completed execution records usage", async () => {
    const { cp, store } = makeCP([
      stepFor("mgr", "work", () => [{ type: "note", text: "x" }], {
        usage: { input_tokens: 1000, output_tokens: 100, cost_usd: 0.02 },
      }),
    ]);
    makeManager(cp);
    cp.assignTask({ sender_id: "human:test", recipient_id: "mgr", objective: "t" });
    await cp.drain();

    const exec = store.listExecutions("mgr")[0]!;
    assert.equal(exec.status, "completed");
    assert.equal(exec.usage?.cost_usd, 0.02);
    assert.equal(exec.usage?.input_tokens, 1000);
    assert.equal(cp.totalUsage().cost_usd, 0.02);
  });

  test("actual overage is persisted and the response cannot run tools or actions", async () => {
    const { cp, store, model } = makeCP([
      stepFor("mgr", "over budget", (req) => [{
        type: "mark_task_complete",
        task_id: req.task_id!,
        summary: "must not be applied",
      }], {
        tools: () => [{ command: ["echo", "must-not-run"] }],
        usage: { input_tokens: 2000, output_tokens: 300, cost_usd: 0.03 },
      }),
    ], { budgets: { org_usd: 100, default_agent_usd_per_day: 10, execution_usd: 0.02 } });
    makeManager(cp);
    const task = cp.assignTask({ sender_id: "human:test", recipient_id: "mgr", objective: "t" });
    await cp.drain();

    const exec = store.listExecutions("mgr")[0]!;
    assert.equal(model.calls.length, 1, "the reserved call is allowed to obtain actual usage");
    assert.equal(exec.status, "failed");
    assert.equal(exec.error?.reason, "budget_exhausted");
    assert.match(exec.error!.detail!, /execution/);
    assert.equal(exec.usage?.cost_usd, 0.03, "the provider charge survives exhaustion");
    assert.notEqual(store.getTask(task.task_id)!.status, "completed", "model action was refused");
    assert.equal(
      store.events().some((e) => e.event_type === "tool.invoked"),
      false,
      "model tool calls were refused",
    );
  });

  test("the current execution is not double-counted between per-call gates", async () => {
    const { cp, store, model } = makeCP([
      stepFor("mgr", "loop", () => [], {
        repeatable: true,
        tools: () => [{ command: ["echo", "one-turn"] }],
        usage: { input_tokens: 100, output_tokens: 20, cost_usd: 0.01 },
      }),
    ], { budgets: { org_usd: 0.035, default_agent_usd_per_day: 10, execution_usd: 5 } });
    makeManager(cp);
    cp.assignTask({ sender_id: "human:test", recipient_id: "mgr", objective: "loop" });
    await cp.drain();

    const exec = store.listExecutions("mgr")[0]!;
    assert.equal(model.calls.length, 2, "two calls fit; the third reservation does not");
    assert.equal(exec.error?.reason, "budget_exhausted");
    assert.match(exec.error!.detail!, /org/);
    assert.equal(exec.usage?.cost_usd, 0.02);
    assert.equal(
      store.events().filter((e) => e.event_type === "tool.invoked").length,
      2,
      "only calls whose post-call checks passed may run tools",
    );
  });

  test("model.invoke max_tokens_per_execution is enforced on actual usage", async () => {
    const grants: Permission[] = [{
      kind: "model.invoke",
      scope: { budget_usd_per_day: 5, max_tokens_per_execution: 50_000 },
    }];
    const { cp, store } = makeCP([
      stepFor("mgr", "too many tokens", (req) => [{
        type: "mark_task_complete",
        task_id: req.task_id!,
        summary: "must not be applied",
      }], { usage: { input_tokens: 50_000, output_tokens: 1, cost_usd: 0.01 } }),
    ]);
    makeManager(cp, grants);
    const task = cp.assignTask({ sender_id: "human:test", recipient_id: "mgr", objective: "t" });
    await cp.drain();

    const exec = store.listExecutions("mgr")[0]!;
    assert.equal(exec.error?.reason, "budget_exhausted");
    assert.match(exec.error!.detail!, /model_tokens/);
    assert.equal(exec.usage?.input_tokens, 50_000);
    assert.notEqual(store.getTask(task.task_id)!.status, "completed");
  });

  test("delegation max_cost and max_tokens cap the worker's model response", async () => {
    const cases = [
      {
        name: "delegation_cost",
        budget: { timeout_seconds: 60, max_cost_usd: 0.02 },
        usage: { input_tokens: 100, output_tokens: 20, cost_usd: 0.03 },
      },
      {
        name: "delegation_tokens",
        budget: { timeout_seconds: 60, max_tokens: 50_000 },
        usage: { input_tokens: 50_000, output_tokens: 1, cost_usd: 0.01 },
      },
    ] as const;

    for (const example of cases) {
      const { cp, store } = makeCP([
        stepFor("mgr", `delegate-${example.name}`, () => [{
          type: "delegate_task",
          objective: "bounded work",
          output_contract: "summary",
          granted_permissions: [
            { kind: "model.invoke", scope: { budget_usd_per_day: 1 } },
          ],
          budget: example.budget,
        }]),
        {
          label: `worker-${example.name}`,
          when: (req) => req.agent_id.startsWith("worker-"),
          then: () => [{
            type: "return_worker_result",
            result: { status: "completed", summary: "must not be applied" },
          }],
          usage: example.usage,
        },
      ]);
      makeManager(cp);
      cp.assignTask({ sender_id: "human:test", recipient_id: "mgr", objective: "delegate" });
      await cp.drain();

      const worker = store.listExecutions().find((e) => e.agent_id.startsWith("worker-"))!;
      assert.equal(worker.error?.reason, "budget_exhausted", example.name);
      assert.match(worker.error!.detail!, new RegExp(example.name));
      assert.deepEqual(worker.usage, example.usage, "actual worker usage is persisted");
    }
  });

  test("model invocation fails closed without an effective grant", async () => {
    const { cp, store, model } = makeCP([
      stepFor("mgr", "must not run", () => [{ type: "note", text: "no" }]),
    ]);
    makeManager(cp, [{ kind: "memory.write_own" }]);
    cp.assignTask({ sender_id: "human:test", recipient_id: "mgr", objective: "t" });
    await cp.drain();

    const exec = store.listExecutions("mgr")[0]!;
    assert.equal(model.calls.length, 0);
    assert.equal(exec.error?.reason, "permission_denied");
    assert.ok(store.events().some(
      (e) => e.event_type === "permission.denied" && e.summary?.includes("model.invoke"),
    ));
  });
});

describe("event invariants", () => {
  test("#14 an unregistered event type is refused", () => {
    const { cp } = makeCP([]);
    makeManager(cp);
    assert.throws(
      () => cp.events.emit({ type: "totally.invented", agent_id: "mgr" }),
      /unregistered event_type/,
    );
  });

  test("#14 every emitted type during a full run is in the registry", async () => {
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
        label: "worker returns",
        when: (r) => r.prompt.includes("ephemeral worker"),
        then: () => [{ type: "return_worker_result", result: { status: "completed", summary: "done" } }],
      },
    ]);
    makeManager(cp);
    cp.assignTask({ sender_id: "human:test", recipient_id: "mgr", objective: "root" });
    await cp.drain();

    const emitted = new Set(store.events().map((e) => e.event_type));
    assert.ok(emitted.size > 8, "a meaningful number of event types were exercised");
    for (const t of emitted) assert.ok(EVENT_TYPES.has(t), `unregistered type emitted: ${t}`);
  });

  test("#13 causation ids reference real events and a workflow shares one correlation id", async () => {
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
        label: "worker returns",
        when: (r) => r.prompt.includes("ephemeral worker"),
        then: () => [{ type: "return_worker_result", result: { status: "completed", summary: "done" } }],
      },
    ]);
    makeManager(cp);
    const root = cp.assignTask({ sender_id: "human:test", recipient_id: "mgr", objective: "root" });
    await cp.drain();

    const all = store.events();
    const ids = new Set(all.map((e) => e.event_id));
    for (const e of all) {
      if (e.causation_id) assert.ok(ids.has(e.causation_id), `dangling causation_id ${e.causation_id}`);
    }

    const correlated = all.filter((e) => e.correlation_id === root.correlation_id);
    assert.ok(correlated.length >= 6, "the whole delegation workflow shares one correlation id");
    assert.ok(
      correlated.some((e) => e.event_type === "delegation.created") &&
      correlated.some((e) => e.event_type === "delegation.completed"),
      "both ends of the delegation are on the same correlation",
    );
  });

  test("audit-visibility payloads are redacted for non-audit audiences", async () => {
    // A permission check emits an audit-visibility event carrying the concrete grant.
    const { cp, store } = makeCP([
      stepFor("mgr", "message a peer", () => [
        { type: "send_message", recipient_id: "peer", body: "hello" },
      ]),
    ]);
    makeManager(cp);
    cp.createAgent({ agent_id: "peer", name: "Peer", responsibility: "r", mission: "m" });
    cp.assignTask({ sender_id: "human:test", recipient_id: "mgr", objective: "t" });
    await cp.drain();

    const auditEvent = store.events().find(
      (e) => e.visibility === "audit" && e.payload?.grant !== undefined,
    );
    assert.ok(auditEvent, "the permission check is recorded as an audit event with its grant");

    // Audit audience sees the grant; a user audience does not.
    const forAudit = redactForAudience(auditEvent!, "audit");
    assert.equal(forAudit.payload?.grant, auditEvent!.payload?.grant);

    const forUser = redactForAudience(auditEvent!, "user");
    assert.equal(forUser.payload?.redacted, true);
    assert.equal(forUser.payload?.grant, undefined, "the grant does not leak to the user view");
  });
});

describe("memory invariants", () => {
  test("#25 an agent is told how much of its memory it is not being shown", async () => {
    // 20 memories, a retrieval window of 12: without a count, the other 8 are invisible in
    // a way the agent cannot distinguish from their not existing.
    const { cp, store, model } = makeCP([
      stepFor("mgr", "look", () => [{ type: "note", text: "considering" }]),
    ]);
    makeManager(cp);
    const now = new Date().toISOString();
    for (let i = 0; i < 20; i++) {
      store.putMemory({
        memory_id: `mem-${i}`, agent_id: "mgr", kind: "knowledge",
        content: `durable fact number ${i} about the build`,
        revision: 1, status: "active", created_at: now, updated_at: now,
      });
    }
    cp.assignTask({ sender_id: "human:test", recipient_id: "mgr", objective: "build" });
    await cp.drain();

    const prompt = model.calls[0]!.prompt;
    assert.match(prompt, /8 more durable memories are not shown/);
    assert.match(prompt, /merging or archiving/, "the affordance is named, the choice is not made");
  });

  test("#25 no such note appears when the whole memory fits", async () => {
    const { cp, store, model } = makeCP([
      stepFor("mgr", "look", () => [{ type: "note", text: "considering" }]),
    ]);
    makeManager(cp);
    const now = new Date().toISOString();
    store.putMemory({
      memory_id: "mem-only", agent_id: "mgr", kind: "knowledge",
      content: "the only thing worth remembering",
      revision: 1, status: "active", created_at: now, updated_at: now,
    });
    cp.assignTask({ sender_id: "human:test", recipient_id: "mgr", objective: "build" });
    await cp.drain();

    assert.doesNotMatch(model.calls[0]!.prompt, /more durable memories are not shown/);
  });

  test("#15 applying a proposal writes a revision with rationale and provenance", async () => {
    const { cp, store } = makeCP([
      stepFor("mgr", "learn", () => [{
        type: "propose_memory_update",
        proposal: {
          operation: "create", kind: "knowledge",
          content: "the build cache lives in /var/cache/app",
          rationale: "recovered during an investigation",
          confidence: 0.9,
        },
      }]),
    ]);
    makeManager(cp);
    cp.assignTask({ sender_id: "human:test", recipient_id: "mgr", objective: "t" });
    await cp.drain();

    const memories = store.activeMemories("mgr");
    assert.equal(memories.length, 1);
    assert.equal(memories[0]!.revision, 1);

    const revisions = store.memoryRevisions(memories[0]!.memory_id);
    assert.equal(revisions.length, 1);
    assert.equal(revisions[0]!.rationale, "recovered during an investigation");
    assert.equal(revisions[0]!.actor_agent_id, "mgr");
    assert.ok(revisions[0]!.source_execution, "the revision names the execution that produced it");
  });

  test("#15 revising increments the revision and keeps the chain", async () => {
    const { cp, store } = makeCP([]);
    makeManager(cp);

    const created = cp.memory.apply({
      agent_id: "mgr", operation: "create", kind: "knowledge",
      content: "v1", rationale: "first",
    });
    assert.equal(created.applied, true);
    const memId = created.applied ? created.memory.memory_id : "";

    const revised = cp.memory.apply({
      agent_id: "mgr", operation: "revise", target_memory_ids: [memId],
      content: "v2", rationale: "corrected",
    });
    assert.equal(revised.applied, true);
    assert.equal(store.getMemory(memId)!.revision, 2);
    assert.equal(store.getMemory(memId)!.content, "v2");

    const chain = store.memoryRevisions(memId);
    assert.deepEqual(chain.map((r) => r.revision), [1, 2]);
    assert.equal(chain[1]!.previous_revision, 1);
  });

  test("#16 delete requires review, and cross-agent writes require review", () => {
    const { cp } = makeCP([]);
    makeManager(cp);
    cp.createAgent({ agent_id: "other", name: "Other", responsibility: "r", mission: "m" });

    const created = cp.memory.apply({
      agent_id: "other", operation: "create", content: "theirs", rationale: "seed",
    });
    const otherId = created.applied ? created.memory.memory_id : "";

    const del = cp.memory.apply({
      agent_id: "mgr", operation: "delete", target_memory_ids: [otherId], rationale: "cleanup",
    });
    assert.equal(del.applied, false);
    assert.equal(del.applied === false && del.requiresApproval, true);

    const crossWrite = cp.memory.apply({
      agent_id: "mgr", operation: "revise", target_memory_ids: [otherId],
      content: "hijacked", rationale: "no",
    });
    assert.equal(crossWrite.applied, false);
    assert.equal(crossWrite.applied === false && crossWrite.requiresApproval, true);
  });

  test("a proposal without a rationale is refused", () => {
    const { cp } = makeCP([]);
    makeManager(cp);
    const out = cp.memory.apply({
      agent_id: "mgr", operation: "create", content: "x", rationale: "",
    });
    assert.equal(out.applied, false);
  });

  test("§16 a durable-agent proposal is never auto-applied", async () => {
    const { cp, store } = makeCP([
      stepFor("mgr", "propose agent", () => [{
        type: "propose_durable_agent",
        name: "Security Specialist",
        responsibility: "own security review",
        rationale: "recurring need",
      }]),
    ]);
    makeManager(cp);
    cp.assignTask({ sender_id: "human:test", recipient_id: "mgr", objective: "t" });
    await cp.drain();

    assert.equal(store.listAgents().length, 1, "no new durable agent was created");
    const approval = store.listApprovals().find((a) => a.action === "agent.propose_durable")!;
    assert.ok(approval, "a pending approval was recorded instead");
    assert.equal(approval.status, "pending");
  });
});
