import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { newDesignGate, designContext, updateDesign, validateDesignCoverage } from './design-gate.mjs';

const ensure = (ok, message) => { if (!ok) throw new Error(message); };
const digest = file => fs.existsSync(file) ? createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null;
const kinds = ['implementation', 'design', 'acceptance', 'environment', 'format', 'improvement'];
const git = (workspace, args) => execFileSync('git', ['-C', workspace, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();
function changes(workspace, head) {
  const tracked = git(workspace, ['diff', '--name-only', '-z', head]).split('\0').filter(Boolean);
  const untracked = git(workspace, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean)
    .filter(file => !file.split('/').some(part => ['.codex-delegate', '.pnpm-store', 'node_modules', '.cache', 'coverage'].includes(part)));
  return [...new Set([...tracked, ...untracked])];
}
function baseline(workspace) {
  if (!workspace) return null;
  try {
    if (fs.realpathSync(git(workspace, ['rev-parse', '--show-toplevel'])) !== fs.realpathSync(workspace)) return null;
    const head = git(workspace, ['rev-parse', 'HEAD']);
    return { head, existing: Object.fromEntries(changes(workspace, head).map(file => [file, digest(path.join(workspace, file))])) };
  } catch { return null; }
}
function changedFiles(cycle, workspace) {
  return cycle.baseline ? changes(workspace, cycle.baseline.head).filter(file => !Object.hasOwn(cycle.baseline.existing, file) || digest(path.join(workspace, file)) !== cycle.baseline.existing[file]) : [];
}
export const newReviewCycle = (worker = null, workspace) => ({ worker, reviewer: null, reviewerEvidence: [], baseline: baseline(workspace), design: newDesignGate(), specialists: [], requirements: [], findings: [], checks: [], approval: null, history: [] });
function inputs(workspace, files) {
  ensure(Array.isArray(files) && files.length, 'explicit verification input files required');
  return Object.fromEntries(files.map(file => {
    ensure(typeof file === 'string' && file && !path.isAbsolute(file) && !file.split(/[\\/]/).includes('..') && !/[?*]/.test(file), 'inputs must be literal workspace-relative files');
    const full = path.resolve(workspace, file);
    if (fs.existsSync(full)) ensure(fs.statSync(full).isFile() && fs.realpathSync(full).startsWith(fs.realpathSync(workspace) + path.sep), 'input must be a workspace file, not a directory or external symlink');
    return [file, digest(full)];
  }));
}
function valid(workspace, check) {
  try { return Object.entries(check.inputs).every(([file, hash]) => digest(path.resolve(workspace, file)) === hash)
    && check.evidence.every(item => digest(item.path) === item.sha256); } catch { return false; }
}
const fixedInputsValid = (workspace, finding) => Object.entries(finding.fixInputs ?? {}).every(([file, hash]) => digest(path.join(workspace, file)) === hash);
export function reviewContext(cycle, workspace) {
  const evidenceValid = evidence => evidence.every(item => digest(item.path) === item.sha256);
  const findingsIntact = cycle.findings.filter(f => f.required).every(f => evidenceValid(f.evidence) && evidenceValid(f.scopeDecision?.evidence ?? []) && (f.status !== 'resolved' || fixedInputsValid(workspace, f)))
    && cycle.history.filter(item => ['fixed', 'resolve'].includes(item.type) && cycle.findings.some(f => f.id === item.id && f.required)).every(item => evidenceValid(item.evidence))
    && evidenceValid(cycle.reviewerEvidence ?? []);
  const designIntact = !cycle.design || evidenceValid(cycle.design.evidence) && cycle.design.questions.every(q => evidenceValid(q.answer?.evidence ?? []) && evidenceValid(q.confirmation ?? []));
  const changed = changedFiles(cycle, workspace);
  return { worker: cycle.worker, reviewer: cycle.reviewer, specialists: cycle.specialists,
    participantCount: Number(Boolean(cycle.worker)) + Number(Boolean(cycle.reviewer)) + cycle.specialists.length,
    findings: cycle.findings.map(f => ({ ...f, needsRecheck: f.status === 'resolved' && !fixedInputsValid(workspace, f) })), history: cycle.history,
    verification: cycle.checks.map(check => ({ ...check, reusable: valid(workspace, check) })),
    requirements: cycle.requirements,
    design: cycle.design ? designContext(cycle.design) : null,
    designIntact,
    followups: cycle.findings.filter(f => !f.required),
    scopeDecisions: cycle.findings.filter(f => f.basis === 'blocking-dependency' && !['include', 'within-scope'].includes(f.scopeDecision?.choice)),
    changedFiles: changed, diffCoverage: cycle.baseline ? 'git-since-start' : 'explicit-inputs-only',
    findingsIntact,
    approved: Boolean(designIntact && findingsIntact && cycle.approval && changed.every(file => Object.hasOwn(cycle.approval.inputs, file)) && cycle.checks.every(check => valid(workspace, check)) && !cycle.findings.some(f => f.required && f.status !== 'resolved') && valid(workspace, cycle.approval)) };
}
export function updateReviewCycle(cycle, workspace, operation, evidence) {
  const op = operation;
  if (op.type === 'assign') {
    ensure(['worker', 'reviewer', 'specialist'].includes(op.role) && typeof op.agentId === 'string' && op.agentId.trim(), 'actual agent ID and role required');
    let assigned;
    if (op.role !== 'worker') {
      const receipt = evidence.find(item => item.kind === 'host-assignment');
      ensure(receipt, 'participant needs host-assignment evidence');
      assigned = JSON.parse(fs.readFileSync(receipt.path, 'utf8'));
      ensure(assigned.agentId === op.agentId && assigned.parentAgentId === cycle.worker && assigned.independent === true && assigned.model && assigned.reasoningEffort, 'host assignment must identify the independent participant and parent');
    }
    if (op.role === 'specialist') {
      ensure(op.reason?.trim() && op.sourceClause?.trim() && evidence.length, 'extra agents need a playbook clause, reason and evidence');
      ensure(![cycle.worker, cycle.reviewer, ...cycle.specialists.map(s => s.agentId)].includes(op.agentId), 'agent already registered');
      cycle.specialists.push({ agentId: op.agentId, model: assigned.model, modelFamily: assigned.modelFamily, reasoningEffort: assigned.reasoningEffort, sourceClause: op.sourceClause, reason: op.reason, evidence });
    } else {
      ensure(!cycle[op.role] || cycle[op.role] === op.agentId, 'reuse the existing role session; phase changes cannot replace it');
      ensure(cycle[op.role === 'worker' ? 'reviewer' : 'worker'] !== op.agentId && !cycle.specialists.some(s => s.agentId === op.agentId), 'worker and reviewer must be independent');
      if (op.role === 'reviewer') {
        cycle.reviewerEvidence = evidence;
        cycle.reviewerModel = { model: assigned.model, modelFamily: assigned.modelFamily, reasoningEffort: assigned.reasoningEffort };
      }
      cycle[op.role] = op.agentId;
    }
    return;
  }
  ensure(cycle.worker, 'register the retained worker');
  ensure(evidence.length, 'operation requires real evidence');
  if (['assess-design', 'grill-question', 'grill-answer', 'grill-confirm', 'design-ready'].includes(op.type)) {
    ensure(!cycle.requirements.length, 'design is frozen; use a scoped finding rather than reopening all design');
    updateDesign(cycle.design ??= newDesignGate(), cycle, op, evidence); return;
  }
  if (op.type === 'acceptance') {
    ensure(op.actorId === cycle.worker && !cycle.requirements.length, 'worker freezes requirements once; a new user scope needs a new contract');
    ensure(Array.isArray(op.requirements) && op.requirements.length && op.requirements.every(r => r.id?.trim() && r.text?.trim()), 'nonempty requirement IDs and text required');
    ensure(new Set(op.requirements.map(r => r.id)).size === op.requirements.length, 'duplicate requirement ID');
    if (cycle.design) {
      ensure(reviewContext(cycle, workspace).designIntact, 'design evidence changed before acceptance');
      validateDesignCoverage(cycle.design, op.requirements);
      for (const requirement of op.requirements) inputs(workspace, requirement.implementationFiles);
    }
    cycle.requirements = op.requirements; cycle.history.push({ type: 'acceptance', requirements: op.requirements, evidence }); return;
  }
  if (op.type === 'finding') {
    ensure(cycle.reviewer, 'register the independent reviewer');
    ensure(op.actorId === cycle.reviewer, 'only the retained reviewer records findings');
    ensure(op.id?.trim() && op.summary?.trim() && kinds.includes(op.kind) && typeof op.required === 'boolean', 'finding needs ID, summary, kind and required flag');
    ensure(!cycle.findings.some(f => f.id === op.id), 'existing finding ID must be reused via fix/resolve, not redefined');
    ensure(!op.required || cycle.requirements.some(r => r.id === op.requirementId), 'required findings must identify an existing acceptance requirement');
    if (cycle.design) ensure(['design-omission', 'change-regression', 'blocking-dependency', 'preexisting', 'improvement'].includes(op.basis), 'classify why the finding belongs in this review');
    ensure(!['design-omission', 'change-regression', 'blocking-dependency'].includes(op.basis) || op.required, 'design omissions, regressions and blocking dependencies cannot be downgraded to optional');
    ensure(!['preexisting', 'improvement'].includes(op.basis) || !op.required, 'out-of-scope existing issues and improvements belong in followups');
    ensure(op.kind !== 'improvement' || !op.required, 'improvement cannot silently expand completion requirements');
    const affectedInputs = inputs(workspace, op.affectedFiles);
    cycle.findings.push({ id: op.id, summary: op.summary, kind: op.kind, basis: op.basis, required: op.required, requirementId: op.requirementId,
      affectedFiles: Object.keys(affectedInputs), status: 'open', evidence });
    if (op.required) cycle.approval = null;
  } else if (op.type === 'scope-decision') {
    const finding = cycle.findings.find(f => f.id === op.id);
    ensure(op.actorId === cycle.reviewer && finding?.basis === 'blocking-dependency' && finding.status === 'open' && ['include', 'within-scope', 'defer'].includes(op.choice) && op.reason?.trim(), 'reviewer records the open blocking dependency disposition');
    if (op.choice === 'include') ensure(op.userQuote?.trim() && evidence.some(e => e.kind === 'user-decision'), 'scope expansion needs actual user input');
    if (op.choice !== 'defer') ensure(Array.isArray(op.checkIds) && op.checkIds.length && op.checkIds.every(id => typeof id === 'string' && id.trim()), 'scope decision must map dependency verification check IDs');
    finding.scopeDecision = { choice: op.choice, reason: op.reason, userQuote: op.userQuote, checkIds: op.checkIds, evidence }; cycle.approval = null;
  } else if (op.type === 'reopen') {
    const finding = cycle.findings.find(f => f.id === op.id);
    ensure(op.actorId === cycle.reviewer && finding?.status === 'resolved', 'reviewer reopens an existing resolved finding');
    finding.status = 'open'; cycle.approval = null;
    cycle.history.push({ type: 'reopen', id: op.id, actorId: op.actorId, evidence });
  } else if (op.type === 'fixed' || op.type === 'resolve') {
    const finding = cycle.findings.find(f => f.id === op.id);
    ensure(finding, 'unknown finding');
    ensure(finding.required, 'deferred finding is not current implementation scope');
    ensure(finding.basis !== 'blocking-dependency' || ['include', 'within-scope'].includes(finding.scopeDecision?.choice), 'resolve scope before fixing a newly discovered blocking dependency');
    ensure(op.actorId === (op.type === 'fixed' ? cycle.worker : cycle.reviewer), 'finding transition belongs to its retained role');
    ensure(finding.status === (op.type === 'fixed' ? 'open' : 'fixed'), 'invalid finding transition');
    if (op.type === 'fixed') { finding.fixInputs = inputs(workspace, finding.affectedFiles); finding.fixVerificationVersion = cycle.verificationVersion ?? 0; }
    else ensure(Object.entries(finding.fixInputs).every(([file, hash]) => digest(path.join(workspace, file)) === hash), 'fix inputs changed before resolution');
    finding.status = op.type === 'fixed' ? 'fixed' : 'resolved';
    cycle.history.push({ type: op.type, id: op.id, actorId: op.actorId, evidence, summary: op.summary });
    cycle.approval = null;
  } else if (op.type === 'verify') {
    ensure(op.actorId === cycle.worker && op.id?.trim(), 'verification belongs to retained worker and needs a check ID');
    ensure(Array.isArray(op.requirementIds) && op.requirementIds.length && op.requirementIds.every(id => cycle.requirements.some(r => r.id === id)), 'verification must map to frozen requirements');
    cycle.verificationVersion = (cycle.verificationVersion ?? 0) + 1;
    const check = { id: op.id, version: cycle.verificationVersion, requirementIds: op.requirementIds, inputs: inputs(workspace, op.inputFiles), evidence };
    const prior = cycle.checks.find(c => c.id === op.id);
    if (prior) cycle.history.push({ type: 'previous-check', check: prior });
    cycle.checks = [...cycle.checks.filter(c => c.id !== op.id), check];
    cycle.approval = null;
  } else if (op.type === 'approve') {
    ensure(cycle.reviewer && op.actorId === cycle.reviewer, 'only the retained independent reviewer approves');
    ensure(cycle.requirements.length, 'acceptance requirements are not frozen');
    ensure(!cycle.findings.some(f => f.required && f.status !== 'resolved'), 'required findings are unresolved');
    ensure(reviewContext(cycle, workspace).findingsIntact, 'finding or assignment evidence changed; recheck or restore proof');
    ensure(reviewContext(cycle, workspace).designIntact, 'design evidence changed; restore or revalidate the design');
    ensure(cycle.checks.length && cycle.checks.every(check => valid(workspace, check)), 'missing or stale verification; rerun affected checks');
    ensure(cycle.requirements.every(requirement => cycle.checks.some(check => check.requirementIds.includes(requirement.id))), 'unverified acceptance requirement');
    for (const finding of cycle.findings.filter(f => f.required && f.basis === 'blocking-dependency')) {
      ensure(finding.scopeDecision?.checkIds?.every(id => cycle.checks.some(check => check.id === id && check.version > finding.fixVerificationVersion
        && check.requirementIds.includes(finding.requirementId) && finding.affectedFiles.every(file => Object.hasOwn(check.inputs, file)))), 'blocking dependency verification is missing or predates the fix');
    }
    const snapshot = inputs(workspace, op.inputFiles);
    ensure(cycle.checks.every(check => Object.keys(check.inputs).every(file => Object.hasOwn(snapshot, file))), 'review inputs must cover verification inputs');
    ensure(cycle.findings.filter(f => f.required).every(f => f.affectedFiles.every(file => Object.hasOwn(snapshot, file))), 'review inputs must cover affected finding files');
    ensure(cycle.requirements.every(r => (r.implementationFiles ?? []).every(file => Object.hasOwn(snapshot, file))), 'review inputs must cover the agreed implementation locations');
    ensure(changedFiles(cycle, workspace).every(file => Object.hasOwn(snapshot, file)), 'review inputs must cover the actual changed files');
    cycle.approval = { inputs: snapshot, evidence };
  } else throw new Error('unknown review-cycle operation');
}

export function repairDestination(cycle, id) {
  const finding = cycle.findings.find(f => f.id === id);
  ensure(finding && finding.status !== 'resolved', 'open finding required for repair');
  if (!finding.required) return 'defer';
  ensure(finding.basis !== 'blocking-dependency' || ['include', 'within-scope'].includes(finding.scopeDecision?.choice), 'scope decision required before implementation');
  return { implementation: 'implement', design: 'design', acceptance: 'acceptance', environment: 'verify', format: 'verify', improvement: 'defer' }[finding.kind];
}
