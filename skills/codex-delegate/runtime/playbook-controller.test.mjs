import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PLAYBOOKS, getPlaybook } from './playbook-catalog.mjs';
import { resolveIntent } from './task-intent.mjs';
import { compilePlaybook, startPlaybook, nextStep, recordStep, retryStep, startChild, resumePlaybook, statusPlaybook, pausePlaybook } from './playbook-controller.mjs';

const all = Object.keys(PLAYBOOKS).map(getPlaybook);
const grants = [...new Set(all.flatMap(p => p.steps.flatMap(s => Array.isArray(s.authority) ? s.authority : [s.authority])))];
function fixture(t, playbook = all[0].id, allowed = grants) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'playbook-test-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const requestFile = path.join(workspace, 'input.md'); fs.writeFileSync(requestFile, 'Host task');
  const taskIntent = resolveIntent('Host task', { kind: 'other', restriction: 'none', requestedDelivery: 'unspecified', playbook, reason: 'Controller-only fixture for a specialized playbook' });
  return startPlaybook({ workspace, playbook, requestFile, grants: allowed, taskIntent }).run;
}
function evidence(run, kinds) {
  return kinds.map(kind => {
    const file = path.join(run, 'artifacts', `${kind}-${Math.random()}.log`);
    fs.writeFileSync(file, `Host semantic verdict for ${kind}`);
    return { kind, path: file };
  });
}
function pass(run, { skip = true } = {}) {
  const current = nextStep(run);
  const step = getPlaybook(current.playbook).steps.find(s => s.id === current.stepId);
  if (!skip || !step.when) for (const invocation of step.invokes ?? []) {
    const child = startChild({ run, playbook: typeof invocation === 'string' ? invocation : invocation.playbook });
    finish(child.run);
  }
  return recordStep({ run, stepId: step.id, generation: current.generation,
    outcome: skip && step.when ? 'not-applicable' : 'passed', reason: 'Host confirmed the conditional branch is outside this request',
    data: Object.fromEntries((step.assertions ?? []).map(a => [a.field, a.equals])),
    evidence: evidence(run, skip && step.when ? ['scope-exclusion'] : step.evidence) });
}
function finish(run) {
  for (let i = 0; i < 100; i++) { if (statusPlaybook(run).status === 'complete') return; pass(run); }
  assert.fail('playbook did not finish');
}

test('all 23 playbooks compile unique guarded machines and complete with host receipts', t => {
  assert.equal(all.length, 23);
  assert.equal(new Set(all.map(p => compilePlaybook(p).id)).size, 23);
  for (const manifest of all) {
    const machine = compilePlaybook(manifest);
    for (const step of manifest.steps) assert.equal(typeof machine.config.states[step.id].on.RECORD.guard, 'function');
    const run = fixture(t, manifest.id); finish(run);
    assert.equal(statusPlaybook(run).status, 'complete');
  }
});

test('every conditional step independently accepts its applicable branch with required children', t => {
  for (const manifest of all) for (const target of manifest.steps.filter(s => s.when)) {
    const run = fixture(t, manifest.id);
    while (statusPlaybook(run).stepId !== target.id) pass(run);
    pass(run, { skip: false });
    assert.ok(statusPlaybook(run).completedSteps.includes(target.id), `${manifest.id}/${target.id}`);
  }
});

test('order, required evidence, unconditional skip and stale generation are rejected', t => {
  const manifest = all.find(p => !p.steps[0].when);
  const run = fixture(t, manifest.id); const current = nextStep(run);
  const base = { run, stepId: current.stepId, generation: current.generation, outcome: 'passed' };
  assert.throws(() => recordStep({ ...base, stepId: 'foreign' }), /not active/);
  assert.throws(() => recordStep(base), /required evidence/);
  assert.throws(() => recordStep({ ...base, generation: 0 }), /generation/);
  assert.throws(() => recordStep({ ...base, outcome: 'not-applicable', reason: 'skip', evidence: evidence(run, ['scope-exclusion']) }), /required evidence/);
});

test('conditional exclusions stay separate from completed steps with their reasons and evidence', t => {
  const run = fixture(t, 'authoring-a-skill'); finish(run);
  const status = statusPlaybook(run);
  assert.ok(status.skippedSteps.length);
  for (const skipped of status.skippedSteps) {
    assert.ok(!status.completedSteps.includes(skipped.stepId));
    assert.ok(skipped.reason && skipped.evidence.some(e => e.kind === 'scope-exclusion'));
  }
});

