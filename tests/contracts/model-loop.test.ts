/**
 * The runtime's bounded model loop (ADR 0013).
 *
 * A real model decides what to do *after* seeing tool output, so the runtime must be able to
 * run tools and call the adapter again. These tests pin the loop's contract: tool output
 * comes back, the sandbox outlives a turn, actions end the loop, and a model that never
 * decides anything costs a bounded number of turns rather than an unbounded one.
 *
 * Enforces CONTRACT_TESTS #20 (tool output reaches the next turn) and #21 (bounded loop,
 * usage summed across turns).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent, Permission } from "../../src/domain/types.ts";
import type { BuiltContext } from "../../src/control-plane/context.ts";
import type { ModelAdapter, ModelRequest, ModelResponse } from "../../src/data-plane/model/adapter.ts";
import { OpenAIModelAdapter } from "../../src/data-plane/model/openai.ts";
import { AgentRuntime } from "../../src/data-plane/runtime.ts";
import { LocalSandbox } from "../../src/data-plane/sandbox/local.ts";
import { EventLog } from "../../src/control-plane/events.ts";
import { Store } from "../../src/control-plane/store.ts";
import { fixedClock, sequentialIds } from "../../src/control-plane/runtime-env.ts";

const GRANTS: Permission[] = [
  { kind: "fs.read", scope: { paths: ["/"] } },
  { kind: "fs.write", scope: { paths: ["/"] } },
  { kind: "tool.exec" },
  { kind: "sandbox.create" },
];

/** Records every request it receives and replays a fixed list of responses. */
class StubAdapter implements ModelAdapter {
  readonly name = "stub";
  readonly contextWindow = 200_000;
  readonly seen: ModelRequest[] = [];
  private readonly turns: ModelResponse[];

  constructor(turns: ModelResponse[]) {
    this.turns = turns;
  }

  async complete(req: ModelRequest): Promise<ModelResponse> {
    this.seen.push(structuredClone(req));
    return this.turns[Math.min(this.seen.length - 1, this.turns.length - 1)]!;
  }
}

const usage = { input_tokens: 100, output_tokens: 20, cost_usd: 0.01 };

function harness(adapter: ModelAdapter) {
  const store = new Store();
  const events = new EventLog(store, fixedClock(), sequentialIds());
  return { runtime: new AgentRuntime(adapter, new LocalSandbox(), events), store };
}

const context = (): BuiltContext => ({
  agent: { agent_id: "w1", name: "Worker" } as Agent,
  sections: [],
  manifest: [],
  context_pressure: false,
  total_tokens: 10,
  prompt: "inspect the workspace",
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "loop-test-"));
  return root;
}

test("tool output from one turn reaches the model on the next", async () => {
  const adapter = new StubAdapter([
    { actions: [], usage, tool_calls: [{ command: ["echo", "hello-from-sandbox"] }] },
    { actions: [{ type: "note", text: "saw it" }], usage },
  ]);
  const { runtime } = harness(adapter);

  const out = await runtime.runExecution({
    execution_id: "exec-1",
    context: context(),
    grants: GRANTS,
    sandbox: { mounts: [{ source: await workspace(), target: "workspace" }], timeout_seconds: 30 },
  });

  assert.equal(adapter.seen.length, 2);
  assert.equal(adapter.seen[0]!.turn, 0);
  assert.deepEqual(adapter.seen[0]!.tool_results, []);
  assert.equal(adapter.seen[1]!.turn, 1);
  assert.match(adapter.seen[1]!.tool_results![0]!.stdout, /hello-from-sandbox/);
  assert.deepEqual(out.actions, [{ type: "note", text: "saw it" }]);
});

