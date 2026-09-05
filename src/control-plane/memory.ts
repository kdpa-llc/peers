/**
 * Memory services (ADR 0003). The platform provides storage, retrieval, revision, and
 * provenance; the agent owns the semantics. Every change arrives as an explicit proposal
 * and produces an immutable revision.
 *
 * Auto-apply policy: create/revise/archive of the agent's own
 * memory applies directly; delete, shared memory, and memory referenced by another agent
 * require an approval.
 */
import type { MemoryProposal, MemoryRecord, MemoryRevision } from "../domain/types.ts";
import type { Store } from "./store.ts";
import type { Clock, Ids } from "./runtime-env.ts";
import { iso } from "./runtime-env.ts";
import type { EventLog } from "./events.ts";

export type ApplyOutcome =
  | { applied: true; memory: MemoryRecord; revision: MemoryRevision }
  | { applied: false; reason: string; requiresApproval: boolean };

const AUTO_APPLY = new Set(["create", "revise", "archive", "merge", "supersede"]);

export class MemoryService {
  private readonly store: Store;
  private readonly events: EventLog;
  private readonly clock: Clock;
  private readonly ids: Ids;

  constructor(store: Store, events: EventLog, clock: Clock, ids: Ids) {
    this.store = store;
    this.events = events;
    this.clock = clock;
    this.ids = ids;
  }

  /**
   * Retrieval for the context builder. Naive relevance: term overlap, newest first.
   *
   * `total` is the whole active set, not what was returned. An agent whose memory has
   * outgrown its retrieval window needs to know that — otherwise the records it cannot see
   * are indistinguishable from records that do not exist, and it will never propose the
   * merge or archive that would fix it. Reporting the number is mechanics; deciding what to
   * consolidate is the agent's judgment (Constitution: the control plane provides the
   * mechanics, not the intelligence).
   */
  retrieve(
    agentId: string,
    query: string | undefined,
    limit: number,
  ): { records: MemoryRecord[]; total: number } {
    const all = this.store.activeMemories(agentId);
    if (!query) return { records: all.slice(-limit), total: all.length };
    const terms = query.toLowerCase().split(/\W+/).filter((t) => t.length > 3);
    const scored = all.map((m) => {
      const text = m.content.toLowerCase();
      return { m, score: terms.reduce((n, t) => n + (text.includes(t) ? 1 : 0), 0) };
    });
    scored.sort((a, b) => b.score - a.score || b.m.revision - a.m.revision);
    return { records: scored.slice(0, limit).map((s) => s.m), total: all.length };
  }

  propose(proposal: MemoryProposal, executionId?: string): MemoryProposal {
    const withId: MemoryProposal = {
      ...proposal,
      proposal_id: proposal.proposal_id ?? this.ids.next("prop"),
      source_execution: proposal.source_execution ?? executionId,
    };
    this.events.emit({
      type: "memory.proposed",
      agent_id: proposal.agent_id,
      execution_id: executionId,
      summary: `${proposal.operation}: ${(proposal.content ?? "").slice(0, 60)}`,
      payload: { proposal_id: withId.proposal_id, operation: proposal.operation },
      visibility: "organization",
    });
    return withId;
  }

  /** Apply a proposal if policy permits, writing the record and its immutable revision. */
  apply(proposal: MemoryProposal, opts: { approvalId?: string } = {}): ApplyOutcome {
    if (!proposal.rationale) {
      return { applied: false, reason: "proposal requires a rationale", requiresApproval: false };
    }
    if (!AUTO_APPLY.has(proposal.operation) && !opts.approvalId) {
      return {
        applied: false,
        reason: `operation '${proposal.operation}' requires review`,
        requiresApproval: true,
      };
    }

    for (const target of proposal.target_memory_ids ?? []) {
      const existing = this.store.getMemory(target);
      if (!existing) {
        return { applied: false, reason: `target memory ${target} does not exist`, requiresApproval: false };
      }
      if (existing.agent_id !== proposal.agent_id && !opts.approvalId) {
        return {
          applied: false,
          reason: `memory ${target} is owned by ${existing.agent_id}; cross-agent changes require review`,
          requiresApproval: true,
        };
      }
    }

    const now = iso(this.clock.now());
    let record: MemoryRecord;
    let previousRevision: number | undefined;

    if (proposal.operation === "create") {
      record = {
        memory_id: this.ids.next("mem"),
        agent_id: proposal.agent_id,
        kind: proposal.kind ?? "knowledge",
        content: proposal.content ?? "",
        revision: 1,
        confidence: proposal.confidence,
        source_refs: proposal.evidence_refs,
        provenance: proposal.provenance,
        status: "active",
        created_at: now,
        updated_at: now,
      };
    } else {
      const targetId = (proposal.target_memory_ids ?? [])[0];
      const existing = targetId ? this.store.getMemory(targetId) : undefined;
      if (!existing) {
        return { applied: false, reason: "operation requires an existing target memory", requiresApproval: false };
      }
      previousRevision = existing.revision;

      if (proposal.operation === "archive") {
        record = { ...existing, status: "archived", revision: existing.revision + 1, updated_at: now };
      } else if (proposal.operation === "revise") {
        record = {
          ...existing,
          content: proposal.content ?? existing.content,
          confidence: proposal.confidence ?? existing.confidence,
          // A revision built from untrusted input taints the record it revises.
          provenance: proposal.provenance ?? existing.provenance,
          revision: existing.revision + 1,
          updated_at: now,
        };
      } else {
        // merge / supersede: a new record superseding the targets.
        for (const t of proposal.target_memory_ids ?? []) {
          const old = this.store.getMemory(t);
          if (old) this.store.putMemory({ ...old, status: "superseded", updated_at: now });
        }
        record = {
          memory_id: this.ids.next("mem"),
          agent_id: proposal.agent_id,
          kind: proposal.kind ?? existing.kind,
          content: proposal.content ?? existing.content,
          revision: 1,
          confidence: proposal.confidence,
          supersedes: proposal.target_memory_ids,
          provenance: proposal.provenance,
          status: "active",
          created_at: now,
          updated_at: now,
        };
      }
    }

    this.store.putMemory(record);
    const revision: MemoryRevision = {
      revision_id: this.ids.next("rev"),
      memory_id: record.memory_id,
      revision: record.revision,
      operation: proposal.operation,
      proposal_id: proposal.proposal_id,
      rationale: proposal.rationale,
      confidence: proposal.confidence,
      source_execution: proposal.source_execution,
      evidence_refs: proposal.evidence_refs,
      provenance: proposal.provenance,
      previous_revision: previousRevision,
      actor_agent_id: proposal.agent_id,
      approval_id: opts.approvalId,
      created_at: now,
    };
    this.store.putMemoryRevision(revision);

    this.events.emit({
      type: proposal.operation === "archive" ? "memory.archived" : "memory.revised",
      agent_id: proposal.agent_id,
      execution_id: proposal.source_execution,
      summary: `${proposal.operation} ${record.memory_id} r${record.revision}: ${proposal.rationale}`,
      payload: { memory_id: record.memory_id, revision: record.revision, operation: proposal.operation },
      visibility: "organization",
    });

    return { applied: true, memory: record, revision };
  }
}
