/**
 * Deterministic model stand-in.
 *
 * A script is a list of steps, each with a predicate over the assembled prompt and the
 * actions it would take. The adapter picks the first unconsumed step whose predicate
 * matches — the shape of a model choosing what to do next, minus the nondeterminism. This
 * lets the whole control plane run in CI with no API key.
 *
 * Important: the *script* decides to delegate. The control plane contains no branch on
 * agent identity or task text, so there is no hard-coded orchestration graph.
 */
import type { AgentAction, Usage } from "../../domain/types.ts";
import type { ModelAdapter, ModelRequest, ModelResponse } from "./adapter.ts";

export type ScriptStep = {
  /** Human label used in failure messages. */
  label: string;
  /** Matches against the assembled prompt and request metadata. */
  when: (req: ModelRequest) => boolean;
  /** What the "model" decides to do. */
  then: (req: ModelRequest) => AgentAction[];
  /** Sandbox commands the step wants run before its actions are dispatched. */
  tools?: (req: ModelRequest) => { command: string[] }[];
  /** Simulated cost for budget accounting. */
  usage?: Usage;
  /** Allow this step to fire more than once. */
  repeatable?: boolean;
};

const DEFAULT_USAGE: Usage = { input_tokens: 1200, output_tokens: 180, cost_usd: 0.01 };

export class ScriptedModelAdapter implements ModelAdapter {
  readonly name = "scripted";
  readonly contextWindow: number;
  readonly calls: { agent_id: string; prompt: string; step: string }[] = [];
  private readonly script: ScriptStep[];
  private readonly consumed = new Set<number>();

  constructor(script: ScriptStep[], opts: { contextWindow?: number } = {}) {
    this.script = script;
    this.contextWindow = opts.contextWindow ?? 200_000;
  }

  async complete(req: ModelRequest): Promise<ModelResponse> {
    for (let i = 0; i < this.script.length; i++) {
      const step = this.script[i]!;
      if (!step.repeatable && this.consumed.has(i)) continue;
      if (!step.when(req)) continue;
      this.consumed.add(i);
      this.calls.push({ agent_id: req.agent_id, prompt: req.prompt, step: step.label });
      return {
        actions: step.then(req),
        usage: step.usage ?? DEFAULT_USAGE,
        tool_calls: step.tools?.(req),
      };
    }
    this.calls.push({ agent_id: req.agent_id, prompt: req.prompt, step: "(no match)" });
    return {
      actions: [{ type: "note", text: "no scripted step matched; taking no action" }],
      usage: { input_tokens: 200, output_tokens: 10, cost_usd: 0.001 },
    };
  }

  /** Steps never exercised — surfaces a script that drifted from the system under test. */
  unusedSteps(): string[] {
    return this.script.filter((_, i) => !this.consumed.has(i)).map((s) => s.label);
  }
}