test("the sandbox outlives a turn, so a file written on turn 1 is readable on turn 2", async () => {
  const adapter = new StubAdapter([
    { actions: [], usage, tool_calls: [{ command: ["write_file", "outputs/x.txt", "persisted"] }] },
    { actions: [], usage, tool_calls: [{ command: ["cat", "outputs/x.txt"] }] },
    { actions: [{ type: "note", text: "done" }], usage },
  ]);
  const { runtime } = harness(adapter);

  await runtime.runExecution({
    execution_id: "exec-2",
    context: context(),
    grants: GRANTS,
    sandbox: { mounts: [{ source: await workspace(), target: "workspace" }], timeout_seconds: 30 },
  });

  assert.equal(adapter.seen.length, 3);
  assert.match(adapter.seen[2]!.tool_results![0]!.stdout, /persisted/);
});

test("usage accumulates across turns so budgets see the whole execution", async () => {
  const adapter = new StubAdapter([
    { actions: [], usage, tool_calls: [{ command: ["echo", "1"] }] },
    { actions: [], usage, tool_calls: [{ command: ["echo", "2"] }] },
    { actions: [{ type: "note", text: "done" }], usage },
  ]);
  const { runtime } = harness(adapter);

  const out = await runtime.runExecution({
    execution_id: "exec-3",
    context: context(),
    grants: GRANTS,
    sandbox: { mounts: [{ source: await workspace(), target: "workspace" }], timeout_seconds: 30 },
  });

  assert.equal(out.usage.cost_usd, 0.03);
  assert.equal(out.usage.input_tokens, 300);
});

test("remaining execution tokens cap every provider turn", async () => {
  const adapter = new StubAdapter([
    { actions: [], usage, tool_calls: [{ command: ["echo", "continue"] }] },
    { actions: [{ type: "note", text: "done" }], usage },
  ]);
  const { runtime } = harness(adapter);

  await runtime.runExecution({
    execution_id: "exec-token-cap",
    context: context(),
    grants: GRANTS,
    model_token_limit: 1_000,
    sandbox: { mounts: [{ source: await workspace(), target: "workspace" }], timeout_seconds: 30 },
  });

  assert.equal(adapter.seen[0]!.max_output_tokens, 990, "context estimate is reserved");
  assert.equal(adapter.seen[1]!.max_output_tokens, 870, "reported prior usage is also reserved");
});

test("a token ceiling with no room for context refuses the call itself", async () => {
  const adapter = new StubAdapter([{ actions: [{ type: "note", text: "must not run" }], usage }]);
  const { runtime } = harness(adapter);
  const built = context();

  const outcome = await runtime.runExecution({
    execution_id: "exec-no-token-room",
    context: built,
    grants: GRANTS,
    model_token_limit: built.total_tokens,
  });

  assert.equal(adapter.seen.length, 0);
  assert.match(outcome.budget_exhausted ?? "", /model token limit/);
  assert.deepEqual(outcome.actions, []);
});

test("a model that never decides anything is capped, not unbounded", async () => {
  // Always asks for another command, never returns an action.
  const adapter = new StubAdapter([
    { actions: [], usage, tool_calls: [{ command: ["echo", "again"] }] },
  ]);
  const { runtime } = harness(adapter);

  const out = await runtime.runExecution({
    execution_id: "exec-4",
    context: context(),
    grants: GRANTS,
    sandbox: { mounts: [{ source: await workspace(), target: "workspace" }], timeout_seconds: 30 },
  });

  assert.equal(adapter.seen.length, 8, "MAX_TURNS");
  assert.deepEqual(out.actions, [], "no action was ever taken");
});

test("an adapter that returns tools and actions together is called exactly once", async () => {
  // The scripted adapter's shape: it already knows what it wants.
  const adapter = new StubAdapter([
    { actions: [{ type: "note", text: "decided" }], usage, tool_calls: [{ command: ["echo", "hi"] }] },
  ]);
  const { runtime } = harness(adapter);

  const out = await runtime.runExecution({
    execution_id: "exec-5",
    context: context(),
    grants: GRANTS,
    sandbox: { mounts: [{ source: await workspace(), target: "workspace" }], timeout_seconds: 30 },
  });

  assert.equal(adapter.seen.length, 1);
  assert.deepEqual(out.actions, [{ type: "note", text: "decided" }]);
});

