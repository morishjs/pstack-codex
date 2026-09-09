import assert from "node:assert/strict";
import test from "node:test";
import { validateWorkflowRegistry, WORKFLOW_REGISTRY } from "./workflows.mjs";

const copy = () => structuredClone(WORKFLOW_REGISTRY);

test("registry is valid and contains every task kind", () => {
  assert.equal(validateWorkflowRegistry(), true);
  assert.deepEqual(Object.keys(WORKFLOW_REGISTRY), [
    "investigation",
    "simple-fix",
    "bug-fix",
    "feature",
    "refactor",
    "ui-change",
    "performance",
    "pr-maintenance",
    "skill-change",
  ]);
});

test("simple fix requires fresh independent review", () => {
  const workflow = WORKFLOW_REGISTRY["simple-fix"];
  assert.deepEqual(workflow.phases, ["classify", "reproduce", "acceptance", "implement", "verify", "review", "deliver"]);
  assert.deepEqual(workflow.evidence, {
    classify: ["classification"],
    reproduce: ["reproduction"],
    acceptance: ["acceptance-contract"],
    implement: ["change-set"],
    verify: ["verification-result"],
    review: ["independent-review"],
    deliver: ["delivery-report"],
  });
  assert.equal(workflow.sideEffectCeiling, "local-workspace");
  assert.equal(workflow.independentFinalReview, "required");
});

test("rejects unknown and duplicate phases", () => {
  const unknown = copy();
  unknown.feature.phases[1] = "guess";
  assert.throws(() => validateWorkflowRegistry(unknown), /unknown phase guess/);

  const duplicate = copy();
  duplicate.feature.phases.splice(1, 0, "classify");
  assert.throws(() => validateWorkflowRegistry(duplicate), /duplicate phase classify/);
});

test("rejects missing evidence and impossible completion", () => {
  const missingEvidence = copy();
  delete missingEvidence.feature.evidence.design;
  assert.throws(() => validateWorkflowRegistry(missingEvidence), /missing evidence for design/);

  const impossible = copy();
  impossible.feature.finishPhases = ["review"];
  assert.throws(() => validateWorkflowRegistry(impossible), /final phase cannot finish workflow/);
});

test("read-only investigation cannot mutate", () => {
  assert.equal(WORKFLOW_REGISTRY.investigation.phases.includes("implement"), false);
  assert.deepEqual(WORKFLOW_REGISTRY.investigation.finishPhases, ["investigate", "deliver"]);

  const malformed = copy();
  malformed.investigation.phases.splice(-1, 0, "implement");
  malformed.investigation.evidence.implement = ["change-set"];
  assert.throws(() => validateWorkflowRegistry(malformed), /read-only workflow contains mutation phase/);
});

test("bug fix requires reproduce, acceptance, implement, and verify", () => {
  const phases = WORKFLOW_REGISTRY["bug-fix"].phases;
  assert.ok(["reproduce", "acceptance", "implement", "verify"].every((phase) => phases.includes(phase)));
  assert.equal(WORKFLOW_REGISTRY["bug-fix"].independentFinalReview, "required");
});

test("performance requires baseline and measurement evidence", () => {
  const workflow = WORKFLOW_REGISTRY.performance;
  assert.ok(workflow.phases.includes("baseline"));
  assert.ok(workflow.phases.includes("measure"));
  assert.deepEqual(workflow.evidence.baseline, ["performance-baseline"]);
  assert.deepEqual(workflow.evidence.measure, ["performance-measurement"]);
});

test("PR maintenance does not authorize push or merge", () => {
  assert.equal(WORKFLOW_REGISTRY["pr-maintenance"].sideEffectCeiling, "local-workspace");
});

test("UI verification requires runtime visual evidence", () => {
  assert.ok(WORKFLOW_REGISTRY["ui-change"].evidence.verify.includes("runtime-visual"));
});
