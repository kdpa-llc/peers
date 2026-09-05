/**
 * Per-agent model configuration (ADR 0017).
 *
 * An agent's model is part of its durable definition, like its permissions — so the tests
 * that matter are about *precedence and persistence*, not about any particular provider:
 * a declared model wins over the organization default, an undeclared one inherits it, and
 * either survives a restart.
 *
 * The last test is the one that protects the architecture. Resolution reads a field the
 * operator wrote on the agent record; it must never become a mapping from agent id to model,
 * which would move organizational knowledge into the platform (Constitution §2).
 *
 * Enforces CONTRACT_TESTS #30 (an agent's declared model is the model it runs on).
 */
import { test, describe } from "node:test";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { Store } from "../../src/control-plane/store.ts";
import { AgentRuntime } from "../../src/data-plane/runtime.ts";
import { LocalSandbox } from "../../src/data-plane/sandbox/local.ts";
import { EventLog } from "../../src/control-plane/events.ts";
import { ControlPlane } from "../../src/control-plane/controlPlane.ts";
import { Observer } from "../../src/observer/observer.ts";
import { ScriptedModelAdapter } from "../../src/data-plane/model/scripted.ts";
import { ModelResolver } from "../../src/data-plane/model/select.ts";
import type { ModelConfig } from "../../src/domain/types.ts";
import { fixedClock, sequentialIds } from "../../src/control-plane/runtime-env.ts";
import { MANAGER, stepFor } from "../helpers.ts";

describe("model resolution", () => {
  const resolver = new ModelResolver({ provider: "claude", model: "claude-opus-5", thinking: "high" });

  test("an agent with no declaration inherits the organization default", () => {
    assert.deepEqual(resolver.resolve(undefined), {
      provider: "claude", model: "claude-opus-5", thinking: "high",
    });
  });

  test("a declared model overrides the default", () => {
    assert.equal(resolver.resolve({ model: "claude-sonnet-5" }).model, "claude-sonnet-5");
    assert.equal(resolver.resolve({ thinking: "low" }).thinking, "low");
  });

  test("changing provider drops the inherited model id, which belonged to the old provider", () => {
    // Carrying "claude-opus-5" onto openai would send a model id that provider never heard of.
    const resolved = resolver.resolve({ provider: "openai" });
    assert.equal(resolved.provider, "openai");
    assert.equal(resolved.model, undefined, "the default model id did not follow the provider");
    assert.equal(resolved.thinking, "high", "thinking is provider-neutral, so it does follow");
  });

  test("an explicit model survives a provider change", () => {
    const resolved = resolver.resolve({ provider: "openrouter", model: "anthropic/claude-opus-4" });
    assert.equal(resolved.provider, "openrouter");
    assert.equal(resolved.model, "anthropic/claude-opus-4");
  });

  test("the resolved adapter reflects the agent's declaration", () => {
    assert.match(resolver.for({ provider: "openrouter", model: "x/y" }).name, /^openrouter:x\/y$/);
    assert.match(resolver.for(undefined).name, /^claude:/);
  });

  test("each call returns a fresh adapter, so no conversation can span executions", () => {
    const a = resolver.for({ provider: "claude" });
    const b = resolver.for({ provider: "claude" });
    assert.notEqual(a, b, "a shared instance would make Constitution §5 depend on timing");
  });

  test("thinking is mapped onto each provider's own vocabulary, not passed through blindly", () => {
    // Chat Completions has three levels, not five; asking for more yields the most it offers
    // rather than an API error.
    for (const level of ["high", "xhigh", "max"] as const) {
      assert.doesNotThrow(() => resolver.for({ provider: "openai", thinking: level }));
    }
  });
});

