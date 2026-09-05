/**
 * Provider selection and per-agent model resolution (ADR 0016, ADR 0017).
 *
 * Two things live here. `buildAdapter` turns a provider name into an adapter — the console's
 * job. `ModelResolver` turns an *agent's own* `model_config` into one, falling back to the
 * organization's default when the agent declares nothing.
 *
 * The resolver reads a declared field on the agent record, exactly as permission checks read
 * `agent.permissions`. It never maps an agent id to a model: that would put organizational
 * knowledge in the platform, which Constitution §2 forbids. An agent's model is data the
 * operator wrote down, not behaviour the control plane knows.
 */
import type { ModelConfig } from "../../domain/types.ts";
import type { ModelAdapter } from "./adapter.ts";
import { ClaudeModelAdapter } from "./claude.ts";
import { OpenAIModelAdapter, PRESETS } from "./openai.ts";
import { ScriptedModelAdapter } from "./scripted.ts";
import { buildScript } from "../../scripted/scenario.ts";

export const PROVIDERS = ["claude", "openai", "openrouter", "scripted"] as const;
export type ProviderName = (typeof PROVIDERS)[number];

export const THINKING_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export function isProvider(name: string): name is ProviderName {
  return (PROVIDERS as readonly string[]).includes(name);
}

export function isThinkingLevel(name: string): name is ThinkingLevel {
  return (THINKING_LEVELS as readonly string[]).includes(name);
}

/** The environment variable each provider reads its credential from. */
export function keyEnvFor(provider: ProviderName): string | undefined {
  if (provider === "claude") return "ANTHROPIC_API_KEY";
  if (provider === "scripted") return undefined;
  return PRESETS[provider].keyEnv;
}

/** True when the provider needs a credential and none is visible in the environment. */
export function missingCredential(provider: ProviderName): boolean {
  if (provider === "scripted") return false;
  if (provider === "claude") {
    return !process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN;
  }
  return !process.env[PRESETS[provider].keyEnv];
}

/**
 * Chat Completions exposes reasoning effort as three levels, not five. Collapsing the two
 * deepest onto `high` is lossy in one direction only: an agent asking for more thinking than
 * the provider can express gets the most it offers, rather than an API error.
 */
function reasoningEffort(thinking?: ThinkingLevel): "low" | "medium" | "high" | undefined {
  if (!thinking) return undefined;
  return thinking === "low" ? "low" : thinking === "medium" ? "medium" : "high";
}

export function buildAdapter(provider: ProviderName, model?: string, thinking?: ThinkingLevel): ModelAdapter {
  switch (provider) {
    case "scripted":
      return new ScriptedModelAdapter(buildScript());
    case "claude":
      return new ClaudeModelAdapter({
        ...(model ? { model } : {}),
        ...(thinking ? { effort: thinking } : {}),
      });
    case "openai":
    case "openrouter":
      return new OpenAIModelAdapter({
        provider,
        ...(model ? { model } : {}),
        ...(reasoningEffort(thinking) ? { reasoningEffort: reasoningEffort(thinking) } : {}),
      });
  }
}

/** The organization-wide default, from `--provider`/`--model`/`--thinking` or the environment. */
export type ModelDefaults = {
  provider: ProviderName;
  model?: string;
  thinking?: ThinkingLevel;
};

/**
 * Resolves an agent's declared model to an adapter.
 *
 * A **new adapter per execution** is deliberate. Adapters hold a conversation buffer scoped to
 * one execution (Constitution §5); handing the same instance to two executions would make that
 * guarantee depend on them never interleaving. Constructing one is cheap — the provider client
 * is built lazily on first call — so the invariant is structural instead of circumstantial.
 */
export class ModelResolver {
  private readonly defaults: ModelDefaults;

  constructor(defaults: ModelDefaults) {
    this.defaults = defaults;
  }

  /** The effective configuration for an agent, after defaults are applied. */
  resolve(config?: ModelConfig): Required<Pick<ModelDefaults, "provider">> & ModelDefaults {
    const provider = config?.provider ?? this.defaults.provider;
    return {
      provider,
      // A model id belongs to a provider, so it only carries over from the defaults when the
      // agent did not override the provider too. Pairing claude's default model with openai
      // would produce a model id that provider has never heard of.
      model: config?.model ?? (config?.provider && config.provider !== this.defaults.provider
        ? undefined
        : this.defaults.model),
      thinking: config?.thinking ?? this.defaults.thinking,
    };
  }

  for(config?: ModelConfig): ModelAdapter {
    const { provider, model, thinking } = this.resolve(config);
    return buildAdapter(provider, model, thinking);
  }

  /** Context window for an agent's model, so the context budget is sized per agent. */
  windowFor(config?: ModelConfig): number {
    return this.for(config).contextWindow;
  }
}
