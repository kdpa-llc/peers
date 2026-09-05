import { test } from "node:test";
import assert from "node:assert/strict";
import type { Permission } from "../../src/domain/types.ts";
import { permittedTools, permitsRunCommand } from "../../src/data-plane/model/tools.ts";

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

test("malformed grants cannot expose model tools and valid alternatives remain effective", () => {
  const malformedTool = {
    kind: "tool.exec",
    scope: { unexpected: true },
  } as unknown as Permission;
  const malformedDelegate = {
    kind: "agent.delegate",
    scope: { max_concurrent: Number.POSITIVE_INFINITY },
  } as unknown as Permission;
  const supporting = grant("sandbox.create", "fs.read");

  assert.equal(permitsRunCommand([malformedTool, ...supporting]), false);
  assert.equal(
    permittedTools([malformedDelegate]).some((tool) => tool.name === "delegate_task"),
    false,
  );
  assert.equal(
    permitsRunCommand([malformedTool, { kind: "tool.exec" }, ...supporting]),
    true,
    "discarding an invalid alternative must not discard a separate valid grant",
  );
});
