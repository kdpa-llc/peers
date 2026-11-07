/** Folder agents and layouts (ADR 0005): any folder or page can have an agent; PARA is a preset. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { frontPage, isFrontPage, matches, suggestLayout } from "../src/vault/layout.ts";
import { makeVault, writeFiles } from "./helpers.ts";

test("path patterns: * stays in one folder, ** goes any depth", () => {
  const cases: [string, string, boolean][] = [
    ["Projects/*", "Projects/Alpha", true], ["Projects/*", "Projects/Alpha/notes", false],
    ["projects/*.org", "projects/job.org", true], ["projects/*.org", "projects/sub/job.org", false],
    ["Archive/**", "Archive", true], ["Archive/**", "Archive/x/y.md", true], ["Archive/**", "Archived", false],
    ["**/drafts", "a/b/drafts", true], ["a/**/b", "a/b", true], ["a/**/b", "a/x/y/b", true],
  ];
  for (const [pat, path, want] of cases) assert.equal(matches(path, pat), want, `${pat} ~ ${path}`);
});

test("a PARA vault is recognised; an Org repo's generated, source and tool folders are handled", () => {
  const para = mkdtempSync(join(tmpdir(), "peers-layout-"));
  writeFiles(para, { "1. Projects/A/x.md": "", "2. Areas/B/y.md": "", "Inbox/z.md": "", "AGENTS.md": "# Rules\n" });
  const l = suggestLayout(para);
  assert.equal(l.preset, "para");
  assert.ok(l.agents.includes("1. Projects/*") && l.agents.includes("2. Areas/*.org"));
  assert.deepEqual([l.inbox, l.archive, l.paused, l.rules], ["Inbox", "Archive", ["Archive/**"], ["AGENTS.md"]]);

  const org = mkdtempSync(join(tmpdir(), "peers-layout-"));
  writeFiles(org, {
    "projects/projects.org": "#+TITLE: Projects\n", "projects/job-search.org": "#+TITLE: Job search\n",
    "areas/finance.org": "#+TITLE: Finance\n", "archive/old.org": "* DONE old\n", "inbox.org": "* capture\n",
    "views/README.md": "# Views — generated projections. DO NOT HAND-EDIT.\n", "views/gtd.org": "* GTD\n",
    "raw/chat/a.md": "x", "scripts/build.py": "print()", "resources/para.org": "* PARA\n",
  });
  const o = suggestLayout(org);
  assert.equal(o.preset, "para");
  assert.equal(o.inbox, "inbox.org");
  assert.equal(o.archive, "archive");
  assert.deepEqual(o.readonly, ["views/**"]);
  assert.deepEqual(o.hidden.sort(), ["raw", "scripts"]);

  const plain = mkdtempSync(join(tmpdir(), "peers-layout-"));
  writeFiles(plain, { "Clients/acme.md": "", "Courses/ml.md": "", "node_modules/x/y.js": "" });
  const p = suggestLayout(plain);
  assert.equal(p.preset, "folders");
  assert.deepEqual(p.agents, ["Clients", "Courses"]);
});

test("front pages: index, README, main, Overview or the folder note; they never become agents", () => {
  const root = mkdtempSync(join(tmpdir(), "peers-front-"));
  writeFiles(root, { "A/README.md": "", "A/notes.md": "", "B/B.org": "", "C/plan.md": "" });
  assert.equal(frontPage(root, "A"), "A/README.md");
  assert.equal(frontPage(root, "B"), "B/B.org");
  assert.equal(frontPage(root, "C"), undefined);
  assert.ok(isFrontPage("projects/projects.org") && isFrontPage("x/index.md") && !isFrontPage("projects/job.org"));
});

const ORG_REPO = {
  "projects/projects.org": "#+TITLE: Projects\n- [[file:job-search-2026.org][Job search]]\n",
  "projects/job-search-2026.org": "#+TITLE: Job Search / Career Evidence (figure-out-next-steps)\n* NEXT Update the résumé\n",
  "projects/job-search-2026/cv.md": "# CV\n",
  "projects/kitchen.org": "#+TITLE: Kitchen\n",
  "areas/areas.org": "#+TITLE: Areas\n",
  "areas/finance.org": "#+TITLE: Finance\n",
  "archive/old-trip.org": "* DONE Trip\n",
  "resources/para-method.org": "* PARA\n",
  "views/README.md": "Generated. DO NOT HAND-EDIT.\n",
  "views/gtd.org": "* Board\n",
  "raw/chat/one.md": "x",
  "scripts/validate.py": "print()",
  "inbox.org": "* Capture\n",
};

