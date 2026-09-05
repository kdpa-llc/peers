/**
 * Model adapter boundary (ADR 0001). The control plane assembles the prompt and interprets
 * the returned actions; the adapter only turns a prompt into intent. Swapping adapters must
 * not change the durable agent model.
 */
import type { AgentAction, Permission, Usage } from "../../domain/types.ts";

export type ModelRequest = {
  /** Fully assembled prompt from the control plane's context builder. */
  prompt: string;
  /** Actions this execution is permitted to take, for the adapter to expose as tools. */
  available_actions: string[];
  /** Identity of the acting agent, for adapters that route by role. */
  agent_id: string;
  /** The execution this call belongs to; adapters key per-execution state on it. */
  execution_id: string;
  /**
   * The acting agent's own grants. An adapter that lets a model delegate uses these to
   * narrow the worker's authority from the manager's actual permissions, so a subset is
   * produced by construction rather than trusted from model output (CONTRACT_TESTS #5).
   */
  grants: Permission[];
  /** Task under execution, when there is one. */
  task_id?: string;
  /**
   * Results of the tool calls this adapter asked for on the previous turn, oldest first.
   * Empty on the first turn. A one-shot adapter can ignore this; an adapter driving a real
   * model needs it, because deciding what to do usually depends on what the tools returned.
   */
  tool_results?: ToolResult[];
  /** 0 on the first call of an execution, incremented for each tool round-trip. */
  turn: number;
  /** Remaining provider output-token allowance for this execution, when bounded. */
  max_output_tokens?: number;
};

export type ToolResult = {
  command: string[];
  code: number;
  stdout: string;
  stderr: string;
};

export type ModelResponse = {
  actions: AgentAction[];
  usage: Usage;
  /**
   * Sandbox commands to run inside the execution's sandbox. Tool use is a runtime concern,
   * so it stays off the AGENT_CONTRACT action list; the runtime executes these and emits
   * tool.* events.
   *
   * Returning tool calls with **no** actions asks the runtime for another turn: it runs the
   * commands and calls `complete` again with their output in `tool_results`. Returning any
   * action ends the execution's model loop, so an adapter that already knows what it wants
   * can return tools and actions together and be called exactly once (ADR 0013).
   */
  tool_calls?: { command: string[] }[];
};

export interface ModelAdapter {
  readonly name: string;
  /** Context window in tokens; the context builder sizes its budget from this. */
  readonly contextWindow: number;
  complete(req: ModelRequest): Promise<ModelResponse>;
}
