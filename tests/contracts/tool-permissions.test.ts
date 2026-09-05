import { test } from "node:test";
import assert from "node:assert/strict";
import type { Permission } from "../../src/domain/types.ts";
import { permitsRunCommand } from "../../src/data-plane/model/tools.ts";

const grant = (...kinds: Permission["kind"][]): Permission[] => kinds.map((kind) => (
  kind === "fs.read" || kind === "fs.write"
    ? { kind, scope: { paths: ["/"] } }
    : { kind }
));

test("run_command requires execution, sandbox, and filesystem capabilities", () => {
  assert.equal(permitsRunCommand(grant("tool.exec", "sandbox.create", "fs.read")), true);
  assert.equal(permitsRunCommand(grant("tool.exec", "sandbox.create", "fs.write")), true);
  assert.equal(permitsRunCommand(grant("sandbox.create", "fs.read")), false, "missing tool.exec");
  assert.equal(permitsRunCommand(grant("tool.exec", "fs.read")), false, "missing sandbox.create");
  assert.equal(permitsRunCommand(grant("tool.exec", "sandbox.create")), false, "missing fs scope");
});
