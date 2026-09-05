/**
 * Long-lived scheduler loop (ADR 0002).
 *
 * The control plane owns eligibility and `drain()` owns the mechanics of running everything
 * currently eligible. This loop adds only process lifetime: drain to quiescence, pause, and
 * try again. It deliberately contains no domain policy about what an agent should do.
 */
import { setTimeout as delay } from "node:timers/promises";

export type SchedulerTarget = {
  drain(maxRounds?: number): Promise<number>;
};

export type SchedulerCycle = {
  cycle: number;
  executions: number;
  totalExecutions: number;
};

export type SchedulerResult = {
  cycles: number;
  executions: number;
  stopped: "once" | "aborted";
};

export type SchedulerOptions = {
  /** Delay between drain cycles. Defaults to one second. */
  intervalMs?: number;
  /** Maximum number of control-plane ticks in each drain cycle. */
  maxRounds?: number;
  /** Injectable so tests and embedded runtimes never need wall-clock sleeps. */
  pause?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  /** Optional operational hook; it cannot influence eligibility. */
  onCycle?: (cycle: SchedulerCycle) => void | Promise<void>;
};

const systemPause = async (milliseconds: number, signal: AbortSignal): Promise<void> => {
  await delay(milliseconds, undefined, { signal });
};

function positiveInteger(value: number, name: string, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

/**
 * Repeatedly drives a control plane to quiescence until asked to stop.
 *
 * Cancellation is graceful: an in-flight drain is allowed to finish, while an abort during
 * the idle pause returns immediately. An already-aborted signal starts no new work.
 */
export class Scheduler {
  private readonly target: SchedulerTarget;
  private readonly intervalMs: number;
  private readonly maxRounds: number;
  private readonly pause: NonNullable<SchedulerOptions["pause"]>;
  private readonly onCycle?: SchedulerOptions["onCycle"];

  constructor(target: SchedulerTarget, options: SchedulerOptions = {}) {
    this.target = target;
    // Node timers clamp larger values down to 1ms, which would turn a configuration typo
    // into a hot loop. Refuse anything beyond their documented signed 32-bit range.
    this.intervalMs = positiveInteger(options.intervalMs ?? 1_000, "intervalMs", 2_147_483_647);
    this.maxRounds = positiveInteger(options.maxRounds ?? 50, "maxRounds");
    this.pause = options.pause ?? systemPause;
    this.onCycle = options.onCycle;
  }

  /** One scheduler cycle, useful for cron jobs and the CLI's `run` command. */
  async runOnce(signal?: AbortSignal): Promise<SchedulerResult> {
    return this.run({ once: true, signal });
  }

  async run(options: { once?: boolean; signal?: AbortSignal } = {}): Promise<SchedulerResult> {
    const signal = options.signal ?? new AbortController().signal;
    let cycles = 0;
    let executions = 0;

    while (!signal.aborted) {
      const ran = await this.target.drain(this.maxRounds);
      cycles++;
      executions += ran;
      await this.onCycle?.({ cycle: cycles, executions: ran, totalExecutions: executions });

      if (options.once) return { cycles, executions, stopped: "once" };
      if (signal.aborted) break;

      try {
        await this.pause(this.intervalMs, signal);
      } catch (error) {
        // node:timers/promises rejects with AbortError. Embedded pause functions may reject
        // with the signal's custom reason instead, so the signal itself is authoritative.
        if (!signal.aborted) throw error;
      }
    }

    return { cycles, executions, stopped: "aborted" };
  }
}
