import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startQueue, resumeQueue } from './queue-session.mjs';
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function fixture(t, dependencies = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-session-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'); fs.mkdirSync(source); git(source, 'init');
  git(source, 'config', 'user.name', 'Test'); git(source, 'config', 'user.email', 'test@example.com');
  fs.writeFileSync(path.join(source, 'original'), 'original\n'); git(source, 'add', '.'); git(source, 'commit', '-m', 'base');
  const task = (id, dependsOn = []) => ({ id, dependsOn, owns: [`${id}.txt`, `${id}.test.mjs`], request: `Implement ${id}`, scope: { allowedImplementationPaths: [`${id}.txt`], allowedTestPaths: [`${id}.test.mjs`], requiredRequirementIds: [`${id}-works`] } });
  const plan = { tasks: [task('a'), task('b', dependencies ? ['a'] : []), task('c')] };
  const planFile = path.join(root, 'plan.json'), requestFile = path.join(root, 'request.txt'), scopeFile = path.join(root, 'scope.json');
  fs.writeFileSync(planFile, JSON.stringify(plan)); fs.writeFileSync(requestFile, 'Integrate all features');
  fs.writeFileSync(scopeFile, JSON.stringify({ allowedImplementationPaths: ['a.txt', 'b.txt', 'c.txt'], allowedTestPaths: ['a.test.mjs', 'b.test.mjs', 'c.test.mjs'], requiredRequirementIds: ['all-work'] }));
  return { source, planFile, requestFile, scopeFile, plan, authority: 'local-workspace' };
}
const success = run => ({ phase: 'complete', verified: true, run });
function implement(task, workspace) { fs.writeFileSync(path.join(workspace, `${task.id}.txt`), task.id); fs.writeFileSync(path.join(workspace, `${task.id}.test.mjs`), `assert('${task.id}');\n`); }
test('transitive dependency patches include added tests; integration and source isolation', async t => {
  const f = fixture(t); f.plan.tasks[2].dependsOn = ['b']; fs.writeFileSync(f.planFile, JSON.stringify(f.plan));
  let integration = 0;
  const result = await startQueue({ ...f, execute: async ({ task, integration: final, workspace }) => {
    if (final) { integration++; for (const id of ['a', 'b', 'c']) assert.ok(fs.existsSync(path.join(workspace, `${id}.test.mjs`))); return success('integration-run'); }
    if (task.id === 'c') for (const id of ['a', 'b']) assert.equal(fs.readFileSync(path.join(workspace, `${id}.txt`), 'utf8'), id);
    implement(task, workspace); return success(`run-${task.id}`);
  } });
  assert.equal(result.phase, 'complete'); assert.equal(integration, 1);
  assert.equal(fs.existsSync(path.join(f.source, 'a.txt')), false);
  assert.match(fs.readFileSync(result.queue.a.result.patch, 'utf8'), /a.test.mjs/);
  assert.equal(git(f.source, 'log', '--oneline').split('\n').length, 1);
});
test('failed lane preserves edits; independent lane continues; retry reuses checkout and successes', async t => {
  const f = fixture(t); const calls = [], workspaces = {}; let fail = true;
  const execute = async ({ task, integration, workspace, run, onRunCreated }) => {
    if (integration) return success('integration');
    calls.push(task.id); (workspaces[task.id] ??= []).push(workspace); onRunCreated(`run-${task.id}`);
    implement(task, workspace);
    if (task.id === 'a' && fail) return { phase: 'blocked', run: 'run-a', reason: 'test failed' };
    if (task.id === 'a') { assert.equal(run, 'run-a'); assert.equal(fs.readFileSync(path.join(workspace, 'a.txt'), 'utf8'), 'a'); }
    return success(`run-${task.id}`);
  };
  const initial = await startQueue({ ...f, execute }); assert.equal(initial.phase, 'blocked');
  assert.equal(initial.queue.c.status, 'passed'); assert.equal(initial.queue.b.status, 'blocked');
  assert.equal(fs.readFileSync(path.join(initial.lanes.a.workspace, 'a.txt'), 'utf8'), 'a');
  fail = false; const final = await resumeQueue({ session: initial.session, retry: true, execute });
  assert.equal(final.phase, 'complete'); assert.deepEqual(calls, ['a', 'c', 'a', 'b']); assert.equal(workspaces.a[0], workspaces.a[1]);
});
test('integration gate mandatory and blocked integration resumes alone', async t => {
  const f = fixture(t); let laneCalls = 0, finalCalls = 0;
  const execute = async ({ task, integration, workspace, run, onRunCreated }) => {
    if (!integration) { laneCalls++; implement(task, workspace); return success(task.id); }
    finalCalls++; onRunCreated('final');
    if (finalCalls === 1) return { phase: 'complete', verified: false, run: 'final' };
    assert.equal(run, 'final'); return success('final');
  };
  const initial = await startQueue({ ...f, execute }); assert.equal(initial.phase, 'blocked'); assert.equal(initial.blockedPhase, 'reviewing');
  const final = await resumeQueue({ session: initial.session, retry: true, execute }); assert.equal(final.phase, 'complete'); assert.equal(laneCalls, 3); assert.equal(finalCalls, 2);
});
test('cache corruption creates replacement checkout and reruns downstream', async t => {
  const f = fixture(t); let fail = true; const calls = [];
  const execute = async ({ task, integration, workspace }) => {
    if (integration) return success('final'); calls.push(task.id); implement(task, workspace);
    if (task.id === 'c' && fail) return { phase: 'blocked' }; return success(task.id);
  };
  const initial = await startQueue({ ...f, execute }); const old = initial.lanes.a.workspace;
  fs.writeFileSync(path.join(old, 'a.txt'), 'corrupted'); fail = false;
  const final = await resumeQueue({ session: initial.session, retry: true, execute });
  assert.equal(final.phase, 'complete'); assert.notEqual(final.lanes.a.workspace, old); assert.equal(fs.readFileSync(path.join(old, 'a.txt'), 'utf8'), 'corrupted'); assert.equal(calls.filter(id => id === 'a').length, 2); assert.equal(calls.filter(id => id === 'b').length, 2);
});
test('reject unowned tests and dirty source before running', async t => {
  const f = fixture(t); f.plan.tasks[0].owns = ['a.txt']; fs.writeFileSync(f.planFile, JSON.stringify(f.plan));
  await assert.rejects(startQueue({ ...f }), /owns must cover/);
  fs.writeFileSync(path.join(f.source, 'untracked'), 'x'); await assert.rejects(startQueue({ ...f }), /source must be clean/);
});
test('queue validates every task scope and authority before execution', async t => {
  const f = fixture(t); let calls = 0;
  const execute = async () => { calls++; return success('unexpected'); };
  await assert.rejects(startQueue({ ...f, authority: 'read-only', execute }), /explicit local-workspace/);
  f.plan.tasks[0].owns = ['a']; f.plan.tasks[0].scope.allowedImplementationPaths = ['a/**'];
  fs.writeFileSync(f.planFile, JSON.stringify(f.plan));
  await assert.rejects(startQueue({ ...f, execute }), /unsupported scope glob/);
  assert.equal(calls, 0);
});
test('stale running slots block without launching duplicate workers', async t => {
  const f = fixture(t);
  const initial = await startQueue({ ...f, execute: async () => ({ phase: 'blocked' }) });
  const file = path.join(initial.session, 'state.json'); const state = JSON.parse(fs.readFileSync(file));
  state.phase = 'queue'; state.queue.a.status = 'running'; fs.writeFileSync(file, JSON.stringify(state));
  const lock = path.join(initial.session, 'coordinator.lock'); fs.mkdirSync(lock); fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: 2147483647 }));
  let calls = 0; const recovered = await resumeQueue({ session: initial.session, retry: true, execute: async () => { calls++; return success('unexpected'); } });
  assert.equal(recovered.phase, 'blocked'); assert.equal(recovered.queue.a.status, 'blocked'); assert.equal(calls, 0); assert.match(recovered.reason, /Interrupted coordinator/);
});
test('frozen plan mutation prevents resume', async t => {
  const f = fixture(t); const initial = await startQueue({ ...f, execute: async () => ({ phase: 'blocked' }) });
  const file = path.join(initial.session, 'plan.json'); fs.chmodSync(file, 0o600); fs.appendFileSync(file, '\n');
  await assert.rejects(async () => resumeQueue({ session: initial.session, retry: true }), /frozen input changed/);
});
test('integration installs through reusable helper only when probe exists', async t => {
  const f = fixture(t); f.plan.probeModule = 'typescript'; f.plan.tasks[0].probeModule = 'typescript'; fs.writeFileSync(f.planFile, JSON.stringify(f.plan));
  const prepared = [];
  const result = await startQueue({ ...f, prepare: options => {
    prepared.push(options.worker); const workspace = path.join(options.directory, 'workspace');
    git(options.source, 'worktree', 'add', '--detach', workspace, options.ref);
    return { workspace };
  }, execute: async ({ task, integration, workspace }) => { if (integration) { assert.equal(prepared.at(-1), 'integration'); assert.deepEqual([...prepared].sort(), ['a','b','c','integration']); return success('final'); } implement(task, workspace); return success(task.id); } });
  assert.equal(result.phase, 'complete'); assert.equal(result.probeModule, 'typescript');
  assert.equal(JSON.parse(fs.readFileSync(path.join(result.session, 'plan.json'))).probeModule, 'typescript');
});
test('completed resume revalidates lane, integration fingerprint, and review', async t => {
  const f = fixture(t); const result = await startQueue({ ...f, execute: async ({ task, integration, workspace }) => { if (!integration) implement(task, workspace); return success(integration ? 'final' : task.id); } });
  let verified = 0;
  const valid = await resumeQueue({ session: result.session, verifyIntegration: async () => { verified++; return true; } });
  assert.equal(valid.phase, 'complete'); assert.equal(verified, 1);
  fs.writeFileSync(path.join(result.integration.workspace, 'a.txt'), 'changed after review');
  const invalid = await resumeQueue({ session: result.session, verifyIntegration: async () => true });
  assert.equal(invalid.phase, 'blocked'); assert.match(invalid.reason, /integration checkout changed/);
  const retry = await resumeQueue({ session: result.session, retry: true, execute: async () => { throw new Error('must not rerun stale evidence'); } });
  assert.match(retry.reason, /start a new queue session/);
});

