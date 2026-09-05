/**
 * Model adapter backed by a real Claude model (ADR 0014).
 *
 * This is the counterpart to `ScriptedModelAdapter`: same `ModelAdapter` interface, same
 * control plane, but the decisions come from a model instead of a script. Nothing about the
 * organization changes when you swap them — that is the claim ADR 0001 makes, and this file
 * is what makes it testable rather than asserted.
 *
 * Three properties are deliberate:
 *
 *  - **No transcript accumulation across executions** (Constitution §5). The conversation
 *    buffer is scoped to a single execution and reset whenever a new `execution_id` arrives.
 *    The control plane reconstructs the prompt every time; this adapter never carries
 *    history from one execution into the next.
 *  - **Actions come from tool calls, not prose.** Each `AgentAction` the agent is permitted
 *    to take is exposed as a tool with a strict schema, so the control plane receives typed
 *    intent rather than parsed text.
 *  - **Delegated authority is derived, not trusted.** The model names permission *kinds*; the
 *    adapter resolves them against the manager's own grants, so a worker's permissions are a
 *    subset by construction (CONTRACT_TESTS #5) even if the model asks for more.
 *
 * The SDK is the project's one runtime dependency. `import type` is erased and the runtime
 * import stays dynamic so adapters for other providers do not initialize it unnecessarily.
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { AgentAction, Permission, PermissionKind, Usage } from "../../domain/types.ts";
import type { ModelAdapter, ModelRequest, ModelResponse, ToolResult } from "./adapter.ts";
import {
  ACTION_TOOLS, RUN_COMMAND, SYSTEM_PROMPT, permitsRunCommand, permittedTools,
} from "./tools.ts";

/**
 * Anything exposing the one call this adapter makes. Tests inject a fake; production passes
 * the SDK's own `beta.messages`.
 *
 * The parameter is the SDK's own params type rather than a hand-written shape, so the
 * request body is structurally checked at compile time: a misspelled or unknown field fails
 * the build. That is worth having on a path with no credentials to test against, but it is
 * not a guarantee the request is *accepted* — per-model rules (which thinking configs a
 * given model allows, which betas apply) are enforced by the API at runtime, not by these
 * types. The first live call remains the real test.
 */
export interface BetaMessagesClient {
  stream(body: Anthropic.Beta.MessageCreateParams): {
    finalMessage(): Promise<Anthropic.Beta.BetaMessage>;
  };
}

export type ClaudeModelAdapterOptions = {
  /** Defaults to Claude Opus 5. */
  model?: string;
  maxTokens?: number;
  /** Thinking depth and overall token spend. */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  contextWindow?: number;
  /** Price per million tokens, for the cost the control plane charges against budgets. */
  pricing?: { input_per_mtok: number; output_per_mtok: number };
  /** Injected transport. Omit in production and the adapter builds an SDK client itself. */
  client?: BetaMessagesClient;
  apiKey?: string;
};

const DEFAULT_MODEL = "claude-opus-5";
/** Claude Opus 5 list price, USD per million tokens. */
const DEFAULT_PRICING = { input_per_mtok: 5, output_per_mtok: 25 };

export class ClaudeModelAdapter implements ModelAdapter {
  readonly name: string;
  readonly contextWindow: number;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly effort: NonNullable<ClaudeModelAdapterOptions["effort"]>;
  private readonly pricing: { input_per_mtok: number; output_per_mtok: number };
  private readonly apiKey?: string;
  private client?: BetaMessagesClient;
  /** Per-execution conversation, never spanning executions (Constitution §5). */
  private conversation: Anthropic.Beta.BetaMessageParam[] = [];
  private currentExecution?: string;
  /**
   * tool_use ids from the last assistant turn, in order. Every one of them needs a matching
   * tool_result on the next turn or the API rejects the request, so ids for blocks we did
   * not execute are tracked too and answered with a stub.
   */
  private pending: { id: string; ran: boolean }[] = [];

  constructor(opts: ClaudeModelAdapterOptions = {}) {
    this.model = opts.model ?? DEFAULT_MODEL;
    this.name = `claude:${this.model}`;
    this.contextWindow = opts.contextWindow ?? 1_000_000;
    this.maxTokens = opts.maxTokens ?? 16_000;
    this.effort = opts.effort ?? "high";
    this.pricing = opts.pricing ?? DEFAULT_PRICING;
    this.client = opts.client;
    this.apiKey = opts.apiKey;
  }

  /**
   * Built lazily so constructing the adapter never requires the SDK to be installed —
   * only actually talking to a model does.
   */
  private async messages(): Promise<BetaMessagesClient> {
    if (this.client) return this.client;
    let Ctor: typeof Anthropic;
    try {
      ({ default: Ctor } = await import("@anthropic-ai/sdk"));
    } catch {
      throw new Error(
        "The Anthropic SDK is missing — run `npm install`. To run without a model, " +
          "pass --scripted.",
      );
    }
    const sdk = new Ctor(this.apiKey ? { apiKey: this.apiKey } : {});
    this.client = sdk.beta.messages as unknown as BetaMessagesClient;
    return this.client;
  }

