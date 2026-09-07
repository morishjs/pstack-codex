import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { applyEvaluationResult, canonicalRouteKey, selectModel, validateModelPolicy } from "./model-policy.mjs";

const policy = JSON.parse(readFileSync(new URL("./model-policy.json", import.meta.url), "utf8"));
const simpleSignals = {
  "known-failing-deterministic-check": true,
  "explicit-expected-behavior": true,
  "bounded-implementation-allowlist": true,
};

function evaluation(overrides = {}) {
  const result = {
    version: 1,
    taskClass: "simple-fix",
    workflow: "bug-fix",
    risk: "low",
    complexity: "low",
    signals: simpleSignals,
    capability: "implement",
    model: "gpt-5.6-terra",
    reasoning: "medium",
    skillVersion: policy.skillVersion,
    caseCount: 4,
    holdoutCount: 2,
    repetitions: 2,
    passed: true,
    falseCompletionCount: 0,
    scopeViolationCount: 0,
    evidencePath: join(mkdtempSync(join(tmpdir(), "codex-delegate-eval-")), "simple-fix.json"),
    evidenceHash: "0".repeat(64),
    evaluatedAt: "2026-09-07T00:00:00.000Z",
    ...overrides,
  };
  const route = {
    version: result.version, taskClass: result.taskClass, workflow: result.workflow,
    risk: result.risk ?? null, complexity: result.complexity ?? null, signals: Object.keys(result.signals).sort(),
    capability: result.capability, model: result.model, reasoning: result.reasoning, skillVersion: result.skillVersion,
    passed: result.passed, caseCount: result.caseCount, holdoutCount: result.holdoutCount, repetitions: result.repetitions,
    falseCompletionCount: result.falseCompletionCount, scopeViolationCount: result.scopeViolationCount,
    evaluatedAt: result.evaluatedAt, independentReview: result.independentReview === false ? false : true,
  };
  route.routeKey = canonicalRouteKey(route);
  writeFileSync(result.evidencePath, JSON.stringify(route));
  result.evidenceHash = createHash("sha256").update(readFileSync(result.evidencePath)).digest("hex");
  return result;
}

test("simple bounded fix routes Terra", () => {
  const decision = selectModel({ capability: "implement", taskClass: "simple-fix", signals: simpleSignals, policy });
  assert.equal(decision.model, "gpt-5.6-terra");
  assert.equal(decision.source, "hypothesis");
});

test("hard signal establishes Sol minimum", () => {
  const decision = selectModel({ capability: "acceptance", taskClass: "simple-fix", signals: { ...simpleSignals, migration: true }, policy });
  assert.equal(decision.model, "gpt-5.6-sol");
  assert.equal(decision.source, "escalation");
});

test("payment-medical-data elevates acceptance but not implementation", () => {
  const acceptance = selectModel({ capability: "acceptance", taskClass: "payment-change", signals: { "payment-medical-data": true }, policy });
  const implementation = selectModel({ capability: "implement", taskClass: "payment-change", signals: { "payment-medical-data": true }, policy });
  assert.equal(acceptance.model, "gpt-5.6-sol");
  assert.equal(acceptance.source, "escalation");
  assert.equal(implementation.model, "gpt-5.6-terra");
  assert.equal(implementation.source, "hypothesis");
});

test("unresolved design contradiction escalates Astra", () => {
  const decision = selectModel({ capability: "design", taskClass: "feature", signals: { "unresolved-contradiction": true }, policy });
  assert.equal(decision.model, "gpt-6-astra");
  assert.equal(decision.source, "escalation");
});

test("failed evaluation does not promote route", () => {
  const next = applyEvaluationResult(policy, evaluation({ passed: false }));
  assert.deepEqual(next.evaluatedRoutes, []);
});

test("insufficient holdout does not promote route", () => {
  const next = applyEvaluationResult(policy, evaluation({ holdoutCount: 1 }));
  assert.deepEqual(next.evaluatedRoutes, []);
});

test("qualifying evaluation promotes exact route", () => {
  const next = applyEvaluationResult(policy, evaluation());
  const decision = selectModel({ capability: "implement", taskClass: "simple-fix", workflow: "bug-fix", risk: "low", complexity: "low", signals: simpleSignals, policy: next });
  assert.equal(decision.model, "gpt-5.6-terra");
  assert.equal(decision.source, "evaluated");
  assert.equal(decision.independentReview, true);
  const differentConditions = selectModel({ capability: "implement", taskClass: "simple-fix", workflow: "bug-fix", risk: "low", complexity: "medium", signals: simpleSignals, policy: next });
  assert.equal(differentConditions.source, "hypothesis");
});

test("tampered evidence keeps default route and requires independent review", () => {
  const result = evaluation({ independentReview: false });
  const next = applyEvaluationResult(policy, result);
  writeFileSync(result.evidencePath, "{}");
  const decision = selectModel({ capability: "implement", taskClass: "simple-fix", workflow: "bug-fix", risk: "low", complexity: "low", signals: simpleSignals, policy: next });
  assert.equal(decision.source, "hypothesis");
  assert.equal(decision.independentReview, true);
});

test("evaluation input cannot turn off independent review", () => {
  const next = applyEvaluationResult(policy, evaluation({ independentReview: false }));
  assert.equal(next.evaluatedRoutes[0].independentReview, true);
});

test("evaluated routes cannot disable independent review", () => {
  const forged = structuredClone(policy);
  forged.evaluatedRoutes.push({
    taskClass: "simple-fix", capability: "implement", model: "gpt-5.6-terra", reasoning: "medium",
    skillVersion: policy.skillVersion, evidencePath: "eval/simple-fix.json", evaluatedAt: "2026-09-07T00:00:00.000Z",
    independentReview: false, status: "evaluated",
  });
  assert.equal(validateModelPolicy(forged).valid, false);
  assert.throws(() => selectModel({ capability: "implement", taskClass: "simple-fix", signals: simpleSignals, policy: forged }), /invalid model policy/);
});

test("stale skill version route is not selected", () => {
  const stale = structuredClone(policy);
  const result = evaluation();
  const next = applyEvaluationResult(policy, result);
  stale.evaluatedRoutes.push({ ...next.evaluatedRoutes[0], skillVersion: "0.9.0" });
  stale.evaluatedRoutes[0].independentReview = true;
  stale.evaluatedRoutes[0].capability = "implement";
  const decision = selectModel({ capability: "implement", taskClass: "simple-fix", workflow: "bug-fix", risk: "low", complexity: "low", signals: simpleSignals, policy: stale });
  assert.equal(decision.source, "hypothesis");
});

test("malformed policy is rejected", () => {
  assert.deepEqual(validateModelPolicy({}).valid, false);
  assert.throws(() => selectModel({ capability: "review", taskClass: "review", policy: {} }), /invalid model policy/);
});
