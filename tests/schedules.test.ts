/** Schedules (CONTRACT_TESTS #2), file-change triggers (#4), and definitions that need review (#5). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { latestSlot, nextSlot } from "../src/vault/schedules.ts";
import { botFor, makeVault } from "./helpers.ts";

test("slot arithmetic in a time zone, across a daylight-saving change", () => {
  const s = { id: "s", every: "day" as const, at: "08:00", tz: "America/New_York", prompt: "p" };
  // New York is UTC-5 after clocks go back on 1 Nov 2026 (08:00 = 13:00 UTC), UTC-4 before.
  assert.equal(latestSlot(s, new Date("2026-11-06T14:00:00Z"))!.toISOString(), "2026-11-06T13:00:00.000Z");
  assert.equal(latestSlot(s, new Date("2026-11-06T12:30:00Z"))!.toISOString(), "2026-11-05T13:00:00.000Z");
  assert.equal(latestSlot(s, new Date("2026-11-02T14:00:00Z"))!.toISOString(), "2026-11-02T13:00:00.000Z");
  assert.equal(latestSlot(s, new Date("2026-10-30T14:00:00Z"))!.toISOString(), "2026-10-30T12:00:00.000Z");
  const weekday = { ...s, every: "weekday" as const, tz: "UTC" };
  assert.equal(latestSlot(weekday, new Date("2026-11-08T09:00:00Z"))!.toISOString(), "2026-11-06T08:00:00.000Z", "Sunday falls back to Friday");
  const hourly = { id: "h", every: "hours" as const, n: 2, tz: "UTC", prompt: "p" };
  assert.equal(latestSlot(hourly, new Date("2026-11-06T09:59:00Z"))!.toISOString(), "2026-11-06T08:00:00.000Z");
  assert.equal(nextSlot(hourly, new Date("2026-11-06T09:59:00Z"))!.toISOString(), "2026-11-06T10:00:00.000Z");
});

test("a schedule fires once per slot, a missed slot once, into one conversation (#2)", async () => {
  const fx = await makeVault({ start: "2026-11-06T07:00:00.000Z" });
  try {
    const bot = botFor(fx.app, "Projects/Alpha");
    fx.app.updateSettings({ tz: "UTC" });
    fx.app.updateBot(bot, { triggers: [{ id: "brief", kind: "schedule", every: "day", at: "08:00", prompt: "Prepare the brief", enabled: true }] });
    assert.equal(await fx.app.tick(), 0, "a new schedule does not fire for a past slot");
    fx.clock.advance!(60 * 60_000 + 1000); // 08:00:01
    assert.equal(await fx.app.tick(), 1);
    assert.equal(await fx.app.tick(), 0, "the same slot never fires twice");
    await fx.settle();
    // The server was off for three days: one catch-up run, not three.
    fx.clock.advance!(3 * 24 * 60 * 60_000);
    assert.equal(await fx.app.tick(), 1);
    await fx.settle();
    const threads = fx.app.conversations.list(bot);
    assert.equal(threads.length, 1, "a trigger keeps one conversation");
    assert.equal(threads[0]!.origin, "trigger");
    assert.equal(threads[0]!.unread, true, "a trigger's reply is unread");
    const msgs = await fx.app.conversations.messages(threads[0]!.id);
    assert.deepEqual(msgs.map((m) => m.role), ["trigger", "bot", "trigger", "bot"]);
    assert.match(msgs[0]!.text, /Prepare the brief/);
    const coming = fx.app.triggers.coming();
    assert.equal(coming[0]!.bot_id, bot);
  } finally {
    await fx.close();
  }
});

test("file triggers batch, skip their own bot and trigger-started runs, and cap per hour (#4)", async () => {
  const fx = await makeVault();
  try {
    const vaultBot = fx.app.registry.vaultBot().def.id;
    const alpha = botFor(fx.app, "Projects/Alpha");
    fx.app.updateBot(vaultBot, { triggers: [{ id: "inbox", kind: "file_change", path: "Inbox", prompt: "Triage new files", enabled: true }] });
    fx.app.updateBot(alpha, { triggers: [{ id: "watch", kind: "file_change", path: "", prompt: "Check the folder", enabled: true }], write_scope: "vault" });
    writeFileSync(join(fx.root, "Inbox/New.md"), "# New clipping\n");
    fx.watcher.emit("Inbox/New.md");
    assert.equal(await fx.app.tick(), 0, "batched for 30 seconds");
    fx.clock.advance!(31_000);
    assert.equal(await fx.app.tick(), 1);
    const run = fx.app.conversations.list(vaultBot)[0]!;
    assert.match((await fx.engine.messages(run.id))[0]!.text, /Inbox\/New.md/);
    // While the trigger run works, it writes into Alpha's folder: that must not wake Alpha.
    writeFileSync(join(fx.root, "Projects/Alpha/Triage.md"), "# Triage\n");
    fx.watcher.emit("Projects/Alpha/Triage.md");
    await fx.settle();
    fx.clock.advance!(31_000);
    assert.equal(await fx.app.tick(), 0, "no ping-pong between bots");
    // Outside changes: four runs an hour at most.
    let fires = 1;
    for (let i = 0; i < 6; i++) {
      fx.clock.advance!(60_000);
      writeFileSync(join(fx.root, `Inbox/More${i}.md`), `# ${i}\n`);
      fx.watcher.emit(`Inbox/More${i}.md`);
      fx.clock.advance!(31_000);
      fires += await fx.app.tick();
      await fx.settle();
    }
    assert.equal(fires, 4);
  } finally {
    await fx.close();
  }
});

test("a definition that arrives with automation, or gains it on disk, waits for review (#5)", async () => {
  const fx = await makeVault({ files: {
    "Projects/Alpha/Plan.md": "# Plan\n",
    "Projects/Gamma/Notes.md": "# Gamma\n",
    // Copied in from elsewhere, with a live schedule.
    ".peers/agents/bot-gamma-abcdef.json": JSON.stringify({ id: "bot-gamma-abcdef", name: "Gamma", path: "Projects/Gamma",
      triggers: [{ id: "t", kind: "schedule", every: "hours", prompt: "go", enabled: true }] }),
  } });
  try {
    const gamma = fx.app.registry.get("bot-gamma-abcdef")!;
    assert.equal(gamma.def.needs_review, true, "copied in with a live schedule");
    fx.app.updateBot(gamma.def.id, { needs_review: false });
    assert.equal(fx.app.registry.get(gamma.def.id)!.def.needs_review, false);
    // Something widens a definition on disk: back to review.
    const alpha = botFor(fx.app, "Projects/Alpha");
    const file = join(fx.root, ".peers", "agents", `${alpha}.json`);
    const def = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify({ ...def, write_scope: "vault" }));
    fx.watcher.emit(`.peers/agents/${alpha}.json`);
    assert.equal(fx.app.registry.get(alpha)!.def.needs_review, true);
    assert.equal(await fx.app.tick(), 0);
    // An edit through the app is accepted as is.
    fx.app.updateBot(alpha, { needs_review: false, write_scope: "folder" });
    fx.app.updateBot(alpha, { triggers: [{ id: "h", kind: "schedule", every: "hours", prompt: "check", enabled: true }] });
    fx.app.registry.sync();
    assert.notEqual(fx.app.registry.get(alpha)!.def.needs_review, true);
  } finally {
    await fx.close();
  }
});

test("an agent definition from before ADR 0005 (.bot.json in the folder) moves into .peers/agents", async () => {
  const fx = await makeVault({ files: {
    "Projects/Alpha/Plan.md": "# Plan\n",
    "Projects/Alpha/.bot.json": JSON.stringify({ id: "bot-alpha-old123", name: "Alpha" }),
    "Projects/Alpha/.bot/MEMORY.md": "- likes short notes\n",
  } });
  try {
    const bot = fx.app.registry.get("bot-alpha-old123")!;
    assert.equal(bot.path, "Projects/Alpha");
    assert.ok(!existsSync(join(fx.root, "Projects/Alpha/.bot.json")));
    assert.match(fx.app.memory(bot.def.id).text, /likes short notes/);
  } finally {
    await fx.close();
  }
});
