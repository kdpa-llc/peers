import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { Scheduler, type SchedulerCycle } from "../../src/control-plane/scheduler.ts";
import { makeCP, makeManager, stepFor } from "../helpers.ts";

describe("scheduler", () => {
  test("one-shot mode drains once and does not pause", async () => {
    const calls: number[] = [];
    let pauses = 0;
    const scheduler = new Scheduler({
      async drain(maxRounds) {
        calls.push(maxRounds ?? -1);
        return 3;
      },
    }, {
      maxRounds: 7,
      pause: async () => { pauses++; },
    });

    const result = await scheduler.runOnce();

    assert.deepEqual(result, { cycles: 1, executions: 3, stopped: "once" });
    assert.deepEqual(calls, [7]);
    assert.equal(pauses, 0);
  });

  test("continuous mode repeats without overlapping drains and aborts during a pause", async () => {
    const controller = new AbortController();
    const order: string[] = [];
    const intervals: number[] = [];
    let active = 0;
    let maxActive = 0;
    let drains = 0;
    const cycles: SchedulerCycle[] = [];

    const scheduler = new Scheduler({
      async drain() {
        active++;
        maxActive = Math.max(maxActive, active);
        order.push(`drain-${++drains}`);
        active--;
        return drains;
      },
    }, {
      intervalMs: 250,
      pause: async (milliseconds) => {
        intervals.push(milliseconds);
        order.push(`pause-${drains}`);
        if (drains === 3) {
          controller.abort();
          throw new Error("injected abort rejection");
        }
      },
      onCycle: (cycle) => { cycles.push(cycle); },
    });

    const result = await scheduler.run({ signal: controller.signal });

    assert.deepEqual(result, { cycles: 3, executions: 6, stopped: "aborted" });
    assert.equal(maxActive, 1, "a new drain never starts while the previous one is running");
    assert.deepEqual(intervals, [250, 250, 250]);
    assert.deepEqual(order, [
      "drain-1", "pause-1", "drain-2", "pause-2", "drain-3", "pause-3",
    ]);
    assert.deepEqual(cycles, [
      { cycle: 1, executions: 1, totalExecutions: 1 },
      { cycle: 2, executions: 2, totalExecutions: 3 },
      { cycle: 3, executions: 3, totalExecutions: 6 },
    ]);
  });

  test("an already-aborted signal starts no work", async () => {
    const controller = new AbortController();
    controller.abort();
    let drains = 0;
    const scheduler = new Scheduler({
      async drain() { drains++; return 0; },
    });

    const result = await scheduler.run({ signal: controller.signal });

    assert.deepEqual(result, { cycles: 0, executions: 0, stopped: "aborted" });
    assert.equal(drains, 0);
  });

  test("invalid loop limits fail before any work starts", () => {
    const target = { async drain() { return 0; } };
    assert.throws(() => new Scheduler(target, { intervalMs: 0 }), /intervalMs/);
    assert.throws(() => new Scheduler(target, { intervalMs: 1.5 }), /intervalMs/);
    assert.throws(() => new Scheduler(target, { intervalMs: 2_147_483_648 }), /intervalMs/);
    assert.throws(() => new Scheduler(target, { maxRounds: -1 }), /maxRounds/);
  });

  test("polling wakes an agent when a wait times out using only the fake clock", async () => {
    const { cp, store, clock } = makeCP([
      stepFor("mgr", "wake after timeout", () => []),
    ]);
    makeManager(cp);
    const wait = cp.waits.register({
      agent_id: "mgr",
      kind: "time",
      timeout_seconds: 2,
    });
    const controller = new AbortController();
    let pauses = 0;
    const scheduler = new Scheduler(cp, {
      intervalMs: 1_000,
      pause: async (milliseconds) => {
        clock.advance!(milliseconds);
        if (++pauses === 3) controller.abort();
      },
    });

    const result = await scheduler.run({ signal: controller.signal });

    assert.equal(result.cycles, 3);
    assert.equal(result.executions, 1);
    assert.equal(store.getWait(wait.wait_id)?.status, "timeout");
    const executions = store.listExecutions("mgr");
    assert.equal(executions.length, 1);
    assert.deepEqual(executions[0]!.trigger, { type: "wait", ref: wait.wait_id });
  });
});
