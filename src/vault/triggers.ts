/**
 * Schedules and file-change triggers (TECHNICAL.md §10, ADR 0003).
 *
 * Each trigger keeps one conversation: its runs land there, so the owner sees a trigger's
 * history in one place and the bot keeps context between runs. A schedule fires once for its
 * latest slot, even after Peers was off for days. A file trigger batches changes for 30
 * seconds, ignores changes its own bot made and changes any trigger-started run made, runs
 * at most four times an hour, and waits while its conversation is still working: that is
 * what stops two bots waking each other forever.
 */
import type { DatabaseSync } from "node:sqlite";
import { describeSchedule, latestSlot, nextSlot } from "./schedules.ts";
import type { BotRegistry, FileTrigger } from "./bots.ts";
import type { Conversations } from "./conversations.ts";
import type { FileChange } from "./files.ts";

const BATCH_MS = 30_000;
const PER_HOUR = 4;

type Row = { bot_id: string; trigger_id: string; pending: string; first_pending_at: string | null; fired: string; last_slot: string | null };

export class Triggers {
  private readonly db: DatabaseSync;
  private readonly registry: BotRegistry;
  private readonly conversations: Conversations;
  private readonly now: () => Date;
  private readonly firing = new Set<string>();

  constructor(args: { db: DatabaseSync; registry: BotRegistry; conversations: Conversations; now: () => Date }) {
    this.db = args.db;
    this.registry = args.registry;
    this.conversations = args.conversations;
    this.now = args.now;
  }

  private row(botId: string, triggerId: string): Row | undefined {
    return this.db.prepare("SELECT * FROM vault_triggers WHERE bot_id = ? AND trigger_id = ?").get(botId, triggerId) as Row | undefined;
  }

  private ensure(botId: string, triggerId: string): Row {
    this.db.prepare("INSERT OR IGNORE INTO vault_triggers (bot_id, trigger_id) VALUES (?, ?)").run(botId, triggerId);
    return this.row(botId, triggerId)!;
  }

  private active(botId: string): boolean {
    const bot = this.registry.get(botId);
    return !!bot && !bot.def.paused && !bot.archived && !bot.def.needs_review;
  }

  /** A file changed in the vault (by anyone). */
  onChange(c: FileChange): void {
    // Changes made by a trigger-started run never wake a trigger: no bot ping-pong.
    if (c.viaTrigger) return;
    for (const bot of this.registry.list()) {
      if (!this.active(bot.def.id) || bot.def.id === c.author) continue;
      for (const t of bot.def.triggers ?? []) {
        if (t.kind !== "file_change" || !t.enabled) continue;
        const prefix = this.registry.triggerScope(bot, t);
        if (prefix && c.path !== prefix && !c.path.startsWith(`${prefix}/`)) continue;
        if (c.path.startsWith(".peers/")) continue;
        const row = this.ensure(bot.def.id, t.id);
        const pending = new Set<string>(JSON.parse(row.pending) as string[]);
        pending.add(c.path);
        this.db.prepare(
          "UPDATE vault_triggers SET pending = ?, first_pending_at = COALESCE(first_pending_at, ?) WHERE bot_id = ? AND trigger_id = ?",
        ).run(JSON.stringify([...pending].slice(0, 100)), this.now().toISOString(), bot.def.id, t.id);
      }
    }
  }

