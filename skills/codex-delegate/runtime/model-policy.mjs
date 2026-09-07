import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CAPABILITIES = new Set(["classify", "investigate", "design", "acceptance", "implement", "review"]);
const MODELS = ["gpt-5.6-terra", "gpt-5.6-sol", "gpt-6-astra"];
const REASONING = "medium";
const HARD_SIGNALS = new Set([
  "ambiguous-reproduction",
  "cross-module",
  "public-contract",
  "auth-security",
  "payment-medical-data",
  "migration",
  "external-side-effect",
  "missing-executable-check",
  "contract-revision",
]);
const ASTRA_SIGNALS = new Set(["unresolved-contradiction", "repeated-contract-failure"]);
const JUDGMENT_CAPABILITIES = new Set(["classify", "investigate", "design", "acceptance", "review"]);
const REQUIRED_EVALUATION_FIELDS = [
  "version", "taskClass", "capability", "model", "reasoning", "skillVersion", "caseCount",
  "holdoutCount", "repetitions", "passed", "falseCompletionCount", "scopeViolationCount",
  "workflow", "risk", "complexity", "signals", "evidencePath", "evidenceHash", "evaluatedAt",
];
const RUNTIME_DIR = dirname(fileURLToPath(import.meta.url));
const EVALUATION_METRICS = ["caseCount", "holdoutCount", "repetitions", "passed", "falseCompletionCount", "scopeViolationCount"];

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function routeIsValid(route) {
  return isObject(route)
    && MODELS.includes(route.model)
    && route.reasoning === REASONING
    && ["hypothesis", "evaluated"].includes(route.status);
}

function routeSignals(signals = {}) {
  if (Array.isArray(signals)) return new Set(signals.map(normalizeSignal));
  if (!isObject(signals)) return new Set();
  return new Set(Object.entries(signals).filter(([, value]) => value).map(([key]) => normalizeSignal(key)));
}

function normalizeSignal(signal) {
  return String(signal).replace(/([a-z])([A-Z])/g, "$1-$2").replaceAll("_", "-").toLowerCase();
}

export function canonicalRouteKey({ taskClass, workflow, risk, complexity, signals = {} }) {
  return JSON.stringify({ taskClass, workflow, risk: risk ?? null, complexity: complexity ?? null, signals: [...routeSignals(signals)].sort() });
}

function hasSignal(signals, name) {
  const camel = name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
  return signals.has(name) || signals.has(name.replaceAll("-", "_")) || signals.has(camel);
}

function hasAnySignal(signals, names) {
  return [...names].some((name) => hasSignal(signals, name));
}

function routeAtLeast(route, model) {
  return MODELS.indexOf(route.model) >= MODELS.indexOf(model);
}

function isSimpleFix(taskClass, signals) {
  return taskClass === "simple-fix"
    && hasSignal(signals, "known-failing-deterministic-check")
    && hasSignal(signals, "explicit-expected-behavior")
    && hasSignal(signals, "bounded-implementation-allowlist")
    && !hasAnySignal(signals, HARD_SIGNALS);
}

function qualifiesForPromotion(route) {
  return route.passed === true && route.caseCount >= route.holdoutCount && route.holdoutCount >= 2
    && route.repetitions >= 2 && route.falseCompletionCount === 0 && route.scopeViolationCount === 0;
}

function evaluatedRouteIsValid(route) {
  return routeIsValid(route) && route.status === "evaluated" && Number.isInteger(route.evaluationVersion)
    && route.evaluationVersion >= 1 && CAPABILITIES.has(route.capability)
    && typeof route.taskClass === "string" && route.taskClass && typeof route.workflow === "string" && route.workflow
    && typeof route.skillVersion === "string" && route.skillVersion && typeof route.routeKey === "string" && route.routeKey
    && ["caseCount", "holdoutCount", "repetitions", "falseCompletionCount", "scopeViolationCount"].every(
      (field) => Number.isInteger(route[field]) && route[field] >= 0,
    ) && qualifiesForPromotion(route) && typeof route.evidencePath === "string" && route.evidencePath
    && typeof route.evidenceHash === "string" && /^[a-f0-9]{64}$/i.test(route.evidenceHash)
    && typeof route.evaluatedAt === "string" && !Number.isNaN(Date.parse(route.evaluatedAt))
    && route.independentReview === true;
}

