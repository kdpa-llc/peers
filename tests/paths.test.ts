/** Path policy (CONTRACT_TESTS #1) and PARA detection. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkBotWrite, checkRead, normalize, PolicyError, rootKindOf } from "../src/vault/paths.ts";

test("PARA roots are recognised with numbered variants", () => {
  assert.equal(rootKindOf("Projects"), "projects");
  assert.equal(rootKindOf("1. Projects"), "projects");
  assert.equal(rootKindOf("01-Projects"), "projects");
  assert.equal(rootKindOf("2 Areas"), "areas");
  assert.equal(rootKindOf("4_Archives"), "archive");
  assert.equal(rootKindOf("inbox"), "inbox");
  assert.equal(rootKindOf("Projects old"), undefined);
});

test("normalize rejects traversal, hidden components, control characters and secrets (#1)", () => {
  assert.equal(normalize("/vault/Projects/A/x.md"), "Projects/A/x.md");
  assert.equal(normalize("Projects//A/./x.md"), "Projects/A/x.md");
  for (const bad of ["../x.md", "Projects/../../etc/passwd", "Projects/A/.bot.json", ".peers/vault.json",
    ".git/config", "a/.obsidian/x", "a\u0000b.md", "keys/server.pem", ".env", "a/.env.local", "creds/credentials.json"]) {
    assert.throws(() => normalize(bad), PolicyError, bad);
  }
  assert.throws(() => normalize(""), PolicyError);
  assert.equal(normalize("", { allowRoot: true }), "");
});

test("a symbolic link anywhere in a path is refused, even inside the vault (#1)", () => {
  const root = mkdtempSync(join(tmpdir(), "peers-paths-"));
  mkdirSync(join(root, "Projects", "A"), { recursive: true });
  mkdirSync(join(root, "Areas", "Finances"), { recursive: true });
  writeFileSync(join(root, "Areas", "Finances", "Budget.md"), "x");
  symlinkSync(join(root, "Areas", "Finances"), join(root, "Projects", "A", "alias"));
  symlinkSync(join(root, "Areas", "Finances", "Budget.md"), join(root, "Projects", "A", "budget.md"));
  assert.throws(() => checkRead(root, "Projects/A/alias/Budget.md"), PolicyError);
  assert.throws(() => checkRead(root, "Projects/A/budget.md"), PolicyError);
  assert.equal(checkRead(root, "Areas/Finances/Budget.md"), "Areas/Finances/Budget.md");
  // A path that does not exist yet is fine as long as its existing parents are real folders.
  assert.equal(checkRead(root, "Projects/A/new/page.md"), "Projects/A/new/page.md");
});

test("bots write only text pages", () => {
  const root = mkdtempSync(join(tmpdir(), "peers-paths-"));
  assert.equal(checkBotWrite(root, "A/page.md"), "A/page.md");
  assert.equal(checkBotWrite(root, "A/data.csv"), "A/data.csv");
  for (const bad of ["A/page.html", "A/script.js", "A/image.png", "A/doc.pdf", "A/noext"]) {
    assert.throws(() => checkBotWrite(root, bad), PolicyError, bad);
  }
});