test("an Org repo where each project is one file: page agents, ownership, names, hidden and generated parts", async () => {
  const fx = await makeVault({ files: ORG_REPO });
  try {
    const r = fx.app.registry;
    const paths = r.list().map((b) => [b.kind, b.path]).sort();
    assert.deepEqual(paths, [
      ["page", "archive/old-trip.org"], ["page", "areas/finance.org"], ["page", "projects/job-search-2026.org"],
      ["page", "projects/kitchen.org"], ["vault", ""],
    ], "registries (projects.org, areas.org) are front pages, not agents");
    const job = r.byPath("projects/job-search-2026.org")!;
    assert.equal(job.def.name, "Job search 2026", "a long title gives way to the file name");
    assert.equal(r.byPath("projects/kitchen.org")!.def.name, "Kitchen");
    assert.equal(r.ownerOf("projects/job-search-2026.org").def.id, job.def.id);
    assert.equal(r.ownerOf("projects/job-search-2026/cv.md").def.id, job.def.id, "the page's folder of attachments is its too");
    assert.equal(r.ownerOf("resources/para-method.org").kind, "vault");
    assert.equal(r.ownerOf("archive/old-trip.org").kind, "vault", "a paused agent does not answer");
    assert.equal(r.byPath("archive/old-trip.org")!.archived, true);
    assert.ok(r.mayWrite(job, "projects/job-search-2026/cv.md") && !r.mayWrite(job, "areas/finance.org"));
    const view = fx.app.treeView() as { tree: { children: { path: string }[] }; readonly: string[]; fronts: Record<string, string>; inbox: string };
    assert.ok(!view.tree.children.some((c) => c.path === "raw" || c.path === "scripts"), "hidden from the tree");
    assert.deepEqual(view.readonly, ["views"]);
    assert.equal(view.fronts.projects, "projects/projects.org");
    assert.equal(view.inbox, "inbox.org");
    assert.equal((fx.app.readFile("views/gtd.org") as { readonly?: boolean }).readonly, true);
    const brief = fx.app.conversations.briefFor(job);
    assert.match(brief, /You look after the page projects\/job-search-2026\.org/);
    assert.match(brief, /Never edit generated content \(views\/\*\*\)/);
  } finally {
    await fx.close();
  }
});

test("any folder or page can be given an agent, and lose it; archive and restore move it", async () => {
  const fx = await makeVault();
  try {
    // Resources has no agents in the PARA preset; give one folder an agent by hand.
    writeFileSync(join(fx.root, "Resources/Recipes.md"), "# Recipes\n");
    const added = fx.app.addAgent("Resources") as { id: string; path: string; kind: string };
    assert.deepEqual([added.path, added.kind], ["Resources", "folder"]);
    assert.equal(fx.app.registry.ownerOf("Resources/Ref.md").def.id, added.id);
    assert.ok(fx.app.layout.agents.includes("Resources"));
    // Take away an agent a pattern gave: it is excluded, and comes back with the same id.
    const alpha = fx.app.registry.byPath("Projects/Alpha")!.def.id;
    fx.app.removeAgent(alpha);
    assert.equal(fx.app.registry.byPath("Projects/Alpha"), undefined);
    assert.ok(fx.app.layout.exclude.includes("Projects/Alpha"));
    const again = fx.app.addAgent("Projects/Alpha") as { id: string };
    assert.equal(again.id, alpha, "memory and conversations come back with it");
    // Archive moves it into the layout's archive and pauses it; restore puts it back.
    const moved = fx.app.archive("Projects/Beta") as { folder: string };
    assert.equal(moved.folder, "Archive/Beta");
    const beta = fx.app.registry.byPath("Archive/Beta")!;
    assert.equal(beta.archived, true);
    assert.equal(fx.app.restore("Archive/Beta").folder, "Projects/Beta");
    assert.equal(fx.app.registry.byPath("Projects/Beta")!.def.id, beta.def.id);
    assert.throws(() => fx.app.addAgent("Projects/Alpha/Plan.md/../x"), /path|parent/i);
  } finally {
    await fx.close();
  }
});

test("a page agent's page and attachments move together; a folder moved outside Peers is found again", async () => {
  const fx = await makeVault({ files: ORG_REPO });
  try {
    const job = fx.app.registry.byPath("projects/job-search-2026.org")!;
    fx.app.archive("projects/job-search-2026.org");
    assert.ok(existsSync(join(fx.root, "archive/job-search-2026.org")) && existsSync(join(fx.root, "archive/job-search-2026/cv.md")));
    assert.equal(fx.app.registry.byPath("archive/job-search-2026.org")!.def.id, job.def.id);
    fx.app.restore("archive/job-search-2026.org");
    assert.equal(fx.app.registry.byPath("projects/job-search-2026.org")!.def.id, job.def.id);
  } finally {
    await fx.close();
  }
  const md = await makeVault();
  try {
    const alpha = md.app.registry.byPath("Projects/Alpha")!.def.id;
    // Renamed in Finder: the agent follows by name only if unambiguous; a moved folder keeps its name.
    const { renameSync, mkdirSync } = await import("node:fs");
    mkdirSync(join(md.root, "Areas/Moved"), { recursive: true });
    renameSync(join(md.root, "Projects/Alpha"), join(md.root, "Areas/Alpha"));
    md.app.registry.sync();
    assert.equal(md.app.registry.byPath("Areas/Alpha")!.def.id, alpha, "found again by its name");
  } finally {
    await md.close();
  }
});

test("editing .peers/layout.json on disk takes effect; a broken one is reported and the old one kept", async () => {
  const fx = await makeVault();
  try {
    const file = join(fx.root, ".peers/layout.json");
    const layout = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify({ ...layout, agents: [...layout.agents, "Resources"] }));
    fx.watcher.emit(".peers/layout.json");
    assert.ok(fx.app.registry.byPath("Resources"));
    writeFileSync(file, "{ not json");
    fx.watcher.emit(".peers/layout.json");
    assert.ok(fx.app.registry.byPath("Resources"), "the last good layout stays in use");
    const today = fx.app.today() as { needs_you: { invalid: { folder: string }[] } };
    assert.ok(today.needs_you.invalid.some((i) => i.folder === ".peers/layout.json"));
  } finally {
    await fx.close();
  }
});
