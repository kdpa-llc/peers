/**
 * ClaudeModelAdapter contract tests.
 *
 * No network and no API key: a fake transport stands in for the SDK, so what is under test
 * is the translation layer — permitted tools in, typed actions out — which is the part the
 * control plane depends on. The live model is exercised by `npm run peers -- run`,
 * deliberately outside CI.
 *
 * Enforces CONTRACT_TESTS #5 (least authority on delegation), #22 (no conversation crosses
 * an execution) and #23 (the tool surface equals the permission surface).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Permission } from "../../src/domain/types.ts";
import type { ModelRequest } from "../../src/data-plane/model/adapter.ts";
import { ClaudeModelAdapter, type BetaMessagesClient } from "../../src/data-plane/model/claude.ts";
import { MANAGER } from "../helpers.ts";

/** Canned assistant turns, returned in order; every request body is captured. */
function fakeClient(turns: any[]): BetaMessagesClient & { bodies: any[] } {
  const bodies: any[] = [];
  let i = 0;
  return {
    bodies,
    stream(body: any) {
      bodies.push(body);
      const turn = turns[Math.min(i++, turns.length - 1)];
      return {
        async finalMessage() {
          return {
            id: `msg-${i}`,
            type: "message",
            role: "assistant",
            model: "claude-opus-5",
            stop_reason: turn.stop_reason ?? "tool_use",
            stop_details: turn.stop_details ?? null,
            content: turn.content ?? [],
            usage: turn.usage ?? { input_tokens: 1000, output_tokens: 200 },
          } as any;
        },
      };
    },
  };
}

const toolUse = (id: string, name: string, input: Record<string, unknown>) =>
  ({ type: "tool_use", id, name, input });

const request = (over: Partial<ModelRequest> = {}): ModelRequest => ({
  prompt: "You own the repository. Decide what to do.",
  available_actions: MANAGER.map((g) => g.kind),
  agent_id: "mgr",
  execution_id: "exec-1",
  grants: MANAGER,
  turn: 0,
  ...over,
});

test("tool calls become typed AgentActions", async () => {
  const client = fakeClient([{
    content: [toolUse("t1", "mark_task_complete", { summary: "done" })],
  }]);
  const adapter = new ClaudeModelAdapter({ client });

  const res = await adapter.complete(request({ task_id: "task-9" }));

  assert.deepEqual(res.actions, [
    { type: "mark_task_complete", task_id: "task-9", summary: "done" },
  ]);
});

test("the execution token allowance caps provider output", async () => {
  const client = fakeClient([{ content: [] }]);
  const adapter = new ClaudeModelAdapter({ client, maxTokens: 16_000 });
  await adapter.complete(request({ max_output_tokens: 321 }));
  assert.equal(client.bodies[0].max_tokens, 321);
});

test("malformed provider usage fails closed", async () => {
  for (const usage of [
    { input_tokens: Number.POSITIVE_INFINITY, output_tokens: 1 },
    { input_tokens: 1, output_tokens: -1 },
  ]) {
    const client = fakeClient([{ content: [], usage }]);
    const adapter = new ClaudeModelAdapter({ client });
    await assert.rejects(() => adapter.complete(request()), /provider returned invalid usage/);
  }
});

test("run_command becomes a sandbox tool call, not an action", async () => {
  const client = fakeClient([{
    content: [toolUse("t1", "run_command", { command: ["ls", "workspace"] })],
  }]);
  const adapter = new ClaudeModelAdapter({ client });

  const res = await adapter.complete(request());

  assert.deepEqual(res.actions, []);
  assert.deepEqual(res.tool_calls, [{ command: ["ls", "workspace"] }]);
});

test("only permitted tools are offered (no capability the control plane would refuse)", async () => {
  const readOnly: Permission[] = [
    { kind: "fs.read", scope: { paths: ["/"] } },
    { kind: "tool.exec" },
    { kind: "sandbox.create" },
  ];
  const client = fakeClient([{ content: [toolUse("t1", "note", { text: "looked" })] }]);
  const adapter = new ClaudeModelAdapter({ client });

  await adapter.complete(request({ grants: readOnly, available_actions: ["fs.read", "tool.exec"] }));

  const offered = client.bodies[0].tools.map((t: any) => t.name);
  assert.ok(offered.includes("run_command"), "tool.exec and sandbox.create were granted");
  assert.ok(offered.includes("note"), "note is always available");
  assert.ok(!offered.includes("delegate_task"), "agent.delegate was not granted");
  assert.ok(!offered.includes("send_message"), "agent.message was not granted");
  assert.ok(!offered.includes("propose_memory_update"), "memory.write_own was not granted");
});

