/**
 * Minimal management console (OBSERVABILITY_AND_UI).
 *
 * The primary surface is the organization view — who exists, what they own, what is
 * happening, what needs attention. Direct chat with an agent is a drill-down, not the
 * home screen.
 *
 * State lives in a SQLite file so the console reflects a real, restartable organization:
 *   npm run peers -- seed
 *   npm run peers -- run
 *   npm run peers -- org
 *   npm run peers -- timeline
 *   npm run peers -- agent repo-maintainer
 *   npm run peers -- chat repo-maintainer "why did you delegate that?"
 *   npm run peers -- events --since 0
 *   npm run peers -- recover
 *
 * Decisions come from a real model by default (ADR 0015): an agent that cannot reason is not
 * an agent. `--provider` chooses which one — claude, openai or openrouter (ADR 0016) — and
 * `--model` picks a specific model within it.
 *
 * `--provider scripted` swaps in the deterministic adapter, which needs no API key and no
 * network: same control plane, same events, decisions from a fixed script instead of a
 * model. It exists for CI and for offline inspection. `--scripted` is shorthand for it.
 */
import { ControlPlane } from "../control-plane/controlPlane.ts";
import { Store } from "../control-plane/store.ts";
import { EventLog } from "../control-plane/events.ts";
import { randomIds, systemClock } from "../control-plane/runtime-env.ts";
import { AgentRuntime } from "../data-plane/runtime.ts";
import { LocalSandbox } from "../data-plane/sandbox/local.ts";
import {
  isProvider, isThinkingLevel, keyEnvFor, missingCredential, ModelResolver,
  PROVIDERS, THINKING_LEVELS, type ProviderName, type ThinkingLevel,
} from "../data-plane/model/select.ts";
import { Observer } from "../observer/observer.ts";
import { makeSampleRepo, seed, MANAGER_ID } from "../scripted/scenario.ts";

const DB = process.env.PEERS_DB ?? ".peers.db";

/** `--flag value` or `--flag=value`, so both spellings work. */
function flag(name: string): string | undefined {
  const argv = process.argv;
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

const requested = process.argv.includes("--scripted")
  ? "scripted"
  : flag("provider") ?? process.env.PEERS_PROVIDER ?? "claude";

if (!isProvider(requested)) {
  console.error(`unknown provider "${requested}" — expected one of: ${PROVIDERS.join(", ")}`);
  process.exit(2);
}
const PROVIDER: ProviderName = requested;
const MODEL = flag("model") ?? process.env.PEERS_MODEL;

const requestedThinking = flag("thinking") ?? process.env.PEERS_THINKING;
if (requestedThinking && !isThinkingLevel(requestedThinking)) {
  console.error(
    `unknown thinking level "${requestedThinking}" — expected one of: ${THINKING_LEVELS.join(", ")}`,
  );
  process.exit(2);
}
const THINKING = requestedThinking as ThinkingLevel | undefined;

/**
 * These are the organization's defaults. An agent that declares its own `model_config`
 * overrides them (ADR 0017); the resolver, not this file, decides which wins.
 */
const models = new ModelResolver({ provider: PROVIDER, model: MODEL, thinking: THINKING });

const bold = (s: string): string => `[1m${s}[0m`;
const dim = (s: string): string => `[2m${s}[0m`;

async function harness(): Promise<{ cp: ControlPlane; observer: Observer; store: Store }> {
  const store = new Store(DB);
  const clock = systemClock;
  // State outlives the process here, so ids must not restart per run.
  const ids = randomIds();
  const events = new EventLog(store, clock, ids);
  const runtimeModels = models;
  const sandbox = new LocalSandbox({
    artifactRoot: process.env.PEERS_ARTIFACTS ?? ".peers-artifacts",
  });
  const runtime = new AgentRuntime(runtimeModels, sandbox, events);
  const workspaceRoot = process.env.PEERS_WORKSPACE ?? (await makeSampleRepo());
  const cp = new ControlPlane(runtime, {
    store, clock, ids, workspaceRoot,
    budgets: { org_usd: 50, default_agent_usd_per_day: 5, execution_usd: 2 },
  });
  return { cp, observer: new Observer(store), store };
}

function printOrg(observer: Observer): void {
  const rows = observer.organization();
  if (rows.length === 0) { console.log(dim("no agents yet — run: npm run peers -- seed")); return; }
  console.log(bold("AGENT".padEnd(24) + "STATE".padEnd(9) + "TASKS  OBJECTIVE"));
  for (const r of rows) {
    const mark = r.attention ? " ⚠" : "";
    console.log(
      `${r.name.padEnd(24)}${r.state.padEnd(9)}${String(r.active_tasks).padEnd(7)}${r.objective}${mark}`,
    );
    console.log(dim(`  ${r.responsibility}`));
    console.log(dim(`  last: ${r.last_event}`));
  }
  const attention = observer.attentionNeeded();
  if (attention.length) {
    console.log(bold("\nNeeds attention"));
    for (const a of attention) console.log(`  ${a.agent_id}: ${a.reason}`);
  }
}

/**
 * Strip selection flags and their values before the command is parsed, so `run --provider
 * openai` and `--provider openai run` are the same and neither is mistaken for a command.
 */
function commandArgs(): string[] {
  const out: string[] = [];
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--scripted") continue;
    if (a === "--provider" || a === "--model" || a === "--thinking") { i++; continue; }
    if (a.startsWith("--provider=") || a.startsWith("--model=") || a.startsWith("--thinking=")) continue;
    out.push(a);
  }
  return out;
}

