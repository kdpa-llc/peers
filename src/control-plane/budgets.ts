/**
 * Budget and usage accounting (ADR 0008).
 *
 * Enforced before and after every model call: per-execution, per-agent-per-day,
 * organization-wide, delegation, and model-token scopes. Exhaustion moves the agent to
 * BLOCKED with an attention flag — it never fails silently.
 */
import type { Agent, DelegationBudget, Permission, Usage } from "../domain/types.ts";
import type { Store } from "./store.ts";

export type BudgetLimits = {
  /** Org-wide ceiling across all agents, in USD. */
  org_usd?: number;
  /** Fallback per-agent daily ceiling when the agent has no model.invoke grant scope. */
  default_agent_usd_per_day?: number;
  /** Ceiling for a single execution, in USD. */
  execution_usd?: number;
};

export type BudgetVerdict =
  | { ok: true }
  | {
      ok: false;
      scope:
        | "execution" | "agent_day" | "org"
        | "delegation_cost" | "delegation_tokens" | "model_tokens";
      limit: number;
      spent: number;
      unit: "usd" | "tokens";
    };

export type BudgetCheckOptions = {
  /** Effective grants for this execution (delegated workers run under narrowed grants). */
  grants?: Permission[];
  /** Per-task worker ceiling, when this is a delegated execution. */
  delegation?: DelegationBudget;
  /** Excluded from durable totals because `pending` already contains this execution. */
  current_execution_id?: string;
};

export const ZERO_USAGE: Usage = { input_tokens: 0, output_tokens: 0, cost_usd: 0 };

const round = (n: number): number => Math.round(n * 1e6) / 1e6;

export function addUsage(a: Usage | undefined, b: Usage | undefined): Usage {
  return {
    input_tokens: (a?.input_tokens ?? 0) + (b?.input_tokens ?? 0),
    output_tokens: (a?.output_tokens ?? 0) + (b?.output_tokens ?? 0),
    cost_usd: round((a?.cost_usd ?? 0) + (b?.cost_usd ?? 0)),
  };
}

export class Budgets {
  private readonly store: Store;
  private readonly limits: BudgetLimits;

  constructor(store: Store, limits: BudgetLimits = {}) {
    this.store = store;
    this.limits = limits;
  }

  /** Daily ceiling for an agent: its model.invoke grant scope, else the platform default. */
  agentDailyLimit(agent: Agent, grants: Permission[] = agent.permissions ?? []): number | undefined {
    const grant = grants.find((p) => p.kind === "model.invoke");
    return grant?.scope?.budget_usd_per_day ?? this.limits.default_agent_usd_per_day;
  }

  /**
   * `pending` is the execution's actual usage so far and `reservation` is the projected
   * usage of the next call. For the authoritative post-call check, pass ZERO_USAGE as the
   * reservation. The current execution is excluded from durable totals because callers
   * persist its live usage and also pass it as `pending`.
   */
  check(
    agent: Agent,
    pending: Usage,
    reservation: Usage,
    isoDate: string,
    options: BudgetCheckOptions = {},
  ): BudgetVerdict {
    const projected = addUsage(pending, reservation);
    const projectedCost = projected.cost_usd ?? 0;
    const projectedTokens = (projected.input_tokens ?? 0) + (projected.output_tokens ?? 0);

    if (this.limits.execution_usd !== undefined && projectedCost > this.limits.execution_usd) {
      return {
        ok: false, scope: "execution", limit: this.limits.execution_usd,
        spent: projectedCost, unit: "usd",
      };
    }

    const dayLimit = this.agentDailyLimit(agent, options.grants);
    if (dayLimit !== undefined) {
      const spentToday = round(
        this.store.costForAgentOnDate(agent.agent_id, isoDate, options.current_execution_id) +
          projectedCost,
      );
      if (spentToday > dayLimit) {
        return {
          ok: false, scope: "agent_day", limit: dayLimit, spent: spentToday, unit: "usd",
        };
      }
    }

    if (this.limits.org_usd !== undefined) {
      const orgSpent = round(this.store.totalCost(options.current_execution_id) + projectedCost);
      if (orgSpent > this.limits.org_usd) {
        return {
          ok: false, scope: "org", limit: this.limits.org_usd, spent: orgSpent, unit: "usd",
        };
      }
    }

    if (
      options.delegation?.max_cost_usd !== undefined &&
      projectedCost > options.delegation.max_cost_usd
    ) {
      return {
        ok: false, scope: "delegation_cost", limit: options.delegation.max_cost_usd,
        spent: projectedCost, unit: "usd",
      };
    }
    if (
      options.delegation?.max_tokens !== undefined &&
      projectedTokens > options.delegation.max_tokens
    ) {
      return {
        ok: false, scope: "delegation_tokens", limit: options.delegation.max_tokens,
        spent: projectedTokens, unit: "tokens",
      };
    }

    const modelTokenLimit = options.grants
      ?.find((p) => p.kind === "model.invoke")?.scope?.max_tokens_per_execution;
    if (modelTokenLimit !== undefined && projectedTokens > modelTokenLimit) {
      return {
        ok: false, scope: "model_tokens", limit: modelTokenLimit,
        spent: projectedTokens, unit: "tokens",
      };
    }
    return { ok: true };
  }
}
