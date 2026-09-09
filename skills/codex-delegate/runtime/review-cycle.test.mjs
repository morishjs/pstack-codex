import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { newReviewCycle, updateReviewCycle, reviewContext, repairDestination } from './review-cycle.mjs';
import { startPlaybook, nextStep, recordStep, updateTeam, repairFinding } from './playbook-controller.mjs';
import { resolveIntent } from './task-intent.mjs';

function fixture(t) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'review-cycle-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  for (const file of ['migration.mjs', 'send.mjs', 'proof.txt']) fs.writeFileSync(path.join(workspace, file), file);
  const evidence = [{ kind: 'review', path: path.join(workspace, 'proof.txt'), sha256: createHash('sha256').update('proof.txt').digest('hex') }];
  const cycle = newReviewCycle('worker');
  const op = operation => {
    if (operation.type === 'finding') operation = { basis: 'design-omission', ...operation };
    let proof = evidence;
    if (operation.type === 'assign' && operation.role !== 'worker') {
      const file = path.join(workspace, operation.agentId + '-host.json');
      const data = JSON.stringify({ agentId: operation.agentId, parentAgentId: cycle.worker, independent: true, model: 'fixture-model', reasoningEffort: 'medium' });
      fs.writeFileSync(file, data); proof = [...evidence, { kind: 'host-assignment', path: file, sha256: createHash('sha256').update(data).digest('hex') }];
    }
    return updateReviewCycle(cycle, workspace, operation, proof);
  };
  op({ type: 'assign', role: 'reviewer', agentId: 'reviewer' });
  op({ type: 'assess-design', actorId: 'worker', clear: true, reason: 'Existing sending path and requested outcome are clear', questions: [] });
  op({ type: 'acceptance', actorId: 'worker', requirements: [{ id: 'send', text: 'Send with the correct tenant fields', implementationFiles: ['send.mjs'], verification: 'Sender behavior checks', decisionIds: [] }] });
  return { workspace, evidence, assignmentEvidence: cycle.reviewerEvidence, cycle, op };
}
test('two retained roles survive repeated findings and independent review resolves each fix', t => {
  const { workspace, cycle, op } = fixture(t);
  assert.throws(() => op({ type: 'assign', role: 'worker', agentId: 'new-worker' }), /reuse/);
  assert.throws(() => op({ type: 'assign', role: 'reviewer', agentId: 'worker' }), /reuse|independent/);
  for (const id of ['tenant-name', 'loading-race']) {
    op({ type: 'finding', actorId: 'reviewer', id, kind: 'implementation', required: true, requirementId: 'send', summary: id, affectedFiles: ['send.mjs'] });
    assert.throws(() => op({ type: 'resolve', actorId: 'worker', id }), /retained role/);
    op({ type: 'fixed', actorId: 'worker', id }); op({ type: 'resolve', actorId: 'reviewer', id });
  }
  const context = reviewContext(cycle, workspace);
  assert.equal(context.worker, 'worker'); assert.equal(context.reviewer, 'reviewer'); assert.equal(context.findings.length, 2);
  assert.equal(context.history.filter(item => item.type === 'resolve').length, 2);
});
test('only changed verification inputs invalidate proof and approval cannot hide stale checks', t => {
  const { workspace, cycle, op } = fixture(t);
  for (const file of ['migration.mjs', 'send.mjs']) op({ type: 'verify', actorId: 'worker', id: file, requirementIds: ['send'], inputFiles: [file] });
  op({ type: 'approve', actorId: 'reviewer', inputFiles: ['migration.mjs', 'send.mjs'] });
  assert.equal(reviewContext(cycle, workspace).approved, true);
  fs.writeFileSync(path.join(workspace, 'send.mjs'), 'fixed sender');
  let context = reviewContext(cycle, workspace);
  assert.equal(context.verification.find(c => c.id === 'migration.mjs').reusable, true);
  assert.equal(context.verification.find(c => c.id === 'send.mjs').reusable, false);
  assert.equal(context.approved, false);
  assert.throws(() => op({ type: 'approve', actorId: 'reviewer', inputFiles: ['migration.mjs', 'send.mjs'] }), /stale verification/);
  op({ type: 'verify', actorId: 'worker', id: 'send.mjs', requirementIds: ['send'], inputFiles: ['send.mjs'] });
  op({ type: 'approve', actorId: 'reviewer', inputFiles: ['migration.mjs', 'send.mjs'] });
  assert.equal(reviewContext(cycle, workspace).approved, true);
});
test('extra participants and required findings need explicit existing scope', t => {
  const { cycle, op } = fixture(t);
  assert.throws(() => op({ type: 'assign', role: 'specialist', agentId: 'extra' }), /clause/);
  op({ type: 'assign', role: 'specialist', agentId: 'extra', reason: 'Independent design alternative', sourceClause: 'architect/Sketch' });
  assert.equal(cycle.specialists.length, 1);
  assert.throws(() => op({ type: 'finding', actorId: 'reviewer', id: 'scope', kind: 'implementation', required: true, requirementId: 'invented', summary: 'new scope', affectedFiles: ['send.mjs'] }), /existing acceptance/);
  assert.throws(() => op({ type: 'finding', actorId: 'reviewer', id: 'polish', kind: 'improvement', required: true, requirementId: 'send', summary: 'polish', affectedFiles: ['send.mjs'] }), /silently expand/);
  for (const kind of ['environment', 'format', 'acceptance', 'design']) {
    op({ type: 'finding', actorId: 'reviewer', id: kind, kind, required: true, requirementId: 'send', summary: kind, affectedFiles: ['send.mjs'] });
    assert.equal(repairDestination(cycle, kind), { environment: 'verify', format: 'verify', acceptance: 'acceptance', design: 'design' }[kind]);
  }
  assert.throws(() => op({ type: 'approve', actorId: 'reviewer', inputFiles: ['send.mjs'] }), /unresolved/);
});
test('XState repair preserves roles and history and format repair stays at verification', t => {
  const { workspace, evidence, assignmentEvidence } = fixture(t);
  const request = 'Implement tenant-safe sending'; fs.writeFileSync(path.join(workspace, 'request.md'), request);
  const taskIntent = resolveIntent(request, { kind: 'implementation', restriction: 'none', requestedDelivery: 'local', playbook: 'feature', reason: 'New local behavior' });
  const run = startPlaybook({ workspace, requestFile: path.join(workspace, 'request.md'), playbook: 'feature', grants: taskIntent.grants, taskIntent, workerId: 'worker' }).run;
  const team = operation => updateTeam({ run, operation: operation.type === 'finding' ? { basis: 'design-omission', ...operation } : operation, evidence: operation.type === 'assign' ? assignmentEvidence : evidence });
  team({ type: 'assign', role: 'reviewer', agentId: 'reviewer' });
  team({ type: 'assess-design', actorId: 'worker', clear: true, reason: 'Clear existing behavior change', questions: [] });
  team({ type: 'acceptance', actorId: 'worker', requirements: [{ id: 'send', text: 'Correct sending', implementationFiles: ['send.mjs'], verification: 'Sender behavior', decisionIds: [] }] });
  while (nextStep(run).stepId !== 'verify') {
    const current = nextStep(run);
    recordStep({ run, stepId: current.stepId, generation: current.generation, outcome: 'passed',
      data: current.panelRequirement ? { panel: { skipped: true, reason: 'Source permits single design' } } : undefined,
      evidence: [...current.evidence, ...(current.panelRequirement ? ['scope-exclusion'] : [])].map(kind => ({ ...evidence[0], kind })) });
  }
  team({ type: 'verify', actorId: 'worker', id: 'migration', requirementIds: ['send'], inputFiles: ['migration.mjs'] });
  team({ type: 'finding', actorId: 'reviewer', id: 'format', kind: 'format', required: true, requirementId: 'send', summary: 'Format the touched test', affectedFiles: ['send.mjs'] });
  assert.equal(repairFinding({ run, findingId: 'format' }).stepId, 'verify');
  let context = nextStep(run).reviewContext;
  assert.equal(context.worker, 'worker'); assert.equal(context.reviewer, 'reviewer'); assert.equal(context.verification[0].reusable, true);
  team({ type: 'finding', actorId: 'reviewer', id: 'bug', kind: 'implementation', required: true, requirementId: 'send', summary: 'Tenant replacement', affectedFiles: ['send.mjs'] });
  assert.equal(repairFinding({ run, findingId: 'bug' }).stepId, 'implement');
  context = nextStep(run).reviewContext;
  assert.equal(context.findings.length, 2); assert.equal(context.verification[0].reusable, true);
});