  async complete(req: ModelRequest): Promise<ModelResponse> {
    // A new execution starts a new conversation. This is the line that keeps the adapter
    // honest about context reconstruction.
    if (req.execution_id !== this.currentExecution) {
      this.currentExecution = req.execution_id;
      this.conversation = [];
      this.pending = [];
    }

    this.conversation.push(
      this.conversation.length === 0
        ? { role: "user", content: req.prompt }
        : { role: "user", content: toolResultBlocks(this.pending, req.tool_results ?? []) },
    );

    const tools = this.toolsFor(req);
    const client = await this.messages();
    const message = await client
      .stream({
        model: this.model,
        max_tokens: Math.min(this.maxTokens, req.max_output_tokens ?? this.maxTokens),
        // Adaptive thinking: the agent is deciding what to do next, which is exactly the
        // kind of judgment that benefits from it.
        thinking: { type: "adaptive" },
        output_config: { effort: this.effort },
        // A policy decline mid-organization would otherwise strand the execution with no
        // actions; the server retries on a fallback model inside the same call.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        system: SYSTEM_PROMPT,
        tools,
        // A snapshot: the conversation keeps growing after this call returns, and the
        // request body must not change under the transport.
        messages: [...this.conversation],
      })
      .finalMessage();

    // Echo the assistant turn back verbatim: tool_use blocks must be present for the
    // matching tool_result blocks on the next turn to be valid, and thinking blocks must
    // be replayed unchanged on the same model.
    this.conversation.push({ role: "assistant", content: message.content });

    const usage = this.usageOf(message);

    if (message.stop_reason === "refusal") {
      return {
        actions: [{
          type: "note",
          text: `model declined to act${
            message.stop_details && "category" in message.stop_details
              ? ` (${message.stop_details.category})`
              : ""
          }`,
        }],
        usage,
      };
    }

    const actions: AgentAction[] = [];
    const toolCalls: { command: string[] }[] = [];
    this.pending = [];

    for (const block of message.content) {
      if (block.type !== "tool_use") continue;
      // Tool inputs are JSON from the model: read fields, never string-match the raw input.
      const input = (block.input ?? {}) as Record<string, any>;
      if (block.name === RUN_COMMAND) {
        const command = Array.isArray(input.command) ? input.command.map(String) : [];
        this.pending.push({ id: block.id, ran: command.length > 0 });
        if (command.length > 0) toolCalls.push({ command });
        continue;
      }
      this.pending.push({ id: block.id, ran: false });
      const spec = ACTION_TOOLS.find((t) => t.name === block.name);
      const action = spec?.build(input, req);
      if (action) actions.push(action);
    }

    return { actions, usage, tool_calls: toolCalls.length > 0 ? toolCalls : undefined };
  }

  /** Only tools the agent is actually permitted to use (see ActionTool.requires). */
  private toolsFor(req: ModelRequest): Anthropic.Beta.BetaToolUnion[] {
    const tools: Anthropic.Beta.BetaToolUnion[] = permittedTools(req.grants)
      .map((t) => ({
        name: t.name,
        description: t.description,
        strict: t.strict ?? true,
        input_schema: {
          type: "object" as const,
          properties: t.properties,
          required: t.required,
          additionalProperties: false,
        },
      }));

    if (permitsRunCommand(req.grants)) {
      tools.push({
          name: RUN_COMMAND,
          description:
            "Run a constrained file utility inside your sandbox and see its output. Supported " +
            "commands are ls, cat, grep, wc, head, tail, echo, and write_file. Read paths must " +
            "be within fs.read scopes; write_file is limited to an fs.write-scoped outputs/ path.",
        strict: true,
        input_schema: {
          type: "object" as const,
          properties: {
            command: {
              type: "array",
              items: { type: "string" },
              description: "argv, e.g. [\"grep\", \"-n\", \"TIMEOUT\", \"workspace/app.js\"]",
            },
          },
          required: ["command"],
          additionalProperties: false,
        },
      });
    }
    return tools;
  }

  private usageOf(message: Anthropic.Beta.BetaMessage): Usage {
    const input = message.usage?.input_tokens ?? 0;
    const output = message.usage?.output_tokens ?? 0;
    return {
      input_tokens: input,
      output_tokens: output,
      cost_usd:
        (input * this.pricing.input_per_mtok + output * this.pricing.output_per_mtok) / 1_000_000,
    };
  }
}



/**
 * Tool output for the next turn. The Messages API requires exactly one tool_result per
 * tool_use id from the previous assistant turn, so blocks we never executed get a stub
 * rather than being dropped.
 */
function toolResultBlocks(
  pending: { id: string; ran: boolean }[],
  results: ToolResult[],
): Anthropic.Beta.BetaContentBlockParam[] {
  let next = 0;
  return pending.map(({ id, ran }) => {
    const result = ran ? results[next++] : undefined;
    if (!result) {
      return {
        type: "tool_result" as const,
        tool_use_id: id,
        is_error: true,
        content: "not executed",
      };
    }
    return {
      type: "tool_result" as const,
      tool_use_id: id,
      is_error: result.code !== 0,
      content: [
        `exit ${result.code}`,
        result.stdout.trim() ? result.stdout.trim() : "(no stdout)",
        result.stderr.trim() ? `stderr: ${result.stderr.trim()}` : "",
      ].filter(Boolean).join("\n"),
    };
  });
}
