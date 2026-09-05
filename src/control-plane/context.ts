/**
 * Context reconstruction (Constitution §5, MEMORY_AND_CONTEXT).
 *
 * Context is a *reconstructed working set*, never a replayed transcript. Each section gets
 * a share of a per-execution token target chosen from the model's window, so the budget
 * composes with model swaps.
 *
 * The builder reports `context_pressure` back to the agent when sections are truncated —
 * an explicit signal so the delegate-or-not decision stays with the agent (ADR 0002).
 */
import type { Agent, AgentEvent, InboxItem, MemoryRecord, Task } from "../domain/types.ts";
import type { Store } from "./store.ts";
import type { MemoryService } from "./memory.ts";

/** Section shares from MEMORY_AND_CONTEXT (tunable; the point is having a budget). */
export const DEFAULT_SHARES = {
  identity: 0.10,
  task: 0.15,
  memory: 0.25,
  org: 0.15,
  evidence: 0.30,
  spare: 0.05,
} as const;

export type ContextBudget = {
  /** Model context window in tokens. */
  window: number;
  /** Fraction of the window a single execution may occupy. */
  targetFraction: number;
  shares: typeof DEFAULT_SHARES;
};

export const DEFAULT_BUDGET: ContextBudget = {
  window: 200_000,
  targetFraction: 0.5,
  shares: DEFAULT_SHARES,
};

export type ContextSection = {
  name: keyof typeof DEFAULT_SHARES;
  text: string;
  token_budget: number;
  tokens_used: number;
  truncated: boolean;
};

export type BuiltContext = {
  agent: Agent;
  task?: Task;
  sections: ContextSection[];
  /** Ids of every record that fed this context — the audit trail (execution.context_manifest). */
  manifest: string[];
  context_pressure: boolean;
  total_tokens: number;
  prompt: string;
};

/** How many durable memories are surfaced per execution. */
const MEMORY_LIMIT = 12;

/** Deterministic, adapter-independent token estimate (~4 chars/token). */
export const estimateTokens = (s: string): number => Math.ceil(s.length / 4);

function fit(text: string, budget: number): { text: string; used: number; truncated: boolean } {
  const used = estimateTokens(text);
  if (used <= budget) return { text, used, truncated: false };
  const keep = Math.max(0, budget * 4 - 20);
  return { text: text.slice(0, keep) + "\n…[truncated]", used: budget, truncated: true };
}

function summarize(i: InboxItem): string {
  const p = i.payload as Record<string, unknown>;
  if (typeof p.objective === "string") return p.objective;
  if (typeof p.summary === "string") return p.summary;
  if (typeof p.body === "string") return p.body;
  return i.kind;
}

export class ContextBuilder {
  private readonly store: Store;
  private readonly memory: MemoryService;
  private readonly budget: ContextBudget;

  constructor(store: Store, memory: MemoryService, budget: ContextBudget = DEFAULT_BUDGET) {
    this.store = store;
    this.memory = memory;
    this.budget = budget;
  }

