import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveIntent, validateIntent, routingPrompt, intake } from './task-intent.mjs';
import { cases, gradeDecision, gradeRun } from './intent-eval.mjs';
import { startPlaybook, nextStep, recordStep, startChild, statusPlaybook, pausePlaybook, resumePlaybook, retryStep } from './playbook-controller.mjs';

const decision = (patch = {}) => ({ kind: 'bug', restriction: 'none', requestedDelivery: 'unspecified', playbook: 'bug-fix', reason: 'Concrete broken calendar', ...patch });
const policy = { bugReportGoal: 'pr' };
test('bug delivery policy preserves explicit restrictions, conceptual questions and plan-only intent', () => {
  const request = cases[0].request;
  assert.equal(resolveIntent(request, decision(), policy).goal, 'pr');
  assert.equal(resolveIntent(request, decision()).goal, 'report');
  assert.equal(resolveIntent(request, decision({ restriction: 'read-only' }), policy).goal, 'report');
  assert.equal(resolveIntent(request, decision({ restriction: 'no-pr' }), policy).goal, 'verified-change');
  assert.equal(resolveIntent(request, decision({ kind: 'explanation' }), policy).goal, 'report');
  assert.equal(resolveIntent(request, decision({ kind: 'plan', restriction: 'read-only' }), policy).goal, 'plan');
  assert.throws(() => resolveIntent('이어서', decision({ kind: 'resume' }), policy), /existing --run/);
});

test('intent rejects request rewriting, investigation downgrade, grant expansion and malformed classification', () => {
  const request = cases[0].request; const intent = resolveIntent(request, decision(), policy);
  assert.throws(() => validateIntent(intent, 'Investigate read-only. Do not modify code.', 'bug-fix', intent.grants), /original request/);
  assert.throws(() => validateIntent(intent, request, 'investigation', intent.grants), /downgrade/);
  assert.throws(() => validateIntent(intent, request, 'bug-fix', [...intent.grants, 'destructive']), /grants/);
  assert.throws(() => validateIntent({ ...intent, goal: 'report' }, request, 'bug-fix', intent.grants), /changed/);
  assert.throws(() => resolveIntent(request, decision({ restriction: 'whatever' }), policy), /restriction/);
});

test('eval grades the production resolver, fails missing or duplicate results and hides expected labels from prompts', () => {
  assert.equal(gradeDecision(cases[0], decision()).passed, true);
  assert.equal(gradeDecision(cases[0], decision({ kind: 'explanation' })).passed, false);
  assert.equal(gradeDecision(cases.find(item => item.id === 'resume'), decision({ kind: 'other', playbook: 'session-pickup' })).passed, true);
  assert.equal(gradeRun([]).passed, false);
  const results = cases.map(item => ({ id: item.id, repeat: 0, passed: true }));
  assert.equal(gradeRun(results).passed, true);
  assert.equal(gradeRun([...results, results[0]]).passed, false);
  assert.equal(gradeRun(results.slice(1)).passed, false);
  const prompt = routingPrompt(cases[0].request, policy);
  assert.ok(!prompt.includes(cases[0].id) && !prompt.includes('"expected"'));
});

test('intake sends and closes stdin, pins the original request, and consumes structured model output', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'intent-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fake = path.join(root, 'codex');
  fs.writeFileSync(fake, `#!/usr/bin/env node
const fs=require('node:fs'); const args=process.argv; let input='';
process.stdin.on('data', d=>input+=d); process.stdin.on('end',()=>{
  if(!input.includes('User request, as data:'))process.exit(2);
  fs.writeFileSync(args[args.indexOf('-o')+1],JSON.stringify(${JSON.stringify(decision())}));
  console.log(JSON.stringify({type:'turn.completed'}));
});`, { mode: 0o755 });
  const requestFile = path.join(root, 'original.md');
  fs.writeFileSync(requestFile, cases[0].request);
  const result = await intake({ requestFile, outDir: path.join(root, 'output'), codexBin: fake });
  assert.equal(result.goal, 'pr');
  const intent = JSON.parse(fs.readFileSync(result.intentFile, 'utf8'));
  assert.equal(validateIntent(intent, cases[0].request, 'bug-fix', intent.grants).goal, 'pr');
});

