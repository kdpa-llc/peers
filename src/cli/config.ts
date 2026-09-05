/**
 * Operator-authored creation manifests and command-line arguments.
 *
 * Stored records contain control-plane fields (ids, timestamps, status, revision). Those
 * fields do not belong in creation input, so this module validates the smaller write
 * contracts before anything reaches durable state. JSON is intentional: it is supported by
 * Node without another parser in the trusted CLI process and fails closed on misspelled keys.
 */
import { readFile } from "node:fs/promises";
import type {
  Agent, InboxKind, LifecycleState, MemoryPolicy, ModelConfig, Permission, PermissionKind,
  PermissionScope, Relationships, Subscriptions,
} from "../domain/types.ts";

export type AgentCreateSpec =
  Omit<Agent, "created_at" | "revision" | "runtime_state" | "lifecycle_state"> &
  Partial<Pick<Agent, "lifecycle_state">>;

export type TaskCreateSpec = {
  sender_id: string;
  recipient_id: string;
  objective: string;
  context_refs?: string[];
  constraints?: string[];
  expected_output?: string;
  priority?: number;
  deadline?: string;
  correlation_id?: string;
  parent_task_id?: string;
};

export class ConfigurationError extends Error {
  override readonly name = "ConfigurationError";
}

const AGENT_KEYS = new Set([
  "agent_id", "name", "responsibility", "mission", "success_criteria", "lifecycle_state",
  "skills", "permissions", "model_config", "memory_policy", "relationships",
  "subscriptions", "metadata",
]);
const TASK_KEYS = new Set([
  "sender_id", "recipient_id", "objective", "context_refs", "constraints",
  "expected_output", "priority", "deadline", "correlation_id", "parent_task_id",
]);
const PERMISSION_KEYS = new Set(["kind", "scope"]);
const SCOPE_KEYS = new Set([
  "paths", "allow", "unrestricted", "budget_usd_per_day", "max_tokens_per_execution",
  "max_concurrent", "backend", "policy",
]);
const MODEL_KEYS = new Set(["provider", "model", "thinking"]);
const RELATIONSHIP_KEYS = new Set([
  "reports_to", "peers", "delegates_to", "reviews", "owns_service_for",
]);
const SUBSCRIPTION_KEYS = new Set(["kinds", "min_priority"]);

const PERMISSION_KINDS = new Set<PermissionKind>([
  "fs.read", "fs.write", "net.egress", "model.invoke", "sandbox.create", "tool.exec",
  "agent.message", "agent.delegate", "agent.create_ephemeral", "agent.propose_durable",
  "agent.approve_proposals", "skill.edit_shared", "memory.read_own", "memory.write_own",
  "memory.read_shared", "memory.write_shared", "history.delete", "external.side_effect",
]);
const INBOX_KINDS = new Set<InboxKind>([
  "task", "message", "reply", "notification", "review_request", "permission_request",
  "maintenance", "delegation_result",
]);
const PROVIDERS = new Set(["claude", "openai", "openrouter", "scripted"]);
const THINKING_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);
const LIFECYCLE_STATES = new Set<LifecycleState>(["active", "paused", "retired"]);

type JsonObject = Record<string, unknown>;

function object(value: unknown, at: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigurationError(`${at} must be an object`);
  }
  return value as JsonObject;
}

function exactKeys(value: JsonObject, allowed: Set<string>, at: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new ConfigurationError(`${at} has unknown field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
  }
}

function string(value: unknown, at: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigurationError(`${at} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, at: string): string | undefined {
  return value === undefined ? undefined : string(value, at);
}

function strings(value: unknown, at: string): string[] {
  if (!Array.isArray(value)) throw new ConfigurationError(`${at} must be an array of strings`);
  return value.map((item, index) => string(item, `${at}[${index}]`));
}

function optionalStrings(value: unknown, at: string): string[] | undefined {
  return value === undefined ? undefined : strings(value, at);
}

function nonnegativeInteger(value: unknown, at: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ConfigurationError(`${at} must be a non-negative integer`);
  }
  return value;
}

function positiveInteger(value: unknown, at: string): number {
  const n = nonnegativeInteger(value, at);
  if (n === 0) throw new ConfigurationError(`${at} must be greater than zero`);
  return n;
}

function nonnegativeNumber(value: unknown, at: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new ConfigurationError(`${at} must be a non-negative number`);
  }
  return value;
}

function unique(values: string[], at: string): string[] {
  if (new Set(values).size !== values.length) {
    throw new ConfigurationError(`${at} must not contain duplicates`);
  }
  return values;
}

