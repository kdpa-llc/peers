/**
 * CONTRACT_TESTS #4–#5: delegation depth limit and least-authority permission subsetting
 * (ADR 0009, ADR 0012, SECURITY_AND_PERMISSIONS).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { check, isSubset } from "../../src/control-plane/permissions.ts";
import { makeCP, makeManager, MANAGER, stepFor } from "../helpers.ts";
import type { AgentAction, Permission } from "../../src/domain/types.ts";

const READ_ONLY: Permission[] = [
  { kind: "fs.read", scope: { paths: ["/"] } },
  { kind: "model.invoke", scope: { budget_usd_per_day: 1 } },
  { kind: "sandbox.create" },
  { kind: "tool.exec" },
];

const delegateAction = (grants: Permission[]) => ({
  type: "delegate_task" as const,
  objective: "analyze",
  output_contract: "finding: string",
  granted_permissions: grants,
  budget: { timeout_seconds: 60 },
});

describe("delegation invariants", () => {
  test("#4 a delegated task may not itself delegate, even holding agent.delegate", async () => {
    // The worker is deliberately granted delegation rights (a legal subset of the
    // manager's) so the refusal can only come from the depth limit, not the permission
    // check — otherwise this test would pass for the wrong reason.
    const CAN_DELEGATE: Permission[] = [
      ...READ_ONLY,
      { kind: "agent.delegate" },
      { kind: "agent.create_ephemeral", scope: { max_concurrent: 1 } },
    ];
    const { cp, store } = makeCP([
      stepFor("mgr", "manager delegates", () => [delegateAction(CAN_DELEGATE)]),
      {
        label: "worker tries to delegate again",
        when: (r) => r.prompt.includes("ephemeral worker"),
        then: () => [delegateAction(READ_ONLY)],
      },
    ]);
    makeManager(cp);
    cp.assignTask({ sender_id: "human:test", recipient_id: "mgr", objective: "root" });
    await cp.drain();

    const delegated = store.listTasks().filter((t) => !!t.delegation);
    assert.equal(delegated.length, 1, "the worker's delegation was refused");

    const refusal = store.events().find(
      (e) => e.event_type === "delegation.failed" && (e.summary ?? "").includes("depth limit"),
    );
    assert.ok(refusal, "the refusal is recorded as an event");
  });

  test("#5 a worker grant exceeding the manager's authority is rejected", async () => {
    const escalation: Permission[] = [
      { kind: "fs.read", scope: { paths: ["/"] } },
      // The manager has no unrestricted egress — only github.com.
      { kind: "net.egress", scope: { unrestricted: true } },
    ];
    const { cp, store } = makeCP([
      stepFor("mgr", "delegate with escalation", () => [delegateAction(escalation)]),
    ]);
    makeManager(cp);
    cp.assignTask({ sender_id: "human:test", recipient_id: "mgr", objective: "root" });
    await cp.drain();

    assert.equal(store.listTasks().filter((t) => !!t.delegation).length, 0, "no delegation created");
    const denial = store.events().find(
      (e) => e.event_type === "delegation.failed" && (e.summary ?? "").includes("exceeds manager authority"),
    );
    assert.ok(denial, "the escalation attempt is recorded");
  });

  test("#5 subsetting rules: narrower scopes pass, wider scopes fail", () => {
    const parent: Permission[] = [
      { kind: "fs.write", scope: { paths: ["/srv/app"] } },
      { kind: "net.egress", scope: { allow: ["github.com", "*.example.com"] } },
      { kind: "model.invoke", scope: { budget_usd_per_day: 5 } },
    ];

    assert.equal(isSubset([{ kind: "fs.write", scope: { paths: ["/srv/app/sub"] } }], parent).ok, true);
    assert.equal(isSubset([{ kind: "fs.write", scope: { paths: ["/srv"] } }], parent).ok, false);
    assert.equal(isSubset([{ kind: "net.egress", scope: { allow: ["api.example.com"] } }], parent).ok, true);
    assert.equal(isSubset([{ kind: "net.egress", scope: { allow: ["evil.com"] } }], parent).ok, false);
    assert.equal(isSubset([{ kind: "model.invoke", scope: { budget_usd_per_day: 1 } }], parent).ok, true);
    assert.equal(isSubset([{ kind: "model.invoke", scope: { budget_usd_per_day: 50 } }], parent).ok, false);
    assert.equal(isSubset([{ kind: "history.delete" }], parent).ok, false, "unheld kind");
  });

  test("#5 a worker cannot erase parent ceilings or sandbox selectors", () => {
    const parent: Permission[] = [
      { kind: "fs.read", scope: { paths: ["/workspace"] } },
      { kind: "net.egress", scope: { allow: ["api.example.com"] } },
      {
        kind: "model.invoke",
        scope: { budget_usd_per_day: 5, max_tokens_per_execution: 10_000 },
      },
      { kind: "agent.create_ephemeral", scope: { max_concurrent: 2 } },
      { kind: "sandbox.create", scope: { backend: "local", policy: "restricted" } },
    ];

    assert.equal(isSubset([{ kind: "fs.read" }], parent).ok, false);
    assert.equal(isSubset([{ kind: "net.egress" }], parent).ok, false);
    assert.equal(isSubset([{ kind: "model.invoke" }], parent).ok, false);
    assert.equal(
      isSubset([{
        kind: "model.invoke",
        scope: { budget_usd_per_day: 1 },
      }], parent).ok,
      false,
      "omitting the parent's token cap is an escalation",
    );
    assert.equal(isSubset([{ kind: "agent.create_ephemeral" }], parent).ok, false);
    assert.equal(isSubset([{ kind: "sandbox.create" }], parent).ok, false);
    assert.equal(
      isSubset([{
        kind: "sandbox.create",
        scope: { backend: "remote", policy: "restricted" },
      }], parent).ok,
      false,
    );
    assert.equal(
      isSubset([{
        kind: "sandbox.create",
        scope: { backend: "local", policy: "restricted" },
      }], parent).ok,
      true,
    );
  });

  test("#5 an unbounded scope dimension may be explicitly narrowed", () => {
    const parent: Permission[] = [
      { kind: "model.invoke", scope: { budget_usd_per_day: 5 } },
      { kind: "agent.create_ephemeral" },
      { kind: "sandbox.create" },
    ];
    const child: Permission[] = [
      { kind: "model.invoke", scope: { budget_usd_per_day: 1, max_tokens_per_execution: 1000 } },
      { kind: "agent.create_ephemeral", scope: { max_concurrent: 1 } },
      { kind: "sandbox.create", scope: { backend: "local", policy: "restricted" } },
    ];
    assert.equal(isSubset(child, parent).ok, true);
    assert.equal(
      isSubset([{
        kind: "model.invoke", scope: { budget_usd_per_day: 1 },
      }], [{ kind: "model.invoke" }]).ok,
      false,
      "a platform-default daily cap cannot be compared without its runtime value",
    );
  });

  test("malformed scopes cannot authorize or bypass delegation ceilings", () => {
    const malformed: Permission = {
      kind: "model.invoke",
      scope: { budget_usd_per_day: Number.NaN, max_tokens_per_execution: Number.POSITIVE_INFINITY },
    };
    assert.equal(check([malformed], { kind: "model.invoke" }).allowed, false);
    assert.equal(
      isSubset([malformed], [{
        kind: "model.invoke",
        scope: { budget_usd_per_day: 5, max_tokens_per_execution: 10_000 },
      }]).ok,
      false,
    );
    assert.equal(
      isSubset([{
        kind: "sandbox.create",
        scope: { policy: "restricted", unexpected: "ignored" } as unknown as Permission["scope"],
      }], [{ kind: "sandbox.create", scope: { policy: "restricted" } }]).ok,
      false,
      "unknown scope dimensions fail closed instead of being silently discarded",
    );
  });

  test("a worker executes under the delegation's grants, not the manager's", async () => {
    let workerGrants: string[] = [];
    const { cp } = makeCP([
      stepFor("mgr", "delegate", () => [delegateAction(READ_ONLY)]),
      {
        label: "worker inspects its own grants",
        when: (r) => r.prompt.includes("ephemeral worker"),
        then: (r) => {
          workerGrants = r.available_actions;
          return [{ type: "return_worker_result", result: { status: "completed", summary: "ok" } }];
        },
      },
    ]);
    makeManager(cp);
    cp.assignTask({ sender_id: "human:test", recipient_id: "mgr", objective: "root" });
    await cp.drain();

    assert.deepEqual(workerGrants.sort(), ["fs.read", "model.invoke", "sandbox.create", "tool.exec"]);
    assert.ok(!workerGrants.includes("fs.write"), "worker cannot write");
    assert.ok(!workerGrants.includes("agent.delegate"), "worker cannot delegate");
    assert.ok(MANAGER.some((p) => p.kind === "fs.write"), "manager itself can write");
  });

  test("delegation is refused without agent.delegate", async () => {
    const { cp, store } = makeCP([
      stepFor("mgr", "delegate", () => [delegateAction(READ_ONLY)]),
    ]);
    makeManager(cp, [
      { kind: "fs.read", scope: { paths: ["/"] } },
      { kind: "model.invoke", scope: { budget_usd_per_day: 5 } },
    ]);
    cp.assignTask({ sender_id: "human:test", recipient_id: "mgr", objective: "root" });
    await cp.drain();

    assert.equal(store.listTasks().filter((t) => !!t.delegation).length, 0);
    assert.ok(store.events().some(
      (e) => e.event_type === "permission.denied" && (e.summary ?? "").includes("agent.delegate"),
    ));
  });
});

describe("ephemeral worker concurrency (CONTRACT_TESTS #28)", () => {
  const delegate = (objective: string): AgentAction => ({
    type: "delegate_task",
    objective,
    output_contract: "summary: string",
    granted_permissions: [
      { kind: "fs.read", scope: { paths: ["/"] } },
      { kind: "model.invoke", scope: { budget_usd_per_day: 1 } },
    ],
    budget: { timeout_seconds: 60 },
    // Do not wait: both delegations happen inside one execution, so the first worker is
    // still live when the second is attempted. That is exactly the case the cap is for.
    wait_for_result: false,
  });

  const manager = (maxConcurrent?: number): Permission[] => [
    { kind: "fs.read", scope: { paths: ["/"] } },
    { kind: "model.invoke", scope: { budget_usd_per_day: 5 } },
    { kind: "agent.delegate" },
    maxConcurrent === undefined
      ? { kind: "agent.create_ephemeral" }
      : { kind: "agent.create_ephemeral", scope: { max_concurrent: maxConcurrent } },
  ];

  test("#28 a manager at its max_concurrent cap is refused a further worker", async () => {
    const { cp, store } = makeCP([
      stepFor("mgr", "delegate twice", () => [delegate("first"), delegate("second")]),
    ]);
    makeManager(cp, manager(1));
    cp.assignTask({ sender_id: "human:test", recipient_id: "mgr", objective: "do two things" });
    await cp.drain();

    const created = store.events().filter((e) => e.event_type === "delegation.created");
    assert.equal(created.length, 1, "only the first delegation was allowed");

    const refused = store.events().find(
      (e) => e.event_type === "delegation.failed" && /worker limit reached/.test(e.summary ?? ""),
    );
    assert.ok(refused, "the second was refused against the cap, not silently dropped");
    assert.match(refused!.summary!, /1\/1/);
  });

  test("#28 no max_concurrent scope means no cap", async () => {
    const { cp, store } = makeCP([
      stepFor("mgr", "delegate twice", () => [delegate("first"), delegate("second")]),
    ]);
    makeManager(cp, manager(undefined));
    cp.assignTask({ sender_id: "human:test", recipient_id: "mgr", objective: "do two things" });
    await cp.drain();

    assert.equal(
      store.events().filter((e) => e.event_type === "delegation.created").length, 2,
      "an unscoped grant is unlimited, as the permission model says",
    );
  });

  test("#28 the cap counts only this manager's live workers", async () => {
    // A retired worker must not occupy a slot forever, or one delegation would exhaust the
    // cap permanently and the manager could never delegate again.
    const { cp, store } = makeCP([
      stepFor("mgr", "delegate once, waiting", () => [{ ...delegate("first"), wait_for_result: true }]),
      {
        label: "worker returns",
        when: (req) => req.agent_id !== "mgr",
        then: () => [{ type: "return_worker_result", result: { status: "completed", summary: "done" } }],
      },
      {
        label: "manager delegates again after the first retired",
        when: (req) => req.agent_id === "mgr" && req.prompt.includes("delegation_result"),
        then: () => [delegate("second")],
      },
    ]);
    makeManager(cp, manager(1));
    cp.assignTask({ sender_id: "human:test", recipient_id: "mgr", objective: "do things in sequence" });
    await cp.drain();

    assert.equal(
      store.events().filter((e) => e.event_type === "delegation.created").length, 2,
      "the slot was freed when the first worker retired",
    );
  });
});