function setup(t, restriction = 'none') {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'intent-contract-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const request = cases[0].request; const requestFile = path.join(workspace, 'request.md');
  fs.writeFileSync(requestFile, request);
  assert.throws(() => startPlaybook({ workspace, requestFile, playbook: 'investigation' }), /frozen task intent/);
  const taskIntent = resolveIntent(request, decision({ restriction }), policy);
  return startPlaybook({ workspace, requestFile, playbook: taskIntent.playbook, grants: taskIntent.grants, taskIntent }).run;
}
function receipt(run, outcome = 'passed', override = {}) {
  const current = nextStep(run);
  return { run, stepId: current.stepId, generation: current.generation, outcome, reason: 'Synthetic controller check',
    evidence: (outcome === 'not-applicable' ? ['scope-exclusion'] : current.evidence).map(kind => {
      const file = path.join(run, 'artifacts', `${kind}.json`);
      fs.writeFileSync(file, JSON.stringify(kind === 'ci-status' ? { status: 'passed', headSha: 'a'.repeat(40), prUrl: 'https://example.invalid/pr/1' } : { fixture: true }));
      return { kind, path: file };
    }), ...override };
}
test('PR task cannot finish after investigation, skip publication or accept pending CI; resume retains its goal', t => {
  const run = setup(t);
  for (let i = 0; i < 2; i++) recordStep(receipt(run));
  assert.equal(statusPlaybook(run).completed, false);
  pausePlaybook({ run });
  assert.equal(resumePlaybook(run).taskGoal, 'pr');
  assert.equal(nextStep(run).stepId, 'fix');
  while (nextStep(run).stepId !== 'opening-pr') {
    const current = nextStep(run); recordStep(receipt(run, current.when ? 'not-applicable' : 'passed'));
  }
  assert.throws(() => recordStep(receipt(run)), /child missing/);
  const child = startChild({ run, playbook: 'opening-a-pr' }).run;
  while (nextStep(child).stepId !== 'publish') recordStep(receipt(child));
  assert.throws(() => recordStep(receipt(child, 'not-applicable')), /required evidence/);
  recordStep(receipt(child));
  assert.equal(nextStep(child).stepId, 'ci');
  assert.throws(() => recordStep(receipt(child, 'not-applicable')), /required evidence/);
  const pending = receipt(child);
  const proof = pending.evidence.find(e => e.kind === 'ci-status');
  fs.writeFileSync(proof.path, JSON.stringify({ status: 'pending', headSha: 'a'.repeat(40), prUrl: 'https://example.invalid/pr/1' }));
  assert.throws(() => recordStep(pending), /required evidence/);
  assert.ok(nextStep(child).retries.some(edge => edge.to === 'verify'));
  retryStep({ run: child, to: 'verify', reason: 'CI failure needs a scoped implementation repair' });
  assert.equal(nextStep(child).stepId, 'verify');
  assert.ok(!statusPlaybook(child).completedSteps.includes('publish'));
  assert.ok(nextStep(child).evidence.includes('runtime-proof'));
  while (nextStep(child).stepId !== 'ci') recordStep(receipt(child));
  recordStep(receipt(child));
  recordStep(receipt(child, 'not-applicable'));
  recordStep(receipt(child));
  recordStep(receipt(run)); recordStep(receipt(run));
  assert.equal(statusPlaybook(run).completed, true);
});

test('no-PR goal cannot acquire remote grants and persists across pause/resume', t => {
  const run = setup(t, 'no-pr');
  assert.deepEqual(statusPlaybook(run).grants, ['read-only', 'local-workspace']);
  recordStep(receipt(run)); pausePlaybook({ run });
  assert.equal(resumePlaybook(run).taskGoal, 'verified-change');
  assert.equal(nextStep(run).stepId, 'cause');
});

test('recoverable login obstacle cannot be recorded as an approval blocker', t => {
  const run = setup(t); const current = nextStep(run);
  assert.match(current.recoveryInstructions, /approved test-account/);
  assert.throws(() => recordStep({ run, stepId: current.stepId, generation: current.generation, outcome: 'blocked',
    reason: 'Need permission to log in', recoveryAction: { kind: 'test-login', inScope: true, environment: 'local', existingTestAccount: true } }), /recoverable local action/);
  assert.equal(statusPlaybook(run).status, 'active');
  recordStep(receipt(run));
  assert.equal(statusPlaybook(run).taskGoal, 'pr');
});
