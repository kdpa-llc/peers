/**
 * OpenAIModelAdapter contract tests.
 *
 * The mirror of the Claude adapter's suite, against a fake transport: no network, no key.
 * What is under test is the translation layer — permitted tools in, typed actions out —
 * which is the part the control plane depends on, and the part that has to behave the same
 * whichever provider is behind it.
 *
 * The last test here is the one that matters most for ADR 0016: both adapters must offer the
 * same tool names for the same grants. If that ever diverges, swapping providers would
 * quietly change what an agent can do.
 *
 * Enforces CONTRACT_TESTS #5 (least authority on delegation), #22 (no conversation crosses
 * an execution), #23 (the tool surface equals the permission surface) and #29 (a provider
 * swap does not change what an agent may do).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Permission } from "../../src/domain/types.ts";
import type { ModelRequest } from "../../src/data-plane/model/adapter.ts";
import {
  OpenAIModelAdapter, PRESETS,
  type ChatRequest, type ChatResponse, type ChatToolCall,
} from "../../src/data-plane/model/openai.ts";
import { ClaudeModelAdapter, type BetaMessagesClient } from "../../src/data-plane/model/claude.ts";
import { MANAGER } from "../helpers.ts";

/** Canned assistant turns, returned in order; every request body is captured. */
function fakeTransport(turns: Partial<ChatResponse["choices"][number]["message"]>[]) {
  const bodies: ChatRequest[] = [];
  let i = 0;
  const send = async (body: ChatRequest): Promise<ChatResponse> => {
    bodies.push(body);
    const message = turns[Math.min(i++, turns.length - 1)] ?? {};
    return {
      choices: [{ finish_reason: "tool_calls", message: { content: null, ...message } }],
      usage: { prompt_tokens: 1000, completion_tokens: 200 },
    };
  };
  return Object.assign(send, { bodies });
}

const call = (id: string, name: string, args: Record<string, unknown>): ChatToolCall =>
  ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });

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
  const transport = fakeTransport([{ tool_calls: [call("t1", "mark_task_complete", { summary: "done" })] }]);
  const adapter = new OpenAIModelAdapter({ transport });

  const res = await adapter.complete(request({ task_id: "task-9" }));

  assert.deepEqual(res.actions, [
    { type: "mark_task_complete", task_id: "task-9", summary: "done" },
  ]);
});

test("the execution token allowance caps provider output", async () => {
  const transport = fakeTransport([{ content: "done" }]);
  const adapter = new OpenAIModelAdapter({ transport, maxTokens: 16_000 });
  await adapter.complete(request({ max_output_tokens: 321 }));
  assert.equal(transport.bodies[0]!.max_tokens, 321);
});

test("missing or malformed provider usage fails closed", async () => {
  const response = (usage: ChatResponse["usage"]): ChatResponse => ({
    choices: [{ message: { content: "done" } }],
    usage,
  });
  for (const usage of [
    undefined,
    { prompt_tokens: Number.POSITIVE_INFINITY, completion_tokens: 1 },
    { prompt_tokens: 1, completion_tokens: -1 },
  ]) {
    const adapter = new OpenAIModelAdapter({ transport: async () => response(usage) });
    await assert.rejects(() => adapter.complete(request()), /provider returned invalid usage/);
  }
});

test("run_command becomes a sandbox tool call, not an action", async () => {
  const transport = fakeTransport([{ tool_calls: [call("t1", "run_command", { command: ["ls", "workspace"] })] }]);
  const adapter = new OpenAIModelAdapter({ transport });

  const res = await adapter.complete(request());

  assert.deepEqual(res.actions, []);
  assert.deepEqual(res.tool_calls, [{ command: ["ls", "workspace"] }]);
});

test("only permitted tools are offered (CONTRACT_TESTS #23)", async () => {
  const readOnly: Permission[] = [
    { kind: "fs.read", scope: { paths: ["/"] } },
    { kind: "tool.exec" },
    { kind: "sandbox.create" },
  ];
  const transport = fakeTransport([{ tool_calls: [call("t1", "note", { text: "looked" })] }]);
  const adapter = new OpenAIModelAdapter({ transport });

  await adapter.complete(request({ grants: readOnly, available_actions: ["fs.read", "tool.exec"] }));

  const offered = (transport.bodies[0]!.tools ?? []).map((t) => t.function.name);
  assert.ok(offered.includes("run_command"), "tool.exec and sandbox.create were granted");
  assert.ok(offered.includes("note"), "note is always available");
  assert.ok(!offered.includes("delegate_task"), "agent.delegate was not granted");
  assert.ok(!offered.includes("send_message"), "agent.message was not granted");
  assert.ok(!offered.includes("propose_memory_update"), "memory.write_own was not granted");
});