function evidenceFile(path) {
  return isAbsolute(path) ? path : resolve(RUNTIME_DIR, path);
}

function evidenceMatches(route) {
  const path = evidenceFile(route.evidencePath);
  if (!existsSync(path)) return false;
  let raw, artifact;
  try {
    raw = readFileSync(path);
    artifact = JSON.parse(raw.toString("utf8"));
  } catch {
    return false;
  }
  if (!isObject(artifact) || createHash("sha256").update(raw).digest("hex") !== route.evidenceHash) return false;
  return artifact.routeKey === route.routeKey && artifact.version === route.evaluationVersion
    && ["taskClass", "workflow", "risk", "complexity", "capability", "model", "reasoning", "skillVersion", "evaluatedAt", ...EVALUATION_METRICS]
      .every((field) => artifact[field] === route[field])
    && canonicalRouteKey(artifact) === route.routeKey;
}

export function validateModelPolicy(policy) {
  const errors = [];
  if (!isObject(policy)) return { valid: false, errors: ["policy must be an object"] };
  if (!Number.isInteger(policy.version) || policy.version < 1) errors.push("version must be a positive integer");
  if (typeof policy.skillVersion !== "string" || !policy.skillVersion) errors.push("skillVersion must be a nonempty string");
  if (policy.reasoning !== REASONING) errors.push(`reasoning must be ${REASONING}`);
  if (!isObject(policy.defaults)) errors.push("defaults must be an object");
  else for (const capability of CAPABILITIES) {
    if (!routeIsValid(policy.defaults[capability])) errors.push(`defaults.${capability} is invalid`);
  }
  if (!isObject(policy.taskClasses)) errors.push("taskClasses must be an object");
  else for (const [taskClass, route] of Object.entries(policy.taskClasses)) {
    if (!routeIsValid(route) || !CAPABILITIES.has(route.capability)) errors.push(`taskClasses.${taskClass} is invalid`);
    if (typeof route.independentReview !== "boolean") errors.push(`taskClasses.${taskClass}.independentReview must be boolean`);
  }
  if (!Array.isArray(policy.evaluatedRoutes)) errors.push("evaluatedRoutes must be an array");
  else for (const [index, route] of policy.evaluatedRoutes.entries()) {
    if (!evaluatedRouteIsValid(route)) {
      errors.push(`evaluatedRoutes.${index} is invalid`);
    }
  }
  return { valid: errors.length === 0, errors };
}

function evaluatedRoute(policy, capability, routeKey) {
  return policy.evaluatedRoutes
    .filter((route) => route.capability === capability && route.routeKey === routeKey
      && route.skillVersion === policy.skillVersion && evaluatedRouteIsValid(route) && evidenceMatches(route))
    .sort((left, right) => String(right.evaluatedAt).localeCompare(String(left.evaluatedAt)))[0];
}

export function selectModel({ capability, taskClass, workflow, risk, complexity, signals = {}, policy }) {
  const validation = validateModelPolicy(policy);
  if (!validation.valid) throw new TypeError(`invalid model policy: ${validation.errors.join("; ")}`);
  if (!CAPABILITIES.has(capability)) throw new TypeError(`unknown capability: ${capability}`);
  const signalSet = routeSignals(signals);
  const routeKey = canonicalRouteKey({ taskClass, workflow, risk, complexity, signals });
  const reasons = [];
  const deterministic = taskClass === "deterministic-tool" || hasSignal(signalSet, "deterministic-tool-operation");
  if (deterministic) return { model: null, reasoning: null, source: "no-model", reasons: ["deterministic-tool-operation"] };

  let route = evaluatedRoute(policy, capability, routeKey);
  const evaluated = route;
  let source = route ? "evaluated" : "hypothesis";
  if (!route && isSimpleFix(taskClass, signalSet) && capability === "implement") {
    route = policy.taskClasses[taskClass];
    reasons.push("bounded-simple-fix");
  }
  if (!route) route = policy.defaults[capability];

  if (JUDGMENT_CAPABILITIES.has(capability) && hasAnySignal(signalSet, HARD_SIGNALS)) {
    if (!routeAtLeast(route, "gpt-5.6-sol")) route = { model: "gpt-5.6-sol", reasoning: REASONING };
    source = "escalation";
    reasons.push("hard-escalation-signal");
  }
  if (["design", "acceptance"].includes(capability) && hasAnySignal(signalSet, ASTRA_SIGNALS)) {
    route = { model: "gpt-6-astra", reasoning: REASONING };
    source = "escalation";
    reasons.push("astra-escalation-signal");
  }
  if (risk) reasons.push(`risk:${risk}`);
  if (complexity) reasons.push(`complexity:${complexity}`);
  return { model: route.model, reasoning: route.reasoning, source, reasons,
    independentReview: true };
}

