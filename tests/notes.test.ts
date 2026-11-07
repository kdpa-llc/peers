/** Notes: anchoring, sending as a message, idempotency, and outcomes from the page (ADR 0003). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { locate, project, type Deliver } from "../src/vault/annotations.ts";
import { parseNotesMessage } from "../src/vault/messages.ts";
import { makeVault, type Fixture } from "./helpers.ts";

const PLAN = "Projects/Alpha/Plan.md";

const deliver = (fx: Fixture): Deliver => (bot, text, title) => fx.app.conversations.start(bot, text, { origin: "notes", title });

test("rendered quotes are found in markdown source despite markup", () => {
  const src = "# Title\n\nShip **on** March 14. See [[Launch plan|the plan]].\n\n- [ ] Write `copy`\n";
  assert.ok(project(src).plain.includes("Ship on March 14. See the plan."));
  assert.deepEqual(locate(src, { exact: "Ship on March 14" }), [3, 3]);
  assert.deepEqual(locate(src, { exact: "Write copy" }), [5, 5]);
});

test("ambiguous or missing quotes do not anchor; prefix and suffix disambiguate", () => {
  const src = "- [ ] Test\n- [ ] Ship\n- [ ] Test\n";
  assert.equal(locate(src, { exact: "Test" }), undefined, "two matches is no match");
  assert.deepEqual(locate(src, { exact: "Test", prefix: "Ship " }), [3, 3]);
  assert.equal(locate(src, { exact: "Nothing like this" }), undefined);
});

test("send re-anchors against the current page, sends one message, and is idempotent", async () => {
  const fx = await makeVault();
  try {
    const page = fx.app.readFile(PLAN) as { hash: string };
    fx.app.notes.upsert({ client_key: "note-aaaaaaaa", path: PLAN, tool: "select", doc_blob: page.hash,
      anchor: { lines: [5, 5], quote: { exact: "Write copy" } }, instruction: "make this bold" });
    fx.app.notes.upsert({ client_key: "note-bbbbbbbb", path: PLAN, tool: "select", doc_blob: page.hash,
      anchor: { lines: [6, 6], quote: { exact: "Test on phones" } }, instruction: "delete this" });
    // The page changes before sending: one quote still matches once, the other is gone.
    writeFileSync(join(fx.root, PLAN), "# Plan\n\nIntro added.\n\nShip on March 14.\n\n- [ ] Write copy\n");
    const r = await fx.app.notes.send({ path: PLAN, keys: ["note-aaaaaaaa", "note-bbbbbbbb"], idempotency_key: "send-1" }, deliver(fx));
    assert.equal(r.sent.length, 1);
    assert.deepEqual(r.sent[0]!.anchor?.lines, [7, 7], "re-anchored to the new line");
    assert.equal(r.unresolved.length, 1);
    assert.equal(fx.app.notes.byKey("note-bbbbbbbb")?.status, "unresolved");
    const again = await fx.app.notes.send({ path: PLAN, keys: ["note-aaaaaaaa"], idempotency_key: "send-1" }, deliver(fx));
    assert.equal(again.thread_id, r.thread_id, "the same key returns the first result");
    assert.equal(fx.app.conversations.list(r.recipient).length, 1, "one conversation, not two");
    const [first] = await fx.engine.messages(r.thread_id!);
    const parsed = parseNotesMessage(first!.text)!;
    assert.deepEqual(parsed.notes.map((n) => [n.lines, n.instruction]), [[[7, 7], "make this bold"]]);
    const [shown] = await fx.app.conversations.messages(r.thread_id!);
    assert.deepEqual(shown!.notes, { path: PLAN, count: 1 }, "the owner sees a summary, not the plumbing");
  } finally {
    await fx.close();
  }
});

test("a note is applied when its marked text changed, answered when it did not", async () => {
  const fx = await makeVault();
  try {
    fx.app.notes.upsert({ client_key: "note-cccccccc", path: PLAN, tool: "select",
      anchor: { lines: [5, 5], quote: { exact: "Write copy" } }, instruction: "make this bold" });
    const r = await fx.app.notes.send({ path: PLAN, keys: ["note-cccccccc"], idempotency_key: "send-2" }, deliver(fx));
    await fx.settle();
    assert.match(readFileSync(join(fx.root, PLAN), "utf8"), /\*\*Write copy\*\*/);
    assert.equal(fx.app.notes.byKey("note-cccccccc")?.status, "applied");
    assert.ok(r.thread_id);

    // A note on a PDF cannot change it: the bot answers.
    writeFileSync(join(fx.root, "Resources/Scan.pdf"), "%PDF-1.4 fake");
    fx.app.scan();
    fx.app.notes.upsert({ client_key: "note-dddddddd", path: "Resources/Scan.pdf", tool: "pen", anchor: { page: 1, region: [0.1, 0.1, 0.2, 0.2] }, instruction: "what is this?" });
    await fx.app.notes.send({ path: "Resources/Scan.pdf", keys: ["note-dddddddd"], idempotency_key: "send-3" }, deliver(fx));
    await fx.settle();
    assert.equal(fx.app.notes.byKey("note-dddddddd")?.status, "answered");
  } finally {
    await fx.close();
  }
});

test("a failed run fails its notes with the reason", async () => {
  const fx = await makeVault();
  try {
    fx.app.notes.upsert({ client_key: "note-eeeeeeee", path: PLAN, tool: "select",
      anchor: { lines: [3, 3], quote: { exact: "Ship on March 14." } }, instruction: "shorten" });
    fx.engine.failNext = "usage limit reached";
    await fx.app.notes.send({ path: PLAN, keys: ["note-eeeeeeee"], idempotency_key: "send-4" }, deliver(fx));
    await fx.settle();
    const n = fx.app.notes.byKey("note-eeeeeeee")!;
    assert.equal(n.status, "failed");
    assert.equal(n.reason, "usage limit reached");
    assert.deepEqual(fx.app.notes.unresolved().map((x) => x.client_key), ["note-eeeeeeee"]);
  } finally {
    await fx.close();
  }
});