test("strict OpenAI tools require every declared property", async () => {
  const transport = fakeTransport([{ tool_calls: [call("t1", "note", { text: "checked" })] }]);
  const adapter = new OpenAIModelAdapter({ transport });
  await adapter.complete(request({
    grants: [{ kind: "agent.delegate" }, { kind: "memory.write_own" }],
  }));

  const offered = (transport.bodies[0]!.tools ?? []).map((tool) => tool.function);
  for (const tool of offered) {
    const parameters = tool.parameters as {
      properties: Record<string, unknown>;
      required: string[];
    };
    if (tool.strict === true) {
      assert.deepEqual(
        [...parameters.required].sort(),
        Object.keys(parameters.properties).sort(),
        `${String(tool.name)} cannot be strict with optional properties`,
      );
    }
  }
  for (const name of ["delegate_task", "propose_memory_update"] as const) {
    assert.equal(offered.find((tool) => tool.name === name)?.strict, false);
  }
});

test("delegated permissions are narrowed to the manager's own grants (CONTRACT_TESTS #5)", async () => {
  const transport = fakeTransport([{
    tool_calls: [call("t1", "delegate_task", {
      objective: "Analyze the failures.",
      output_contract: "root_cause: string",
      // The model asks for more than the manager holds, including kinds it has no grant for.
      granted_permission_kinds: ["fs.read", "tool.exec", "net.egress", "agent.delegate", "fs.write"],
    })],
  }]);
  const limited: Permission[] = [
    { kind: "fs.read", scope: { paths: ["/repo"] } },
    { kind: "tool.exec" },
    { kind: "agent.delegate" },
    { kind: "agent.create_ephemeral" },
  ];
  const adapter = new OpenAIModelAdapter({ transport });

  const res = await adapter.complete(request({ grants: limited }));

  const action = res.actions[0] as Extract<typeof res.actions[number], { type: "delegate_task" }>;
  assert.equal(action.type, "delegate_task");
  assert.deepEqual(
    (action.granted_permissions ?? []).map((p) => p.kind).sort(),
    ["agent.delegate", "fs.read", "tool.exec"],
  );
  // The scope came from the manager's grant, not from the model.
  assert.deepEqual(
    action.granted_permissions?.find((p) => p.kind === "fs.read")?.scope,
    { paths: ["/repo"] },
  );
});

test("tool output returns as a tool message for every tool_call id", async () => {
  const transport = fakeTransport([
    { tool_calls: [call("call-a", "run_command", { command: ["cat", "log"] })] },
    { tool_calls: [call("call-b", "note", { text: "read the log" })] },
  ]);
  const adapter = new OpenAIModelAdapter({ transport });

  await adapter.complete(request());
  await adapter.complete(request({
    turn: 1,
    tool_results: [{ command: ["cat", "log"], code: 0, stdout: "FAIL: timeout", stderr: "" }],
  }));

  const second = transport.bodies[1]!;
  const last = second.messages.at(-1) as Extract<typeof second.messages[number], { role: "tool" }>;
  assert.equal(last.role, "tool");
  assert.equal(last.tool_call_id, "call-a");
  assert.match(last.content, /FAIL: timeout/);
  // The assistant turn carrying the tool_calls must be replayed, or the ids dangle.
  const assistant = second.messages.find((m) => m.role === "assistant") as any;
  assert.equal(assistant.tool_calls[0].id, "call-a");
});

test("an unexecuted tool call still gets an answer, or the next request is invalid", async () => {
  // Two calls in one turn, only one of them a real command: the note is not executed.
  const transport = fakeTransport([
    {
      tool_calls: [
        call("call-a", "run_command", { command: ["cat", "log"] }),
        call("call-b", "note", { text: "meanwhile" }),
      ],
    },
    { tool_calls: [call("call-c", "mark_task_complete", { summary: "done" })] },
  ]);
  const adapter = new OpenAIModelAdapter({ transport });

  await adapter.complete(request());
  await adapter.complete(request({
    turn: 1,
    tool_results: [{ command: ["cat", "log"], code: 0, stdout: "ok", stderr: "" }],
  }));

  const answered = transport.bodies[1]!.messages
    .filter((m): m is Extract<typeof m, { role: "tool" }> => m.role === "tool")
    .map((m) => m.tool_call_id);
  assert.deepEqual(answered, ["call-a", "call-b"], "every id from the assistant turn is answered");
});

test("a nonzero exit is reported in the tool message", async () => {
  const transport = fakeTransport([
    { tool_calls: [call("call-a", "run_command", { command: ["grep", "nope", "f"] })] },
    { tool_calls: [call("call-b", "note", { text: "not found" })] },
  ]);
  const adapter = new OpenAIModelAdapter({ transport });

  await adapter.complete(request());
  await adapter.complete(request({
    turn: 1,
    tool_results: [{ command: ["grep", "nope", "f"], code: 1, stdout: "", stderr: "no match" }],
  }));

  const last = transport.bodies[1]!.messages.at(-1) as any;
  assert.match(last.content, /exit 1/);
  assert.match(last.content, /no match/);
});

