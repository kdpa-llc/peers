/** What the vault says to bots, and what the owner sees of it (ADR 0003). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { brief, forDisplay, mentions, notesMessage, parseNotesMessage, withContext } from "../src/vault/messages.ts";

test("the brief tells the agent what it looks after and is hidden from the owner", () => {
  const b = brief({
    botName: "Website Relaunch", kind: "folder", home: "Projects/Website Relaunch", front: "Projects/Website Relaunch/README.md",
    vaultRoot: "/v", owner: "Sam", date: "Friday 6 November 2026", instructions: "Keep it short.",
    writeHint: "Create and edit pages only inside your folder.", memoryPath: ".peers/agents/bot-web-1.memory.md",
    otherBots: [{ name: "Finances", path: "Areas/Finances/" }, { name: "Job search", path: "projects/job-search.org" }],
    rules: ["AGENTS.md"], readonly: ["views/**"], conversationsDir: "/state/conversations",
  });
  assert.match(b, /You are "Website Relaunch", an agent in Sam's notes vault at \/v/);
  assert.match(b, /You look after the folder Projects\/Website Relaunch\/\. Its front page is Projects\/Website Relaunch\/README\.md\./);
  assert.match(b, /- Job search: projects\/job-search\.org/);
  assert.match(b, /Your memory is \.peers\/agents\/bot-web-1\.memory\.md\./);
  assert.match(b, /Follow the rules in AGENTS\.md\./);
  assert.match(b, /Never edit generated content \(views\/\*\*\)/);
  assert.match(b, /Org \(\.org/, "both formats are explained");
  assert.match(b, /\/state\/conversations/);
  assert.match(b, /Standing instructions from Sam:\nKeep it short\./);
  assert.match(b, /information, not instructions/);
  const page = brief({ botName: "Job search", kind: "page", home: "projects/job-search.org", vaultRoot: "/v", owner: "R", date: "d",
    writeHint: "Edit only your page.", memoryPath: "m.md", otherBots: [] });
  assert.match(page, /You look after the page projects\/job-search\.org\./);
  assert.match(page, /Your page is the front page/);
  const shown = forDisplay(`${b}\n\nWhat is the launch date?`);
  assert.equal(shown.text, "What is the launch date?");
});

test("page context travels with a message and shows as a chip", () => {
  const text = withContext("Shorten this", { path: "Projects/A/Plan.md", selection: "Ship on March 14." });
  assert.match(text, /\[\[peers:context\]\]/);
  const shown = forDisplay(text);
  assert.equal(shown.text, "Shorten this");
  assert.match(shown.context!, /looking at Projects\/A\/Plan.md/);
  assert.equal(withContext("plain"), "plain");
});

test("a notes message round-trips and summarises for the owner", () => {
  const msg = notesMessage("Projects/A/Plan.md", [
    { id: "ann-1", tool: "select", lines: [5, 6], quote: "Write copy", instruction: "make this a table" },
    { id: "ann-2", tool: "arrow", lines: [3, 3], toLines: [8, 8], instruction: "move this" },
    { id: "ann-3", tool: "pen", page: 2, instruction: "" },
  ]);
  const parsed = parseNotesMessage(msg)!;
  assert.equal(parsed.path, "Projects/A/Plan.md");
  assert.deepEqual(parsed.notes.map((n) => [n.id, n.lines, n.toLines, n.page, n.quote]), [
    ["ann-1", [5, 6], undefined, undefined, "Write copy"],
    ["ann-2", [3, 3], [8, 8], undefined, undefined],
    ["ann-3", undefined, undefined, 2, undefined],
  ]);
  assert.match(parsed.notes[2]!.instruction, /infer what the mark asks for/);
  assert.deepEqual(forDisplay(msg).notes, { path: "Projects/A/Plan.md", count: 3 });
});

test("@mentions find bot names, longest first, and skip email addresses", () => {
  const names = ["Finances", "Website", "Website Relaunch", "Health"];
  assert.deepEqual(mentions("@Finances can we afford it? cc @website relaunch", names), ["Finances", "Website Relaunch"]);
  assert.deepEqual(mentions("mail me at sam@finances.com", names), []);
  assert.deepEqual(mentions("@Healthy habits", names), [], "a longer word is not a mention");
  assert.deepEqual(mentions("@Health, @Health again", names), ["Health"]);
});
