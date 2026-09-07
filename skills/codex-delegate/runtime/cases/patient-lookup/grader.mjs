import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const workspace = path.resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("candidate workspace required");
const { getCustomer } = await import(pathToFileURL(path.join(workspace, "src", "controller.mjs")));

test("known missing identifier maps to an actionable HTTP response", () => {
  assert.deepEqual(getCustomer("missing"), {
    status: 400,
    body: { code: "IDENTIFIER_MISSING" },
  });
});

test("successful customer lookup remains unchanged", () => {
  assert.deepEqual(getCustomer("customer-1"), {
    status: 200,
    body: { identifier: "customer-1", name: "Fixture Customer" },
  });
});

test("unexpected lookup errors remain internal failures", () => {
  assert.deepEqual(getCustomer("unexpected"), {
    status: 500,
    body: { code: "INTERNAL_ERROR" },
  });
});
