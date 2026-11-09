/** Conversations with bots: several per bot, briefs, unread, @mentions, transcripts (ADR 0003). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { botFor, makeVault } from "./helpers.ts";

test("each message without a conversation starts a new one; replies land in the right one", async () => {
  const fx = await makeVault();
  try {
    const alpha = botFor(fx.app, "Projects/Alpha");
    const a = await fx.app.send({ botId: alpha, text: "What is the launch date?" });
    const b = await fx.app.send({ botId: alpha, text: "Draft a launch email" });
    assert.notEqual(a.thread_id, b.thread_id);
    await fx.app.send({ botId: alpha, threadId: a.thread_id, text: "And the backup date?" });
    await fx.settle();
    const threads = fx.app.conversations.list(alpha);
    assert.equal(threads.length, 2);
    assert.deepEqual(threads.map((t) => t.title).sort(), ["Draft a launch email", "What is the launch date?"]);
    const msgs = await fx.app.conversations.messages(a.thread_id);
    assert.deepEqual(msgs.map((m) => m.role), ["owner", "bot", "owner", "bot"]);
    assert.equal(msgs[0]!.text, "What is the launch date?", "the brief is hidden");
    const raw = await fx.engine.messages(a.thread_id);
    assert.match(raw[0]!.text, /^\[\[peers:brief\]\]/, "the first message carries the brief");
    assert.doesNotMatch(raw[2]!.text, /peers:brief/, "later messages do not");
    await assert.rejects(fx.app.send({ botId: botFor(fx.app, "Projects/Beta"), threadId: a.thread_id, text: "x" }), /another agent/);
  } finally {
    await fx.close();
  }
});

test("a reply is unread until the owner opens the conversation", async () => {
  const fx = await makeVault();
  try {
    const alpha = botFor(fx.app, "Projects/Alpha");
    const { thread_id } = await fx.app.send({ botId: alpha, text: "Hello" });
    fx.clock.advance!(1000);
    await fx.settle();
    assert.equal(fx.app.conversations.view(thread_id)!.unread, true);
    assert.equal(fx.app.botStatus(fx.app.requireBot(alpha)).unread, 1);
    const today = fx.app.today() as { needs_you: { replies: { thread_id: string }[] } };
    assert.deepEqual(today.needs_you.replies.map((r) => r.thread_id), [thread_id]);
    fx.clock.advance!(1000);
    fx.app.conversations.markRead(thread_id);
    assert.equal(fx.app.conversations.view(thread_id)!.unread, false);
  } finally {
    await fx.close();
  }
});

test("@Name sends the message to that bot too, as a new conversation that links back", async () => {
  const fx = await makeVault();
  try {
    const alpha = botFor(fx.app, "Projects/Alpha");
    const finances = botFor(fx.app, "Areas/Finances");
    const r = await fx.app.send({ botId: alpha, text: "@Finances can we afford the launch party?", context: { path: "Projects/Alpha/Plan.md" } });
    assert.deepEqual(r.mentioned.map((m) => m.bot_id), [finances]);
    const theirs = fx.app.conversations.view(r.mentioned[0]!.thread_id)!;
    assert.equal(theirs.bot_id, finances);
    assert.equal(theirs.origin, "mention");
    assert.equal(theirs.from_thread, r.thread_id);
    await fx.settle();
    const [first] = await fx.app.conversations.messages(theirs.id);
    assert.equal(first!.text, "@Finances can we afford the launch party?");
    assert.match(first!.context!, /from the Alpha chat/);
    assert.equal(fx.app.conversations.list(alpha).length, 1, "the sender's own bot keeps its copy");
    const [own] = await fx.app.conversations.messages(r.thread_id);
    assert.match(own!.context!, /also went to Finances, who will answer it/, "and is told not to answer for Finances");
    const self = await fx.app.send({ botId: alpha, text: "@Alpha talking to myself" });
    assert.equal(self.mentioned.length, 0, "mentioning the bot you are talking to sends once");
  } finally {
    await fx.close();
  }
});

test("finished conversations are saved as text for other bots to read", async () => {
  const fx = await makeVault();
  try {
    const alpha = botFor(fx.app, "Projects/Alpha");
    const { thread_id } = await fx.app.send({ botId: alpha, text: "Summarise the plan" });
    await fx.settle();
    await new Promise((r) => setTimeout(r, 20));
    const dir = join(fx.app.conversations.transcriptsDir, "Alpha");
    const files = readdirSync(dir);
    assert.equal(files.length, 1);
    assert.match(files[0]!, new RegExp(`\\(${thread_id.slice(0, 8)}\\)\\.md$`));
    const text = readFileSync(join(dir, files[0]!), "utf8");
    assert.match(text, /Summarise the plan/);
    assert.doesNotMatch(text, /peers:brief/);
    const brief = fx.app.conversations.briefFor(fx.app.requireBot(alpha));
    assert.match(brief, new RegExp(fx.app.conversations.transcriptsDir.replace(/[/\\^$.*+?()[\]{}|]/g, "\\$&")));
  } finally {
    await fx.close();
  }
});

test("memory is a file in .peers/agents; 'remember' adds a line", async () => {
  const fx = await makeVault();
  try {
    const alpha = botFor(fx.app, "Projects/Alpha");
    assert.equal(fx.app.memory(alpha).text, "");
    await fx.app.send({ botId: alpha, text: "Remember that the launch is invite-only" });
    await fx.settle();
    assert.match(fx.app.memory(alpha).text, /- the launch is invite-only/);
    assert.ok(existsSync(join(fx.root, `.peers/agents/${alpha}.memory.md`)), "memory lives in .peers/agents");
    fx.app.saveMemory(alpha, "# Memory\n");
    assert.equal(fx.app.memory(alpha).text, "# Memory\n");
  } finally {
    await fx.close();
  }
});

test("stopping a bot interrupts its running conversations; a failed run shows on Today", async () => {
  const fx = await makeVault();
  try {
    const alpha = botFor(fx.app, "Projects/Alpha");
    const { thread_id } = await fx.app.send({ botId: alpha, text: "Long job" });
    assert.equal(fx.app.conversations.stateOf(alpha), "working");
    assert.equal(await fx.app.conversations.stopBot(alpha), 1);
    assert.equal(fx.app.conversations.view(thread_id)!.state, "idle");
    await fx.settle();
    fx.engine.failNext = "usage limit reached";
    const failed = await fx.app.send({ botId: alpha, text: "Another" });
    await fx.settle();
    const today = fx.app.today() as { needs_you: { failures: { thread_id: string; detail: string }[] } };
    assert.deepEqual(today.needs_you.failures.map((f) => [f.thread_id, f.detail]), [[failed.thread_id, "usage limit reached"]]);
  } finally {
    await fx.close();
  }
});