  /** Fire what is due. Returns how many runs started. */
  async tick(): Promise<number> {
    let started = 0;
    const now = this.now();
    for (const bot of this.registry.list()) {
      if (!this.active(bot.def.id)) continue;
      // Schedules: the latest slot, once.
      for (const s of this.registry.schedules(bot)) {
        const slot = latestSlot(s, now);
        if (!slot) continue;
        const row = this.ensure(bot.def.id, s.id);
        if (!row.last_slot) {
          // A new schedule starts from now; it does not fire for slots before it existed.
          this.db.prepare("UPDATE vault_triggers SET last_slot = ? WHERE bot_id = ? AND trigger_id = ?").run(slot.toISOString(), bot.def.id, s.id);
          continue;
        }
        if (row.last_slot >= slot.toISOString()) continue;
        this.db.prepare("UPDATE vault_triggers SET last_slot = ? WHERE bot_id = ? AND trigger_id = ?").run(slot.toISOString(), bot.def.id, s.id);
        if (await this.fire(bot.def.id, s.id, `${s.prompt}\n\n(${describeSchedule(s)}; due ${slot.toISOString()})`, `Schedule: ${s.trigger.prompt}`)) started++;
      }
      // File triggers: after the batch window, within the hourly cap.
      for (const t of (bot.def.triggers ?? []).filter((x): x is FileTrigger => x.kind === "file_change" && !!x.enabled)) {
        const row = this.row(bot.def.id, t.id);
        if (!row?.first_pending_at) continue;
        if (now.getTime() - Date.parse(row.first_pending_at) < BATCH_MS) continue;
        const open = this.conversations.triggerThread(bot.def.id, t.id);
        if (open?.state === "working") continue;
        const fired = (JSON.parse(row.fired) as string[]).filter((at) => now.getTime() - Date.parse(at) < 3_600_000);
        if (fired.length >= PER_HOUR) continue;
        const paths = JSON.parse(row.pending) as string[];
        fired.push(now.toISOString());
        this.db.prepare(
          "UPDATE vault_triggers SET pending = '[]', first_pending_at = NULL, fired = ? WHERE bot_id = ? AND trigger_id = ?",
        ).run(JSON.stringify(fired), bot.def.id, t.id);
        const text = `${t.prompt}\n\nChanged files:\n${paths.map((p) => `- ${p}`).join("\n")}`;
        if (await this.fire(bot.def.id, t.id, text, `When files change: ${t.prompt}`)) started++;
      }
    }
    // Pending changes for triggers that were turned off are dropped.
    for (const row of this.db.prepare("SELECT * FROM vault_triggers WHERE first_pending_at IS NOT NULL").all() as Row[]) {
      const bot = this.registry.get(row.bot_id);
      const t = bot?.def.triggers?.find((x) => x.id === row.trigger_id);
      if (!bot || !t?.enabled || !this.active(row.bot_id)) {
        this.db.prepare("UPDATE vault_triggers SET pending = '[]', first_pending_at = NULL WHERE bot_id = ? AND trigger_id = ?").run(row.bot_id, row.trigger_id);
      }
    }
    return started;
  }

  /** Run a trigger now: into its conversation, or a new one. */
  async fire(botId: string, triggerId: string, text: string, title: string): Promise<boolean> {
    const key = `${botId}/${triggerId}`;
    if (this.firing.has(key)) return false;
    const bot = this.registry.get(botId);
    if (!bot) return false;
    this.firing.add(key);
    try {
      const open = this.conversations.triggerThread(botId, triggerId);
      if (open) await this.conversations.post(open.id, text).then(() => this.markUnread(open.id));
      else await this.conversations.start(bot, text, { origin: "trigger", trigger_id: triggerId, title });
      return true;
    } finally {
      this.firing.delete(key);
    }
  }

  /** `post` marks a conversation read for the owner; a trigger run should not. */
  private markUnread(threadId: string): void {
    this.db.prepare("UPDATE vault_threads SET seen_at = NULL WHERE thread_id = ? AND seen_at IS NOT NULL")
      .run(threadId);
  }

  /** Next runs, for Today and the settings page. */
  coming(limit = 8): { bot_id: string; bot: string; at: string; label: string; prompt: string }[] {
    const now = this.now();
    const out: { bot_id: string; bot: string; at: string; label: string; prompt: string }[] = [];
    for (const bot of this.registry.list()) {
      if (!this.active(bot.def.id)) continue;
      for (const s of this.registry.schedules(bot)) {
        const at = nextSlot(s, now);
        if (at) out.push({ bot_id: bot.def.id, bot: bot.def.name, at: at.toISOString(), label: describeSchedule(s), prompt: s.trigger.prompt });
      }
    }
    return out.sort((a, b) => a.at.localeCompare(b.at)).slice(0, limit);
  }
}