test("a turn with no actions and no tools ends the loop instead of repeating itself", async () => {
  const adapter = new StubAdapter([{ actions: [], usage }]);
  const { runtime } = harness(adapter);

  const out = await runtime.runExecution({
    execution_id: "exec-6",
    context: context(),
    grants: GRANTS,
  });

  assert.equal(adapter.seen.length, 1);
  assert.deepEqual(out.actions, []);
});

test("#18 registered credentials are redacted from prompts, tool results, and events", async () => {
  const secret = "sk-test-peers-never-send-this-value";
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = secret;
  try {
    const adapter = new StubAdapter([
      {
        actions: [], usage,
        tool_calls: [
          { command: ["cat", "workspace/notes.txt"] },
          { command: [secret] },
          { command: ["write_file", "outputs/provider-key.txt", secret] },
        ],
      },
      { actions: [{ type: "note", text: `model repeated ${secret}` }], usage },
    ]);
    const { runtime, store } = harness(adapter);
    const root = await workspace();
    await writeFile(join(root, "notes.txt"), `accidentally copied ${secret}`, "utf8");
    const secretContext = context();
    secretContext.prompt = `operator pasted ${secret}`;

    const outcome = await runtime.runExecution({
      execution_id: "exec-secret",
      context: secretContext,
      grants: GRANTS,
      sandbox: { mounts: [{ source: root, target: "workspace" }], timeout_seconds: 30 },
    });

    assert.doesNotMatch(adapter.seen[0]!.prompt, new RegExp(secret));
    assert.match(adapter.seen[0]!.prompt, /REDACTED CREDENTIAL/);
    assert.doesNotMatch(adapter.seen[1]!.tool_results![0]!.stdout, new RegExp(secret));
    assert.match(adapter.seen[1]!.tool_results![0]!.stdout, /REDACTED CREDENTIAL/);
    assert.doesNotMatch(JSON.stringify(store.events()), new RegExp(secret));
    assert.doesNotMatch(JSON.stringify(outcome.actions), new RegExp(secret));
    assert.match(JSON.stringify(outcome.actions), /REDACTED CREDENTIAL/);
    assert.equal(outcome.artifacts.length, 1);
    assert.doesNotMatch(await readFile(outcome.artifacts[0]!.uri, "utf8"), new RegExp(secret));
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  }
});

test("provider errors are credential-redacted before the control plane can store them", async () => {
  const secret = "sk-test-provider-error-must-not-persist";
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = secret;
  try {
    const adapter: ModelAdapter = {
      name: "failing",
      contextWindow: 200_000,
      async complete() { throw new Error(`provider echoed ${secret}`); },
    };
    const { runtime } = harness(adapter);
    await assert.rejects(
      () => runtime.runExecution({ execution_id: "exec-provider-error", context: context(), grants: GRANTS }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.doesNotMatch(err.message, new RegExp(secret));
        assert.match(err.message, /REDACTED CREDENTIAL/);
        return true;
      },
    );
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  }
});

test("provider errors redact credentials supplied directly to an adapter", async () => {
  const secret = "sk-programmatic-provider-key-must-not-persist";
  const adapter = new OpenAIModelAdapter({
    apiKey: secret,
    transport: async () => { throw new Error(`upstream echoed ${secret}`); },
  });
  const { runtime } = harness(adapter);
  await assert.rejects(
    () => runtime.runExecution({ execution_id: "exec-direct-key-error", context: context(), grants: GRANTS }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.doesNotMatch(err.message, new RegExp(secret));
      assert.match(err.message, /REDACTED CREDENTIAL/);
      return true;
    },
  );
});

