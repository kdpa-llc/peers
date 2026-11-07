/** Org pages (Emacs vaults): parsing, links, tasks, and notes anchored in Org source. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { plainText, type MdBlock } from "../src/vault/markdown.ts";
import { orgLinkTarget, orgTasks, parseOrg, parseOrgInline } from "../src/vault/org.ts";
import { locate } from "../src/vault/annotations.ts";
import { makeVault } from "./helpers.ts";

const PROJECT = `#+TITLE: Kitchen Renovation
#+FILETAGS: :project:home:
#+TODO: TODO NEXT WAITING | DONE CANCELLED

* NEXT [#A] Confirm the cabinet order :vendor:
SCHEDULED: <2026-11-09 Mon> DEADLINE: <2026-11-13 Fri>
:PROPERTIES:
:TID: T171
:CREATED: [2026-09-16]
:END:
Call the supplier about the *walnut* finish; see [[file:../resources/suppliers.org][supplier list]].

** WAITING Quote from the electrician
** DONE Measure the wall

* Budget
| Item     | Cost  |
|----------+-------|
| Cabinets | 9,000 |
| Oven     | 2,400 |

- [X] Pick the tiles
- [ ] Book the plumber
- Lead time :: six weeks

#+BEGIN_SRC python
print("hi")
#+END_SRC

: fixed width line
# a comment
-----
Plain text with /emphasis/, =verbatim=, ~code~ and +old+ words, https://example.com/x.
`;

const kinds = (blocks: MdBlock[]): string[] => blocks.map((b) => b.t);

test("an Org page parses into the same blocks as Markdown, with its title, tags and tasks", () => {
  const doc = parseOrg(PROJECT);
  assert.equal(doc.title, "Kitchen Renovation");
  assert.deepEqual(doc.tags, ["project", "home"]);
  assert.deepEqual(kinds(doc.blocks), [
    "frontmatter", "heading", "planning", "drawer", "para", "heading", "heading", "heading", "table", "list", "code", "code", "hr", "para",
  ]);
  const h = doc.blocks[1] as Extract<MdBlock, { t: "heading" }>;
  assert.deepEqual([h.level, h.todo, h.done, h.priority, h.tags, plainText(h.c)], [1, "NEXT", false, "A", ["vendor"], "Confirm the cabinet order"]);
  assert.deepEqual(h.line, [5, 5]);
  const planning = doc.blocks[2] as Extract<MdBlock, { t: "planning" }>;
  assert.deepEqual(planning.items, [{ kind: "SCHEDULED", date: "2026-11-09 Mon" }, { kind: "DEADLINE", date: "2026-11-13 Fri" }]);
  const drawer = doc.blocks[3] as Extract<MdBlock, { t: "drawer" }>;
  assert.deepEqual([drawer.name, drawer.props[0], drawer.line], ["PROPERTIES", ["TID", "T171"], [7, 10]]);
  const table = doc.blocks[8] as Extract<MdBlock, { t: "table" }>;
  assert.equal(plainText(table.head[1]!), "Cost");
  assert.equal(table.rows.length, 2);
  const list = doc.blocks[9] as Extract<MdBlock, { t: "list" }>;
  assert.deepEqual(list.items.map((i) => i.task), [true, false, null]);
  assert.equal(plainText((list.items[2]!.c[0] as Extract<MdBlock, { t: "para" }>).c), "Lead time — six weeks");
  assert.equal((doc.blocks[10] as Extract<MdBlock, { t: "code" }>).lang, "python");
  assert.deepEqual(orgTasks(PROJECT).map((t) => [t.todo, t.done]), [["NEXT", false], ["WAITING", false], ["DONE", true]]);
});

test("Org inline markup and links", () => {
  const nodes = parseOrgInline("A *bold* /em/ =v= ~c~ +del+ [[file:../a b.org][the plan]] [[https://x.dev][site]] [[id:123][x]] [[file:pic.png]]");
  assert.deepEqual(nodes.filter((n) => n.t !== "text").map((n) => n.t), ["strong", "em", "code", "code", "del", "link", "link", "img"]);
  const link = nodes.find((n) => n.t === "link") as { href: string; kind: string };
  assert.deepEqual([link.href, link.kind], ["../a b.org", "vault"]);
  assert.ok(nodes.some((n) => n.t === "text" && n.v.includes("x")), "id: links show their label, not a link");
  assert.equal(orgLinkTarget("javascript:alert(1)"), undefined, "unknown schemes are never followed");
  assert.equal(orgLinkTarget("file:/etc/passwd"), undefined, "absolute file links are not vault links");
  assert.deepEqual(parseOrgInline("2026/11/09 and a/b paths"), [{ t: "text", v: "2026/11/09 and a/b paths" }], "slashes in text are not emphasis");
});

test("a quote from a rendered Org page anchors to its source lines", () => {
  assert.deepEqual(locate(PROJECT, { exact: "Call the supplier about the walnut finish; see supplier list." }, "org"), [11, 11]);
  assert.deepEqual(locate(PROJECT, { exact: "Book the plumber" }, "org"), [23, 23]);
  assert.deepEqual(locate(PROJECT, { exact: "Confirm the cabinet order" }, "org"), [5, 5]);
  assert.deepEqual(locate(PROJECT, { exact: "Plain text with emphasis, verbatim, code and old words" }, "org"), [33, 33]);
});

test("notes on an Org page are sent with their Org lines and applied", async () => {
  const fx = await makeVault({ files: { "Projects/Kitchen/Plan.org": PROJECT } });
  try {
    const page = fx.app.readFile("Projects/Kitchen/Plan.org") as { kind: string; hash: string };
    assert.equal(page.kind, "page");
    fx.app.notes.upsert({ client_key: "note-org-0001", path: "Projects/Kitchen/Plan.org", tool: "select", doc_blob: page.hash,
      anchor: { quote: { exact: "Book the plumber" } }, instruction: "make this bold" });
    const r = await fx.app.notes.send({ path: "Projects/Kitchen/Plan.org", keys: ["note-org-0001"], idempotency_key: "org-1" },
      (bot, text, title) => fx.app.conversations.start(bot, text, { origin: "notes", title }));
    assert.deepEqual(r.sent[0]!.anchor?.lines, [23, 23]);
    await fx.settle();
    assert.match(readFileSync(join(fx.root, "Projects/Kitchen/Plan.org"), "utf8").split("\n")[22]!, /^- \[ \] \*Book the plumber\*$/, "bold the Org way");
    assert.equal(fx.app.notes.byKey("note-org-0001")?.status, "applied");
    // Search finds text in Org pages too.
    writeFileSync(join(fx.root, "Projects/Kitchen/Notes.org"), "* Grout colour\nWarm grey.\n");
    fx.app.scan();
    assert.ok(fx.app.search("warm grey").some((x) => x.path === "Projects/Kitchen/Notes.org"));
  } finally {
    await fx.close();
  }
});
