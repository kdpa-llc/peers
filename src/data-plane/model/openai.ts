/**
 * Model adapter for any endpoint speaking the OpenAI Chat Completions API (ADR 0016).
 *
 * One adapter covers OpenAI and OpenRouter because they are the same wire protocol behind
 * different base URLs. Adding a third such provider is a preset, not a file.
 *
 * It offers the same tool surface as `ClaudeModelAdapter`, taken from the same table in
 * `tools.ts`, and upholds the same three properties that make an adapter swappable:
 *
 *  - **No transcript accumulation across executions** (Constitution §5). The message buffer
 *    is scoped to one execution and reset when a new `execution_id` arrives.
 *  - **Actions come from tool calls, not prose.** The control plane receives typed intent.
 *  - **Delegated authority is derived, not trusted.** Requested permission kinds are resolved
 *    against the manager's real grants (CONTRACT_TESTS #5).
 *
 * Transport is `fetch`, not a vendor SDK. The request is a JSON body and the response is
 * JSON; an SDK here would add a dependency to do work Node already does, and would still
 * need a compatibility shim for OpenRouter. `transport` is injectable so the translation
 * layer is testable with no network and no key.
 */
import type { AgentAction, Usage } from "../../domain/types.ts";
import type { ModelAdapter, ModelRequest, ModelResponse, ToolResult } from "./adapter.ts";
import {
  ACTION_TOOLS, RUN_COMMAND, SYSTEM_PROMPT, permitsRunCommand, permittedTools,
} from "./tools.ts";

