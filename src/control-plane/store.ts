/**
 * SQLite persistence for the control plane.
 *
 * Durable entities mirror ARCHITECTURE.md. Complex nested values (permissions, delegation,
 * payloads) are stored as JSON text; every field the scheduler or observer filters on gets
 * its own column so queries never decode a domain payload.
 */
import { DatabaseSync } from "node:sqlite";
import type {
  Agent, AgentEvent, Approval, Artifact, Execution, InboxItem, MemoryRecord,
  MemoryRevision, Task, WaitCondition,
} from "../domain/types.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (
  agent_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  responsibility TEXT NOT NULL,
  mission TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL,
  runtime_state TEXT NOT NULL DEFAULT 'IDLE',
  created_at TEXT NOT NULL,
  revision INTEGER NOT NULL,
  ephemeral INTEGER NOT NULL DEFAULT 0,
  doc TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  task_id TEXT PRIMARY KEY,
  parent_task_id TEXT,
  sender_id TEXT NOT NULL,
  recipient_id TEXT NOT NULL,
  status TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  deadline TEXT,
  correlation_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT,
  has_delegation INTEGER NOT NULL DEFAULT 0,
  doc TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS inbox_items (
  item_id TEXT PRIMARY KEY,
  sender_id TEXT NOT NULL,
  recipient_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  deadline TEXT,
  correlation_id TEXT,
  causation_id TEXT,
  created_at TEXT NOT NULL,
  processed_at TEXT,
  doc TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS executions (
  execution_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  trigger_type TEXT NOT NULL,
  trigger_ref TEXT,
  status TEXT NOT NULL,
  retry_of TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  doc TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT UNIQUE NOT NULL,
  event_type TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  execution_id TEXT,
  task_id TEXT,
  correlation_id TEXT,
  causation_id TEXT,
  visibility TEXT NOT NULL DEFAULT 'internal',
  doc TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS waits (
  wait_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  task_id TEXT,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  timeout_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  doc TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memories (
  memory_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT,
  doc TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_revisions (
  revision_id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  actor_agent_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  doc TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  uri TEXT NOT NULL,
  created_by_agent_id TEXT,
  created_in_execution TEXT,
  created_at TEXT NOT NULL,
  doc TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS approvals (
  approval_id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  requested_by_agent_id TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  doc TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_inbox_recipient ON inbox_items(recipient_id, processed_at);
CREATE INDEX IF NOT EXISTS idx_events_seq ON events(seq);
CREATE INDEX IF NOT EXISTS idx_exec_agent ON executions(agent_id, status);
CREATE INDEX IF NOT EXISTS idx_waits_status ON waits(status);
CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task_id);
`;

type Row = Record<string, string | number | null>;

export class Store {
  readonly db: DatabaseSync;

  constructor(path = ":memory:") {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
  }

  close(): void { this.db.close(); }

  /** Run `fn` inside a transaction; roll back on throw. Used for outbox writes (ADR 0007). */
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  // ----- agents -----

  putAgent(a: Agent, ephemeral = false): void {
    this.db.prepare(
      `INSERT INTO agents (agent_id,name,responsibility,mission,lifecycle_state,runtime_state,
         created_at,revision,ephemeral,doc)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(agent_id) DO UPDATE SET
         name=excluded.name, responsibility=excluded.responsibility, mission=excluded.mission,
         lifecycle_state=excluded.lifecycle_state, revision=excluded.revision, doc=excluded.doc`,
    ).run(a.agent_id, a.name, a.responsibility, a.mission, a.lifecycle_state,
      a.runtime_state ?? "IDLE", a.created_at, a.revision, ephemeral ? 1 : 0, JSON.stringify(a));
  }

  getAgent(id: string): Agent | undefined {
    const r = this.db.prepare("SELECT doc, runtime_state FROM agents WHERE agent_id = ?").get(id) as Row | undefined;
    if (!r) return undefined;
    return { ...JSON.parse(String(r.doc)), runtime_state: r.runtime_state } as Agent;
  }

  listAgents(opts: { includeEphemeral?: boolean } = {}): Agent[] {
    const sql = opts.includeEphemeral
      ? "SELECT doc, runtime_state FROM agents ORDER BY created_at"
      : "SELECT doc, runtime_state FROM agents WHERE ephemeral = 0 ORDER BY created_at";
    return (this.db.prepare(sql).all() as Row[])
      .map((r) => ({ ...JSON.parse(String(r.doc)), runtime_state: r.runtime_state }) as Agent);
  }

  setRuntimeState(agentId: string, state: string): void {
    this.db.prepare("UPDATE agents SET runtime_state = ? WHERE agent_id = ?").run(state, agentId);
  }

  isEphemeral(agentId: string): boolean {
    const r = this.db.prepare("SELECT ephemeral FROM agents WHERE agent_id = ?").get(agentId) as Row | undefined;
    return !!r && Number(r.ephemeral) === 1;
  }

  // ----- tasks -----

  putTask(t: Task): void {
    this.db.prepare(
      `INSERT INTO tasks (task_id,parent_task_id,sender_id,recipient_id,status,priority,deadline,
         correlation_id,created_at,updated_at,has_delegation,doc)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(task_id) DO UPDATE SET
         status=excluded.status, updated_at=excluded.updated_at, doc=excluded.doc`,
    ).run(t.task_id, t.parent_task_id ?? null, t.sender_id, t.recipient_id, t.status,
      t.priority ?? 0, t.deadline ?? null, t.correlation_id ?? null, t.created_at,
      t.updated_at ?? null, t.delegation ? 1 : 0, JSON.stringify(t));
  }

  getTask(id: string): Task | undefined {
    const r = this.db.prepare("SELECT doc FROM tasks WHERE task_id = ?").get(id) as Row | undefined;
    return r ? (JSON.parse(String(r.doc)) as Task) : undefined;
  }

  listTasks(): Task[] {
    return (this.db.prepare("SELECT doc FROM tasks ORDER BY created_at").all() as Row[])
      .map((r) => JSON.parse(String(r.doc)) as Task);
  }

  childTasks(parentId: string): Task[] {
    return (this.db.prepare("SELECT doc FROM tasks WHERE parent_task_id = ? ORDER BY created_at").all(parentId) as Row[])
      .map((r) => JSON.parse(String(r.doc)) as Task);
  }

  // ----- inbox -----

  putInboxItem(i: InboxItem): void {
    this.db.prepare(
      `INSERT INTO inbox_items (item_id,sender_id,recipient_id,kind,priority,deadline,
         correlation_id,causation_id,created_at,processed_at,doc)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(item_id) DO UPDATE SET processed_at=excluded.processed_at, doc=excluded.doc`,
    ).run(i.item_id, i.sender_id, i.recipient_id, i.kind, i.priority ?? 0, i.deadline ?? null,
      i.correlation_id ?? null, i.causation_id ?? null, i.created_at, i.processed_at ?? null,
      JSON.stringify(i));
  }

  getInboxItem(id: string): InboxItem | undefined {
    const r = this.db.prepare("SELECT doc FROM inbox_items WHERE item_id = ?").get(id) as Row | undefined;
    return r ? (JSON.parse(String(r.doc)) as InboxItem) : undefined;
  }

  /** Unprocessed items for an agent, in deterministic delivery order (EXECUTION_MODEL). */
  pendingInbox(agentId: string): InboxItem[] {
    return (this.db.prepare(
      `SELECT doc FROM inbox_items WHERE recipient_id = ? AND processed_at IS NULL
       ORDER BY priority DESC, COALESCE(deadline, '9999') ASC, created_at ASC`,
    ).all(agentId) as Row[]).map((r) => JSON.parse(String(r.doc)) as InboxItem);
  }

  inboxFor(agentId: string): InboxItem[] {
    return (this.db.prepare("SELECT doc FROM inbox_items WHERE recipient_id = ? ORDER BY created_at").all(agentId) as Row[])
      .map((r) => JSON.parse(String(r.doc)) as InboxItem);
  }

  /** Terminal delegation results already delivered for a task (enforces exactly-one). */
  countDelegationResults(taskId: string): number {
    const r = this.db.prepare(
      `SELECT COUNT(*) AS n FROM inbox_items
       WHERE kind = 'delegation_result' AND json_extract(doc, '$.payload.task_id') = ?`,
    ).get(taskId) as Row;
    return Number(r.n);
  }

  // ----- executions -----

  putExecution(e: Execution): void {
    this.db.prepare(
      `INSERT INTO executions (execution_id,agent_id,trigger_type,trigger_ref,status,retry_of,
         started_at,ended_at,input_tokens,output_tokens,cost_usd,doc)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(execution_id) DO UPDATE SET
         status=excluded.status, ended_at=excluded.ended_at, input_tokens=excluded.input_tokens,
         output_tokens=excluded.output_tokens, cost_usd=excluded.cost_usd, doc=excluded.doc`,
    ).run(e.execution_id, e.agent_id, e.trigger.type, e.trigger.ref ?? null, e.status,
      e.retry_of ?? null, e.started_at, e.ended_at ?? null, e.usage?.input_tokens ?? 0,
      e.usage?.output_tokens ?? 0, e.usage?.cost_usd ?? 0, JSON.stringify(e));
  }

  getExecution(id: string): Execution | undefined {
    const r = this.db.prepare("SELECT doc FROM executions WHERE execution_id = ?").get(id) as Row | undefined;
    return r ? (JSON.parse(String(r.doc)) as Execution) : undefined;
  }

  listExecutions(agentId?: string): Execution[] {
    const rows = agentId
      ? this.db.prepare("SELECT doc FROM executions WHERE agent_id = ? ORDER BY started_at").all(agentId)
      : this.db.prepare("SELECT doc FROM executions ORDER BY started_at").all();
    return (rows as Row[]).map((r) => JSON.parse(String(r.doc)) as Execution);
  }

  runningExecutions(agentId?: string): Execution[] {
    const rows = agentId
      ? this.db.prepare("SELECT doc FROM executions WHERE status='running' AND agent_id = ?").all(agentId)
      : this.db.prepare("SELECT doc FROM executions WHERE status='running'").all();
    return (rows as Row[]).map((r) => JSON.parse(String(r.doc)) as Execution);
  }

  /** Total cost for an agent on a given UTC date (ADR 0008 per-agent-per-day scope). */
  costForAgentOnDate(agentId: string, isoDate: string, excludeExecutionId?: string): number {
    const r = excludeExecutionId
      ? this.db.prepare(
          `SELECT COALESCE(SUM(cost_usd),0) AS c FROM executions
           WHERE agent_id = ? AND substr(started_at,1,10) = ? AND execution_id <> ?`,
        ).get(agentId, isoDate, excludeExecutionId) as Row
      : this.db.prepare(
          `SELECT COALESCE(SUM(cost_usd),0) AS c FROM executions
           WHERE agent_id = ? AND substr(started_at,1,10) = ?`,
        ).get(agentId, isoDate) as Row;
    return Number(r.c);
  }

  totalCost(excludeExecutionId?: string): number {
    const r = excludeExecutionId
      ? this.db.prepare(
          "SELECT COALESCE(SUM(cost_usd),0) AS c FROM executions WHERE execution_id <> ?",
        ).get(excludeExecutionId) as Row
      : this.db.prepare("SELECT COALESCE(SUM(cost_usd),0) AS c FROM executions").get() as Row;
    return Number(r.c);
  }

  // ----- events -----

  appendEvent(e: AgentEvent): void {
    this.db.prepare(
      `INSERT INTO events (event_id,event_type,timestamp,agent_id,execution_id,task_id,
         correlation_id,causation_id,visibility,doc)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(e.event_id, e.event_type, e.timestamp, e.agent_id, e.execution_id ?? null,
      e.task_id ?? null, e.correlation_id ?? null, e.causation_id ?? null,
      e.visibility ?? "internal", JSON.stringify(e));
  }

  events(opts: { sinceSeq?: number; agentId?: string; limit?: number } = {}): AgentEvent[] {
    const clauses: string[] = [];
    const args: (string | number)[] = [];
    if (opts.sinceSeq !== undefined) { clauses.push("seq > ?"); args.push(opts.sinceSeq); }
    if (opts.agentId) { clauses.push("agent_id = ?"); args.push(opts.agentId); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = opts.limit ? `LIMIT ${Number(opts.limit)}` : "";
    return (this.db.prepare(`SELECT doc FROM events ${where} ORDER BY seq ${limit}`).all(...args) as Row[])
      .map((r) => JSON.parse(String(r.doc)) as AgentEvent);
  }

  eventSeq(eventId: string): number | undefined {
    const r = this.db.prepare("SELECT seq FROM events WHERE event_id = ?").get(eventId) as Row | undefined;
    return r ? Number(r.seq) : undefined;
  }

  maxEventSeq(): number {
    const r = this.db.prepare("SELECT COALESCE(MAX(seq),0) AS s FROM events").get() as Row;
    return Number(r.s);
  }

  // ----- waits -----

  putWait(w: WaitCondition, timeoutAt: string): void {
    this.db.prepare(
      `INSERT INTO waits (wait_id,agent_id,task_id,kind,status,timeout_at,created_at,resolved_at,doc)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(wait_id) DO UPDATE SET
         status=excluded.status, resolved_at=excluded.resolved_at, doc=excluded.doc`,
    ).run(w.wait_id, w.agent_id, w.task_id ?? null, w.kind, w.status, timeoutAt,
      w.created_at, w.resolved_at ?? null, JSON.stringify(w));
  }

  getWait(id: string): WaitCondition | undefined {
    const r = this.db.prepare("SELECT doc FROM waits WHERE wait_id = ?").get(id) as Row | undefined;
    return r ? (JSON.parse(String(r.doc)) as WaitCondition) : undefined;
  }

  activeWaits(): { wait: WaitCondition; timeout_at: string }[] {
    return (this.db.prepare("SELECT doc, timeout_at FROM waits WHERE status = 'active'").all() as Row[])
      .map((r) => ({ wait: JSON.parse(String(r.doc)) as WaitCondition, timeout_at: String(r.timeout_at) }));
  }

  waitsForTask(taskId: string): WaitCondition[] {
    return (this.db.prepare("SELECT doc FROM waits WHERE task_id = ?").all(taskId) as Row[])
      .map((r) => JSON.parse(String(r.doc)) as WaitCondition);
  }

  listWaits(): WaitCondition[] {
    return (this.db.prepare("SELECT doc FROM waits ORDER BY created_at").all() as Row[])
      .map((r) => JSON.parse(String(r.doc)) as WaitCondition);
  }

  // ----- memory -----

  putMemory(m: MemoryRecord): void {
    this.db.prepare(
      `INSERT INTO memories (memory_id,agent_id,kind,status,revision,created_at,updated_at,doc)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(memory_id) DO UPDATE SET
         status=excluded.status, revision=excluded.revision, updated_at=excluded.updated_at,
         doc=excluded.doc, kind=excluded.kind`,
    ).run(m.memory_id, m.agent_id, m.kind, m.status ?? "active", m.revision, m.created_at,
      m.updated_at ?? null, JSON.stringify(m));
  }

  getMemory(id: string): MemoryRecord | undefined {
    const r = this.db.prepare("SELECT doc FROM memories WHERE memory_id = ?").get(id) as Row | undefined;
    return r ? (JSON.parse(String(r.doc)) as MemoryRecord) : undefined;
  }

  activeMemories(agentId: string): MemoryRecord[] {
    return (this.db.prepare(
      "SELECT doc FROM memories WHERE agent_id = ? AND status = 'active' ORDER BY created_at",
    ).all(agentId) as Row[]).map((r) => JSON.parse(String(r.doc)) as MemoryRecord);
  }

  putMemoryRevision(r: MemoryRevision): void {
    this.db.prepare(
      "INSERT INTO memory_revisions (revision_id,memory_id,revision,actor_agent_id,created_at,doc) VALUES (?,?,?,?,?,?)",
    ).run(r.revision_id, r.memory_id, r.revision, r.actor_agent_id, r.created_at, JSON.stringify(r));
  }

  memoryRevisions(memoryId?: string): MemoryRevision[] {
    const rows = memoryId
      ? this.db.prepare("SELECT doc FROM memory_revisions WHERE memory_id = ? ORDER BY revision").all(memoryId)
      : this.db.prepare("SELECT doc FROM memory_revisions ORDER BY created_at").all();
    return (rows as Row[]).map((r) => JSON.parse(String(r.doc)) as MemoryRevision);
  }

  // ----- artifacts / approvals -----

  putArtifact(a: Artifact): void {
    this.db.prepare(
      `INSERT INTO artifacts (artifact_id,kind,uri,created_by_agent_id,created_in_execution,created_at,doc)
       VALUES (?,?,?,?,?,?,?)`,
    ).run(a.artifact_id, a.kind, a.uri, a.created_by_agent_id ?? null,
      a.created_in_execution ?? null, a.created_at, JSON.stringify(a));
  }

  getArtifact(id: string): Artifact | undefined {
    const r = this.db.prepare("SELECT doc FROM artifacts WHERE artifact_id = ?").get(id) as Row | undefined;
    return r ? (JSON.parse(String(r.doc)) as Artifact) : undefined;
  }

  listArtifacts(): Artifact[] {
    return (this.db.prepare("SELECT doc FROM artifacts ORDER BY created_at").all() as Row[])
      .map((r) => JSON.parse(String(r.doc)) as Artifact);
  }

  putApproval(a: Approval): void {
    this.db.prepare(
      "INSERT INTO approvals (approval_id,action,requested_by_agent_id,status,created_at,doc) VALUES (?,?,?,?,?,?) " +
      "ON CONFLICT(approval_id) DO UPDATE SET status=excluded.status, doc=excluded.doc",
    ).run(a.approval_id, a.action, a.requested_by_agent_id, a.status, a.created_at, JSON.stringify(a));
  }

  listApprovals(): Approval[] {
    return (this.db.prepare("SELECT doc FROM approvals ORDER BY created_at").all() as Row[])
      .map((r) => JSON.parse(String(r.doc)) as Approval);
  }
}