test('approval rejects omitted affected code and invalidates changed fix, resolution and assignment evidence', t => {
  const { workspace, cycle, evidence, op } = fixture(t);
  assert.throws(() => updateReviewCycle(newReviewCycle('worker'), workspace, { type: 'assign', role: 'reviewer', agentId: 'reviewer' }, evidence), /host-assignment/);
  op({ type: 'finding', actorId: 'reviewer', id: 'F1', kind: 'implementation', required: true, requirementId: 'send', summary: 'Sender defect', affectedFiles: ['send.mjs'] });
  op({ type: 'fixed', actorId: 'worker', id: 'F1' }); op({ type: 'resolve', actorId: 'reviewer', id: 'F1' });
  op({ type: 'verify', actorId: 'worker', id: 'check', requirementIds: ['send'], inputFiles: ['migration.mjs'] });
  assert.throws(() => op({ type: 'approve', actorId: 'reviewer', inputFiles: ['migration.mjs'] }), /affected finding/);
  op({ type: 'approve', actorId: 'reviewer', inputFiles: ['migration.mjs', 'send.mjs'] });
  assert.equal(reviewContext(cycle, workspace).approved, true);
  fs.writeFileSync(path.join(workspace, 'proof.txt'), 'changed fix or resolution proof');
  assert.equal(reviewContext(cycle, workspace).approved, false);
  fs.writeFileSync(path.join(workspace, 'proof.txt'), 'proof.txt');
  fs.writeFileSync(path.join(workspace, 'reviewer-host.json'), '{}');
  assert.equal(reviewContext(cycle, workspace).approved, false);
});