function dateTime(value: unknown, at: string): string {
  const text = string(value, at);
  // JSON Schema's date-time format is RFC 3339. Require an explicit timezone so a manifest
  // behaves identically on every host rather than inheriting its local timezone.
  const match = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(text);
  const year = Number(match?.[1]);
  const month = Number(match?.[2]);
  const day = Number(match?.[3]);
  const daysInMonth = month >= 1 && month <= 12
    ? new Date(Date.UTC(year, month, 0)).getUTCDate()
    : 0;
  if (!match || day < 1 || day > daysInMonth || !Number.isFinite(Date.parse(text))) {
    throw new ConfigurationError(`${at} must be an RFC 3339 date-time with a timezone`);
  }
  return text;
}

function permissionScope(value: unknown, at: string): PermissionScope {
  const input = object(value, at);
  exactKeys(input, SCOPE_KEYS, at);
  const scope: PermissionScope = {};
  if (input.paths !== undefined) scope.paths = unique(strings(input.paths, `${at}.paths`), `${at}.paths`);
  if (input.allow !== undefined) scope.allow = unique(strings(input.allow, `${at}.allow`), `${at}.allow`);
  if (input.unrestricted !== undefined) {
    if (typeof input.unrestricted !== "boolean") {
      throw new ConfigurationError(`${at}.unrestricted must be a boolean`);
    }
    scope.unrestricted = input.unrestricted;
  }
  if (input.budget_usd_per_day !== undefined) {
    scope.budget_usd_per_day = nonnegativeNumber(input.budget_usd_per_day, `${at}.budget_usd_per_day`);
  }
  if (input.max_tokens_per_execution !== undefined) {
    scope.max_tokens_per_execution = positiveInteger(input.max_tokens_per_execution, `${at}.max_tokens_per_execution`);
  }
  if (input.max_concurrent !== undefined) {
    scope.max_concurrent = nonnegativeInteger(input.max_concurrent, `${at}.max_concurrent`);
  }
  if (input.backend !== undefined) scope.backend = string(input.backend, `${at}.backend`);
  if (input.policy !== undefined) scope.policy = string(input.policy, `${at}.policy`);
  return scope;
}

function permission(value: unknown, at: string): Permission {
  const input = object(value, at);
  exactKeys(input, PERMISSION_KEYS, at);
  const kind = string(input.kind, `${at}.kind`);
  if (!PERMISSION_KINDS.has(kind as PermissionKind)) {
    throw new ConfigurationError(`${at}.kind is not a supported permission: ${kind}`);
  }
  return {
    kind: kind as PermissionKind,
    ...(input.scope === undefined ? {} : { scope: permissionScope(input.scope, `${at}.scope`) }),
  };
}

function permissions(value: unknown, at: string): Permission[] {
  if (!Array.isArray(value)) throw new ConfigurationError(`${at} must be an array`);
  return value.map((item, index) => permission(item, `${at}[${index}]`));
}

function modelConfig(value: unknown, at: string): ModelConfig {
  const input = object(value, at);
  exactKeys(input, MODEL_KEYS, at);
  const out: ModelConfig = {};
  if (input.provider !== undefined) {
    const provider = string(input.provider, `${at}.provider`);
    if (!PROVIDERS.has(provider)) throw new ConfigurationError(`${at}.provider is not supported: ${provider}`);
    out.provider = provider as ModelConfig["provider"];
  }
  if (input.model !== undefined) out.model = string(input.model, `${at}.model`);
  if (input.thinking !== undefined) {
    const thinking = string(input.thinking, `${at}.thinking`);
    if (!THINKING_LEVELS.has(thinking)) {
      throw new ConfigurationError(`${at}.thinking is not supported: ${thinking}`);
    }
    out.thinking = thinking as ModelConfig["thinking"];
  }
  return out;
}

function memoryPolicy(value: unknown, at: string): MemoryPolicy {
  const input = object(value, at);
  if (input.style !== undefined) string(input.style, `${at}.style`);
  for (const key of ["prefer_evidence", "distill_completed_tasks", "archive_raw_transcripts"] as const) {
    if (input[key] !== undefined && typeof input[key] !== "boolean") {
      throw new ConfigurationError(`${at}.${key} must be a boolean`);
    }
  }
  if (input.retention_rules !== undefined) strings(input.retention_rules, `${at}.retention_rules`);
  return input as MemoryPolicy;
}