test("invalid provider usage fails closed before model intent is honored", async () => {
  const adapter = new StubAdapter([{
    actions: [{ type: "note", text: "must not be honored" }],
    usage: { input_tokens: Number.NaN, output_tokens: 1, cost_usd: 0 },
  }]);
  const { runtime } = harness(adapter);
  await assert.rejects(
    () => runtime.runExecution({ execution_id: "exec-invalid-usage", context: context(), grants: GRANTS }),
    /invalid usage\.input_tokens/,
  );

  const malformed = new StubAdapter([{
    actions: [{ type: "note", text: "must not be honored" }],
    usage: null as unknown as ModelResponse["usage"],
  }]);
  await assert.rejects(
    () => harness(malformed).runtime.runExecution({
      execution_id: "exec-malformed-usage", context: context(), grants: GRANTS,
    }),
    /invalid usage/,
  );
});

test("provider token counters must be exact safe integers", async () => {
  const adapter = new StubAdapter([{
    actions: [{ type: "note", text: "must not be honored" }],
    usage: { input_tokens: Number.MAX_SAFE_INTEGER + 1, output_tokens: 0, cost_usd: 0 },
  }]);
  const { runtime } = harness(adapter);
  await assert.rejects(
    () => runtime.runExecution({ execution_id: "exec-unsafe-usage", context: context(), grants: GRANTS }),
    /invalid usage\.input_tokens/,
  );
});

test("valid per-turn usage cannot overflow the cumulative ledger", async () => {
  const huge = Number.MAX_VALUE;
  const adapter = new StubAdapter([
    { actions: [], usage: { input_tokens: 1, output_tokens: 0, cost_usd: huge },
      tool_calls: [{ command: ["echo", "continue"] }] },
    { actions: [{ type: "note", text: "must not be honored" }],
      usage: { input_tokens: 1, output_tokens: 0, cost_usd: huge } },
  ]);
  const { runtime } = harness(adapter);
  const root = await workspace();
  await assert.rejects(
    () => runtime.runExecution({
      execution_id: "exec-overflow-usage",
      context: context(),
      grants: GRANTS,
      sandbox: { mounts: [{ source: root, target: "workspace" }], timeout_seconds: 30 },
    }),
    /invalid usage\.cost_usd/,
  );
});

test("tool calls are mechanically refused without tool.exec and sandbox.create", async () => {
  const adapter = new StubAdapter([
    { actions: [], usage, tool_calls: [{ command: ["echo", "must-not-run"] }] },
    { actions: [{ type: "note", text: "saw denial" }], usage },
  ]);
  const { runtime, store } = harness(adapter);

  await runtime.runExecution({
    execution_id: "exec-denied-tool",
    context: context(),
    grants: [{ kind: "fs.read", scope: { paths: ["/"] } }],
    sandbox: { mounts: [{ source: await workspace(), target: "workspace" }], timeout_seconds: 30 },
  });

  assert.equal(adapter.seen.length, 2);
  assert.equal(adapter.seen[1]!.tool_results![0]!.code, 126);
  assert.ok(store.events().some(
    (event) => event.event_type === "permission.denied" && event.summary?.includes("tool.exec"),
  ));
  assert.equal(store.events().some((event) => event.event_type === "tool.invoked"), false);
});

test("malformed grants are removed before the model or sandbox can use them", async () => {
  const adapter = new StubAdapter([
    { actions: [], usage, tool_calls: [{ command: ["echo", "must-not-run"] }] },
    { actions: [{ type: "note", text: "saw denial" }], usage },
  ]);
  const { runtime, store } = harness(adapter);
  const malformedTool = {
    kind: "tool.exec",
    scope: { unexpected: true },
  } as unknown as Permission;

  await runtime.runExecution({
    execution_id: "exec-malformed-tool-grant",
    context: context(),
    grants: [
      { kind: "fs.read", scope: { paths: ["/"] } },
      { kind: "sandbox.create" },
      malformedTool,
    ],
    sandbox: { mounts: [{ source: await workspace(), target: "workspace" }], timeout_seconds: 30 },
  });

  assert.equal(adapter.seen[0]!.grants.includes(malformedTool), false);
  assert.equal(adapter.seen[0]!.available_actions.includes("tool.exec"), false);
  assert.equal(adapter.seen[1]!.tool_results![0]!.code, 126);
  assert.equal(store.events().some((event) => event.event_type === "tool.invoked"), false);
});
