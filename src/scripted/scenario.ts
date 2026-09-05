/**
 * The reference scenario, wired to the deterministic adapter.
 *
 * The *script* below is the stand-in for a model: it decides to delegate, decides what to
 * ask the worker for, and decides what is worth remembering. The control plane contains no
 * matching branch — swap the script and the organization behaves differently with no change
 * to the platform. That is the "no hard-coded orchestration graph" claim, made checkable.
 */
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Permission } from "../domain/types.ts";
import { ControlPlane } from "../control-plane/controlPlane.ts";
import { Store } from "../control-plane/store.ts";
import { fixedClock, sequentialIds } from "../control-plane/runtime-env.ts";
import { EventLog } from "../control-plane/events.ts";
import { AgentRuntime } from "../data-plane/runtime.ts";
import { LocalSandbox } from "../data-plane/sandbox/local.ts";
import { ScriptedModelAdapter, type ScriptStep } from "../data-plane/model/scripted.ts";
import { Observer } from "../observer/observer.ts";

export const MANAGER_ID = "repo-maintainer";

export const MANAGER_PERMISSIONS: Permission[] = [
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

/** Strictly narrower than the manager's: workspace read, output-only write, no network. */
export const WORKER_PERMISSIONS: Permission[] = [
  { kind: "fs.read", scope: { paths: ["/"] } },
  { kind: "fs.write", scope: { paths: ["/outputs"] } },
  { kind: "model.invoke", scope: { budget_usd_per_day: 1 } },
  { kind: "sandbox.create" },
  { kind: "tool.exec" },
];

/** A sample repository for the worker to inspect inside its sandbox. */
export async function makeSampleRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "sample-repo-"));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "README.md"), "# checkout-service\n", "utf8");
  await writeFile(
    join(root, "src", "checkout.js"),
    "const TIMEOUT_MS = 2000; // default request timeout\nmodule.exports = { TIMEOUT_MS };\n",
    "utf8",
  );
  await writeFile(
    join(root, "test-output.log"),
    [
      "FAIL src/checkout.test.js",
      "  ● checkout › completes within timeout",
      "    Exceeded timeout of 2000 ms for a test.",
      "    at Object.<anonymous> (src/checkout.test.js:14:3)",
      "Tests: 1 failed, 12 passed",
    ].join("\n"),
    "utf8",
  );
  return root;
}

