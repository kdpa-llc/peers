/**
 * Agent runtime — the data plane (ADR 0001).
 *
 * Starts a session for one execution, invokes the model with the context the control plane
 * assembled, runs any tool calls inside the execution's sandbox, and streams normalized
 * events. It returns the agent's requested actions; it never mutates durable state itself —
 * authorization and mechanics belong to the control plane (Constitution §3).
 */
import type { AgentAction, Artifact, Permission, Usage } from "../domain/types.ts";
import type { BuiltContext } from "../control-plane/context.ts";
import type { EventLog } from "../control-plane/events.ts";
import type { ModelAdapter, ToolResult } from "./model/adapter.ts";
import type { ModelConfig } from "../domain/types.ts";
import type { Sandbox, SandboxHandle } from "./sandbox/adapter.ts";
import { redactRegisteredCredentials, registeredCredentialValues } from "./redaction.ts";

/**
 * Ceiling on model turns per execution. Reaching it ends the execution with whatever
 * actions the agent has taken so far, rather than looping on the platform's budget.
 */
const MAX_TURNS = 8;

function validatedUsage(raw: Usage): Required<Usage> {
  const number = (value: unknown, field: string, integer: boolean): number => {
    if (value === undefined) return 0;
    if (
      typeof value !== "number" || !Number.isFinite(value) || value < 0 ||
      (integer && !Number.isInteger(value))
    ) {
      throw new Error(`model returned invalid ${field}`);
    }
    return value;
  };
  return {
    input_tokens: number(raw?.input_tokens, "usage.input_tokens", true),
    output_tokens: number(raw?.output_tokens, "usage.output_tokens", true),
    cost_usd: number(raw?.cost_usd, "usage.cost_usd", false),
  };
}

/** Model intent is JSON-shaped; redact registered credentials before it reaches storage. */
function redactValue<T>(value: T, redact: (text: string) => string): T {
  if (typeof value === "string") return redact(value) as T;
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, redact)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, redactValue(entry, redact)]),
    ) as T;
  }
  return value;
}

export type RuntimeOutcome = {
  actions: AgentAction[];
  usage: Usage;
  artifacts: Artifact[];
  /** Set when a pre- or post-model-call guard refuses further execution. */
  budget_exhausted?: string;
  /**
   * True when sandbox output was fed back to the model during this execution. Whatever the
   * agent decided afterwards is derived from content the platform does not control, so the
   * control plane stamps provenance on the records it produces (CONTRACT_TESTS #19).
   *
   * This is a mechanical fact about the execution, not a judgment about the content.
   */
  read_untrusted: boolean;
};

/** Either every agent shares one adapter, or a resolver picks one per agent (ADR 0017). */
export type ModelSource = ModelAdapter | { for(config?: ModelConfig): ModelAdapter };

export type RunArgs = {
  execution_id: string;
  context: BuiltContext;
  grants: Permission[];
  correlation_id?: string;
  /** Provision a sandbox for this execution (workers always; managers only if granted). */
  sandbox?: { mounts: { source: string; target: string }[]; timeout_seconds: number };
  /** The acting agent's declared model, if it has one (ADR 0017). */
  model_config?: ModelConfig;
  /** Control-plane callbacks that gate and account for every individual model call. */
  model_call_budget?: {
    before(usage: Usage): { ok: true } | { ok: false; detail: string };
    /** Called after actual usage is accumulated and before response intent is honored. */
    after(usage: Usage): { ok: true } | { ok: false; detail: string };
  };
  /** Total input + output token ceiling applied across every model turn. */
  model_token_limit?: number;
};

export class AgentRuntime {
  private readonly models: ModelSource;
  private readonly sandbox: Sandbox;
  private readonly events: EventLog;

