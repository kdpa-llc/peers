import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dist = fileURLToPath(new URL("../dist", import.meta.url));
const relativeTypeScriptSpecifier =
  /((?:from\s+|import\s*(?:\(\s*)?|require\s*\(\s*)["'](?:\.\.?\/)[^"']+)(?<!\.d)\.ts(["'])/g;
const residualTypeScriptSpecifier =
  /(?:from\s+|import\s*(?:\(\s*)?|require\s*\(\s*)["'](?:\.\.?\/)[^"']+(?<!\.d)\.ts["']/;

export function rewriteDeclarationText(declaration, source = "declaration") {
  const rewritten = declaration.replace(relativeTypeScriptSpecifier, "$1.js$2");
  if (residualTypeScriptSpecifier.test(rewritten)) {
    throw new Error(`unrewritten TypeScript import specifier in ${source}`);
  }
  return rewritten;
}

async function declarationFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await declarationFiles(path));
    else if (entry.name.endsWith(".d.ts")) files.push(path);
  }
  return files;
}

async function rewriteDeclarations() {
  for (const path of await declarationFiles(dist)) {
    const declaration = await readFile(path, "utf8");
    const rewritten = rewriteDeclarationText(declaration, path);
    if (rewritten !== declaration) await writeFile(path, rewritten);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await rewriteDeclarations();
}