test('shipping hard failure reaches exit without inventing a merged SHA', t => {
  const run = fixture(t, 'shipping');
  while (statusPlaybook(run).stepId !== 'watch') pass(run);
  pass(run);
  assert.equal(nextStep(run).stepId, 'recompute');
  const current = nextStep(run);
  recordStep({ run, stepId: current.stepId, generation: current.generation, outcome: 'not-applicable',
    reason: 'PR closed without merge; hard failure captured in watch evidence', evidence: evidence(run, ['scope-exclusion']) });
  assert.equal(nextStep(run).stepId, 'exit');
  finish(run);
  assert.ok(statusPlaybook(run).skippedSteps.some(s => s.stepId === 'recompute'));
});

test('autopilot hold pauses immediately and cannot resume before owner acknowledgments', t => {
  const run = fixture(t, 'autopilot-full'); pass(run);
  const stepId = nextStep(run).stepId;
  const paused = pausePlaybook({ run });
  assert.equal(paused.status, 'paused');
  assert.deepEqual(paused.holdRequired.evidence, ['hold-acknowledgments']);
  assert.throws(() => resumePlaybook(run), /hold-acknowledgments/);
  const ack = evidence(run, ['hold-acknowledgments']);
  pausePlaybook({ run, evidence: ack });
  assert.equal(resumePlaybook(run).stepId, stepId);
  pausePlaybook({ run });
  assert.throws(() => resumePlaybook(run), /hold-acknowledgments/);
});

test('next exposes source paths and model recommendations without invoking models', t => {
  const run = fixture(t); const current = nextStep(run);
  assert.equal(current.modelPolicy.planning, 'gpt-6-astra');
  assert.equal(current.modelPolicy.implementation, 'gpt-5.6-terra');
  assert.equal(current.modelPolicy.review, 'gpt-5.6-sol');
  assert.equal(current.modelPolicy.reviewSession, 'fresh');
  for (const file of [current.source, current.runtimeGuide, current.executionPolicy, current.requestFile]) assert.ok(fs.statSync(file).isFile());
  assert.equal(current.role, getPlaybook(current.playbook).steps[0].role);
});

test('missing authority withholds instructions', t => {
  const candidates = all.map(p => ({ p, s: p.steps.find(s => s.authority !== 'read-only') })).filter(({ s }) => s && !s.when);
  assert.ok(candidates.length);
  const { p, s } = candidates[0]; const run = fixture(t, p.id, ['read-only']);
  while (statusPlaybook(run).stepId !== s.id) pass(run);
  const next = nextStep(run); assert.equal(next.status, 'blocked'); assert.equal(next.instruction, undefined);
});

test('local grant does not authorize remote actions; conditional exclusions require evidence', t => {
  const manifest = all.find(p => p.steps.some(s => s.authority === 'remote-write' && s.when));
  const target = manifest.steps.find(s => s.authority === 'remote-write' && s.when);
  const run = fixture(t, manifest.id, ['read-only', 'local-workspace']);
  while (statusPlaybook(run).stepId !== target.id) pass(run);
  const next = nextStep(run);
  assert.equal(next.status, 'blocked'); assert.equal(next.instruction, undefined);
  assert.ok(next.scopeExclusion);
  const receipt = { run, stepId: target.id, generation: next.generation, outcome: 'not-applicable', reason: 'No remote delivery requested' };
  assert.throws(() => recordStep(receipt), /required evidence/);
  recordStep({ ...receipt, evidence: evidence(run, ['scope-exclusion']) });
  assert.notEqual(statusPlaybook(run).stepId, target.id);
});

test('monitor scheduling and publishing each require their matching grant', t => {
  for (const authority of ['scheduler', 'remote-write']) {
    const manifest = all.find(p => p.steps.some(s => s.authority === authority && s.when));
    const target = manifest.steps.find(s => s.authority === authority && s.when);
    const run = fixture(t, manifest.id, ['read-only', 'local-workspace']);
    while (statusPlaybook(run).stepId !== target.id) pass(run);
    const next = nextStep(run);
    assert.equal(next.status, 'blocked'); assert.equal(next.authority, authority); assert.equal(next.instruction, undefined);
    const receipt = { run, stepId: target.id, generation: next.generation, outcome: 'passed', evidence: evidence(run, target.evidence) };
    assert.throws(() => recordStep(receipt), /resume blocked/);
    resumePlaybook(run);
    assert.throws(() => recordStep({ ...receipt, generation: statusPlaybook(run).generation }), /required evidence/);
  }
});

