import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createMachine, transition as step } from "xstate";
import { start as startRunner, resume as resumeRunner, status as runnerStatus } from "./runner.mjs";
import { WORKFLOW_REGISTRY, validateWorkflowRegistry } from "./workflows.mjs";
import { selectModel, validateModelPolicy } from "./model-policy.mjs";

const runtimeDir = path.dirname(fileURLToPath(import.meta.url));
const VERSION = 1;
const text = (v) => typeof v === "string" && v.trim().length > 0;
const stamp = () => new Date().toISOString();
const ensure = (ok, message) => { if (!ok) throw new Error(message); };
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const hash = (value) => createHash("sha256").update(value).digest("hex");
export function cliValue(args, key) { const index = args.indexOf(key); if (index < 0) return undefined; ensure(args[index + 1] && !args[index + 1].startsWith('--'), `missing value for ${key}`); return args[index + 1]; }

export const orchestratorMachine = createMachine({
  id: "codex-delegate-orchestrator",
  initial: "classifying",
  states: {
    classifying: { on: { CLASSIFIED: "investigating", SKIP_INVESTIGATION: "designing", RUN: "running", BLOCK: "blocked" } },
    investigating: { on: { INVESTIGATED: "delivering", DESIGN: "designing", RUN: "running", BLOCK: "blocked" } },
    designing: { on: { DESIGNED: "running", BLOCK: "blocked" } },
    running: { on: { COMPLETE: "delivering", BLOCK: "blocked" } },
    delivering: { on: { DELIVERED: "complete", BLOCK: "blocked" } },
    blocked: { on: { RETRY: "classifying", RESUME: "running", RETRY_INVESTIGATION: "investigating", RETRY_DESIGN: "designing", RETRY_DELIVERY: "delivering" } },
    complete: { type: "final" },
  },
});
export function transition(value, type) {
  const [next] = step(orchestratorMachine, orchestratorMachine.resolveState({ value, context: {} }), { type });
  if (next.value === value) throw new Error(`invalid transition ${value} --${type}`);
  return next.value;
}
function atomic(file, value) {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600, flag: "wx" });
  fs.renameSync(temp, file);
}
function persist(state, event, detail = {}) {
  state.sequence += 1;
  state.updatedAt = stamp();
  state.lastEvent = { sequence: state.sequence, at: state.updatedAt, event, phase: state.phase, ...detail };
  atomic(path.join(state.run, "state.json"), state);
  fs.appendFileSync(path.join(state.run, "events.jsonl"), JSON.stringify(state.lastEvent) + "\n", { mode: 0o600 });
}
function move(state, event, detail) { state.phase = transition(state.phase, event); persist(state, event, detail); }
function schema(properties) { return { type: "object", properties, required: Object.keys(properties), additionalProperties: false }; }
const classificationSchema = schema({
  workflow: { type: "string", enum: Object.keys(WORKFLOW_REGISTRY) },
  taskClass: { type: "string", enum: Object.keys(WORKFLOW_REGISTRY) }, risk: { type: "string", enum: ["low", "medium", "high"] },
  complexity: { type: "string", enum: ["low", "medium", "high"] }, signals: { type: "array", items: { type: "string" } },
  reason: { type: "string" }, authorizedActions: { type: "array", items: { type: "string", enum: ["read-only", "local-workspace"] } },
  finishAfterInvestigation: { type: "boolean" },
});
const findingsSchema = schema({ findings: { type: "array", items: { type: "string" } }, evidence: { type: "array", items: { type: "string" } }, unknowns: { type: "array", items: { type: "string" } } });
const designSchema = schema({ decisions: { type: "array", items: { type: "string" } }, evidence: { type: "array", items: { type: "string" } }, unknowns: { type: "array", items: { type: "string" } } });
function validateClassification(value) {
  ensure(value && WORKFLOW_REGISTRY[value.workflow], "malformed route: unknown workflow");
  ensure(value.taskClass === value.workflow && ["low", "medium", "high"].includes(value.risk) && ["low", "medium", "high"].includes(value.complexity), "malformed route taskClass/workflow mismatch");
  ensure(Array.isArray(value.signals) && value.signals.every(text) && text(value.reason), "malformed route signals/reason");
  ensure(Array.isArray(value.authorizedActions) && value.authorizedActions.every((x) => ["read-only", "local-workspace"].includes(x)), "malformed route authorization");
  const ceiling = WORKFLOW_REGISTRY[value.workflow].sideEffectCeiling;
  ensure(value.authorizedActions.every((x) => x === "read-only" || ceiling === "local-workspace"), "route exceeds workflow side-effect ceiling");
  ensure(typeof value.finishAfterInvestigation === "boolean", "malformed route finish flag");
  ensure(!WORKFLOW_REGISTRY[value.workflow].phases.includes("implement") || value.authorizedActions.includes("local-workspace"), "mutation workflow requires local-workspace authorization");
  return value;
}
function validateEvidence(value, label) {
  ensure(value && Array.isArray(value.evidence) && Array.isArray(value.unknowns), `${label} output lacks evidence/unknowns`);
  return value;
}
function visualStart(pathname) {
  if (!fs.existsSync(pathname)) return { exists: false };
  const stat = fs.lstatSync(pathname);
  return { exists: true, regular: stat.isFile(), sha256: stat.isFile() ? hash(fs.readFileSync(pathname)) : undefined, mtimeMs: stat.mtimeMs };
}
function recordEvidence(state, phase, value) {
  for (const type of WORKFLOW_REGISTRY[state.classification.workflow].evidence[phase] ?? [])
    state.evidence[type] = value;
  atomic(path.join(state.run, "evidence.json"), state.evidence);
  persist(state, "evidence-recorded", { phase, types: WORKFLOW_REGISTRY[state.classification.workflow].evidence[phase] ?? [] });
}
async function invoke(state, { phase, model, reasoning, sandbox, schema: outputSchema, prompt }, options) {
  const dir = path.join(state.run, "phases", `${state.sequence}-${phase}-${randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const schemaFile = path.join(dir, "schema.json"), output = path.join(dir, "result.json"), log = path.join(dir, "child.jsonl");
  atomic(schemaFile, outputSchema); fs.writeFileSync(path.join(dir, "prompt.txt"), prompt, { mode: 0o600 });
  const argv = [state.codexBin, "exec", "-C", state.workspace, "-m", model, "-c", `model_reasoning_effort=\"${reasoning}\"`, "-s", sandbox, "--json", "--output-schema", schemaFile, "-o", output, "-"];
  const receipt = await new Promise((resolve, reject) => {
    const child = (options.spawn ?? spawn)(argv[0], argv.slice(1), { cwd: state.workspace, stdio: ["pipe", "pipe", "pipe"], detached: true });
    let threadId, complete = false, settled = false;
    const finish = (value, error) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
    const consume = (data) => { const s = data.toString(); fs.appendFileSync(log, s); for (const line of s.split("\n")) try { const e = JSON.parse(line); if (e.type === "thread.started") threadId = e.thread_id; if (e.type === "turn.completed") complete = true; } catch {} };
    const timer = setTimeout(() => { try { process.kill(-child.pid, "SIGTERM"); } catch {} finish(null, new Error(`${phase} timed out`)); }, options.timeout ?? 20 * 60_000);
    child.stdout.on("data", consume); child.stderr.on("data", consume); child.on("error", (error) => finish(null, error)); child.on("close", (code) => finish({ code, threadId, complete })); child.stdin.end(prompt);
  });
  ensure(receipt.code === 0 && receipt.complete && text(receipt.threadId) && fs.existsSync(output), `${phase} CLI failed or incomplete`);
  const result = readJson(output);
  const record = { phase, model, reasoning, sandbox, threadId: receipt.threadId, dir, output: path.relative(state.run, output), at: stamp() };
  state.agents.push(record); atomic(path.join(state.run, "agents.json"), state.agents); persist(state, "phase-result", { record });
  return result;
}
function assignment(state, capability) {
  const decision = selectModel({ capability, taskClass: state.classification.taskClass, workflow: state.classification.workflow, risk: state.classification.risk, complexity: state.classification.complexity, signals: [...state.classification.signals, ...(state.escalationSignals ?? [])], policy: state.policy });
  ensure(decision.model, `${capability} needs a model`);
  state.assignments[capability] = decision; return decision;
}
function contextArtifact(file, label) { return { path: file, label, hash: hash(fs.readFileSync(file)) }; }
function promptFor(state, phase) {
  const base = `You are the ${phase} phase for Codex Delegate. Workspace: ${state.workspace}. Original request:\n${state.request}\n\nDo not write workspace files, commit, push, deploy, message external systems, or spawn agents. Return only JSON matching the schema.`;
  if (phase === "classify") return `${base}\nChoose one registered workflow. Set taskClass to that exact registered workflow key; put any free-form diagnosis only in reason. Authorization is an action ceiling: only read-only/local-workspace are allowed; never infer push, merge, deploy, or external writes.`;
  return `${base}\nClassification: ${JSON.stringify(state.classification)}\n${state.investigation ? `Prior investigation: ${path.join(state.run, 'investigation.json')}. Reuse its findings and inspect only unresolved evidence.` : ''}\nProvide direct local evidence paths/commands and unknowns. Read only files relevant to the request and scope; avoid entire repository or home-directory dumps.`;
}
function loadPolicy() { const policy = readJson(path.join(runtimeDir, "model-policy.json")); ensure(validateModelPolicy(policy).valid, "invalid model policy"); return policy; }
function finish(state) {
  const required = Object.values(WORKFLOW_REGISTRY[state.classification.workflow].evidence).flat();
  state.evidence["delivery-report"] = { workflow: state.classification.workflow, at: stamp() };
  ensure(required.every((type) => state.evidence[type] && Object.keys(state.evidence[type]).length), `missing required evidence: ${required.filter((type) => !state.evidence[type]).join(", ")}`);
  state.delivery = { workflow: state.classification.workflow, requiredEvidence: required, at: stamp() };
  atomic(path.join(state.run, "evidence.json"), state.evidence); atomic(path.join(state.run, "delivery.json"), state.delivery); move(state, "DELIVERED");
}
async function drive(state, options) {
  try {
    while (!["complete", "blocked"].includes(state.phase)) {
      if (state.phase === "classifying") {
        const route = selectModel({ capability: "classify", taskClass: "classification", risk: "low", complexity: "low", policy: state.policy });
        const result = validateClassification(await invoke(state, { phase: "classify", model: route.model, reasoning: route.reasoning, sandbox: "read-only", schema: classificationSchema, prompt: promptFor(state, "classify") }, options));
        if (result.workflow === "ui-change") ensure(state.runtimeVisualEvidence?.path && text(state.runtimeVisualEvidence.route), "ui-change needs --runtime-visual-evidence and --runtime-visual-route");
        state.classification = result; state.assignments.classify = route; atomic(path.join(state.run, "classification.json"), result); recordEvidence(state, "classify", result); persist(state, "classified", { route });
        const phases = WORKFLOW_REGISTRY[result.workflow].phases;
        if (phases.includes("investigate")) move(state, "CLASSIFIED"); else if (phases.includes("design")) move(state, "SKIP_INVESTIGATION"); else move(state, "RUN");
      } else if (state.phase === "investigating") {
        const route = assignment(state, "investigate"); const result = validateEvidence(await invoke(state, { phase: "investigate", model: route.model, reasoning: route.reasoning, sandbox: "read-only", schema: findingsSchema, prompt: promptFor(state, "investigate") }, options), "investigation");
        state.investigation = result; atomic(path.join(state.run, "investigation.json"), result); recordEvidence(state, "investigate", result); persist(state, "investigated", { route });
        if (state.classification.finishAfterInvestigation) move(state, "INVESTIGATED"); else if (WORKFLOW_REGISTRY[state.classification.workflow].phases.includes("design")) move(state, "DESIGN"); else move(state, "RUN");
      } else if (state.phase === "designing") {
        const route = assignment(state, "design"); const result = validateEvidence(await invoke(state, { phase: "design", model: route.model, reasoning: route.reasoning, sandbox: "read-only", schema: designSchema, prompt: promptFor(state, "design") }, options), "design");
        state.design = result; atomic(path.join(state.run, "design.json"), result); recordEvidence(state, "design", result); persist(state, "designed", { route }); move(state, "DESIGNED");
      } else if (state.phase === "running") {
        if (state.classification.workflow === "investigation") { finish(state); continue; }
        const acceptance = assignment(state, "acceptance"), implementation = assignment(state, "implement");
        const review = { model: "gpt-5.6-sol", reasoning: "medium", source: "required-independent-review", reasons: ["mutating-workflow"] };
        state.assignments.review = review;
        const models = { author: acceptance.model, worker: implementation.model, reviewer: review.model };
        const reviewRequired = true;
        const contextArtifacts = [
          ...(state.investigation ? [contextArtifact(path.join(state.run, "investigation.json"), "investigation")] : []),
          ...(state.design ? [contextArtifact(path.join(state.run, "design.json"), "design")] : []),
        ];
        const runnerOptions = { ...options, models, workflow: state.classification.workflow, reviewRequired, contextArtifacts,
          revisionOf: state.priorNestedRun,
          onRunCreated: (run) => { state.nestedRun = run; persist(state, 'nested-started', { run }); },
          ...(state.classification.workflow === "ui-change" ? { visualEvidence: state.runtimeVisualEvidence } : {}) };
        const nested = state.nestedRun ? await resumeRunner({ run: state.nestedRun, retry: options.retry === true, ...runnerOptions }) : await startRunner({ workspace: state.workspace, requestFile: path.join(state.run, "request.txt"), scopeFile: state.scopeFile, codexBin: state.codexBin, ...runnerOptions });
        state.nestedRun = nested.run; state.nestedPhase = nested.phase; persist(state, "nested-run", { run: nested.run, phase: nested.phase, models });
        if (nested.phase !== "complete" && nested.nonRetryable && /acceptance contract revision/.test(nested.reason ?? "")) {
          state.contractRevisions ??= 0;
          ensure(state.contractRevisions < 2, "contract revision budget exhausted; start a new outer run with prior evidence");
          state.contractRevisions++;
          state.priorNestedRun = nested.run;
          state.escalationSignals ??= [];
          state.escalationSignals.push(state.contractRevisions === 1 ? "contract-revision" : "repeated-contract-failure");
          delete state.nestedRun;
          persist(state, "contract-revision-restart", { priorRun: nested.run, reason: nested.reason, revision: state.contractRevisions });
          continue;
        }
        ensure(nested.phase === "complete", nested.reason ?? "nested code workflow blocked");
        state.evidence.reproduction = nested.baseline;
        state.evidence["performance-baseline"] = nested.performance ?? nested.baseline;
        state.evidence[WORKFLOW_REGISTRY[state.classification.workflow].evidence.acceptance?.[0]] = nested.contract;
        state.evidence["change-set"] = nested.implementation;
        state.evidence["verification-result"] = nested.verification;
        state.evidence["performance-measurement"] = nested.performance ?? nested.verification;
        state.evidence["independent-review"] = nested.review;
        if ((WORKFLOW_REGISTRY[state.classification.workflow].evidence.verify ?? []).includes("runtime-visual")) {
          ensure(nested.visualManifest, "required runtime-visual evidence absent"); state.evidence["runtime-visual"] = nested.visualManifest;
        }
        atomic(path.join(state.run, "evidence.json"), state.evidence); persist(state, "nested-evidence-recorded", { nestedRun: nested.run });
        move(state, "COMPLETE");
      } else if (state.phase === "delivering") finish(state);
    }
  } catch (error) { state.reason = error.message; state.blockedPhase = state.phase; if (state.phase !== "blocked") move(state, "BLOCK"); }
  return state;
}
function load(run) { const state = readJson(path.join(path.resolve(run), "state.json")); ensure(state.version === VERSION && state.run === path.resolve(run), "run identity/version mismatch"); ensure(hash(fs.readFileSync(path.join(state.run, "request.txt"))) === state.requestHash, "request changed"); ensure(hash(fs.readFileSync(path.join(state.run, "config.json"))) === state.configHash, "run config changed"); return state; }
export async function start({ workspace, requestFile, scopeFile, planFile, runtimeVisualEvidenceFile, runtimeVisualRoute, policy, ...options }) {
  if (planFile) {
    const { startQueue } = await import('./queue-session.mjs');
    return startQueue({ source: workspace, requestFile, scopeFile, planFile, ...options, onSessionCreated: options.onRunCreated });
  }
  validateWorkflowRegistry(); workspace = fs.realpathSync(workspace); ensure(path.isAbsolute(workspace) && text(fs.readFileSync(requestFile, "utf8")), "workspace/request required");
  const run = path.join(workspace, ".codex-delegate", "sessions", randomUUID()); fs.mkdirSync(path.join(run, "phases"), { recursive: true, mode: 0o700 });
  const visual = runtimeVisualEvidenceFile ? path.resolve(runtimeVisualEvidenceFile) : undefined;
  const selectedPolicy = policy ?? loadPolicy(); ensure(validateModelPolicy(selectedPolicy).valid, "invalid model policy");
  const state = { version: VERSION, id: path.basename(run), run, workspace, request: fs.readFileSync(requestFile, "utf8"), requestHash: hash(fs.readFileSync(requestFile, "utf8")), scopeFile, codexBin: options.codexBin ?? "codex", policy: selectedPolicy, phase: "classifying", sequence: 0, agents: [], assignments: {}, evidence: {}, runtimeVisualEvidence: visual ? { path: visual, route: runtimeVisualRoute, start: visualStart(visual) } : undefined, createdAt: stamp() };
  fs.writeFileSync(path.join(run, "request.txt"), state.request, { mode: 0o600 }); const config = { workspace, scopeFile, codexBin: state.codexBin }; atomic(path.join(run, "config.json"), config); state.configHash = hash(JSON.stringify(config, null, 2)); persist(state, "start"); options.onRunCreated?.(run); return drive(state, options);
}
export async function status(run) {
  if (readJson(path.join(path.resolve(run), 'state.json')).session) return (await import('./queue-session.mjs')).queueStatus(run);
  const state = load(run); if (state.nestedRun) state.nestedStatus = await runnerStatus(state.nestedRun); return state;
}
export async function resume({ run, retry = false, ...options }) {
  if (readJson(path.join(path.resolve(run), 'state.json')).session) return (await import('./queue-session.mjs')).resumeQueue({ session: run, retry, ...options });
  const state = load(run);
  if (state.phase === 'complete') { if (state.nestedRun) { const nested = await runnerStatus(state.nestedRun); ensure(nested.phase === 'complete', nested.reason ?? 'nested evidence stale'); } return state; }
  if (state.phase === 'blocked') {
    ensure(retry, 'blocked run needs --retry');
    const event = { classifying: 'RETRY', investigating: 'RETRY_INVESTIGATION', designing: 'RETRY_DESIGN', running: 'RESUME', delivering: 'RETRY_DELIVERY' }[state.blockedPhase];
    ensure(event, 'unknown blocked phase'); move(state, event);
  }
  return drive(state, { ...options, retry });
}
async function main() {
  try { const [command, ...args] = process.argv.slice(2); const value = (key) => cliValue(args, key); let state;
    if (command === "start") { ensure(value("--workspace") && value("--request-file"), "start needs --workspace and --request-file"); state = await start({ workspace: value("--workspace"), requestFile: value("--request-file"), scopeFile: value("--scope-file"), planFile: value('--plan-file'), concurrency: Number(value('--concurrency') ?? 2), runtimeVisualEvidenceFile: value("--runtime-visual-evidence"), runtimeVisualRoute: value("--runtime-visual-route"), codexBin: value("--codex-bin"), onRunCreated: (run) => console.log(run) }); }
    else if (command === "status") state = await status(value("--run")); else if (command === "resume") state = await resume({ run: value("--run"), retry: args.includes("--retry"), recoverInterrupted: args.includes('--recover-interrupted') }); else throw new Error("usage: start --workspace ABS --request-file ABS [--scope-file ABS] [--plan-file JSON --concurrency 1|2] [--runtime-visual-evidence FILE --runtime-visual-route ROUTE] [--codex-bin ABS] | status --run ABS | resume --run ABS [--retry] [--recover-interrupted]");
    console.log(JSON.stringify({ run: state.run ?? state.session, phase: state.phase, reason: state.reason })); if (state.phase === "blocked") process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
