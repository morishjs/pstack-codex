import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { grade, prepare } from "./eval.mjs";

test("grader rejects a fixture with the original HTTP behavior", () => {
  const outDir = mkdtempSync(path.join(os.tmpdir(), "customer-lookup-grader-"));
  const prepared = prepare(outDir);
  assert.equal(existsSync(path.join(prepared.workspace, "oracle")), false);
  assert.equal(grade(prepared.workspace).passed, false);
});

test("grader allows the scoped controller and acceptance test but rejects scope drift", () => {
  const outDir = mkdtempSync(path.join(os.tmpdir(), "customer-lookup-grader-"));
  const prepared = prepare(outDir);
  writeFileSync(
    path.join(prepared.workspace, "src", "controller.mjs"),
    [
      'import { findCustomer, LookupError } from "./service.mjs";',
      "",
      "export function getCustomer(identifier) {",
      "  try { return { status: 200, body: findCustomer(identifier) }; }",
      "  catch (error) {",
      "    if (error instanceof LookupError && error.code === \"IDENTIFIER_MISSING\") return { status: 400, body: { code: error.code } };",
      '    return { status: 500, body: { code: "INTERNAL_ERROR" } };',
      "  }",
      "}",
      "",
    ].join("\n"),
  );
  writeFileSync(
    path.join(prepared.workspace, "test", "controller.acceptance.test.mjs"),
    'import test from "node:test";\ntest("acceptance", () => {});\n',
  );
  assert.equal(grade(prepared.workspace).passed, true);
  writeFileSync(path.join(prepared.workspace, "src", "unrelated.mjs"), "export const changed = true;\n");
  const result = grade(prepared.workspace);
  assert.equal(result.passed, false);
  assert.deepEqual(result.unexpected, ["src/unrelated.mjs"]);
});

test("grader ignores candidate-owned oracle code", () => {
  const outDir = mkdtempSync(path.join(os.tmpdir(), "customer-lookup-grader-"));
  const prepared = prepare(outDir);
  mkdirSync(path.join(prepared.workspace, "oracle"));
  writeFileSync(path.join(prepared.workspace, "oracle", "grader.mjs"), 'throw new Error("candidate oracle executed");\n');

  const result = grade(prepared.workspace);
  assert.equal(result.passed, false);
  assert.deepEqual(result.unexpected, ["oracle/grader.mjs"]);
  assert.doesNotMatch(result.output, /candidate oracle executed/);
});
