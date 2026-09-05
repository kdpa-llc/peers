/**
 * The tool surface every model-backed adapter offers.
 *
 * There is one table, not one per provider. The wire format differs between vendors — an
 * Anthropic `input_schema` and an OpenAI `parameters` block are not the same JSON — but the
 * set of tools, their descriptions, their schemas, and the permission each one requires must
 * not. If they drifted, `CONTRACT_TESTS` #23 ("the tool surface equals the permission
 * surface") would hold for one provider and quietly stop holding for another, and swapping
 * adapters would change what an agent can do — which is exactly what ADR 0001 says must
 * never happen.
 *
 * Adapters translate these entries into their vendor's shape. They do not add tools.
 */
import type { AgentAction, Permission, PermissionKind } from "../../domain/types.ts";
import type { ModelRequest } from "./adapter.ts";

/**
 * Tool surface. Each entry maps one Anthropic tool to one `AgentAction`, and names the
 * permission that must be granted for the tool to be offered at all — an agent is never
 * shown a capability the control plane would refuse, so refusals are rare and legible.
 */
export type ActionTool = {
  name: string;
  requires?: PermissionKind;
  description: string;
  /**
   * Strict schemas guarantee the control plane receives inputs that validate exactly.
   * Off only where a tool carries a deliberately free-form payload, since strict mode
   * cannot express "any object".
   */
  strict?: false;
  properties: Record<string, unknown>;
  required: string[];
  build: (input: Record<string, any>, req: ModelRequest) => AgentAction | undefined;
};

const STRING = { type: "string" } as const;
const STRINGS = { type: "array", items: { type: "string" } } as const;

export const ACTION_TOOLS: ActionTool[] = [
  {
    name: "note",
    description:
      "Record a short observation without changing anything. Use when nothing else applies.",
    properties: { text: STRING },
    required: ["text"],
    build: (i) => ({ type: "note", text: String(i.text) }),
  },
  {
    name: "send_message",
    requires: "agent.message",
    description: "Send a message to another agent or to a human.",
    properties: { recipient_id: STRING, body: STRING },
    required: ["recipient_id", "body"],
    build: (i) => ({
      type: "send_message",
      recipient_id: String(i.recipient_id),
      body: String(i.body),
    }),
  },
  {
    name: "delegate_task",
    requires: "agent.delegate",
    description:
      "Hand a self-contained piece of work to a fresh ephemeral worker. The worker starts " +
      "with no history, so state everything it needs in the objective and constraints.",
    properties: {
      objective: STRING,
      expected_output: STRING,
      constraints: STRINGS,
      output_contract: {
        type: "string",
        description: "The shape the worker must return, e.g. 'root_cause: string; evidence: string[]'.",
      },
      granted_permission_kinds: {
        type: "array",
        items: STRING,
        description:
          "Permission kinds the worker needs. Narrowed against your own grants — you " +
          "cannot give away authority you do not hold.",
      },
      timeout_seconds: { type: "integer" },
      max_cost_usd: { type: "number" },
      wait_for_result: { type: "boolean" },
    },
    required: ["objective", "output_contract", "granted_permission_kinds"],
    build: (i, req) => ({
      type: "delegate_task",
      objective: String(i.objective),
      expected_output: i.expected_output ? String(i.expected_output) : undefined,
      constraints: Array.isArray(i.constraints) ? i.constraints.map(String) : undefined,
      output_contract: String(i.output_contract),
      // Resolve requested kinds against the manager's real grants: a subset by construction.
      granted_permissions: subsetOf(req.grants, i.granted_permission_kinds),
      budget: {
        timeout_seconds: Number(i.timeout_seconds ?? 900),
        max_cost_usd: Number(i.max_cost_usd ?? 1),
      },
      wait_for_result: i.wait_for_result !== false,
    }),
  },
  {
    name: "propose_memory_update",
    requires: "memory.write_own",
    description:
      "Record something durable and worth carrying into future executions. Prefer facts " +
      "with evidence over impressions.",
    properties: {
      operation: { type: "string", enum: ["create", "update", "supersede"] },
      kind: { type: "string", enum: ["knowledge", "preference", "procedure", "relationship"] },
      content: STRING,
      rationale: STRING,
      confidence: { type: "number" },
      evidence_refs: STRINGS,
    },
    required: ["operation", "kind", "content", "rationale"],
    build: (i) => ({
      type: "propose_memory_update",
      proposal: {
        operation: i.operation,
        kind: i.kind,
        content: String(i.content),
        rationale: String(i.rationale),
        confidence: i.confidence === undefined ? undefined : Number(i.confidence),
        evidence_refs: Array.isArray(i.evidence_refs) ? i.evidence_refs.map(String) : undefined,
      },
    }),
  },
  {
    name: "return_worker_result",
    strict: false,
    description:
      "Return your findings to the manager that delegated to you. This ends your work.",
    properties: {
      status: { type: "string", enum: ["completed", "failed", "partial"] },
      summary: STRING,
      result: { type: "object", description: "Structured payload matching the output contract." },
      evidence: STRINGS,
    },
    required: ["status", "summary"],
    build: (i) => ({
      type: "return_worker_result",
      result: {
        status: i.status,
        summary: String(i.summary),
        result: i.result,
        evidence: Array.isArray(i.evidence) ? i.evidence.map(String) : undefined,
      },
    }),
  },
  {
    name: "mark_task_complete",
    description: "Declare the current task finished, with a summary of the outcome.",
    properties: { summary: STRING },
    required: ["summary"],
    build: (i, req) => ({
      type: "mark_task_complete",
      task_id: req.task_id ?? "",
      summary: String(i.summary),
    }),
  },
  {
    name: "mark_task_blocked",
    description: "Declare the current task blocked on something you cannot resolve yourself.",
    properties: { reason: STRING },
    required: ["reason"],
    build: (i, req) => ({
      type: "mark_task_blocked",
      task_id: req.task_id ?? "",
      reason: String(i.reason),
    }),
  },
  {
    name: "request_permission",
    description: "Ask a human to grant an authority you lack. Creates an approval record.",
    properties: { kind: STRING, reason: STRING },
    required: ["kind", "reason"],
    build: (i) => ({
      type: "request_permission",
      permission: { kind: i.kind as PermissionKind },
      reason: String(i.reason),
    }),
  },
];