test("delegated permissions are narrowed to the manager's own grants (CONTRACT_TESTS #5)", async () => {
  const client = fakeClient([{
    content: [toolUse("t1", "delegate_task", {
      objective: "Analyze the failures.",
      output_contract: "root_cause: string",
      // The model asks for more than the manager holds, including a kind it has no grant for.
      granted_permission_kinds: ["fs.read", "tool.exec", "net.egress", "agent.delegate", "fs.write"],
    })],
  }]);
  // A manager that cannot reach the network and cannot write.
  const limited: Permission[] = [
    { kind: "fs.read", scope: { paths: ["/repo"] } },
    { kind: "tool.exec" },
    { kind: "agent.delegate" },
    { kind: "agent.create_ephemeral" },
  ];
  const adapter = new ClaudeModelAdapter({ client });

  const res = await adapter.complete(request({ grants: limited }));

  const action = res.actions[0] as Extract<typeof res.actions[number], { type: "delegate_task" }>;
  assert.equal(action.type, "delegate_task");
  const kinds = (action.granted_permissions ?? []).map((p) => p.kind).sort();
  assert.deepEqual(kinds, ["agent.delegate", "fs.read", "tool.exec"]);
  // The scope came from the manager's grant, not from the model.
  const read = action.granted_permissions?.find((p) => p.kind === "fs.read");
  assert.deepEqual(read?.scope, { paths: ["/repo"] });
});

test("tool results are returned as tool_result blocks matching every tool_use id", async () => {
  const client = fakeClient([
    { content: [toolUse("call-a", "run_command", { command: ["cat", "log"] })] },
    { content: [toolUse("call-b", "note", { text: "read the log" })] },
  ]);
  const adapter = new ClaudeModelAdapter({ client });

  await adapter.complete(request());
  await adapter.complete(request({
    turn: 1,
    tool_results: [{ command: ["cat", "log"], code: 0, stdout: "FAIL: timeout", stderr: "" }],
  }));

  const second = client.bodies[1];
  const results = second.messages.at(-1).content;
  assert.equal(results.length, 1);
  assert.equal(results[0].type, "tool_result");
  assert.equal(results[0].tool_use_id, "call-a");
  assert.equal(results[0].is_error, false);
  assert.match(results[0].content, /FAIL: timeout/);
  // The assistant turn carrying the tool_use must be replayed, or the ids dangle.
  assert.equal(second.messages[1].role, "assistant");
});

test("a nonzero exit is reported as an error result", async () => {
  const client = fakeClient([
    { content: [toolUse("call-a", "run_command", { command: ["grep", "nope", "f"] })] },
    { content: [toolUse("call-b", "note", { text: "not found" })] },
  ]);
  const adapter = new ClaudeModelAdapter({ client });

  await adapter.complete(request());
  await adapter.complete(request({
    turn: 1,
    tool_results: [{ command: ["grep", "nope", "f"], code: 1, stdout: "", stderr: "no match" }],
  }));

  const result = client.bodies[1].messages.at(-1).content[0];
  assert.equal(result.is_error, true);
  assert.match(result.content, /no match/);
});

test("a new execution starts a new conversation (Constitution §5)", async () => {
  const client = fakeClient([
    { content: [toolUse("t1", "run_command", { command: ["ls"] })] },
    { content: [toolUse("t2", "note", { text: "a" })] },
    { content: [toolUse("t3", "note", { text: "b" })] },
  ]);
  const adapter = new ClaudeModelAdapter({ client });

  await adapter.complete(request({ execution_id: "exec-1" }));
  await adapter.complete(request({
    execution_id: "exec-1",
    turn: 1,
    tool_results: [{ command: ["ls"], code: 0, stdout: "src", stderr: "" }],
  }));
  // Second execution: history from the first must not survive.
  await adapter.complete(request({ execution_id: "exec-2" }));

  assert.equal(client.bodies[1].messages.length, 3, "turn 2 of exec-1 continues the conversation");
  assert.equal(client.bodies[2].messages.length, 1, "exec-2 starts clean");
  assert.equal(client.bodies[2].messages[0].content, request().prompt);
});

test("a refusal ends the execution with a note rather than stranding it", async () => {
  const client = fakeClient([{
    stop_reason: "refusal",
    stop_details: { type: "refusal", category: "cyber", explanation: "no" },
    content: [],
  }]);
  const adapter = new ClaudeModelAdapter({ client });

  const res = await adapter.complete(request());

  assert.equal(res.actions.length, 1);
  assert.equal(res.actions[0]!.type, "note");
  assert.match((res.actions[0] as { type: "note"; text: string }).text, /declined/);
});

test("usage is priced so budgets charge the real cost", async () => {
  const client = fakeClient([{
    content: [toolUse("t1", "note", { text: "x" })],
    usage: { input_tokens: 1_000_000, output_tokens: 100_000 },
  }]);
  const adapter = new ClaudeModelAdapter({
    client,
    pricing: { input_per_mtok: 5, output_per_mtok: 25 },
  });

  const res = await adapter.complete(request());

  // 1M input at $5/M + 0.1M output at $25/M = $5 + $2.50
  assert.equal(res.usage.cost_usd, 7.5);
  assert.equal(res.usage.input_tokens, 1_000_000);
});

test("requests carry adaptive thinking and a refusal fallback", async () => {
  const client = fakeClient([{ content: [toolUse("t1", "note", { text: "x" })] }]);
  const adapter = new ClaudeModelAdapter({ client });

  await adapter.complete(request());

  const body = client.bodies[0];
  assert.equal(body.model, "claude-opus-5");
  assert.deepEqual(body.thinking, { type: "adaptive" });
  assert.equal(body.fallbacks, "default");
  assert.ok(body.betas.includes("server-side-fallback-2026-07-01"));
});