test("a new execution starts a new conversation (Constitution §5, CONTRACT_TESTS #22)", async () => {
  const transport = fakeTransport([
    { tool_calls: [call("t1", "run_command", { command: ["ls"] })] },
    { tool_calls: [call("t2", "note", { text: "a" })] },
    { tool_calls: [call("t3", "note", { text: "b" })] },
  ]);
  const adapter = new OpenAIModelAdapter({ transport });

  await adapter.complete(request({ execution_id: "exec-1" }));
  await adapter.complete(request({
    execution_id: "exec-1",
    turn: 1,
    tool_results: [{ command: ["ls"], code: 0, stdout: "src", stderr: "" }],
  }));
  // Second execution: history from the first must not survive.
  await adapter.complete(request({ execution_id: "exec-2" }));

  // exec-2 carries only the system prompt and the fresh user prompt.
  assert.equal(transport.bodies[2]!.messages.length, 2, "exec-2 starts clean");
  assert.ok(transport.bodies[1]!.messages.length > 2, "turn 2 of exec-1 continued the conversation");
  const fresh = transport.bodies[2]!.messages.at(-1) as any;
  assert.equal(fresh.content, request().prompt);
});

test("a refusal ends the execution with a note rather than stranding it", async () => {
  const transport = fakeTransport([{ refusal: "I can't help with that." }]);
  const adapter = new OpenAIModelAdapter({ transport });

  const res = await adapter.complete(request());

  assert.equal(res.actions.length, 1);
  assert.equal(res.actions[0]!.type, "note");
});

test("malformed tool arguments do not crash the execution", async () => {
  const transport = fakeTransport([{
    tool_calls: [{ id: "t1", type: "function", function: { name: "note", arguments: "{not json" } }],
  }]);
  const adapter = new OpenAIModelAdapter({ transport });

  const res = await adapter.complete(request());

  assert.equal(res.actions.length, 1, "the tool still built an action from empty input");
  assert.equal(res.actions[0]!.type, "note");
});

test("cost is reported as zero rather than guessed when no pricing is configured", async () => {
  const transport = fakeTransport([{ tool_calls: [call("t1", "note", { text: "x" })] }]);
  const adapter = new OpenAIModelAdapter({ transport });

  const res = await adapter.complete(request());

  assert.equal(res.usage.input_tokens, 1000);
  assert.equal(res.usage.output_tokens, 200);
  assert.equal(res.usage.cost_usd, 0, "an invented price would corrupt the budget ledger");
});

test("pricing, when configured, is charged from real usage", async () => {
  const transport = fakeTransport([{ tool_calls: [call("t1", "note", { text: "x" })] }]);
  const adapter = new OpenAIModelAdapter({
    transport,
    pricing: { input_per_mtok: 10, output_per_mtok: 30 },
  });

  const res = await adapter.complete(request());

  // 1000 in at $10/Mtok + 200 out at $30/Mtok.
  assert.equal(res.usage.cost_usd, (1000 * 10 + 200 * 30) / 1_000_000);
});

test("openrouter is the same adapter behind a different base URL", () => {
  assert.equal(PRESETS.openrouter.baseURL, "https://openrouter.ai/api/v1");
  assert.equal(PRESETS.openai.baseURL, "https://api.openai.com/v1");
  assert.notEqual(PRESETS.openrouter.keyEnv, PRESETS.openai.keyEnv);
  assert.equal(
    new OpenAIModelAdapter({ provider: "openrouter", model: "anthropic/claude-opus-4" }).name,
    "openrouter:anthropic/claude-opus-4",
  );
});

test("both providers offer the same tool surface for the same grants (#29)", async () => {
  const grants: Permission[] = [
    { kind: "fs.read", scope: { paths: ["/"] } },
    { kind: "tool.exec" },
    { kind: "agent.message" },
    { kind: "memory.write_own" },
  ];

  const transport = fakeTransport([{ tool_calls: [call("t1", "note", { text: "x" })] }]);
  await new OpenAIModelAdapter({ transport }).complete(request({ grants }));
  const fromOpenAI = (transport.bodies[0]!.tools ?? []).map((t) => t.function.name).sort();

  const bodies: any[] = [];
  const client: BetaMessagesClient = {
    stream(body: any) {
      bodies.push(body);
      return {
        async finalMessage() {
          return {
            id: "m1", type: "message", role: "assistant", model: "claude-opus-5",
            stop_reason: "tool_use", stop_details: null,
            content: [{ type: "tool_use", id: "t1", name: "note", input: { text: "x" } }],
            usage: { input_tokens: 1, output_tokens: 1 },
          } as any;
        },
      };
    },
  };
  await new ClaudeModelAdapter({ client }).complete(request({ grants }));
  const fromClaude = bodies[0].tools.map((t: any) => t.name).sort();

  assert.deepEqual(fromOpenAI, fromClaude,
    "a provider swap must not change what an agent is allowed to do");
});
