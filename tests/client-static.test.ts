/**
 * CONTRACT_TESTS #3: the web client never parses vault content as HTML. Checked by
 * scanning the client source for every API that turns a string into markup or code.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const WEB = join(import.meta.dirname, "..", "web");
const BANNED = [
  /\.innerHTML\b/, /\.outerHTML\b/, /insertAdjacentHTML/, /\bDOMParser\b/, /createContextualFragment/,
  /\bsrcdoc\b/, /document\.write/, /\beval\s*\(/, /new\s+Function\s*\(/, /setAttribute\(\s*["']style["']/,
];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|js|html)$/.test(name) ? [p] : [];
  });
}

test("no HTML-parsing or code-evaluating API appears in the web client (#3)", () => {
  const offenders: string[] = [];
  for (const file of [...files(WEB), join(WEB, "..", "src", "vault", "markdown.ts")]) {
    const text = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    for (const pattern of BANNED) if (pattern.test(text)) offenders.push(`${file}: ${pattern}`);
  }
  assert.deepEqual(offenders, []);
});

test("index.html has no inline script or style", () => {
  const html = readFileSync(join(WEB, "index.html"), "utf8");
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/);
  assert.doesNotMatch(html, /<style\b|style=/);
});