/** The sandbox escape hatch: not an AgentAction, so it is handled separately. */
export const RUN_COMMAND = "run_command";

/** Resolve requested permission kinds against grants actually held. */
function subsetOf(grants: Permission[], kinds: unknown): Permission[] {
  if (!Array.isArray(kinds)) return [];
  const wanted = new Set(kinds.map(String));
  return grants.filter((g) => wanted.has(g.kind));
}

/** The tools this request's grants actually permit, in table order. */
export function permittedTools(grants: Permission[]): ActionTool[] {
  const held = new Set(grants.map((g) => g.kind));
  return ACTION_TOOLS.filter((t) => !t.requires || held.has(t.requires));
}

/** Whether the sandbox escape hatch should be offered alongside the action tools. */
export function permitsRunCommand(grants: Permission[]): boolean {
  const held = new Set(grants.map((grant) => grant.kind));
  return held.has("tool.exec")
    && held.has("sandbox.create")
    && (held.has("fs.read") || held.has("fs.write"));
}

/**
 * The prompt the control plane assembles says who the agent is and what it is doing. This
 * says only how to answer — the platform's half of the contract, not the organization's.
 */
export const SYSTEM_PROMPT = [
  "You are an agent in a multi-agent organization. Everything you need is in the message:",
  "your responsibility, your memory, and the task at hand are reconstructed for you each",
  "time you run, so do not assume you remember earlier executions.",
  "",
  "Act by calling tools. Every decision you want to take must be a tool call — prose alone",
  "changes nothing. Use run_command to inspect permitted sandbox paths before concluding,",
  "and prefer",
  "evidence you have actually seen over what seems likely.",
  "",
  "You are shown only the tools you are permitted to use. When you have nothing further to",
  "do, finish with a tool call that ends your turn (mark_task_complete or",
  "return_worker_result), or note what you observed.",
].join("\n");
