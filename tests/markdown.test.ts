/**
 * The vault markdown parser. Pages are bot-written and therefore untrusted, so beyond
 * rendering the common syntax these tests pin the safety rule: nothing in a page becomes
 * markup or an executable link (CONTRACT_TESTS #3).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyHref, numberLines, parseInline, parseMarkdown, plainText, type MdBlock,
} from "../src/vault/markdown.ts";

const blocks = (src: string): MdBlock[] => parseMarkdown(src).blocks;

test("headings, paragraphs and line ranges", () => {
  const doc = parseMarkdown("# Launch plan\n\nFirst line\nsecond line\n\n## Milestones\n");
  assert.equal(doc.title, "Launch plan");
  assert.deepEqual(doc.blocks.map((b) => [b.t, b.line]), [
    ["heading", [1, 1]], ["para", [3, 4]], ["heading", [6, 6]],
  ]);
  const h2 = doc.blocks[2]!;
  assert.ok(h2.t === "heading" && h2.level === 2 && h2.id === "milestones");
});

test("setext headings and duplicate heading ids", () => {
  const b = blocks("Title\n=====\n\n# Notes\n# Notes");
  assert.ok(b[0]!.t === "heading" && b[0]!.level === 1);
  assert.deepEqual(b[0]!.line, [1, 2]);
  assert.ok(b[1]!.t === "heading" && b[2]!.t === "heading");
  if (b[1]!.t === "heading" && b[2]!.t === "heading") {
    assert.equal(b[1]!.id, "notes");
    assert.equal(b[2]!.id, "notes-1");
  }
});

test("front matter becomes properties", () => {
  const b = blocks("---\nstatus: active\ntags:\n  - a\n  - b\n---\n# T");
  assert.equal(b[0]!.t, "frontmatter");
  if (b[0]!.t === "frontmatter") {
    assert.deepEqual(b[0]!.props, [["status", "active"], ["tags", "a, b"]]);
    assert.deepEqual(b[0]!.line, [1, 6]);
  }
});

test("fenced code keeps content verbatim, including HTML", () => {
  const b = blocks("```js\n<script>alert(1)</script>\n```");
  assert.deepEqual(b, [{ t: "code", lang: "js", v: "<script>alert(1)</script>", line: [1, 3] }]);
});

test("unterminated fence runs to the end of the page", () => {
  const b = blocks("```\nopen");
  assert.equal(b[0]!.t, "code");
  assert.deepEqual(b[0]!.line, [1, 2]);
});

test("lists: nesting, tasks, ordered start and line ranges", () => {
  const src = [
    "- [x] Copy freeze",
    "- [ ] QA pass",
    "  - phone",
    "  - tablet",
    "- plain",
    "",
    "3. three",
    "4. four",
  ].join("\n");
  const b = blocks(src);
  assert.equal(b.length, 2);
  const ul = b[0]!;
  assert.ok(ul.t === "list" && !ul.ordered);
  if (ul.t === "list") {
    assert.deepEqual(ul.items.map((i) => i.task), [true, false, null]);
    assert.deepEqual(ul.line, [1, 5]);
    assert.deepEqual(ul.items[1]!.line, [2, 4]);
    const nested = ul.items[1]!.c[1]!;
    assert.ok(nested.t === "list" && nested.items.length === 2);
    assert.deepEqual(nested.line, [3, 4]);
  }
  const ol = b[1]!;
  assert.ok(ol.t === "list" && ol.ordered && ol.start === 3 && ol.items.length === 2);
});

test("loose list items separated by blank lines stay one list", () => {
  const b = blocks("- one\n\n- two\n\n- three");
  assert.equal(b.length, 1);
  assert.ok(b[0]!.t === "list" && b[0]!.items.length === 3);
});

test("a year at the start of a paragraph line is not a list", () => {
  const b = blocks("Plans for\n2026. A good year");
  assert.equal(b.length, 1);
  assert.equal(b[0]!.t, "para");
});

test("block quotes and Obsidian callouts", () => {
  const b = blocks("> [!warning]- Watch out\n> Budget is tight\n\n> plain quote");
  assert.ok(b[0]!.t === "callout");
  if (b[0]!.t === "callout") {
    assert.equal(b[0]!.kind, "warning");
    assert.equal(b[0]!.fold, "-");
    assert.equal(plainText(b[0]!.title), "Watch out");
    assert.deepEqual(b[0]!.c[0]!.line, [2, 2]);
  }
  assert.equal(b[1]!.t, "quote");
});

test("GFM tables with alignment and escaped pipes", () => {
  const b = blocks("| Milestone | Due |\n| :-- | --: |\n| QA \\| sign-off | Mar 11 |\n| Go live | Mar 14 |");
  assert.ok(b[0]!.t === "table");
  if (b[0]!.t === "table") {
    assert.deepEqual(b[0]!.align, ["left", "right"]);
    assert.equal(b[0]!.rows.length, 2);
    assert.equal(plainText(b[0]!.rows[0]![0]!), "QA | sign-off");
    assert.deepEqual(b[0]!.line, [1, 4]);
  }
});

test("thematic break versus list", () => {
  assert.equal(blocks("---")[0]!.t, "hr");
  assert.equal(blocks("* * *")[0]!.t, "hr");
});

test("inline emphasis family", () => {
  assert.deepEqual(parseInline("**bold** and *it* and ~~gone~~ and ==hi=="), [
    { t: "strong", c: [{ t: "text", v: "bold" }] },
    { t: "text", v: " and " },
    { t: "em", c: [{ t: "text", v: "it" }] },
    { t: "text", v: " and " },
    { t: "del", c: [{ t: "text", v: "gone" }] },
    { t: "text", v: " and " },
    { t: "mark", c: [{ t: "text", v: "hi" }] },
  ]);
  assert.deepEqual(parseInline("snake_case_name"), [{ t: "text", v: "snake_case_name" }]);
  assert.deepEqual(parseInline("2 * 3 * 4"), [{ t: "text", v: "2 * 3 * 4" }]);
});

test("code spans protect their content", () => {
  assert.deepEqual(parseInline("run `a *b* c` now"), [
    { t: "text", v: "run " }, { t: "code", v: "a *b* c" }, { t: "text", v: " now" },
  ]);
});

test("wikilinks, embeds and tags", () => {
  assert.deepEqual(parseInline("see [[Launch plan#Dates|dates]] ![[chart.png]] #launch/q1"), [
    { t: "text", v: "see " },
    { t: "wikilink", target: "Launch plan", heading: "Dates", label: "dates" },
    { t: "text", v: " " },
    { t: "embed", target: "chart.png" },
    { t: "text", v: " " },
    { t: "tag", v: "launch/q1" },
  ]);
  assert.deepEqual(parseInline("issue #12 is not a tag but #ok is")[1], { t: "tag", v: "ok" });
});

test("links and images are classified; unsafe schemes become text", () => {
  assert.deepEqual(parseInline("[site](https://example.com)"), [
    { t: "link", href: "https://example.com", kind: "url", c: [{ t: "text", v: "site" }] },
  ]);
  assert.deepEqual(parseInline("[x](javascript:alert(1))"), [{ t: "text", v: "x" }]);
  assert.deepEqual(parseInline("[x](JaVaScRiPt:alert(1))"), [{ t: "text", v: "x" }]);
  assert.deepEqual(parseInline("![pic](data:image/png;base64,AAAA)"), [{ t: "text", v: "pic" }]);
  assert.deepEqual(parseInline("![pic](images/a.png)"), [
    { t: "img", src: "images/a.png", kind: "vault", alt: "pic" },
  ]);
  assert.deepEqual(parseInline("[top](#dates)")[0], {
    t: "link", href: "#dates", kind: "anchor", c: [{ t: "text", v: "top" }],
  });
  for (const href of ["vbscript:x", "file:///etc/passwd", "//evil.example/x", "java\tscript:x"]) {
    assert.equal(classifyHref(href), "unsafe", href);
  }
});

test("bare URLs and autolinks", () => {
  const n = parseInline("Go to https://example.com/a_(b). Or <mailto:me@example.com>");
  assert.deepEqual(n[1], {
    t: "link", href: "https://example.com/a_(b)", kind: "url",
    c: [{ t: "text", v: "https://example.com/a_(b)" }],
  });
  assert.ok(n.some((x) => x.t === "link" && x.href === "mailto:me@example.com"));
});

test("raw HTML stays literal text everywhere", () => {
  const b = blocks('<img src=x onerror="alert(1)">\n\n<script>x</script> **b**');
  assert.equal(b[0]!.t, "para");
  if (b[0]!.t === "para") {
    assert.deepEqual(b[0]!.c, [{ t: "text", v: '<img src=x onerror="alert(1)">' }]);
  }
  const json = JSON.stringify(b);
  assert.ok(!json.includes('"t":"html"'));
});

test("hard breaks from trailing spaces and backslashes", () => {
  assert.deepEqual(parseInline("a  \nb\\\nc"), [
    { t: "text", v: "a" }, { t: "br" }, { t: "text", v: "b" }, { t: "br" }, { t: "text", v: "c" },
  ]);
});

test("numberLines shows the lines a bot edits", () => {
  assert.equal(numberLines("a\nb\nc", 2, 3), "2│ b\n3│ c");
});

test("parser handles hostile input without throwing", () => {
  const nasty = ["[".repeat(5000), "*".repeat(5000), "`".repeat(3000), "> ".repeat(2000) + "x",
    "- ".repeat(500) + "x", "|".repeat(1000) + "\n|---|"].join("\n\n");
  const started = Date.now();
  parseMarkdown(nasty);
  assert.ok(Date.now() - started < 2000, "parse should stay fast on hostile input");
});
