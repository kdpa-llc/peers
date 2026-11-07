/** "Changed since you last looked": seen versions, changed lines, who changed what (ADR 0003). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { botFor, makeVault } from "./helpers.ts";

type Change = { created: boolean; hunks: { bStart: number; bEnd: number }[]; author: string; author_name: string; outside_scope: boolean };
type FileView = { hash: string; content: string; change?: Change };

const PLAN = "Projects/Alpha/Plan.md";

test("a new vault counts everything as seen", async () => {
  const fx = await makeVault();
  try {
    assert.equal((fx.app.readFile(PLAN) as FileView).change, undefined);
    assert.deepEqual(fx.app.files.unseen(), []);
  } finally {
    await fx.close();
  }
});

test("an outside edit shows its changed lines until the owner has looked", async () => {
  const fx = await makeVault();
  try {
    writeFileSync(join(fx.root, PLAN), "# Plan\n\nShip on March 21.\n\n- [ ] Write copy\n- [ ] Test on phones\n");
    fx.watcher.emit(PLAN);
    const page = fx.app.readFile(PLAN) as FileView;
    assert.equal(page.change!.author_name, "outside Peers");
    assert.deepEqual(page.change!.hunks.map((h) => [h.bStart, h.bEnd]), [[3, 3]]);
    assert.deepEqual(fx.app.files.unseen().map((f) => f.path), [PLAN]);
    // A stale hash (the page changed again while it was on screen) is not marked seen.
    assert.equal(fx.app.markSeen(PLAN, "0".repeat(64)), false);
    assert.equal(fx.app.markSeen(PLAN, page.hash), true);
    assert.equal((fx.app.readFile(PLAN) as FileView).change, undefined);
    assert.deepEqual(fx.app.files.unseen(), []);
  } finally {
    await fx.close();
  }
});

test("a page a bot wrote is credited to it; one outside its folder is flagged", async () => {
  const fx = await makeVault();
  try {
    const alpha = botFor(fx.app, "Projects/Alpha");
    const { thread_id } = await fx.app.send({ botId: alpha, text: "Write a page" });
    // While the bot is working, it writes in its folder and, wrongly, in another one.
    writeFileSync(join(fx.root, "Projects/Alpha/Launch email.md"), "# Launch email\n\nHi all.\n");
    fx.watcher.emit("Projects/Alpha/Launch email.md");
    writeFileSync(join(fx.root, "Areas/Finances/Budget.md"), "# Budget\n\nKitchen fund: $1.\n");
    fx.watcher.emit("Areas/Finances/Budget.md");
    await fx.settle();
    const email = fx.app.readFile("Projects/Alpha/Launch email.md") as FileView;
    assert.equal(email.change!.created, true);
    assert.equal(email.change!.author, alpha);
    assert.equal(email.change!.outside_scope, false);
    const budget = fx.app.readFile("Areas/Finances/Budget.md") as FileView;
    assert.equal(budget.change!.author, alpha);
    assert.equal(budget.change!.outside_scope, true);
    const today = fx.app.today() as { needs_you: { outside_scope: { path: string }[] }; changes: { path: string }[] };
    assert.deepEqual(today.needs_you.outside_scope.map((o) => o.path), ["Areas/Finances/Budget.md"]);
    assert.equal(today.changes.length, 2);
    assert.ok(thread_id);
    // Long after the run, edits are someone else's again.
    fx.clock.advance!(60_000);
    writeFileSync(join(fx.root, "Projects/Beta/Notes.md"), "# Notes\n\nEdited in an editor.\n");
    fx.watcher.emit("Projects/Beta/Notes.md");
    assert.equal(fx.app.files.row("Projects/Beta/Notes.md")!.author, "external");
    assert.equal(fx.app.seeAll(), 3);
    assert.deepEqual(fx.app.files.unseen(), []);
  } finally {
    await fx.close();
  }
});

test("moves and deletes by the owner keep tracking straight", async () => {
  const fx = await makeVault();
  try {
    fx.app.moveFile("Inbox/Clip.md", "Resources/Clip.md");
    assert.equal((fx.app.readFile("Resources/Clip.md") as FileView).change, undefined, "a moved page is not new");
    fx.app.deleteFile("Resources/Ref.md");
    assert.equal(fx.app.files.row("Resources/Ref.md"), undefined);
    assert.equal(fx.app.files.seenHash("Resources/Ref.md"), undefined);
    const restored = fx.app.archive("Projects/Beta") as { folder: string };
    assert.equal(restored.folder, "Archive/Beta");
    assert.equal((fx.app.readFile("Archive/Beta/Notes.md") as FileView).change, undefined, "archiving is not a change");
  } finally {
    await fx.close();
  }
});
