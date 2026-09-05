/**
 * Two durable peers collaborating sideways.
 *
 * Everything else in this suite exercises manager → worker: authority flows down, results
 * come back up. That is a tree, and a tree is the shape the project explicitly says it is
 * not building ("an AI organization, not a workflow graph"). This test covers the other
 * axis — two long-lived agents with different responsibilities, neither owning the other,
 * one asking the other for judgment it does not have.
 *
 * The interesting assertions are not that a message arrives. They are that the recipient
 * *wakes on it*, that it can find its colleague without being told they exist, and that the
 * whole exchange stays on one correlation so the timeline reads as a conversation.
 *
 * Enforces CONTRACT_TESTS #24 (peers collaborate without delegation).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { Permission } from "../../src/domain/types.ts";
import type { ScriptStep } from "../../src/data-plane/model/scripted.ts";
import { makeCP } from "../helpers.ts";

const MAINTAINER = "repo-maintainer";
const REVIEWER = "security-reviewer";

/** Neither peer can delegate: whatever happens here is collaboration, not delegation. */
const PEER_PERMISSIONS: Permission[] = [
  { kind: "fs.read", scope: { paths: ["/"] } },
  { kind: "model.invoke", scope: { budget_usd_per_day: 5 } },
  { kind: "agent.message" },
  { kind: "memory.read_own" },
  { kind: "memory.write_own" },
];

const QUESTION = "Does pinning the base image to a digest break your review process?";
const ANSWER = "No — digest pins are required. Unpinned tags fail the supply-chain check.";

function script(): ScriptStep[] {
  return [
    {
      // The maintainer hits a question that is not its call to make.
      label: "maintainer: ask the reviewer",
      when: (req) => req.agent_id === MAINTAINER && !req.prompt.includes(ANSWER),
      then: () => [{ type: "send_message", recipient_id: REVIEWER, body: QUESTION }],
    },
    {
      // The reviewer answers from its own responsibility, not the maintainer's.
      label: "reviewer: answer",
      when: (req) => req.agent_id === REVIEWER && req.prompt.includes(QUESTION),
      then: () => [{ type: "send_message", recipient_id: MAINTAINER, body: ANSWER }],
    },
    {
      label: "maintainer: act on the answer",
      when: (req) => req.agent_id === MAINTAINER && req.prompt.includes(ANSWER),
      then: (req) => [
        {
          type: "propose_memory_update",
          proposal: {
            operation: "create",
            kind: "knowledge",
            content: "Base images must be pinned by digest; unpinned tags fail the supply-chain check.",
            rationale: "Answered by security-reviewer, who owns that policy.",
            confidence: 0.9,
          },
        },
        {
          type: "mark_task_complete",
          task_id: req.task_id ?? "",
          summary: "Pinned the base image by digest, confirmed with security-reviewer.",
        },
      ],
    },
  ];
}

function organization() {
  const harness = makeCP(script());
  harness.cp.createAgent({
    agent_id: MAINTAINER,
    name: "Repository Maintainer",
    responsibility: "Keep the repository healthy and current.",
    mission: "Find the highest-leverage maintenance work.",
    permissions: PEER_PERMISSIONS,
    subscriptions: { kinds: ["task", "message"] },
  });
  harness.cp.createAgent({
    agent_id: REVIEWER,
    name: "Security Reviewer",
    responsibility: "Own the supply-chain and dependency security posture.",
    mission: "Keep the organization's dependencies defensible.",
    permissions: PEER_PERMISSIONS,
    subscriptions: { kinds: ["task", "message"] },
  });
  return harness;
}

describe("peer collaboration", () => {
  test("a peer wakes on a message, answers, and the asker acts on the answer", async () => {
    const { cp, store, model } = organization();
    cp.assignTask({
      sender_id: "human:operator",
      recipient_id: MAINTAINER,
      objective: "Pin the base image, checking anything you do not own with whoever does.",
    });

    await cp.drain();

    // The reviewer ran because a message arrived, not because anyone scheduled it.
    const reviewerRuns = store.listExecutions(REVIEWER);
    assert.equal(reviewerRuns.length, 1, "the reviewer ran exactly once");
    assert.equal(reviewerRuns[0]!.trigger.type, "inbox");
    assert.equal(reviewerRuns[0]!.status, "completed");

    // The maintainer ran twice: once to ask, once on the reply.
    assert.equal(store.listExecutions(MAINTAINER).length, 2);

    // Every scripted step fired — nobody was left waiting.
    assert.deepEqual(model.unusedSteps(), []);

    const memory = store.activeMemories(MAINTAINER);
    assert.equal(memory.length, 1);
    assert.match(memory[0]!.content, /pinned by digest/i);
  });

  test("neither peer delegated: this is collaboration, not a manager/worker tree", async () => {
    const { cp, store } = organization();
    cp.assignTask({ sender_id: "human:operator", recipient_id: MAINTAINER, objective: "Pin the base image." });

    await cp.drain();

    const kinds = store.events().map((e) => e.event_type);
    assert.ok(!kinds.some((k) => k.startsWith("delegation.")), "no delegation occurred");
    // Ephemeral workers are the delegation mechanism; none should exist.
    const ephemeral = store.listAgents({ includeEphemeral: true })
      .filter((a) => !store.listAgents().some((d) => d.agent_id === a.agent_id));
    assert.deepEqual(ephemeral, [], "no ephemeral workers were created");
  });

  test("a peer discovers its colleague from context, not from hard-coded wiring", async () => {
    const { cp, model } = organization();
    cp.assignTask({ sender_id: "human:operator", recipient_id: MAINTAINER, objective: "Pin the base image." });

    await cp.drain();

    // The maintainer addressed the reviewer by id. That id has to have come from somewhere,
    // and the only place it appears is the peer directory the context builder assembles.
    const firstPrompt = model.calls.find((c) => c.agent_id === MAINTAINER)!.prompt;
    assert.match(firstPrompt, /Colleagues:/);
    assert.match(firstPrompt, new RegExp(`${REVIEWER}.*supply-chain`, "i"));

    // And the reviewer sees the maintainer, so the directory is not one-directional.
    const reviewerPrompt = model.calls.find((c) => c.agent_id === REVIEWER)!.prompt;
    assert.match(reviewerPrompt, new RegExp(`${MAINTAINER}`));
  });

  test("the whole exchange stays on one correlation", async () => {
    const { cp, store } = organization();
    const task = cp.assignTask({
      sender_id: "human:operator",
      recipient_id: MAINTAINER,
      objective: "Pin the base image.",
    });

    await cp.drain();

    const correlation = store.getTask(task.task_id)!.correlation_id;
    assert.ok(correlation, "the task carries a correlation id");

    const onThread = store.events().filter((e) => e.correlation_id === correlation);
    const agents = new Set(onThread.map((e) => e.agent_id));
    assert.ok(agents.has(MAINTAINER) && agents.has(REVIEWER),
      "both peers' events are on the same correlation, so the timeline reads as one conversation");
  });
});