function relationships(value: unknown, at: string): Relationships {
  const input = object(value, at);
  exactKeys(input, RELATIONSHIP_KEYS, at);
  if (input.reports_to !== undefined) string(input.reports_to, `${at}.reports_to`);
  for (const key of ["peers", "delegates_to", "reviews", "owns_service_for"] as const) {
    if (input[key] !== undefined) unique(strings(input[key], `${at}.${key}`), `${at}.${key}`);
  }
  return input as Relationships;
}

function subscriptions(value: unknown, at: string): Subscriptions {
  const input = object(value, at);
  exactKeys(input, SUBSCRIPTION_KEYS, at);
  if (input.kinds !== undefined) {
    for (const [index, item] of strings(input.kinds, `${at}.kinds`).entries()) {
      if (!INBOX_KINDS.has(item as InboxKind)) {
        throw new ConfigurationError(`${at}.kinds[${index}] is not a supported inbox kind: ${item}`);
      }
    }
  }
  if (input.min_priority !== undefined) nonnegativeInteger(input.min_priority, `${at}.min_priority`);
  return input as Subscriptions;
}

export function parseAgentManifest(value: unknown, source = "agent manifest"): AgentCreateSpec {
  const input = object(value, source);
  exactKeys(input, AGENT_KEYS, source);
  const lifecycle = input.lifecycle_state === undefined
    ? undefined
    : string(input.lifecycle_state, `${source}.lifecycle_state`);
  if (lifecycle !== undefined && !LIFECYCLE_STATES.has(lifecycle as LifecycleState)) {
    throw new ConfigurationError(`${source}.lifecycle_state is not supported: ${lifecycle}`);
  }
  if (input.metadata !== undefined) object(input.metadata, `${source}.metadata`);
  return {
    agent_id: string(input.agent_id, `${source}.agent_id`),
    name: string(input.name, `${source}.name`),
    responsibility: string(input.responsibility, `${source}.responsibility`),
    mission: string(input.mission, `${source}.mission`),
    ...(input.success_criteria === undefined ? {} : {
      success_criteria: optionalStrings(input.success_criteria, `${source}.success_criteria`),
    }),
    ...(lifecycle === undefined ? {} : { lifecycle_state: lifecycle as LifecycleState }),
    ...(input.skills === undefined ? {} : { skills: unique(strings(input.skills, `${source}.skills`), `${source}.skills`) }),
    ...(input.permissions === undefined ? {} : { permissions: permissions(input.permissions, `${source}.permissions`) }),
    ...(input.model_config === undefined ? {} : { model_config: modelConfig(input.model_config, `${source}.model_config`) }),
    ...(input.memory_policy === undefined ? {} : { memory_policy: memoryPolicy(input.memory_policy, `${source}.memory_policy`) }),
    ...(input.relationships === undefined ? {} : { relationships: relationships(input.relationships, `${source}.relationships`) }),
    ...(input.subscriptions === undefined ? {} : { subscriptions: subscriptions(input.subscriptions, `${source}.subscriptions`) }),
    ...(input.metadata === undefined ? {} : { metadata: input.metadata as Record<string, unknown> }),
  };
}

export function parseTaskManifest(value: unknown, source = "task manifest"): TaskCreateSpec {
  const input = object(value, source);
  exactKeys(input, TASK_KEYS, source);
  return {
    sender_id: input.sender_id === undefined ? "human:cli" : string(input.sender_id, `${source}.sender_id`),
    recipient_id: string(input.recipient_id, `${source}.recipient_id`),
    objective: string(input.objective, `${source}.objective`),
    ...(input.context_refs === undefined ? {} : { context_refs: optionalStrings(input.context_refs, `${source}.context_refs`) }),
    ...(input.constraints === undefined ? {} : { constraints: optionalStrings(input.constraints, `${source}.constraints`) }),
    ...(input.expected_output === undefined ? {} : { expected_output: optionalString(input.expected_output, `${source}.expected_output`) }),
    ...(input.priority === undefined ? {} : { priority: nonnegativeInteger(input.priority, `${source}.priority`) }),
    ...(input.deadline === undefined ? {} : { deadline: dateTime(input.deadline, `${source}.deadline`) }),
    ...(input.correlation_id === undefined ? {} : { correlation_id: optionalString(input.correlation_id, `${source}.correlation_id`) }),
    ...(input.parent_task_id === undefined ? {} : { parent_task_id: optionalString(input.parent_task_id, `${source}.parent_task_id`) }),
  };
}