const [command, ...rest] = commandArgs();
const adapterName = PROVIDER === "scripted" ? "scripted adapter" : `${PROVIDER}${MODEL ? ` (${MODEL})` : ""}`;
console.log(dim(PROVIDER === "scripted"
  ? "running against the scripted adapter — deterministic, no API calls"
  : `running against ${adapterName} — this costs money`));

// Providers accept credentials by routes other than the obvious environment variable —
// Anthropic via authToken, Bedrock or Vertex — so a missing key is a likely mistake rather
// than a certain one. Warn, do not exit.
if (missingCredential(PROVIDER)) {
  console.log(dim(
    `  no ${keyEnvFor(PROVIDER)} found — set one, or pass --scripted to run without a model`,
  ));
}
if (PROVIDER === "openai" || PROVIDER === "openrouter") {
  console.log(dim(
    "  USD usage is unavailable in the CLI for OpenAI-compatible models — configure " +
      "provider-side spending limits; token and turn limits still apply",
  ));
}
const { cp, observer, store } = await harness();

switch (command) {
  case "seed": {
    seed(cp);
    console.log(`seeded ${MANAGER_ID} and one maintenance task in ${DB}`);
    break;
  }

  case "run": {
    const n = await cp.drain();
    console.log(`ran ${n} execution(s)`);
    printOrg(observer);
    break;
  }

  case "org":
  case undefined:
    printOrg(observer);
    break;

  case "timeline": {
    for (const e of observer.timeline({ limit: Number(rest[0] ?? 40) })) {
      console.log(`${dim(e.time)}  ${e.text}  ${dim(e.event_id)}`);
    }
    break;
  }

  case "events": {
    const sinceIdx = rest.indexOf("--since");
    const since = sinceIdx >= 0 ? Number(rest[sinceIdx + 1] ?? 0) : 0;
    for (const e of store.events({ sinceSeq: since })) {
      console.log(`${e.timestamp} ${e.event_type.padEnd(24)} ${e.agent_id.padEnd(18)} ${e.summary ?? ""}`);
    }
    break;
  }

  case "agent": {
    const id = rest[0];
    if (!id) { console.error("usage: agent <agent_id>"); process.exit(1); }
    const d = observer.agentDetail(id);
    if (!d.agent) { console.error(`unknown agent '${id}'`); process.exit(1); }
    console.log(bold(d.agent.name));
    console.log(`  responsibility : ${d.agent.responsibility}`);
    console.log(`  mission        : ${d.agent.mission}`);
    console.log(`  state          : ${d.agent.runtime_state}`);
    console.log(`  permissions    : ${(d.agent.permissions ?? []).map((p) => p.kind).join(", ")}`);
    const mc = d.agent.model_config;
    const effective = models.resolve(mc);
    console.log(`  model          : ${effective.provider}${effective.model ? `/${effective.model}` : ""}` +
      `${effective.thinking ? ` thinking=${effective.thinking}` : ""}` +
      dim(mc ? "  (declared on the agent)" : "  (organization default)"));
    console.log(bold("\n  executions"));
    for (const e of d.executions) {
      console.log(`    ${e.execution_id} ${e.status.padEnd(10)} trigger=${e.trigger.type} ` +
        `cost=$${e.usage?.cost_usd ?? 0}${e.error ? ` error=${e.error.reason}` : ""}`);
      // The reason alone ("runtime_error") is not diagnosable; the detail is what says
      // which credential is missing or which call threw.
      if (e.error?.detail) console.log(dim(`      ${e.error.detail}`));
    }
    console.log(bold("\n  inbox"));
    for (const i of d.inbox) {
      console.log(`    ${i.kind.padEnd(18)} from ${i.sender_id.padEnd(16)} ` +
        `${i.processed_at ? dim("processed") : bold("unread")}`);
    }
    console.log(bold("\n  delegations"));
    for (const t of d.delegations) console.log(`    ${t.task_id} -> ${t.recipient_id} [${t.status}] ${t.objective}`);
    console.log(bold("\n  durable memory"));
    for (const m of d.memories) console.log(`    [${m.kind} r${m.revision}] ${m.content}`);
    console.log(bold("\n  recent events"));
    for (const e of d.events.slice(-12)) console.log(dim(`    ${e.event_type}: ${e.summary ?? ""}`));
    break;
  }

  case "chat": {
    // Drill-down: a human speaks directly to one agent, and the agent runs.
    const id = rest[0];
    const body = rest.slice(1).join(" ");
    if (!id || !body) { console.error('usage: chat <agent_id> "message"'); process.exit(1); }
    cp.inbox.deliverMessage({ sender_id: "human:cli", recipient_id: id }, body);
    cp.events.emit({
      type: "user.intervened", agent_id: id, summary: `human message: ${body}`, visibility: "user",
    });
    await cp.drain();
    for (const e of observer.timeline({ limit: 8 })) console.log(`${dim(e.time)}  ${e.text}`);
    break;
  }

  case "approve":
  case "deny": {
    const id = rest[0];
    if (!id) { console.error(`usage: ${command} <approval_id>`); process.exit(1); }
    cp.decideApproval(id, command === "approve" ? "approved" : "denied", "human:cli");
    console.log(`${command}d ${id}`);
    break;
  }

  case "recover": {
    const orphans = cp.recoverOrphans();
    console.log(`recovered ${orphans.length} orphaned execution(s)`);
    for (const e of cp.retryable()) console.log(`  retry-eligible: ${e.execution_id} (${e.error?.reason})`);
    break;
  }

  case "model": {
    const id = rest[0];
    if (!id) {
      console.error("usage: model <agent_id> [--provider p] [--model m] [--thinking t] | model <agent_id> reset");
      process.exit(1);
    }
    if (rest[1] === "reset") {
      const a = cp.setAgentModel(id, undefined);
      console.log(`${id}: model reset to the organization default (revision ${a.revision})`);
      break;
    }
    // Only the flags actually passed are recorded, so setting one does not silently pin the
    // other two to whatever the console happened to default to this invocation.
    const config = {
      ...(flag("provider") ? { provider: flag("provider") as ProviderName } : {}),
      ...(flag("model") ? { model: flag("model") } : {}),
      ...(flag("thinking") ? { thinking: flag("thinking") as ThinkingLevel } : {}),
    };
    if (Object.keys(config).length === 0) {
      console.error("nothing to set — pass at least one of --provider, --model, --thinking");
      process.exit(1);
    }
    const a = cp.setAgentModel(id, config);
    const eff = models.resolve(a.model_config);
    console.log(`${id}: ${eff.provider}${eff.model ? `/${eff.model}` : ""}` +
      `${eff.thinking ? ` thinking=${eff.thinking}` : ""} (revision ${a.revision})`);
    break;
  }

  default:
    console.error(`unknown command '${command}'
commands: seed | run | org | timeline [n] | events [--since N] | agent <id> | chat <id> "msg" | model <id> [flags] | approve <id> | deny <id> | recover`);
    process.exit(1);
}

store.close();