  build(args: {
    agent: Agent;
    task?: Task;
    trigger: string;
    recentEvents?: number;
    /** Context window of the model this agent will actually run on. */
    window?: number;
  }): BuiltContext {
    // The window is per-agent when the caller knows it: two agents on different models get
    // budgets sized to their own model rather than to one global number (ADR 0017).
    const window = args.window ?? this.budget.window;
    const target = Math.floor(window * this.budget.targetFraction);
    const manifest: string[] = [];
    const sections: ContextSection[] = [];

    const add = (name: keyof typeof DEFAULT_SHARES, text: string): void => {
      const tokenBudget = Math.floor(target * this.budget.shares[name]);
      const f = fit(text, tokenBudget);
      sections.push({
        name, text: f.text, token_budget: tokenBudget, tokens_used: f.used, truncated: f.truncated,
      });
    };

    // 1. Identity and policies.
    const a = args.agent;
    add("identity", [
      `You are ${a.name} (${a.agent_id}).`,
      `Responsibility: ${a.responsibility}`,
      `Mission: ${a.mission}`,
      a.success_criteria?.length ? `Success criteria:\n- ${a.success_criteria.join("\n- ")}` : "",
      a.permissions?.length ? `Permissions: ${a.permissions.map((p) => p.kind).join(", ")}` : "",
    ].filter(Boolean).join("\n"));

    // 2. Current task and state.
    if (args.task) {
      manifest.push(args.task.task_id);
      add("task", [
        `Current task ${args.task.task_id} (${args.task.status}), triggered by ${args.trigger}.`,
        `Objective: ${args.task.objective}`,
        args.task.expected_output ? `Expected output: ${args.task.expected_output}` : "",
        args.task.constraints?.length ? `Constraints:\n- ${args.task.constraints.join("\n- ")}` : "",
        args.task.delegation
          ? `You are an ephemeral worker. Output contract: ${args.task.delegation.output_contract}. ` +
            `Budget: ${args.task.delegation.budget.timeout_seconds}s.`
          : "",
      ].filter(Boolean).join("\n"));
    } else {
      add("task", `No active task. Triggered by ${args.trigger}.`);
    }

    // 3. Retrieved durable memory — knowledge, not history.
    const { records: memories, total: totalMemories } = this.memory
      .retrieve(a.agent_id, args.task?.objective, MEMORY_LIMIT);
    memories.forEach((m) => manifest.push(m.memory_id));
    const unseen = totalMemories - memories.length;
    add("memory", memories.length
      ? [
          "Durable memory:",
          // Origin is shown, not filtered: a fact learned from a file nobody controls is
          // still worth having, and an agent weighing it should know which kind it is.
          ...memories.map((m) => {
            const taint = m.provenance?.source === "untrusted_content" ? " (from untrusted content)" : "";
            return `- [${m.kind} r${m.revision}]${taint} ${m.content}`;
          }),
          // Without this line, memory the agent cannot see is indistinguishable from
          // memory that does not exist, and it will never consolidate.
          unseen > 0
            ? `(${unseen} more durable memories are not shown. If your memory has grown ` +
              "unwieldy, merging or archiving what is no longer true is yours to propose.)"
            : "",
        ].filter(Boolean).join("\n")
      : "Durable memory: (none yet)");

    // 4. Peer directory — the whole org fits at this scale.
    const peers = this.store.listAgents().filter((p) => p.agent_id !== a.agent_id);
    add("org", peers.length
      ? "Colleagues:\n" + peers.map((p) => `- ${p.name} (${p.agent_id}): ${p.responsibility}`).join("\n")
      : "Colleagues: (none)");

    // 5. Recent unresolved events + pending inbox — evidence, bounded.
    const recent: AgentEvent[] = this.store
      .events({ agentId: a.agent_id })
      .slice(-(args.recentEvents ?? 15));
    recent.forEach((e) => manifest.push(e.event_id));
    const pending: InboxItem[] = this.store.pendingInbox(a.agent_id);
    pending.forEach((i) => manifest.push(i.item_id));

    add("evidence", [
      recent.length
        ? "Recent activity:\n" + recent.map((e) => `- ${e.event_type}: ${e.summary ?? ""}`).join("\n")
        : "Recent activity: (none)",
      pending.length
        ? "Unread inbox:\n" + pending.map((i) => `- ${i.kind} from ${i.sender_id}: ${summarize(i)}`).join("\n")
        : "Unread inbox: (empty)",
    ].join("\n\n"));

    const pressure = sections.some((s) => s.truncated);
    if (pressure) {
      sections.push({
        name: "spare",
        text: "NOTE: context pressure — some sections were truncated. Consider delegating " +
              "context-heavy work to a fresh worker.",
        token_budget: Math.floor(target * this.budget.shares.spare),
        tokens_used: 30,
        truncated: false,
      });
    }

    const prompt = sections.map((s) => s.text).join("\n\n");
    return {
      agent: a,
      task: args.task,
      sections,
      manifest,
      context_pressure: pressure,
      total_tokens: sections.reduce((n, s) => n + s.tokens_used, 0),
      prompt,
    };
  }
}
