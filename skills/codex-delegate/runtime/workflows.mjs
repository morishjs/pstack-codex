export const PHASES = Object.freeze([
  "classify",
  "investigate",
  "reproduce",
  "baseline",
  "design",
  "acceptance",
  "implement",
  "verify",
  "measure",
  "review",
  "deliver",
]);

export const WORKFLOW_REGISTRY = Object.freeze({
  investigation: {
    phases: ["classify", "investigate", "deliver"],
    evidence: {
      classify: ["classification"],
      investigate: ["findings"],
      deliver: ["delivery-report"],
    },
    finishPhases: ["investigate", "deliver"],
    sideEffectCeiling: "read-only",
    independentFinalReview: "none",
  },
  "simple-fix": {
    phases: ["classify", "reproduce", "acceptance", "implement", "verify", "review", "deliver"],
    evidence: {
      classify: ["classification"],
      reproduce: ["reproduction"],
      acceptance: ["acceptance-contract"],
      implement: ["change-set"],
      verify: ["verification-result"],
      review: ["independent-review"],
      deliver: ["delivery-report"],
    },
    finishPhases: ["deliver"],
    sideEffectCeiling: "local-workspace",
    independentFinalReview: "required",
  },
  "bug-fix": {
    phases: ["classify", "investigate", "reproduce", "acceptance", "implement", "verify", "review", "deliver"],
    evidence: {
      classify: ["classification"],
      investigate: ["findings"],
      reproduce: ["reproduction"],
      acceptance: ["acceptance-contract"],
      implement: ["change-set"],
      verify: ["verification-result"],
      review: ["independent-review"],
      deliver: ["delivery-report"],
    },
    finishPhases: ["deliver"],
    sideEffectCeiling: "local-workspace",
    independentFinalReview: "required",
  },
  feature: {
    phases: ["classify", "investigate", "design", "acceptance", "implement", "verify", "review", "deliver"],
    evidence: {
      classify: ["classification"],
      investigate: ["findings"],
      design: ["design-decision"],
      acceptance: ["acceptance-contract"],
      implement: ["change-set"],
      verify: ["verification-result"],
      review: ["independent-review"],
      deliver: ["delivery-report"],
    },
    finishPhases: ["deliver"],
    sideEffectCeiling: "local-workspace",
    independentFinalReview: "required",
  },
  refactor: {
    phases: ["classify", "investigate", "design", "acceptance", "implement", "verify", "review", "deliver"],
    evidence: {
      classify: ["classification"],
      investigate: ["findings"],
      design: ["design-decision"],
      acceptance: ["preservation-contract"],
      implement: ["change-set"],
      verify: ["verification-result"],
      review: ["independent-review"],
      deliver: ["delivery-report"],
    },
    finishPhases: ["deliver"],
    sideEffectCeiling: "local-workspace",
    independentFinalReview: "required",
  },
  "ui-change": {
    phases: ["classify", "investigate", "design", "acceptance", "implement", "verify", "review", "deliver"],
    evidence: {
      classify: ["classification"],
      investigate: ["findings"],
      design: ["design-decision"],
      acceptance: ["acceptance-contract"],
      implement: ["change-set"],
      verify: ["verification-result", "runtime-visual"],
      review: ["independent-review"],
      deliver: ["delivery-report"],
    },
    finishPhases: ["deliver"],
    sideEffectCeiling: "local-workspace",
    independentFinalReview: "required",
  },
  performance: {
    phases: ["classify", "investigate", "baseline", "design", "acceptance", "implement", "measure", "review", "deliver"],
    evidence: {
      classify: ["classification"],
      investigate: ["findings"],
      baseline: ["performance-baseline"],
      design: ["design-decision"],
      acceptance: ["acceptance-contract"],
      implement: ["change-set"],
      measure: ["performance-measurement"],
      review: ["independent-review"],
      deliver: ["delivery-report"],
    },
    finishPhases: ["deliver"],
    sideEffectCeiling: "local-workspace",
    independentFinalReview: "required",
  },
  "pr-maintenance": {
    phases: ["classify", "investigate", "acceptance", "implement", "verify", "review", "deliver"],
    evidence: {
      classify: ["classification"],
      investigate: ["pr-state"],
      acceptance: ["acceptance-contract"],
      implement: ["change-set"],
      verify: ["verification-result"],
      review: ["independent-review"],
      deliver: ["delivery-report"],
    },
    finishPhases: ["deliver"],
    sideEffectCeiling: "local-workspace",
    independentFinalReview: "required",
  },
  "skill-change": {
    phases: ["classify", "investigate", "design", "acceptance", "implement", "verify", "review", "deliver"],
    evidence: {
      classify: ["classification"],
      investigate: ["findings"],
      design: ["design-decision"],
      acceptance: ["acceptance-contract"],
      implement: ["change-set"],
      verify: ["verification-result"],
      review: ["independent-review"],
      deliver: ["delivery-report"],
    },
    finishPhases: ["deliver"],
    sideEffectCeiling: "local-workspace",
    independentFinalReview: "required",
  },
});

const SIDE_EFFECT_CEILINGS = new Set(["read-only", "local-workspace"]);
const REVIEW_POLICIES = new Set(["none", "required"]);
const MUTATION_PHASES = new Set(["implement"]);

export function validateWorkflowRegistry(registry = WORKFLOW_REGISTRY) {
  for (const [kind, workflow] of Object.entries(registry)) {
    if (!Array.isArray(workflow.phases) || workflow.phases.length === 0)
      throw new Error(`${kind}: phases must be non-empty`);

    const seen = new Set();
    for (const phase of workflow.phases) {
      if (!PHASES.includes(phase)) throw new Error(`${kind}: unknown phase ${phase}`);
      if (seen.has(phase)) throw new Error(`${kind}: duplicate phase ${phase}`);
      seen.add(phase);
      if (!Array.isArray(workflow.evidence?.[phase]) || workflow.evidence[phase].length === 0)
        throw new Error(`${kind}: missing evidence for ${phase}`);
    }

    if (!Array.isArray(workflow.finishPhases) || workflow.finishPhases.length === 0)
      throw new Error(`${kind}: no finish phase`);
    if (workflow.finishPhases.some((phase) => !seen.has(phase)))
      throw new Error(`${kind}: finish phase is outside workflow`);
    if (!workflow.finishPhases.includes(workflow.phases.at(-1)))
      throw new Error(`${kind}: final phase cannot finish workflow`);
    if (!SIDE_EFFECT_CEILINGS.has(workflow.sideEffectCeiling))
      throw new Error(`${kind}: unknown side-effect ceiling`);
    if (!REVIEW_POLICIES.has(workflow.independentFinalReview))
      throw new Error(`${kind}: unknown final review policy`);
    if (workflow.sideEffectCeiling === "read-only" && workflow.phases.some((phase) => MUTATION_PHASES.has(phase)))
      throw new Error(`${kind}: read-only workflow contains mutation phase`);
    if (workflow.sideEffectCeiling === "local-workspace" && workflow.independentFinalReview !== "required")
      throw new Error(`${kind}: mutation workflow requires final review`);
    if (workflow.independentFinalReview === "required" && !seen.has("review"))
      throw new Error(`${kind}: required final review is unreachable`);
  }
  return true;
}

validateWorkflowRegistry();