  /**
   * Takes either a single adapter — every agent thinks with the same model — or a resolver
   * that picks one from the agent's own declaration (ADR 0017). Tests inject an adapter
   * directly, which is why both are accepted.
   */
  constructor(model: ModelSource, sandbox: Sandbox, events: EventLog) {
    this.models = model;
    this.sandbox = sandbox;
    this.events = events;
  }

  /** The adapter for one execution: per-agent when a resolver was injected, else the one. */
  private adapterFor(config?: ModelConfig): ModelAdapter {
    return "for" in this.models ? this.models.for(config) : this.models;
  }

  get modelName(): string { return this.adapterFor().name; }
  get contextWindow(): number { return this.adapterFor().contextWindow; }

  /** Context window for one agent's model, so the context budget is sized per agent. */
  windowFor(config?: ModelConfig): number { return this.adapterFor(config).contextWindow; }

  async runExecution(args: RunArgs): Promise<RuntimeOutcome> {
    const agentId = args.context.agent.agent_id;
    const availableActions = args.grants.map((g) => g.kind);
    const credentials = registeredCredentialValues();
    const redact = (value: string): string => redactRegisteredCredentials(value, credentials);

    // One adapter for this execution, resolved from the agent's own declaration. Resolving
    // once here — not per turn — is what makes the conversation buffer span the execution.
    const model = this.adapterFor(args.model_config);

    const artifacts: Artifact[] = [];
    const usage: Usage = { input_tokens: 0, output_tokens: 0, cost_usd: 0 };
    let handle: SandboxHandle | undefined;
    let toolResults: ToolResult[] = [];
    let actions: AgentAction[] = [];
    let readUntrusted = false;
    let budgetExhausted: string | undefined;

    try {
      // Bounded model loop (ADR 0013). A turn that returns actions ends the execution; a
      // turn that returns only tool calls gets their output back and runs again. The cap
      // makes a looping model a bounded cost rather than an unbounded one.
      for (let turn = 0; turn < MAX_TURNS; turn++) {
        const before = args.model_call_budget?.before({ ...usage }) ?? { ok: true as const };
        if (!before.ok) {
          budgetExhausted = before.detail;
          break;
        }

        const consumedTokens = (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);
        const estimatedInputTokens = Math.max(0, args.context.total_tokens);
        const remainingOutputTokens = args.model_token_limit === undefined
          ? undefined
          : Math.max(1, Math.floor(args.model_token_limit - consumedTokens - estimatedInputTokens));
        let response;
        try {
          response = await model.complete({
            // Provider credentials may exist in durable operator input by mistake. Exact-value
            // redaction is the last boundary before any reconstructed context leaves the process.
            prompt: redact(args.context.prompt),
            available_actions: availableActions,
            agent_id: agentId,
            execution_id: args.execution_id,
            grants: args.grants,
            task_id: args.context.task?.task_id,
            tool_results: toolResults,
            turn,
            max_output_tokens: remainingOutputTokens,
          });
        } catch (err) {
          // Provider error bodies are untrusted and may echo request material. The control
          // plane persists this message, so apply the same credential boundary as prompts.
          throw new Error(redact(err instanceof Error ? err.message : String(err)));
        }

        // Usage accumulates across turns so budgets see the true cost of the execution,
        // not just its final turn. Every field is optional on Usage.
        const turnUsage = validatedUsage(response.usage);
        usage.input_tokens = (usage.input_tokens ?? 0) + turnUsage.input_tokens;
        usage.output_tokens = (usage.output_tokens ?? 0) + turnUsage.output_tokens;
        usage.cost_usd = (usage.cost_usd ?? 0) + turnUsage.cost_usd;

        // The provider has already charged this usage, so account for it even when the
        // response crosses a ceiling. Its actions and tool calls are not honored unless
        // the authoritative actual-usage check passes.
        const after = args.model_call_budget?.after({ ...usage }) ?? { ok: true as const };
        if (!after.ok) {
          budgetExhausted = after.detail;
          break;
        }

        const toolCalls = (response.tool_calls ?? []).map((call) => ({
          command: call.command.map((part) => redact(String(part))),
        }));
        toolResults = [];

        if (toolCalls.length > 0) {
          const canExecute = args.grants.some((grant) => grant.kind === "tool.exec")
            && args.grants.some((grant) => grant.kind === "sandbox.create");
          if (!canExecute) {
            for (const call of toolCalls) {
              this.events.emit({
                type: "permission.denied",
                agent_id: agentId,
                execution_id: args.execution_id,
                correlation_id: args.correlation_id,
                summary: "sandbox command denied; tool.exec and sandbox.create are required",
                visibility: "audit",
              });
              toolResults.push({
                command: [redact(call.command[0] ?? "(empty)")],
                code: 126,
                stdout: "",
                stderr: "permission denied: tool.exec and sandbox.create are required",
              });
            }
          } else if (!args.sandbox) {
            this.events.emit({
              type: "tool.failed",
              agent_id: agentId,
              execution_id: args.execution_id,
              correlation_id: args.correlation_id,
              summary: "tool call requested without a provisioned sandbox",
            });
          } else {
            // One sandbox per execution, not per turn: a worker that writes a file on turn
            // 1 must still see it on turn 2.
            handle ??= await this.sandbox.create({
              execution_id: args.execution_id,
              agent_id: agentId,
              mounts: args.sandbox.mounts,
              grants: args.grants,
              timeout_seconds: args.sandbox.timeout_seconds,
            });
            for (const call of toolCalls) {
              const commandName = call.command[0] ?? "(empty)";
              const safeCommandName = redact(commandName);
              this.events.emit({
                type: "tool.invoked",
                agent_id: agentId,
                execution_id: args.execution_id,
                correlation_id: args.correlation_id,
                summary: `${safeCommandName} invoked`,
                // Arguments can contain file content (write_file) and are deliberately not
                // persisted. The command name and arity retain useful audit structure.
                payload: {
                  command: safeCommandName,
                  argument_count: Math.max(0, call.command.length - 1),
                  sandbox: this.sandbox.name,
                },
                visibility: "audit",
              });
              const result = await this.sandbox.exec(handle, call.command);
              const safeResult = {
                code: result.code,
                stdout: redact(result.stdout),
                stderr: redact(result.stderr),
              };
              this.events.emit({
                type: safeResult.code === 0 ? "tool.completed" : "tool.failed",
                agent_id: agentId,
                execution_id: args.execution_id,
                correlation_id: args.correlation_id,
                summary: `${safeCommandName} exited ${safeResult.code}`,
                // Raw output goes to the next model turn after credential redaction, but is
                // never persisted. Counts make truncation/failures diagnosable without data.
                payload: {
                  code: safeResult.code,
                  stdout_bytes: Buffer.byteLength(safeResult.stdout, "utf8"),
                  stderr_bytes: Buffer.byteLength(safeResult.stderr, "utf8"),
                },
                visibility: "audit",
              });
              toolResults.push({
                // The adapter already retains its own requested arguments. Repeating them
                // here would unnecessarily send write_file content through another channel.
                command: [safeCommandName],
                ...safeResult,
              });
              readUntrusted = true;
            }
          }
        }

        if (response.actions.length > 0) {
          actions = response.actions.map((action) => redactValue(action, redact));
          break;
        }
        if (toolResults.length === 0) {
          // No actions and nothing to feed back: another turn would send the same prompt
          // and get the same answer.
          break;
        }
      }

      // A response that crosses a budget ceiling is not allowed to produce durable side
      // effects. Files from earlier tool turns are discarded with the execution sandbox.
      if (handle && !budgetExhausted) {
        artifacts.push(...(await this.sandbox.collectArtifacts(handle)));
      }
    } finally {
      if (handle) await this.sandbox.destroy(handle);
    }

    return {
      actions, usage, artifacts, read_untrusted: readUntrusted,
      budget_exhausted: budgetExhausted,
    };
  }
}
