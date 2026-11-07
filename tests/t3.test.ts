/** The T3 backend: recorded shapes, model choice, and the embedded server's isolation (ADR 0003). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fromSummary, modelsFromConfig, selectionFor, stateOf } from "../src/vault/engine.ts";
import { cleanEnv, writeProviderSettings } from "../src/vault/t3/runtime.ts";
import { failureMessage } from "../src/vault/t3/client.ts";

const fixture = (name: string): any => JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", name), "utf8"));

test("a recorded T3 thread maps to a finished conversation; a live update to a working one", () => {
  const shell = fixture("t3-shell.json");
  const done = fromSummary(shell.threads[0]);
  assert.equal(done.state, "idle");
  assert.equal(done.title, "Launch date check");
  assert.equal(done.lastRunAt, "2026-11-06T21:30:34.266Z");
  assert.deepEqual(done.model, { provider: "claude", model: "claude-sonnet-5-5" });
  assert.equal(done.archived, false);
  // shell updates carry only some fields: the rest is kept from what was known
  const chunk = fixture("t3-chunk.json");
  const running = fromSummary(chunk.values[0].thread, done);
  assert.equal(running.state, "working");
  assert.equal(running.createdAt, done.createdAt);
  assert.deepEqual(running.model, done.model);
});

test("thread states: waiting for approval, failed, and finished", () => {
  assert.equal(stateOf("running", null, null), "working");
  assert.equal(stateOf("completed", { kind: "approval" }, null), "waiting");
  assert.equal(stateOf("failed", null, "boom"), "failed");
  assert.equal(stateOf("interrupted", null, null), "idle");
  assert.equal(stateOf("completed", null, null), "idle");
});

test("models come from the server's config, with each provider's effort option", () => {
  const config = {
    providers: [
      { instanceId: "claudeAgent", enabled: true, status: "ready", models: [
        { slug: "claude-opus-5-5", name: "Claude Opus 5.5", isDefault: true, capabilities: { optionDescriptors: [
          { id: "effort", options: [{ id: "low" }, { id: "medium" }, { id: "high" }, { id: "ultrathink" }] }] } },
        { slug: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", capabilities: { optionDescriptors: [] } }] },
      { instanceId: "codex", enabled: true, status: "warning", message: "update available", models: [
        { slug: "gpt-6-astra", name: "GPT-6-Astra", isDefault: true, capabilities: { optionDescriptors: [
          { id: "reasoningEffort", options: [{ id: "low" }, { id: "xhigh" }, { id: "ultra" }] }] } }] },
      { instanceId: "cursor", enabled: false, models: [] },
    ],
  };
  const { models, providers } = modelsFromConfig({ value: config });
  assert.deepEqual(models.map((m) => m.model), ["claude-opus-5-5", "claude-sonnet-5-5", "gpt-6-astra"]);
  assert.deepEqual(models[0]!.efforts.map((e) => e.id), ["low", "medium", "high"], "only the five standard levels");
  assert.deepEqual(providers, [{ provider: "claude", ready: true }, { provider: "codex", ready: true, message: "update available" }]);

  assert.deepEqual(selectionFor({ provider: "claude", model: "claude-sonnet-5-5", thinking: "low" }, models),
    { instanceId: "claudeAgent", model: "claude-sonnet-5-5", options: [{ id: "effort", value: "low" }] });
  assert.deepEqual(selectionFor({ provider: "codex", thinking: "max" }, models),
    { instanceId: "codex", model: "gpt-6-astra", options: [{ id: "reasoningEffort", value: "low" }] },
    "default model; an effort the model lacks falls back");
  assert.equal(selectionFor({}, []).instanceId, "claudeAgent");
});

test("the embedded T3 gets a clean environment and the bots' own config folders", () => {
  const env = cleanEnv({
    PATH: "/usr/bin", HOME: "/Users/x", CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", T3CODE_HOME: "/owner",
    AI_AGENT: "claude", ANTHROPIC_API_KEY: "secret", OPENAI_API_KEY: "secret", CODEX_HOME: "/owner/.codex",
  }, { T3CODE_HOME: "/bots" });
  assert.deepEqual(env, { PATH: "/usr/bin", HOME: "/Users/x", T3CODE_HOME: "/bots" });

  const base = mkdtempSync(join(tmpdir(), "peers-t3-"));
  mkdirSync(join(base, "userdata"));
  writeFileSync(join(base, "userdata", "settings.json"), JSON.stringify({ theme: "dark", providerInstances: { cursor: { enabled: false } } }));
  writeProviderSettings(base, { claude: "/homes/claude", codex: "/homes/codex" });
  const s = JSON.parse(readFileSync(join(base, "userdata", "settings.json"), "utf8"));
  assert.equal(s.theme, "dark", "other settings kept");
  assert.deepEqual(s.providerInstances.cursor, { enabled: false });
  assert.equal(s.providerInstances.claudeAgent.config.homePath, "/homes/claude");
  assert.equal(s.providerInstances.codex.config.homePath, "/homes/codex");
});

test("RPC failures surface their reason", () => {
  const exit = { _tag: "Failure", cause: { _tag: "Fail", error: { _tag: "OrchestrationError", message: "project not found" } } };
  assert.equal(failureMessage(exit), "project not found");
  assert.equal(failureMessage({}), "T3 refused the request");
});
