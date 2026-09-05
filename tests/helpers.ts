/**
 * Test harness. Everything is deterministic: fixed clock, sequential ids, scripted model,
 * in-memory SQLite. No network, no API key.
 */
import type { Permission } from "../src/domain/types.ts";
import { ControlPlane, type ControlPlaneOptions } from "../src/control-plane/controlPlane.ts";
import { Store } from "../src/control-plane/store.ts";
import { EventLog } from "../src/control-plane/events.ts";
import { fixedClock, sequentialIds } from "../src/control-plane/runtime-env.ts";
import { AgentRuntime } from "../src/data-plane/runtime.ts";
import { LocalSandbox } from "../src/data-plane/sandbox/local.ts";
import { ScriptedModelAdapter, type ScriptStep } from "../src/data-plane/model/scripted.ts";
import { Observer } from "../src/observer/observer.ts";

export const MANAGER: Permission[] = [
  { kind: "fs.read", scope: { paths: ["/"] } },
  { kind: "fs.write", scope: { paths: ["/"] } },
  { kind: "net.egress", scope: { allow: ["github.com"] } },
  { kind: "model.invoke", scope: { budget_usd_per_day: 5 } },
  { kind: "sandbox.create" },
  { kind: "tool.exec" },
  { kind: "agent.message" },
  { kind: "agent.delegate" },
  { kind: "agent.create_ephemeral", scope: { max_concurrent: 2 } },
  { kind: "memory.read_own" },
  { kind: "memory.write_own" },
];

export function makeCP(script: ScriptStep[], opts: Partial<ControlPlaneOptions> = {}): {
  cp: ControlPlane; store: Store; model: ScriptedModelAdapter; observer: Observer;
  clock: ReturnType<typeof fixedClock>;
} {
  const store = opts.store ?? new Store();
  const clock = opts.clock ?? fixedClock();
  const ids = opts.ids ?? sequentialIds();
  const model = new ScriptedModelAdapter(script);
  const events = new EventLog(store, clock, ids);
  const runtime = new AgentRuntime(model, new LocalSandbox(), events);
  const cp = new ControlPlane(runtime, {
    store, clock, ids,
    workspaceRoot: opts.workspaceRoot ?? process.cwd(),
    budgets: opts.budgets ?? { org_usd: 100, default_agent_usd_per_day: 10, execution_usd: 5 },
  });
  return { cp, store, model, observer: new Observer(store), clock: clock as ReturnType<typeof fixedClock> };
}

export function makeManager(cp: ControlPlane, permissions: Permission[] = MANAGER): string {
  cp.createAgent({
    agent_id: "mgr",
    name: "Manager",
    responsibility: "Own the sample repository.",
    mission: "Keep it healthy.",
    permissions,
    subscriptions: { kinds: ["task", "delegation_result", "message", "maintenance"] },
  });
  return "mgr";
}

/** A script step that always matches for one agent. */
export const stepFor = (
  agentId: string, label: string, then: ScriptStep["then"], extra: Partial<ScriptStep> = {},
): ScriptStep => ({
  label, when: (req) => req.agent_id === agentId, then, ...extra,
});