/** The subset of Chat Completions this adapter sends and reads. */
export type ChatRequest = {
  model: string;
  messages: ChatMessage[];
  tools?: { type: "function"; function: Record<string, unknown> }[];
  tool_choice?: "auto";
  max_tokens?: number;
  /** Only meaningful to reasoning models; other models ignore it. */
  reasoning_effort?: "low" | "medium" | "high";
};

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ChatToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export type ChatToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type ChatResponse = {
  choices: {
    finish_reason?: string;
    message: { content?: string | null; refusal?: string | null; tool_calls?: ChatToolCall[] };
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

/** Injectable seam: takes a fully-formed request body, returns the parsed response. */
export type ChatTransport = (body: ChatRequest) => Promise<ChatResponse>;

export type Provider = "openai" | "openrouter";

type Preset = { baseURL: string; keyEnv: string; model: string };

/**
 * Endpoint presets. `model` is only a starting default — pass `model` to use anything the
 * provider offers, which for OpenRouter includes models from vendors it proxies.
 */
export const PRESETS: Record<Provider, Preset> = {
  openai: {
    baseURL: "https://api.openai.com/v1",
    keyEnv: "OPENAI_API_KEY",
    model: "gpt-5",
  },
  openrouter: {
    baseURL: "https://openrouter.ai/api/v1",
    keyEnv: "OPENROUTER_API_KEY",
    model: "openai/gpt-5",
  },
};

export type OpenAIAdapterOptions = {
  /** Which endpoint preset to start from. Default: `openai`. */
  provider?: Provider;
  model?: string;
  /** Overrides the preset's base URL — any OpenAI-compatible endpoint, including a local one. */
  baseURL?: string;
  apiKey?: string;
  contextWindow?: number;
  maxTokens?: number;
  /** USD per million tokens. Unknown by default, so cost is reported as 0 rather than guessed. */
  pricing?: { input_per_mtok: number; output_per_mtok: number };
  /** Reasoning depth for models that support it; sent as `reasoning_effort`. */
  reasoningEffort?: "low" | "medium" | "high";
  /** Extra headers, e.g. OpenRouter's HTTP-Referer and X-Title attribution pair. */
  headers?: Record<string, string>;
  /** Injected in tests; when absent, a fetch-backed transport is built lazily. */
  transport?: ChatTransport;
};

export class OpenAIModelAdapter implements ModelAdapter {
  readonly name: string;
  readonly contextWindow: number;
  private readonly provider: Provider;
  private readonly model: string;
  private readonly baseURL: string;
  private readonly apiKey?: string;
  private readonly maxTokens: number;
  private readonly pricing?: { input_per_mtok: number; output_per_mtok: number };
  private readonly reasoningEffort?: "low" | "medium" | "high";
  private readonly headers: Record<string, string>;
  private transport?: ChatTransport;

  /** Per-execution message buffer, never spanning executions (Constitution §5). */
  private conversation: ChatMessage[] = [];
  private currentExecution?: string;
  /**
   * tool_call ids from the last assistant turn, in order. Chat Completions requires one
   * `tool` message per id before the next assistant turn, so ids we did not execute are
   * tracked too and answered with a stub rather than dropped.
   */
  private pending: { id: string; ran: boolean }[] = [];

  constructor(opts: OpenAIAdapterOptions = {}) {
    this.provider = opts.provider ?? "openai";
    const preset = PRESETS[this.provider];
    this.model = opts.model ?? preset.model;
    this.baseURL = (opts.baseURL ?? preset.baseURL).replace(/\/+$/, "");
    this.apiKey = opts.apiKey ?? process.env[preset.keyEnv];
    this.name = `${this.provider}:${this.model}`;
    this.contextWindow = opts.contextWindow ?? 128_000;
    this.maxTokens = opts.maxTokens ?? 16_000;
    this.pricing = opts.pricing;
    this.reasoningEffort = opts.reasoningEffort;
    this.headers = opts.headers ?? {};
    this.transport = opts.transport;
  }

  async complete(req: ModelRequest): Promise<ModelResponse> {
    // A new execution starts a new conversation. This is the line that keeps the adapter
    // honest about context reconstruction.
    if (req.execution_id !== this.currentExecution) {
      this.currentExecution = req.execution_id;
      this.conversation = [{ role: "system", content: SYSTEM_PROMPT }];
      this.pending = [];
    }

    if (this.pending.length === 0) {
      this.conversation.push({ role: "user", content: req.prompt });
    } else {
      for (const m of toolMessages(this.pending, req.tool_results ?? [])) {
        this.conversation.push(m);
      }
    }

    const tools = this.toolsFor(req);
    const send = this.transport ?? (this.transport = this.fetchTransport());
    const response = await send({
      model: this.model,
      // A snapshot: the conversation keeps growing after this call returns, and the request
      // body must not change under the transport.
      messages: [...this.conversation],
      max_tokens: Math.min(this.maxTokens, req.max_output_tokens ?? this.maxTokens),
      ...(this.reasoningEffort ? { reasoning_effort: this.reasoningEffort } : {}),
      ...(tools.length > 0 ? { tools, tool_choice: "auto" as const } : {}),
    });

    const choice = response.choices?.[0];
    const message = choice?.message;
    const usage = this.usageOf(response);
    const calls = message?.tool_calls ?? [];

    // Echo the assistant turn back verbatim: the tool_calls must be present for the matching
    // `tool` messages on the next turn to be valid.
    this.conversation.push({
      role: "assistant",
      content: message?.content ?? null,
      ...(calls.length > 0 ? { tool_calls: calls } : {}),
    });

    // A refusal would otherwise strand the execution with no actions at all.
    if (message?.refusal) {
      return { actions: [{ type: "note", text: `model declined to act: ${message.refusal}` }], usage };
    }

    const actions: AgentAction[] = [];
    const toolCalls: { command: string[] }[] = [];
    this.pending = [];

    for (const call of calls) {
      // Arguments arrive as a JSON string. Malformed JSON is the model's mistake, not a
      // crash: treat it as an empty object and let the tool's own required fields decide.
      const input = parseArguments(call.function?.arguments);
      if (call.function?.name === RUN_COMMAND) {
        const command = Array.isArray(input.command) ? input.command.map(String) : [];
        this.pending.push({ id: call.id, ran: command.length > 0 });
        if (command.length > 0) toolCalls.push({ command });
        continue;
      }
      this.pending.push({ id: call.id, ran: false });
      const spec = ACTION_TOOLS.find((t) => t.name === call.function?.name);
      const action = spec?.build(input, req);
      if (action) actions.push(action);
    }

    return { actions, usage, tool_calls: toolCalls.length > 0 ? toolCalls : undefined };
  }

  /** Only tools the agent is actually permitted to use (CONTRACT_TESTS #23). */
  private toolsFor(req: ModelRequest): NonNullable<ChatRequest["tools"]> {
    const tools: NonNullable<ChatRequest["tools"]> = permittedTools(req.grants).map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        // `strict` requires every property to be required, which the free-form tools cannot
        // satisfy, so it tracks the same flag the Anthropic side uses.
        strict: t.strict ?? true,
        parameters: {
          type: "object",
          properties: t.properties,
          required: t.required,
          additionalProperties: false,
        },
      },
    }));

    if (permitsRunCommand(req.grants)) {
      tools.push({
        type: "function" as const,
        function: {
          name: RUN_COMMAND,
          description:
            "Run a constrained file utility inside your sandbox and see its output. Supported " +
            "commands are ls, cat, grep, wc, head, tail, echo, and write_file. Read paths must " +
            "be within fs.read scopes; write_file is limited to an fs.write-scoped outputs/ path.",
          strict: true,
          parameters: {
            type: "object",
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
        },
      });
    }
    return tools;
  }

  private usageOf(response: ChatResponse): Usage {
    const input = response.usage?.prompt_tokens ?? 0;
    const output = response.usage?.completion_tokens ?? 0;
    return {
      input_tokens: input,
      output_tokens: output,
      // Without a price for the chosen model, reporting 0 is honest; inventing a number
      // would corrupt the budget ledger. Token gates still apply, but USD gates require
      // operator-supplied pricing for this adapter (ADR 0008/0016).
      cost_usd: this.pricing
        ? (input * this.pricing.input_per_mtok + output * this.pricing.output_per_mtok) / 1_000_000
        : 0,
    };
  }

  /** Built lazily so constructing the adapter never requires a key — only calling does. */
  private fetchTransport(): ChatTransport {
    const url = `${this.baseURL}/chat/completions`;
    const key = this.apiKey;
    const extra = this.headers;
    const provider = this.provider;
    return async (body) => {
      if (!key) {
        throw new Error(
          `No API key for ${provider} — set ${PRESETS[provider].keyEnv}. ` +
            "To run without a model, pass --scripted.",
        );
      }
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${key}`,
          ...extra,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        // The body carries the provider's own explanation; losing it makes a failed run
        // undiagnosable, which is the bug this project already fixed once.
        throw new Error(`${provider} returned ${res.status}: ${(await res.text()).slice(0, 500)}`);
      }
      return (await res.json()) as ChatResponse;
    };
  }
}

function parseArguments(raw: string | undefined): Record<string, any> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Tool output for the next turn. Chat Completions requires exactly one `tool` message per
 * tool_call id from the previous assistant turn, so ids we never executed get a stub rather
 * than being dropped — an unanswered id makes the whole next request invalid.
 */
function toolMessages(
  pending: { id: string; ran: boolean }[],
  results: ToolResult[],
): ChatMessage[] {
  let next = 0;
  return pending.map(({ id, ran }) => {
    const result = ran ? results[next++] : undefined;
    if (!result) return { role: "tool" as const, tool_call_id: id, content: "not executed" };
    return {
      role: "tool" as const,
      tool_call_id: id,
      content: [
        `$ ${result.command.join(" ")}`,
        `exit ${result.code}`,
        result.stdout ? `stdout:\n${result.stdout}` : "",
        result.stderr ? `stderr:\n${result.stderr}` : "",
      ].filter(Boolean).join("\n"),
    };
  });
}
