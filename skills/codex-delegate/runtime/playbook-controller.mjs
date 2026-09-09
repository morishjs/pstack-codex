import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createMachine, transition } from 'xstate';
import { getPlaybook } from './playbook-catalog.mjs';
import { validateIntent } from './task-intent.mjs';
import { assessRecovery, recoveryInstructions } from './recovery-action.mjs';
import { newReviewCycle, reviewContext, updateReviewCycle, repairDestination } from './review-cycle.mjs';

const runtime = path.dirname(fileURLToPath(import.meta.url));
const bundle = path.resolve(runtime, '../poteto');
const fail = message => { throw new Error(message); };
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const array = value => value == null ? [] : Array.isArray(value) ? value : [value];
const inside = (dir, file) => file === dir || file.startsWith(dir + path.sep);
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const knownGrants = ['read-only', 'local-workspace', 'remote-write', 'destructive', 'scheduler'];
function sourceHashes() {
  const manifestFile = path.resolve(runtime, '../poteto-manifest.json');
  const sources = {};
  for (const entry of read(manifestFile).files) {
    const file = path.resolve(runtime, '..', entry.target);
    if (!inside(bundle, file) || hash(file) !== entry.sha256) fail(`bundled source drift: ${entry.target}`);
    sources[file] = entry.sha256;
  }
  for (const file of [manifestFile, fileURLToPath(import.meta.url), path.join(runtime, 'playbook-catalog.mjs'), path.join(runtime, 'task-intent.mjs'), path.join(runtime, 'recovery-action.mjs'), path.join(runtime, 'review-cycle.mjs'), path.join(runtime, 'design-gate.mjs'), path.resolve(runtime, '../references/playbook-execution.md')]) sources[file] = hash(file);
  return sources;
}
function authorities(step) { return array(step.authority).filter(a => a !== 'read-only'); }
function taskManifest(playbook, intent) {
  const source = getPlaybook(playbook);
  if (playbook !== 'opening-a-pr' || intent?.goal !== 'pr') return source;
  return { ...source,
    steps: source.steps.map(step => step.id === 'verify' ? { ...step,
      instruction: `${step.instruction} For this PR-through-CI task, a CI repair retry authorizes the scoped code fix here: inspect failure, repair it, review the new diff, and rerun the original runtime repro and checks before recommitting/publishing.`,
      evidence: [...step.evidence, 'diff-review', 'runtime-proof'],
    } : step),
    loops: [...(source.loops ?? []), { from: 'ci', to: 'verify', reason: 'CI failed: repair within the original scope, reverify, recommit, republish, and check the new head.' }],
  };
}
function authorized(state, step) { return authorities(step).every(a => state.grants.includes(a)); }
function repairTarget(manifest, destination) {
  return manifest.repairStages?.[destination];
}
function receiptAllowed(state, step, receipt) {
  if (receipt.stepId !== step.id || !['passed', 'not-applicable'].includes(receipt.outcome)) return false;
  if (receipt.outcome === 'passed' && step.panelRequirement) {
    if (!receipt.panel) return false;
    if (receipt.panel.skipped) {
      if (!step.panelRequirement.optional || !receipt.panel.reason?.trim() || !receipt.evidence.some(item => item.kind === 'scope-exclusion')) return false;
    } else {
      if (!Number.isInteger(receipt.panel.expectedCount) || receipt.panel.expectedCount < step.panelRequirement.minimum
        || receipt.panel.members?.length !== receipt.panel.expectedCount || new Set(receipt.panel.members.map(m => m.agentId)).size !== receipt.panel.expectedCount) return false;
      for (const member of receipt.panel.members) for (const proof of member.evidence ?? []) if (hash(proof.path) !== proof.sha256) return false;
      if (state.playbook === 'eval' && step.id === 'candidates' && new Set(receipt.panel.members.map(member => member.model)).size !== receipt.panel.members.length) return false;
      if (state.playbook === 'eval' && step.id === 'judge') {
        const candidates = state.receipts.find(item => item.stepId === 'candidates')?.panel?.members;
        if (!candidates?.length || candidates.some(member => !member.modelFamily) || receipt.panel.members.some(member => !member.modelFamily || candidates.some(candidate => candidate.modelFamily === member.modelFamily))) return false;
      }
    }
  }
  const goal = state.taskIntent?.goal;
  if (goal === 'pr' && state.playbook === 'opening-a-pr' && ['commit', 'publish', 'ci'].includes(step.id)) {
    if (receipt.outcome !== 'passed') return false;
    if (step.id === 'ci') {
      try {
        const proof = read(receipt.evidence.find(e => e.kind === 'ci-status').path);
        if (proof.status !== 'passed' || !/^[a-f0-9]{40}$/.test(proof.headSha) || !/^https:\/\//.test(proof.prUrl)) return false;
      } catch { return false; }
    }
  }
  if (goal === 'pr' && receipt.outcome === 'not-applicable' && (step.invokes?.includes('opening-a-pr') || ['implementer', 'reviewer'].includes(step.role))) return false;
  if (goal && goal !== 'pr' && goal !== 'playbook' && state.playbook === 'opening-a-pr' && ['commit', 'publish'].includes(step.id) && receipt.outcome === 'passed') return false;
  if (receipt.outcome === 'not-applicable') return Boolean(step.when) && Boolean(receipt.reason?.trim()) && receipt.evidence.some(e => e.kind === 'scope-exclusion');
  return authorized(state, step) && array(step.evidence).every(kind => receipt.evidence.some(e => e.kind === kind))
    && array(step.assertions).every(a => receipt.data?.[a.field] === a.equals);
}
function guardedReceipt(state, step, receipt) {
  try {
    return receiptAllowed(state, step, receipt)
      && receipt.evidence.every(e => e.sha256 && hash(e.path) === e.sha256)
      && (receipt.outcome === 'not-applicable' || invocations(step).every(playbook => {
        const child = array(receipt.children).find(c => c.playbook === playbook);
        return child && validateChild(state, step.id, child, new Set([state.run]), true);
      }));
  } catch { return false; }
}

// Every playbook gets its own explicit, guarded step graph; the host performs actions.
export function compilePlaybook(manifest) {
  return createMachine({
    id: `playbook-${manifest.id}`, initial: manifest.steps[0].id, context: {},
    states: Object.fromEntries([...manifest.steps.map((s, i) => [s.id, { on: {
      RECORD: { target: manifest.steps[i + 1]?.id ?? 'complete', guard: ({ event }) => guardedReceipt(event.state, s, event.receipt) },
      RETRY: array(manifest.loops).filter(l => l.from === s.id).map(l => ({ target: l.to, guard: ({ event }) => event.to === l.to && Boolean(event.reason?.trim()) })),
      REPAIR: ['implement', 'design', 'acceptance', 'verify'].map(destination => ({ destination, target: repairTarget(manifest, destination) })).filter(edge => edge.target).map(edge => ({ target: edge.target,
        guard: ({ event }) => event.destination === edge.destination && Boolean(event.findingId) })),
    } }]), ['complete', { type: 'final' }]]),
  });
}
function advance(manifest, state, event) {
  const machine = compilePlaybook(manifest);
  const [next] = transition(machine, machine.resolveState({ value: state.stepId, context: {} }), event);
  if (next.value === state.stepId && !['RETRY', 'REPAIR'].includes(event.type)) fail('step transition rejected');
  return next.value;
}
function save(run, state, event) {
  const tmp = path.join(run, `.state-${randomUUID()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, path.join(run, 'state.json'));
  fs.appendFileSync(path.join(run, 'events.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n');
}
function locked(run, action) {
  run = fs.realpathSync(run);
  const lock = path.join(run, '.writer.lock');
  let fd;
  try { fd = fs.openSync(lock, 'wx', 0o600); } catch { fail('run writer is locked'); }
  try { return action(run); } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}
function validateEvidence(state, evidence) {
  if (!Array.isArray(evidence)) fail('evidence must be an array');
  return evidence.map(item => {
    if (!item || typeof item.kind !== 'string' || !item.kind || typeof item.path !== 'string') fail('invalid evidence');
    const file = fs.realpathSync(path.resolve(state.workspace, item.path));
    if (inside(state.run, file) && !inside(path.join(state.run, 'artifacts'), file)) fail('controller files cannot be evidence');
    const stat = fs.statSync(file);
    if (!stat.isFile()) fail('evidence must be a file');
    const digest = hash(file);
    if (item.sha256 && item.sha256 !== digest) fail(`evidence drift: ${file}`);
    return { kind: item.kind, path: file, sha256: digest };
  });
}
function load(run, seen = new Set()) {
  run = fs.realpathSync(run);
  if (seen.has(run) || seen.size > 8) fail('child cycle or depth limit');
  seen = new Set([...seen, run]);
  const state = read(path.join(run, 'state.json'));
  if (state.run !== run) fail('run identity mismatch');
  for (const [file, digest] of Object.entries(state.sources)) if (hash(file) !== digest) fail(`source drift: ${file}`);
  if (hash(path.join(run, 'request.md')) !== state.requestHash) fail('request drift');
  if (state.taskIntent) validateIntent(state.taskIntent, fs.readFileSync(path.join(run, 'request.md'), 'utf8'), state.parent ? state.taskIntent.playbook : state.playbook, state.grants);
  if (state.holdEvidence) validateEvidence(state, state.holdEvidence);
  const manifest = taskManifest(state.playbook, state.taskIntent);
  if (createHash('sha256').update(JSON.stringify(manifest)).digest('hex') !== state.manifestHash) fail('manifest drift');
  let expected = manifest.steps[0].id;
  for (const receipt of state.receipts) {
    validateEvidence(state, receipt.evidence);
    if (receipt.stepId !== expected) fail('receipt order drift');
    if (receipt.outcome !== 'blocked') {
      const step = manifest.steps.find(s => s.id === expected);
      if (!receiptAllowed(state, step, receipt)) fail('invalid persisted receipt');
      if (receipt.outcome === 'passed' && invocations(step).some(p => !array(receipt.children).some(c => c.playbook === p))) fail('required child missing');
      expected = manifest.steps[manifest.steps.indexOf(step) + 1]?.id ?? 'complete';
    }
    if (receipt.outcome !== 'blocked') for (const child of receipt.children ?? []) validateChild(state, receipt.stepId, child, seen, true);
  }
  if (state.stepId !== expected) fail('state order drift');
  if (state.status === 'complete' && (state.stepId !== 'complete' || state.receipts.filter(r => r.outcome !== 'blocked').length !== manifest.steps.length)) fail('invalid completion');
  if (state.status === 'complete' && !state.parent && state.reviewCycle && ['pr', 'verified-change'].includes(state.taskIntent?.goal)
    && !reviewContext(state.reviewCycle, state.workspace).approved) fail('completed review inputs changed or review is incomplete');
  return { state, manifest };
}
function invocations(step) { return array(step.invokes).map(i => typeof i === 'string' ? i : i.playbook); }
function validateChild(state, stepId, child, seen = new Set(), requireComplete = false) {
  const { state: other } = load(child.run, seen);
  if (other.parent?.run !== state.run || other.parent?.stepId !== stepId || other.parent?.token !== child.token || other.playbook !== child.playbook) fail('foreign child run');
  if (requireComplete && other.status !== 'complete') fail(`required child incomplete: ${child.playbook}`);
  return { playbook: child.playbook, run: child.run, status: other.status };
}
function createRun({ workspace, playbook, requestFile, grants = ['read-only'], taskIntent, parent, depth = 0, workerId = process.env.CODEX_THREAD_ID ?? null }) {
  workspace = fs.realpathSync(workspace);
  if (depth > 8) fail('child depth limit');
  if (!Array.isArray(grants) || grants.some(g => !knownGrants.includes(g))) fail(`grants must be one of: ${knownGrants.join(', ')}`);
  if (!taskIntent) fail('new root and child runs require a frozen task intent; legacy runs may only resume');
  const manifest = taskManifest(playbook, taskIntent);
  const run = path.join(workspace, '.codex-delegate', 'playbooks', randomUUID());
  const request = fs.readFileSync(requestFile);
  if (taskIntent) validateIntent(taskIntent, request.toString(), parent ? taskIntent.playbook : playbook, grants);
  const sources = sourceHashes();
  fs.mkdirSync(path.join(run, 'artifacts'), { recursive: true });
  fs.writeFileSync(path.join(run, 'request.md'), request, { mode: 0o444 });
  const state = { version: 1, kind: 'playbook', run, workspace, playbook: manifest.id, grants, taskIntent, parent, depth, sources,
    manifestHash: createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
    requestHash: hash(path.join(run, 'request.md')), stepId: manifest.steps[0].id,
    status: 'active', generation: 1, activatedAt: Date.now(), receipts: [], history: [], children: {}, reviewCycle: newReviewCycle(workerId, workspace) };
  save(run, state, { type: 'start', playbook });
  return { run, ...statusPlaybook(run) };
}
export function startPlaybook(options) { return createRun(options); }
export function statusPlaybook(run) {
  const { state } = load(run);
  return { kind: 'playbook', run: state.run, playbook: state.playbook, stepId: state.stepId, generation: state.generation, status: state.status, phase: state.status === 'active' ? 'running' : state.status, completed: state.status === 'complete', grants: state.grants, reason: state.reason,
    taskGoal: state.taskIntent?.goal, requiredDelivery: state.taskIntent?.requiredDelivery,
    completedSteps: state.receipts.filter(r => r.outcome === 'passed').map(r => r.stepId),
    skippedSteps: state.receipts.filter(r => r.outcome === 'not-applicable').map(({ stepId, reason, evidence }) => ({ stepId, reason, evidence })),
    ...(state.holdPending ? { holdRequired: { instruction: 'Immediately propagate zero-writes hold to every owner; record all owner acknowledgments before resuming.', evidence: ['hold-acknowledgments'] } } : {}) };
}
function cycleRoot(state) {
  let current = state;
  const seen = new Set();
  while (current.parent) {
    if (seen.has(current.run) || seen.size > 8) fail('invalid team parent chain');
    seen.add(current.run); current = load(current.parent.run).state;
  }
  return current;
}
export function updateTeam({ run, operation, evidence = [] }) {
  const active = load(run).state;
  const root = cycleRoot(active);
  return locked(root.run, rootRun => {
    const { state } = load(rootRun);
    if (['complete', 'paused'].includes(state.status)) fail('team cannot change in a completed or paused task');
    if (operation.type === 'assign' && operation.role === 'specialist' && ![state.playbook, active.playbook].some(id => ['eval', 'autopilot-full', 'autopilot-stack', 'orchestrate'].includes(id))) {
      fail('ordinary tasks retain the main worker; source delegation clauses do not authorize extra specialists');
    }
    state.reviewCycle ??= newReviewCycle();
    const proof = validateEvidence(state, evidence);
    updateReviewCycle(state.reviewCycle, state.workspace, operation, proof);
    save(rootRun, state, { type: 'team', operation: operation.type, actorId: operation.actorId ?? operation.agentId });
    return reviewContext(state.reviewCycle, state.workspace);
  });
}
export function nextStep(run) {
  return locked(run, run => {
    const { state, manifest } = load(run);
    if (state.status === 'complete' || state.status === 'paused') return statusPlaybook(run);
    const step = manifest.steps.find(s => s.id === state.stepId);
    if (!authorized(state, step)) {
      state.status = 'blocked'; state.reason = `missing grants: ${authorities(step).filter(a => !state.grants.includes(a)).join(', ')}`;
      save(run, state, { type: 'authority-block', stepId: step.id });
      return { ...statusPlaybook(run), authority: step.authority, when: step.when, scopeExclusion: step.when ? { outcome: 'not-applicable', evidence: ['scope-exclusion'], instruction: 'Document why the conditional step is outside the request scope. Do not execute the action.' } : undefined };
    }
    if (state.status === 'blocked') return statusPlaybook(run);
    return { ...statusPlaybook(run), instruction: step.instruction, sourceSteps: step.sourceSteps,
      execution: { mode: 'retained-worker-and-reviewer', sourceDelegation: 'overridden-by-execution-policy', browserProvider: 'cursor-acp', instruction: 'This execution policy overrides bundled source and linked-skill actor/model instructions. The main worker performs investigation, design alternatives, acceptance, implementation and repairs. Only when independent review is required, create one Sol reviewer and reuse it; read-only explanation and ordinary preparation do not create a reviewer. Cursor executes browser verification. A source arena, delegate, owner or phase is not permission to create another agent. Only explicit eval/program workflows retain their registered panels. Continue in the current turn through authorized delivery; never hand off merely to change the main model.' },
      reviewContext: reviewContext(cycleRoot(state).reviewCycle ?? newReviewCycle(), state.workspace),
      source: path.resolve(runtime, '..', manifest.source), sourceRoot: bundle, runtime, runtimeGuide: path.join(bundle, 'runtime.md'), executionPolicy: path.resolve(runtime, '../references/playbook-execution.md'), requestFile: path.join(run, 'request.md'),
      evidence: step.evidence, assertions: step.assertions, role: step.role, authority: step.authority, when: step.when, panelRequirement: step.panelRequirement,
      retries: array(manifest.loops).filter(edge => edge.from === step.id),
      recoveryInstructions,
      taskRequirements: state.taskIntent?.goal === 'pr' ? 'Retain the task through implementation, verification, PR publication and passed CI. Do not skip required delivery. For opening-a-pr/ci supply ci-status JSON {status:"passed",headSha:<40-char SHA>,prUrl:<https URL>} from actual current-head checks. Pending or failed CI is unfinished; repair within scope and reverify before recording.' : undefined,
      modelPolicy: { workerPreference: 'gpt-5.6-terra', planning: 'retained-worker', implementation: 'retained-worker', specialistPlanning: 'gpt-6-astra', review: 'gpt-5.6-sol', reasoning: 'medium', reviewSession: 'independent-first-then-resume', workerSession: 'retain-across-phases' },
      requiredChildren: invocations(step).map(playbook => {
        const child = array(state.children[step.id]).find(c => c.playbook === playbook);
        return child ? validateChild(state, step.id, child) : { playbook, status: 'not-started' };
      }) };
  });
}
export function recordStep({ run, stepId, generation, outcome, reason, evidence = [], data, recoveryAction }) {
  return locked(run, run => {
    const { state, manifest } = load(run);
    if (['paused', 'complete'].includes(state.status) || stepId !== state.stepId) fail('step is not active');
    if (generation !== state.generation) fail('stale or missing receipt generation');
    const step = manifest.steps.find(s => s.id === stepId);
    if (!['passed', 'not-applicable', 'blocked'].includes(outcome)) fail('invalid outcome');
    if (state.status === 'blocked' && !(outcome === 'not-applicable' && step.when && !authorized(state, step))) fail('resume blocked step before recording');
    if (outcome === 'blocked' && !reason?.trim()) fail('blocked outcome needs reason');
    if (outcome === 'passed' && step.role === 'implementer' && ['pr', 'verified-change'].includes(state.taskIntent?.goal)
      && !cycleRoot(state).reviewCycle?.requirements.length) fail('freeze acceptance with the retained worker before implementation');
    const recoveryAssessment = recoveryAction ? assessRecovery(state, recoveryAction) : undefined;
    if (outcome === 'blocked' && recoveryAssessment?.decision === 'continue') fail('recoverable local action: execute recovery and verification instead of requesting approval or recording a blocker');
    const receipt = { stepId, generation, outcome, reason, data, recoveryAction, recoveryAssessment, activatedAt: state.activatedAt, evidence: validateEvidence(state, evidence), at: Date.now() };
    if (outcome !== 'blocked') {
      if (outcome === 'passed' && step.panelRequirement) {
        const plan = data?.panel;
        if (step.panelRequirement.optional && plan?.skipped === true && plan.reason?.trim() && receipt.evidence.some(item => item.kind === 'scope-exclusion')) receipt.panel = plan;
        else {
          const team = cycleRoot(state).reviewCycle;
          const eligible = [...(team?.specialists ?? []).filter(member => member.sourceClause === `${state.playbook}/${step.id}`), ...(step.panelRequirement.includeReviewer && team?.reviewer ? [{ agentId: team.reviewer, evidence: team.reviewerEvidence, ...team.reviewerModel }] : [])];
          if (!Number.isInteger(plan?.expectedCount) || plan.expectedCount < step.panelRequirement.minimum || !Array.isArray(plan.memberIds)
            || new Set(plan.memberIds).size !== plan.memberIds.length || plan.memberIds.length !== plan.expectedCount) fail('source panel needs its configured participant count and distinct IDs');
          const members = plan.memberIds.map(agentId => eligible.find(member => member.agentId === agentId));
          if (members.some(member => !member)) fail('source panel members must be registered independent participants');
          receipt.panel = { ...plan, members };
        }
      }
      if (!receiptAllowed(state, step, receipt)) fail('receipt lacks required evidence, authority, or conditional scope');
      receipt.children = outcome === 'passed' ? invocations(step).map(playbook => {
        const child = array(state.children[stepId]).find(c => c.playbook === playbook);
        if (!child) fail(`required child missing: ${playbook}`);
        validateChild(state, stepId, child, new Set([run]), true); return child;
      }) : [];
      if (!state.parent && state.reviewCycle && manifest.steps.at(-1).id === stepId && ['pr', 'verified-change'].includes(state.taskIntent?.goal)
        && !reviewContext(state.reviewCycle, state.workspace).approved) fail('independent review missing, stale, or has unresolved findings');
      state.stepId = advance(manifest, state, { type: 'RECORD', state, receipt });
      state.status = state.stepId === 'complete' ? 'complete' : 'active'; state.generation++; state.activatedAt = Date.now(); delete state.reason;
    } else { state.status = 'blocked'; state.reason = reason; }
    state.receipts.push(receipt); save(run, state, { type: 'record', stepId, outcome });
    return statusPlaybook(run);
  });
}
export function resumePlaybook(run) {
  return locked(run, run => {
    const { state } = load(run);
    if (state.holdPending) fail('propagate hold to every owner and record hold-acknowledgments before resume');
    if (state.status !== 'complete') {
      state.history.push(...state.receipts.filter(r => r.outcome === 'blocked'));
      state.receipts = state.receipts.filter(r => r.outcome !== 'blocked');
      if (state.status !== 'active') state.generation++;
      state.status = 'active'; delete state.reason; save(run, state, { type: 'resume', stepId: state.stepId });
    }
    return statusPlaybook(run);
  });
}
export function pausePlaybook({ run, reason = 'user stop', evidence = [] }) {
  return locked(run, run => {
    const { state } = load(run);
    if (state.status !== 'complete') {
      if (state.playbook === 'autopilot-full') {
        if (state.status !== 'paused') { state.holdPending = true; delete state.holdEvidence; }
        // Pause first: missing acknowledgments must never leave owners' work authorized.
        state.status = 'paused'; state.reason = reason; save(run, state, { type: 'hold-request' });
        if (evidence.length) {
          const accepted = validateEvidence(state, evidence);
          if (!accepted.some(e => e.kind === 'hold-acknowledgments')) fail('hold needs hold-acknowledgments evidence');
          state.holdEvidence = accepted; state.holdPending = false;
        }
      }
      state.status = 'paused'; state.reason = reason; save(run, state, { type: 'pause' });
    }
    return statusPlaybook(run);
  });
}
export function retryStep({ run, to, reason }) {
  return locked(run, run => {
    const { state, manifest } = load(run);
    if (state.status === 'paused' || !reason?.trim() || !array(manifest.loops).some(l => l.from === state.stepId && l.to === to)) fail('retry requires a declared loop and reason');
    const index = manifest.steps.findIndex(s => s.id === to);
    const invalid = new Set(manifest.steps.slice(index).map(s => s.id));
    state.history.push(...state.receipts.filter(r => invalid.has(r.stepId)));
    state.receipts = state.receipts.filter(r => !invalid.has(r.stepId));
    for (const id of invalid) { if (state.children[id]) state.history.push({ stepId: id, children: state.children[id], outcome: 'invalidated' }); delete state.children[id]; }
    state.stepId = advance(manifest, state, { type: 'RETRY', to, reason });
    state.status = 'active'; state.generation++; state.activatedAt = Date.now(); delete state.reason;
    save(run, state, { type: 'retry', to, reason }); return statusPlaybook(run);
  });
}
export function repairFinding({ run, findingId }) {
  return locked(run, run => {
    const { state, manifest } = load(run);
    if (['complete', 'paused'].includes(state.status)) fail('repair needs an unfinished active task');
    const root = cycleRoot(state);
    const destination = repairDestination(root.reviewCycle ?? newReviewCycle(), findingId);
    if (destination === 'defer') fail('optional improvement does not restart required work');
    const to = repairTarget(manifest, destination);
    if (!to) fail('selected playbook has no matching repair stage');
    const target = manifest.steps.find(step => step.id === to);
    if (!authorized(state, target)) fail('repair does not grant new authority');
    const index = manifest.steps.findIndex(step => step.id === to);
    if (index > manifest.steps.findIndex(step => step.id === state.stepId)) fail('repair cannot skip forward');
    const invalid = new Set(manifest.steps.slice(index).map(step => step.id));
    state.history.push(...state.receipts.filter(receipt => invalid.has(receipt.stepId)));
    state.receipts = state.receipts.filter(receipt => !invalid.has(receipt.stepId));
    for (const id of invalid) { if (state.children[id]) state.history.push({ type: 'repair-children', stepId: id, children: state.children[id] }); delete state.children[id]; }
    state.stepId = advance(manifest, state, { type: 'REPAIR', destination, findingId });
    state.status = 'active'; state.generation++; delete state.reason;
    save(run, state, { type: 'finding-repair', findingId, destination, to });
    return nextStepUnlocked(state);
  });
}
function nextStepUnlocked(state) { return { ...statusPlaybook(state.run), reviewContext: reviewContext(cycleRoot(state).reviewCycle ?? newReviewCycle(), state.workspace) }; }
export function startChild({ run, playbook }) {
  return locked(run, run => {
    const { state, manifest } = load(run);
    const step = manifest.steps.find(s => s.id === state.stepId);
    if (state.status !== 'active' || !step || !authorized(state, step) || !invocations(step).includes(playbook)) fail('child is not required by active authorized step');
    if (array(state.children[step.id]).some(c => c.playbook === playbook)) fail('child already linked; resume existing child');
    const token = randomUUID();
    const child = createRun({ workspace: state.workspace, playbook, requestFile: path.join(run, 'request.md'), grants: state.grants, taskIntent: state.taskIntent, parent: { run, stepId: step.id, token }, depth: state.depth + 1 });
    (state.children[step.id] ??= []).push({ run: child.run, playbook, token });
    save(run, state, { type: 'child', stepId: step.id, child: child.run }); return child;
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, ...args] = process.argv.slice(2); const options = {};
    for (let i = 0; i < args.length; i += 2) { if (!args[i].startsWith('--') || args[i + 1] == null) fail('expected --option value'); options[args[i].slice(2)] = args[i + 1]; }
    const commands = {
      start: () => {
        if (!options['intent-file']) fail('start requires --intent-file from intake');
        const taskIntent = read(options['intent-file']);
        return startPlaybook({ workspace: options.workspace, playbook: options.playbook ?? taskIntent.playbook, requestFile: options['request-file'], grants: options.grants?.split(',') ?? taskIntent.grants, taskIntent });
      },
      next: () => nextStep(options.run), status: () => statusPlaybook(options.run), resume: () => resumePlaybook(options.run),
      record: () => recordStep({ ...read(options['receipt-file']), run: options.run }),
      child: () => startChild(options), retry: () => retryStep(options), pause: () => pausePlaybook({ ...options, ...(options['receipt-file'] ? read(options['receipt-file']) : {}), run: options.run }),
      team: () => updateTeam({ ...read(options['operation-file']), run: options.run }),
      'repair-finding': () => repairFinding({ run: options.run, findingId: options['finding-id'] }),
    };
    if (!commands[command]) fail('expected start|next|status|record|child|retry|resume|pause|team|repair-finding');
    const result = commands[command]();
    console.log(JSON.stringify(result, null, 2));
    if (result.status === 'blocked') process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