export function validateEvaluationResult(result) {
  const errors = [];
  if (!isObject(result)) return { valid: false, errors: ["result must be an object"] };
  for (const field of REQUIRED_EVALUATION_FIELDS) if (!(field in result)) errors.push(`missing ${field}`);
  if (!Number.isInteger(result.version) || result.version < 1) errors.push("version must be a positive integer");
  if (!CAPABILITIES.has(result.capability)) errors.push("capability is invalid");
  if (!MODELS.includes(result.model)) errors.push("model is invalid");
  if (result.reasoning !== REASONING) errors.push(`reasoning must be ${REASONING}`);
  for (const field of ["caseCount", "holdoutCount", "repetitions", "falseCompletionCount", "scopeViolationCount"]) {
    if (!Number.isInteger(result[field]) || result[field] < 0) errors.push(`${field} must be a nonnegative integer`);
  }
  if (typeof result.taskClass !== "string" || !result.taskClass) errors.push("taskClass must be a nonempty string");
  if (typeof result.workflow !== "string" || !result.workflow) errors.push("workflow must be a nonempty string");
  if (typeof result.skillVersion !== "string" || !result.skillVersion) errors.push("skillVersion must be a nonempty string");
  if (typeof result.passed !== "boolean") errors.push("passed must be boolean");
  if (typeof result.evidencePath !== "string" || !result.evidencePath) errors.push("evidencePath must be a nonempty string");
  if (typeof result.evidenceHash !== "string" || !/^[a-f0-9]{64}$/i.test(result.evidenceHash)) errors.push("evidenceHash must be a SHA-256 hash");
  if (Number.isNaN(Date.parse(result.evaluatedAt))) errors.push("evaluatedAt must be an ISO date");
  return { valid: errors.length === 0, errors };
}

export function applyEvaluationResult(policy, result) {
  const policyValidation = validateModelPolicy(policy);
  if (!policyValidation.valid) throw new TypeError(`invalid model policy: ${policyValidation.errors.join("; ")}`);
  const resultValidation = validateEvaluationResult(result);
  if (!resultValidation.valid) throw new TypeError(`invalid evaluation result: ${resultValidation.errors.join("; ")}`);
  const next = structuredClone(policy);
  const qualifies = result.skillVersion === policy.skillVersion && result.passed && qualifiesForPromotion(result);
  if (!qualifies) return next;
  const route = {
    evaluationVersion: result.version,
    taskClass: result.taskClass,
    workflow: result.workflow,
    risk: result.risk ?? null,
    complexity: result.complexity ?? null,
    signals: [...routeSignals(result.signals)].sort(),
    capability: result.capability,
    model: result.model,
    reasoning: result.reasoning,
    skillVersion: result.skillVersion,
    routeKey: canonicalRouteKey(result),
    passed: result.passed,
    caseCount: result.caseCount,
    holdoutCount: result.holdoutCount,
    repetitions: result.repetitions,
    falseCompletionCount: result.falseCompletionCount,
    scopeViolationCount: result.scopeViolationCount,
    evidencePath: result.evidencePath,
    evidenceHash: result.evidenceHash,
    evaluatedAt: result.evaluatedAt,
    independentReview: true,
    status: "evaluated",
  };
  if (!evidenceMatches(route)) return next;
  next.evaluatedRoutes = next.evaluatedRoutes.filter((current) => !(current.routeKey === route.routeKey && current.capability === route.capability));
  next.evaluatedRoutes.push(route);
  return next;
}

export { ASTRA_SIGNALS, HARD_SIGNALS, MODELS };