test('catalog numeric assertions reject evidence with a nonzero pixel difference', t => {
  const manifest = all.find(p => p.steps.some(s => s.assertions?.length));
  const target = manifest.steps.find(s => s.assertions?.length); const run = fixture(t, manifest.id);
  while (statusPlaybook(run).stepId !== target.id) pass(run);
  const next = nextStep(run);
  const receipt = { run, stepId: target.id, generation: next.generation, outcome: 'passed', evidence: evidence(run, target.evidence) };
  assert.throws(() => recordStep({ ...receipt, data: { pixelDiff: 1 } }), /required evidence/);
  recordStep({ ...receipt, data: { pixelDiff: 0 } });
});

test('pause and failed receipt preserve step; resume increments receipt generation', t => {
  const run = fixture(t); const initial = nextStep(run);
  pausePlaybook({ run }); assert.equal(nextStep(run).status, 'paused');
  assert.throws(() => recordStep({ run, ...initial, outcome: 'blocked', reason: 'failure' }), /not active/);
  resumePlaybook(run); assert.equal(nextStep(run).stepId, initial.stepId);
  const current = nextStep(run);
  recordStep({ run, stepId: current.stepId, generation: current.generation, outcome: 'blocked', reason: 'host failed' });
  assert.equal(nextStep(run).status, 'blocked');
  resumePlaybook(run); assert.equal(nextStep(run).stepId, current.stepId);
  assert.ok(nextStep(run).generation > current.generation);
});

test('request and source drift fail closed', t => {
  const run = fixture(t); const request = path.join(run, 'request.md');
  fs.chmodSync(request, 0o600); fs.writeFileSync(request, 'tamper');
  assert.throws(() => resumePlaybook(run), /request drift/);
  const other = fixture(t); const file = path.join(other, 'state.json'); const state = JSON.parse(fs.readFileSync(file));
  state.sources[Object.keys(state.sources)[0]] = 'wrong'; fs.writeFileSync(file, JSON.stringify(state));
  assert.throws(() => nextStep(other), /source drift/);
});

test('completed runs revalidate artifacts; pre-existing artifacts are accepted', t => {
  const run = fixture(t); finish(run);
  const state = JSON.parse(fs.readFileSync(path.join(run, 'state.json')));
  const file = state.receipts[0].evidence[0].path;
  fs.writeFileSync(file, 'tampered');
  assert.throws(() => statusPlaybook(run), /evidence drift/);
  const other = fixture(t); const current = nextStep(other); const items = evidence(other, current.evidence);
  for (const item of items) fs.utimesSync(item.path, new Date(0), new Date(0));
  recordStep({ run: other, stepId: current.stepId, generation: current.generation, outcome: 'passed', evidence: items });
});

test('declared retry invalidates downstream receipts and rejects old generation', t => {
  const manifest = all.find(p => p.loops?.length); const loop = manifest.loops[0];
  const run = fixture(t, manifest.id);
  while (statusPlaybook(run).stepId !== loop.from) pass(run);
  const before = nextStep(run);
  assert.throws(() => retryStep({ run, to: 'foreign', reason: 'repair' }), /declared loop/);
  retryStep({ run, to: loop.to, reason: 'repair' });
  assert.equal(nextStep(run).stepId, loop.to);
  const state = JSON.parse(fs.readFileSync(path.join(run, 'state.json')));
  assert.ok(state.history.length); assert.ok(state.generation > before.generation);
  assert.throws(() => recordStep({ run, stepId: loop.to, generation: before.generation, outcome: 'passed' }), /generation/);
});

test('required children are linked independent runs; incomplete and foreign children cannot pass', t => {
  const manifest = all.find(p => p.steps.some(s => s.invokes?.length));
  const step = manifest.steps.find(s => s.invokes?.length); const run = fixture(t, manifest.id);
  while (statusPlaybook(run).stepId !== step.id) pass(run);
  const current = nextStep(run); const receipt = { run, stepId: step.id, generation: current.generation, outcome: 'passed', evidence: evidence(run, step.evidence) };
  assert.throws(() => recordStep(receipt), /child missing/);
  const playbook = step.invokes[0]; const child = startChild({ run, playbook });
  assert.notEqual(child.run, run); assert.throws(() => recordStep(receipt), /child incomplete/);
  finish(child.run);
  const file = path.join(child.run, 'state.json'); const state = JSON.parse(fs.readFileSync(file));
  state.parent.token = 'foreign'; fs.writeFileSync(file, JSON.stringify(state));
  assert.throws(() => recordStep(receipt), /foreign child/);
});

test('writer lock prevents concurrent mutation', t => {
  const run = fixture(t); fs.writeFileSync(path.join(run, '.writer.lock'), 'busy');
  assert.throws(() => pausePlaybook({ run }), /locked/);
});