test('Git changes since start must be in approval and new changes invalidate it', t => {
  const { workspace, evidence } = fixture(t);
  const git = (...args) => execFileSync('git', args, { cwd: workspace, stdio: 'pipe' });
  git('init', '-q'); git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'baseline');
  const cycle = newReviewCycle('worker', workspace);
  const op = operation => updateReviewCycle(cycle, workspace, operation, [...evidence, { kind: 'host-assignment', path: path.join(workspace, 'reviewer-host.json'), sha256: createHash('sha256').update(fs.readFileSync(path.join(workspace, 'reviewer-host.json'))).digest('hex') }]);
  op({ type: 'assign', role: 'reviewer', agentId: 'reviewer' });
  op({ type: 'assess-design', actorId: 'worker', clear: true, reason: 'Clear sender requirement', questions: [] });
  op({ type: 'acceptance', actorId: 'worker', requirements: [{ id: 'send', text: 'Correct sender', implementationFiles: ['migration.mjs'], verification: 'Existing check', decisionIds: [] }] });
  fs.writeFileSync(path.join(workspace, 'send.mjs'), 'changed sender');
  op({ type: 'verify', actorId: 'worker', id: 'check', requirementIds: ['send'], inputFiles: ['migration.mjs'] });
  assert.throws(() => op({ type: 'approve', actorId: 'reviewer', inputFiles: ['migration.mjs'] }), /actual changed files/);
  op({ type: 'approve', actorId: 'reviewer', inputFiles: ['migration.mjs', 'send.mjs'] });
  assert.equal(reviewContext(cycle, workspace).approved, true);
  fs.writeFileSync(path.join(workspace, 'new.mjs'), 'new code');
  assert.equal(reviewContext(cycle, workspace).approved, false);
});

test('out-of-scope findings are deferred without revoking approval; blocking dependencies need scope disposition', t => {
  const { workspace, cycle, evidence, op } = fixture(t);
  op({ type: 'verify', actorId: 'worker', id: 'send', requirementIds: ['send'], inputFiles: ['send.mjs'] });
  op({ type: 'approve', actorId: 'reviewer', inputFiles: ['send.mjs'] });
  op({ type: 'finding', actorId: 'reviewer', id: 'old-ui', kind: 'improvement', basis: 'preexisting', required: false, summary: 'Unrelated existing UI issue', affectedFiles: ['migration.mjs'] });
  assert.equal(reviewContext(cycle, workspace).approved, true);
  assert.equal(reviewContext(cycle, workspace).followups.length, 1);
  assert.equal(repairDestination(cycle, 'old-ui'), 'defer');
  assert.throws(() => op({ type: 'fixed', actorId: 'worker', id: 'old-ui' }), /not current implementation scope/);
  assert.throws(() => op({ type: 'finding', actorId: 'reviewer', id: 'hidden', kind: 'implementation', basis: 'change-regression', required: false, summary: 'Actual regression', affectedFiles: ['send.mjs'] }), /cannot be downgraded/);
  op({ type: 'finding', actorId: 'reviewer', id: 'dependency', kind: 'implementation', basis: 'blocking-dependency', required: true, requirementId: 'send', summary: 'New dependency prevents safe sending', affectedFiles: ['send.mjs'] });
  assert.throws(() => repairDestination(cycle, 'dependency'), /scope decision/);
  assert.throws(() => op({ type: 'scope-decision', actorId: 'reviewer', id: 'dependency', choice: 'include', reason: 'Expand scope' }), /actual user input/);
  op({ type: 'scope-decision', actorId: 'reviewer', id: 'dependency', choice: 'within-scope', checkIds: ['dependency-check'], reason: 'Existing boundary can safely handle the case without a policy change' });
  assert.equal(repairDestination(cycle, 'dependency'), 'implement');
  op({ type: 'fixed', actorId: 'worker', id: 'dependency' }); op({ type: 'resolve', actorId: 'reviewer', id: 'dependency' });
  assert.throws(() => op({ type: 'approve', actorId: 'reviewer', inputFiles: ['send.mjs'] }), /dependency verification/);
  op({ type: 'verify', actorId: 'worker', id: 'dependency-check', requirementIds: ['send'], inputFiles: ['migration.mjs'] });
  assert.throws(() => op({ type: 'approve', actorId: 'reviewer', inputFiles: ['send.mjs', 'migration.mjs'] }), /dependency verification/);
  op({ type: 'verify', actorId: 'worker', id: 'dependency-check', requirementIds: ['send'], inputFiles: ['send.mjs'] });
  op({ type: 'approve', actorId: 'reviewer', inputFiles: ['send.mjs'] });
  assert.equal(reviewContext(cycle, workspace).approved, true);
});