describe("model configuration is durable agent state (CONTRACT_TESTS #30)", () => {
  function organization() {
    const store = new Store();
    const clock = fixedClock();
    const ids = sequentialIds();
    const events = new EventLog(store, clock, ids);
    const model = new ScriptedModelAdapter([stepFor("mgr", "note", () => [{ type: "note", text: "ok" }])]);
    const runtime = new AgentRuntime(model, new LocalSandbox(), events);
    const cp = new ControlPlane(runtime, {
      store, clock, ids,
      workspaceRoot: process.cwd(),
      budgets: { org_usd: 100, default_agent_usd_per_day: 10, execution_usd: 5 },
    });
    return { cp, store, observer: new Observer(store) };
  }

  const CONFIG: ModelConfig = {
    provider: "openrouter",
    model: "anthropic/claude-opus-4",
    thinking: "max",
  };

  test("a model declared at creation is stored on the agent", () => {
    const { cp, store } = organization();
    cp.createAgent({
      agent_id: "reviewer",
      name: "Security Reviewer",
      responsibility: "Own the supply-chain posture.",
      mission: "Keep dependencies defensible.",
      permissions: MANAGER,
      model_config: CONFIG,
    });

    assert.deepEqual(store.getAgent("reviewer")?.model_config, CONFIG);
  });

  test("it survives a store round-trip, like every other part of the definition", () => {
    const { cp, store } = organization();
    cp.createAgent({
      agent_id: "reviewer",
      name: "Security Reviewer",
      responsibility: "Own the supply-chain posture.",
      mission: "Keep dependencies defensible.",
      permissions: MANAGER,
      model_config: CONFIG,
    });

    // Re-read through a fresh Observer, as a second process would.
    const reread = new Observer(store).agentDetail("reviewer").agent;
    assert.deepEqual(reread?.model_config, CONFIG);
  });

  test("changing it bumps the revision and is announced", () => {
    const { cp, store } = organization();
    cp.createAgent({
      agent_id: "reviewer",
      name: "Security Reviewer",
      responsibility: "Own the supply-chain posture.",
      mission: "Keep dependencies defensible.",
      permissions: MANAGER,
    });
    const before = store.getAgent("reviewer")!.revision;

    const after = cp.setAgentModel("reviewer", CONFIG);

    assert.equal(after.revision, before + 1, "a definitional change increments the revision");
    assert.deepEqual(store.getAgent("reviewer")?.model_config, CONFIG);
    const announced = store.events().filter((e) => e.event_type === "agent.updated");
    assert.equal(announced.length, 1, "an operator moving an agent's model is visible");
    assert.match(String(announced[0]!.summary), /openrouter/);
  });

  test("resetting it returns the agent to the organization default", () => {
    const { cp, store } = organization();
    cp.createAgent({
      agent_id: "reviewer",
      name: "Security Reviewer",
      responsibility: "Own the supply-chain posture.",
      mission: "Keep dependencies defensible.",
      permissions: MANAGER,
      model_config: CONFIG,
    });

    cp.setAgentModel("reviewer", undefined);

    assert.equal(store.getAgent("reviewer")?.model_config, undefined);
  });

  test("two agents can hold different models at the same time", () => {
    const { cp, store } = organization();
    for (const [id, config] of [
      ["reviewer", CONFIG],
      ["chores", { provider: "openai", thinking: "low" } as ModelConfig],
    ] as const) {
      cp.createAgent({
        agent_id: id,
        name: id,
        responsibility: `${id} responsibility`,
        mission: `${id} mission`,
        permissions: MANAGER,
        model_config: config,
      });
    }

    assert.equal(store.getAgent("reviewer")?.model_config?.provider, "openrouter");
    assert.equal(store.getAgent("chores")?.model_config?.provider, "openai");
    assert.equal(store.getAgent("chores")?.model_config?.thinking, "low");
  });

  test("model resolution reads a declared field, never an agent id (Constitution §2)", async () => {
    // A structural check, in the style of the control-plane scan: resolution must key off
    // the config the operator wrote, not off who is asking. The moment it branches on
    // identity, the platform has started holding organizational knowledge.
    const source = await readFile(
      new URL("../../src/data-plane/model/select.ts", import.meta.url), "utf8",
    );
    assert.ok(!/agent_id/.test(source), "the resolver never even sees an agent id");
    assert.ok(!/["'](repo-maintainer|reviewer|mgr)["']/.test(source), "no agent id is hard-coded");

    // And the behavioural half: identical declarations resolve identically, whoever holds them.
    const resolver = new ModelResolver({ provider: "claude" });
    assert.deepEqual(
      resolver.resolve({ provider: "openai", thinking: "low" }),
      resolver.resolve({ provider: "openai", thinking: "low" }),
    );
  });
});

describe("the context budget is sized from the agent's own model", () => {
  test("windowFor reports the declared model's window, not a single global number", () => {
    const store = new Store();
    const clock = fixedClock();
    const ids = sequentialIds();
    const events = new EventLog(store, clock, ids);
    const resolver = new ModelResolver({ provider: "claude" });
    const runtime = new AgentRuntime(resolver, new LocalSandbox(), events);

    const claudeWindow = runtime.windowFor(undefined);
    const openaiWindow = runtime.windowFor({ provider: "openai" });

    assert.ok(claudeWindow > 0 && openaiWindow > 0);
    assert.notEqual(claudeWindow, openaiWindow,
      "two providers with different windows must not share one budget");
  });
});