export function buildScript(): ScriptStep[] {
  return [
    {
      // The manager sees a maintenance task and decides this is worth delegating.
      label: "manager: delegate analysis",
      when: (req) =>
        req.agent_id === MANAGER_ID &&
        req.prompt.includes("identify one high-priority maintenance issue") &&
        !req.prompt.includes("delegation_result"),
      then: () => [
        {
          type: "delegate_task",
          objective: "Analyze the failing tests and return root cause plus evidence.",
          expected_output: "Root cause with file:line evidence.",
          constraints: ["Read-only. Do not modify the repository."],
          output_contract: "root_cause: string; evidence: string[]",
          granted_permissions: WORKER_PERMISSIONS,
          budget: { timeout_seconds: 900, max_cost_usd: 1 },
          wait_for_result: true,
        },
      ],
      usage: { input_tokens: 2400, output_tokens: 320, cost_usd: 0.02 },
    },
    {
      // The worker inspects the repository in its sandbox and reports back.
      label: "worker: analyze and return result",
      when: (req) => req.prompt.includes("You are an ephemeral worker"),
      tools: () => [
        { command: ["ls", "workspace"] },
        { command: ["cat", "workspace/test-output.log"] },
        { command: ["grep", "-n", "TIMEOUT_MS", "workspace/src/checkout.js"] },
        // Artifacts are collected only from the per-execution output directory.
        {
          command: [
            "write_file",
            "outputs/root-cause.md",
            "# Root cause\n\nTIMEOUT_MS = 2000 in src/checkout.js is below the observed " +
            "checkout latency on slow CI hosts, so checkout.test.js fails intermittently.\n",
          ],
        },
      ],
      then: () => [
        {
          type: "return_worker_result",
          result: {
            status: "completed",
            summary: "Timeout regression: checkout test exceeds the 2000ms default.",
            result: {
              root_cause: "TIMEOUT_MS is 2000ms in src/checkout.js; the checkout test exceeds it on slow hosts.",
              evidence: ["src/checkout.js:1", "test-output.log: Exceeded timeout of 2000 ms"],
            },
            evidence: ["test-output.log", "src/checkout.js:1"],
            proposed_learnings: [
              {
                agent_id: "",
                operation: "create",
                kind: "knowledge",
                content:
                  "checkout-service uses a 2000ms default request timeout (src/checkout.js). " +
                  "Slow CI hosts exceed it, producing intermittent failures in checkout.test.js.",
                rationale: "Root cause of the failing suite; likely to recur on other hosts.",
                confidence: 0.8,
                evidence_refs: ["src/checkout.js:1"],
              },
            ],
          },
        },
      ],
      usage: { input_tokens: 5200, output_tokens: 640, cost_usd: 0.05 },
    },
    {
      // The manager integrates the worker's result and decides what to retain.
      label: "manager: integrate result and record learning",
      when: (req) => req.agent_id === MANAGER_ID && req.prompt.includes("delegation_result"),
      then: (req) => [
        {
          type: "propose_memory_update",
          proposal: {
            operation: "create",
            kind: "knowledge",
            content:
              "checkout-service's 2000ms default timeout (src/checkout.js) causes intermittent " +
              "test failures on slow hosts. Raising it, or making it configurable, is the fix.",
            rationale: "Durable architectural fact recovered from a worker investigation.",
            confidence: 0.85,
            evidence_refs: ["src/checkout.js:1"],
          },
        },
        {
          type: "mark_task_complete",
          task_id: req.task_id ?? "",
          summary: "Identified the checkout timeout regression as the top maintenance issue.",
        },
      ],
      usage: { input_tokens: 3100, output_tokens: 410, cost_usd: 0.03 },
    },
  ];
}

export type Harness = {
  cp: ControlPlane;
  observer: Observer;
  model: ScriptedModelAdapter;
  store: Store;
  repoRoot: string;
  clock: ReturnType<typeof fixedClock>;
};

export async function buildHarness(opts: { dbPath?: string } = {}): Promise<Harness> {
  const repoRoot = await makeSampleRepo();
  const clock = fixedClock();
  const ids = sequentialIds();
  const store = new Store(opts.dbPath);
  const model = new ScriptedModelAdapter(buildScript());
  const sandbox = new LocalSandbox();
  const events = new EventLog(store, clock, ids);
  const runtime = new AgentRuntime(model, sandbox, events);

  const cp = new ControlPlane(runtime, {
    store, clock, ids,
    workspaceRoot: repoRoot,
    budgets: { org_usd: 50, default_agent_usd_per_day: 5, execution_usd: 2 },
  });

  return { cp, observer: new Observer(store), model, store, repoRoot, clock };
}

/** Steps 1–3 of the scenario: register the manager and hand it a maintenance task. */
export function seed(cp: ControlPlane): { managerTaskId: string } {
  cp.createAgent({
    agent_id: MANAGER_ID,
    name: "Repository Maintainer",
    responsibility:
      "Keep repository checkout-service healthy, tested, documented, and moving toward its stated roadmap.",
    mission:
      "Continuously identify the highest-leverage maintenance work, coordinate specialists when useful, " +
      "preserve durable learnings, and surface blockers requiring human judgment.",
    success_criteria: [
      "Important failures are detected and addressed.",
      "Durable architectural learnings are retained.",
    ],
    permissions: MANAGER_PERMISSIONS,
    subscriptions: { kinds: ["task", "delegation_result", "message", "maintenance"], min_priority: 0 },
    memory_policy: { style: "curated", prefer_evidence: true },
  });

  const task = cp.assignTask({
    sender_id: "human:operator",
    recipient_id: MANAGER_ID,
    objective: "Inspect the repository and identify one high-priority maintenance issue.",
    expected_output: "The single highest-priority issue, with evidence.",
    priority: 1,
  });

  return { managerTaskId: task.task_id };
}