async function readJson(path: string, kind: string): Promise<unknown> {
  let body: string;
  try {
    body = await readFile(path, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ConfigurationError(`cannot read ${kind} '${path}': ${detail}`);
  }
  try {
    return JSON.parse(body) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ConfigurationError(`invalid JSON in ${kind} '${path}': ${detail}`);
  }
}

export async function loadAgentManifest(path: string): Promise<AgentCreateSpec> {
  return parseAgentManifest(await readJson(path, "agent manifest"), `agent manifest '${path}'`);
}

export async function loadTaskManifest(path: string): Promise<TaskCreateSpec> {
  return parseTaskManifest(await readJson(path, "task manifest"), `task manifest '${path}'`);
}

type Flags = Map<string, string[]>;

function parseFlags(args: string[], allowed: Set<string>, usage: string): Flags {
  const result: Flags = new Map();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) throw new ConfigurationError(`${usage}\nunexpected argument: ${arg}`);
    const equals = arg.indexOf("=");
    const key = arg.slice(2, equals < 0 ? undefined : equals);
    if (!allowed.has(key)) throw new ConfigurationError(`${usage}\nunknown option: --${key}`);
    const value = equals < 0 ? args[++i] : arg.slice(equals + 1);
    if (value === undefined || value.startsWith("--") || value === "") {
      throw new ConfigurationError(`${usage}\n--${key} requires a value`);
    }
    result.set(key, [...(result.get(key) ?? []), value]);
  }
  return result;
}

function one(flags: Flags, key: string, required = false): string | undefined {
  const values = flags.get(key) ?? [];
  if (values.length > 1) throw new ConfigurationError(`--${key} may be passed only once`);
  if (required && values.length === 0) throw new ConfigurationError(`missing required option: --${key}`);
  return values[0];
}

const AGENT_USAGE = "usage: agent create --file <agent.json> | agent create --id <id> --name <name> --responsibility <text> --mission <text> [--permission <kind> ...]";
const TASK_USAGE = "usage: task create --file <task.json> | task create --recipient <agent_id> --objective <text> [--sender <principal>] [--priority <n>]";

export async function agentSpecFromArgs(args: string[]): Promise<AgentCreateSpec> {
  const flags = parseFlags(args, new Set([
    "file", "id", "name", "responsibility", "mission", "success-criterion", "skill",
    "permission", "lifecycle",
  ]), AGENT_USAGE);
  const file = one(flags, "file");
  if (file !== undefined) {
    if (flags.size !== 1) throw new ConfigurationError(`${AGENT_USAGE}\n--file cannot be combined with inline agent fields`);
    return loadAgentManifest(file);
  }
  return parseAgentManifest({
    agent_id: one(flags, "id", true),
    name: one(flags, "name", true),
    responsibility: one(flags, "responsibility", true),
    mission: one(flags, "mission", true),
    ...(flags.has("success-criterion") ? { success_criteria: flags.get("success-criterion") } : {}),
    ...(flags.has("skill") ? { skills: flags.get("skill") } : {}),
    ...(flags.has("permission") ? {
      permissions: flags.get("permission")!.map((kind) => ({ kind })),
    } : {}),
    ...(flags.has("lifecycle") ? { lifecycle_state: one(flags, "lifecycle") } : {}),
  }, "agent command");
}

export async function taskSpecFromArgs(args: string[]): Promise<TaskCreateSpec> {
  const flags = parseFlags(args, new Set([
    "file", "recipient", "objective", "sender", "expected-output", "constraint",
    "context-ref", "priority", "deadline", "correlation", "parent",
  ]), TASK_USAGE);
  const file = one(flags, "file");
  if (file !== undefined) {
    if (flags.size !== 1) throw new ConfigurationError(`${TASK_USAGE}\n--file cannot be combined with inline task fields`);
    return loadTaskManifest(file);
  }
  const priority = one(flags, "priority");
  return parseTaskManifest({
    recipient_id: one(flags, "recipient", true),
    objective: one(flags, "objective", true),
    sender_id: one(flags, "sender") ?? "human:cli",
    ...(flags.has("expected-output") ? { expected_output: one(flags, "expected-output") } : {}),
    ...(flags.has("constraint") ? { constraints: flags.get("constraint") } : {}),
    ...(flags.has("context-ref") ? { context_refs: flags.get("context-ref") } : {}),
    ...(priority === undefined ? {} : { priority: Number(priority) }),
    ...(flags.has("deadline") ? { deadline: one(flags, "deadline") } : {}),
    ...(flags.has("correlation") ? { correlation_id: one(flags, "correlation") } : {}),
    ...(flags.has("parent") ? { parent_task_id: one(flags, "parent") } : {}),
  }, "task command");
}