test('public CLI plan path executes real queue, runner and final review using fake model process', t => {
  const f = fixture(t), binary = path.join(path.dirname(f.source), 'fake-codex');
  fs.writeFileSync(binary, `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path'), {randomUUID} = require('node:crypto');
const args=process.argv, out=args[args.indexOf('-o')+1], schema=JSON.parse(fs.readFileSync(args[args.indexOf('--output-schema')+1]));
console.log(JSON.stringify({type:'thread.started',thread_id:args.includes('resume')?args.at(-2):randomUUID()}));
let result;
if(schema.properties.workflow) result={workflow:'simple-fix',taskClass:'simple-fix',risk:'low',complexity:'low',signals:[],reason:'fixture',authorizedActions:['local-workspace'],finishAfterInvestigation:false};
else {
 const run=path.resolve(path.dirname(out),'../..'), state=JSON.parse(fs.readFileSync(path.join(run,'state.json')));
 if(schema.properties.checks) {
  const files=state.scope.testPaths;
  for(const file of files) fs.writeFileSync(file,'console.log("PASS");\\n');
  result={status:'ready',reason:'fixture',requirements:state.scope.requirementIds.map(id=>({id,description:id,verification:'automated',checkIds:['check']})),checks:[{id:'check',argv:['node',files[0]],testFiles:files,baseline:'pass',baselineMarker:'PASS',passMarker:'PASS'}],implementationPaths:state.scope.implementationPaths,performanceMeasurements:[]};
 } else if(schema.properties.summary) result={status:'done',summary:'fixture'};
 else result={status:'pass',nextAction:'none',requirements:state.contract.requirements.map(r=>({id:r.id,status:'pass',evidence:'fixture command'})),findings:[]};
}
fs.writeFileSync(out,JSON.stringify(result)); console.log(JSON.stringify({type:'turn.completed'}));
`, {mode:0o755});
  const cli = fileURLToPath(new URL('./orchestrator.mjs', import.meta.url));
  const stdout = execFileSync(process.execPath, [cli,'start','--workspace',f.source,'--authority','local-workspace','--plan-file',f.planFile,'--request-file',f.requestFile,'--scope-file',f.scopeFile,'--codex-bin',binary], {encoding:'utf8',timeout:60000});
  const final = JSON.parse(stdout.trim().split('\n').at(-1));
  assert.equal(final.phase,'complete');
  const status = JSON.parse(execFileSync(process.execPath,[cli,'status','--run',final.run],{encoding:'utf8'}).trim());
  assert.equal(status.phase,'complete');
  assert.equal(fs.existsSync(path.join(f.source,'a.test.mjs')),false);
});
