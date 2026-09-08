import * as fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createMachine, transition } from 'xstate';
import { validatePlan, runQueue } from './task-queue.mjs';
import { prepareWorker, dependencyKey } from './worker-workspace.mjs';
import { status as runnerStatus, validateScope as validateRunnerScope } from './runner.mjs';

const ensure = (ok, message) => { if (!ok) throw new Error(message); };
const hash = value => createHash('sha256').update(value).digest('hex');
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
const head = cwd => git(cwd, 'rev-parse', 'HEAD').trim();
const matches = (file, owned) => { const p = owned.replace(/\/\*\*$/, '').replace(/\/$/, ''); return p === '.' || file === p || file.startsWith(`${p}/`); };
const changed = cwd => [...new Set([...git(cwd, 'diff', '--name-only', '-z', 'HEAD').split('\0'), ...git(cwd, 'ls-files', '--others', '--exclude-standard', '-z').split('\0')])].filter(p => p && !matches(p, '.codex-delegate'));
const clean = cwd => changed(cwd).length === 0;
function environmentKey(workspace) {
  return dependencyKey(workspace, { node: process.version, platform: process.platform, arch: process.arch,
    environment: hash(JSON.stringify(Object.entries(process.env).sort(([a], [b]) => a.localeCompare(b)))),
    modules: ['node_modules/.modules.yaml', 'node_modules/.pnpm/lock.yaml'].map(file => {
      const full = path.join(workspace, file); return [file, fs.existsSync(full) ? hash(fs.readFileSync(full)) : null];
    }) });
}
function fingerprint(cwd) {
  const untracked = git(cwd, 'ls-files', '--others', '--exclude-standard', '-z').split('\0').filter(p => p && !matches(p, '.codex-delegate')).map(p => {
    const file = path.join(cwd, p), stat = fs.lstatSync(file);
    return [p, stat.mode, hash(stat.isSymbolicLink() ? fs.readlinkSync(file) : fs.readFileSync(file))];
  });
  return hash(JSON.stringify({ head: head(cwd), diff: git(cwd, 'diff', '--binary', '--full-index', 'HEAD'), untracked }));
}
function save(state) {
  const file = path.join(state.session, 'state.json'), temp = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(state, null, 2), { mode: 0o600 }); fs.renameSync(temp, file);
}
export const queueMachine = createMachine({ id: 'dependency-session', initial: 'queue', states: {
  queue: { on: { INTEGRATE: 'integrating', BLOCK: 'blocked' } },
  integrating: { on: { REVIEW: 'reviewing', BLOCK: 'blocked' } },
  reviewing: { on: { PASS: 'complete', BLOCK: 'blocked' } },
  blocked: { on: { QUEUE: 'queue', INTEGRATE: 'integrating', REVIEW: 'reviewing' } },
  complete: { type: 'final' },
} });
function move(state, event) {
  const [next] = transition(queueMachine, queueMachine.resolveState({ value: state.phase, context: {} }), { type: event });
  ensure(next.value !== state.phase, `invalid queue transition: ${state.phase}/${event}`); state.phase = next.value; save(state);
}
function validateScope(scope, root) {
  ensure(scope && ['allowedImplementationPaths', 'allowedTestPaths', 'requiredRequirementIds'].every(key => Array.isArray(scope[key]) && scope[key].every(p => typeof p === 'string' && p.trim())), 'explicit implementation/test/requirement scope required');
  ensure(scope.requiredRequirementIds.length > 0, 'requiredRequirementIds must not be empty');
  validateRunnerScope(scope, root);
  return scope;
}
function tasksFrom(plan, root) {
  const tasks = validatePlan(Array.isArray(plan) ? plan : plan.tasks);
  ensure(tasks.length > 0, 'plan needs tasks');
  for (const task of tasks) {
    ensure(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(task.id), 'task id must be a simple identifier');
    ensure(typeof task.request === 'string' && task.request.trim(), `request required: ${task.id}`);
    validateScope(task.scope, root);
    for (const p of [...task.scope.allowedImplementationPaths, ...task.scope.allowedTestPaths]) {
      ensure(!path.isAbsolute(p) && !p.split('/').includes('..'), `invalid scope path: ${p}`);
      ensure(task.owns.some(owned => matches(p.replace(/\/\*\*$/, ''), owned)), `owns must cover implementation and tests: ${task.id}/${p}`);
    }
  }
  return tasks;
}
function load(session) {
  const state = json(path.join(path.resolve(session), 'state.json'));
  ensure(state.session === path.resolve(session) && state.version === 1, 'session identity/version mismatch');
  for (const [file, digest] of Object.entries(state.frozen)) ensure(hash(fs.readFileSync(path.join(state.session, file))) === digest, `frozen input changed: ${file}`);
  state.tasks = tasksFrom(json(path.join(state.session, 'plan.json')), state.source);
  return state;
}
function checkpoint(workspace, message) {
  git(workspace, '-c', 'user.name=Codex Queue', '-c', 'user.email=codex-queue@localhost', '-c', 'core.hooksPath=/dev/null', 'commit', '--allow-empty', '--no-gpg-sign', '-m', message);
  return head(workspace);
}
function dependencyResults(state, task) {
  const wanted = new Set();
  function visit(id) { for (const dep of state.tasks.find(t => t.id === id).dependsOn ?? []) { if (!wanted.has(dep)) { visit(dep); wanted.add(dep); } } }
  visit(task.id);
  return state.tasks.filter(t => wanted.has(t.id)).map(t => { const result = state.queue[t.id]?.result; ensure(result, `dependency result missing: ${t.id}`); return [t.id, result]; });
}
const signature = results => Object.fromEntries(results.map(([id, r]) => [id, r.patchHash]));
function checkPatch(result) {
  ensure(hash(fs.readFileSync(result.patch)) === result.patchHash, 'result patch changed');
}
function apply(workspace, result) {
  checkPatch(result);
  if (fs.statSync(result.patch).size) git(workspace, 'apply', '--index', '--binary', result.patch);
}
function validResult(result) {
  try { checkPatch(result); return environmentKey(result.workspace) === result.environmentKey && head(result.workspace) === result.commit && clean(result.workspace) && git(result.workspace, 'diff', '--binary', '--full-index', result.baseline, result.commit) === fs.readFileSync(result.patch, 'utf8'); } catch { return false; }
}
async function executeDefault({ workspace, requestFile, scopeFile, run, codexBin, onRunCreated }) {
  const { start: startOrchestrator, resume: resumeOrchestrator } = await import('./orchestrator.mjs');
  const result = run ? await resumeOrchestrator({ run, retry: true, codexBin }) : await startOrchestrator({ workspace, requestFile, scopeFile, codexBin, authority: 'local-workspace', onRunCreated });
  const nested = result.nestedRun ? await runnerStatus(result.nestedRun) : undefined;
  return { phase: result.phase, run: result.run, reason: result.reason, verified: nested?.phase === 'complete' && nested.review?.status === 'pass' && nested.review.requirements.every(r => r.status === 'pass') };
}
function prepareLane(state, task, results, prepare) {
  const upstream = signature(results), previous = state.lanes[task.id];
  if (previous && !previous.commit && JSON.stringify(previous.upstream) === JSON.stringify(upstream) && previous.base === state.base) {
    ensure(fs.existsSync(previous.workspace) && head(previous.workspace) === (previous.commit ?? previous.baseline), `task checkout changed: ${task.id}`);
    if (task.probeModule && !previous.prepared) { prepare({ source: state.source, worker: task.id, ref: previous.baseline, probeModule: task.probeModule, directory: previous.directory }); previous.prepared = true; save(state); }
    return previous;
  }
  const directory = path.join(state.session, 'tasks', task.id, ...(previous ? [`revision-${randomUUID()}`] : []));
  fs.mkdirSync(directory, { recursive: true });
  const seed = path.join(directory, 'baseline');
  git(state.source, 'worktree', 'add', '--detach', seed, state.base);
  for (const [, result] of results) apply(seed, result);
  const baseline = results.length ? checkpoint(seed, `Queue dependencies for ${task.id}`) : state.base;
  git(state.source, 'worktree', 'remove', seed);
  const workspace = path.join(directory, 'workspace');
  const lane = { directory, workspace, base: state.base, baseline, upstream };
  state.lanes[task.id] = lane; save(state);
  if (task.probeModule) prepare({ source: state.source, worker: task.id, ref: baseline, probeModule: task.probeModule, directory });
  else git(state.source, 'worktree', 'add', '--detach', workspace, baseline);
  lane.prepared = true; save(state); return lane;
}
async function runTask(state, task, execute, prepare) {
  const results = dependencyResults(state, task), lane = prepareLane(state, task, results, prepare);
  const requestFile = path.join(lane.directory, 'request.txt'), scopeFile = path.join(lane.directory, 'scope.json');
  fs.writeFileSync(requestFile, task.request); fs.writeFileSync(scopeFile, JSON.stringify(task.scope));
  const result = await execute({ task, workspace: lane.workspace, requestFile, scopeFile, run: lane.run, codexBin: state.codexBin, onRunCreated: run => { lane.run = run; save(state); } });
  lane.run = result.run ?? lane.run; save(state);
  ensure(result.phase === 'complete' && result.verified, result.reason ?? `task ${task.id} acceptance/review incomplete`);
  ensure(head(lane.workspace) === lane.baseline, `worker committed outside coordinator: ${task.id}`);
  const files = changed(lane.workspace);
  ensure(files.every(file => task.owns.some(owned => matches(file, owned))), `task changed unowned paths: ${task.id}`);
  if (files.length) git(lane.workspace, 'add', '--', ...files.map(p => `:(literal)${p}`));
  ensure(git(lane.workspace, 'diff', '--cached', '--name-only', '-z').split('\0').filter(Boolean).every(file => !matches(file, '.codex-delegate') && task.owns.some(owned => matches(file, owned))), `task staged unowned paths: ${task.id}`);
  const patchText = git(lane.workspace, 'diff', '--cached', '--binary', '--full-index');
  const patch = path.join(lane.directory, `result-${hash(patchText)}.patch`);
  if (!fs.existsSync(patch)) fs.writeFileSync(patch, patchText, { mode: 0o400, flag: 'wx' });
  const commit = checkpoint(lane.workspace, `Queue result ${task.id}`);
  Object.assign(lane, { commit }); save(state);
  const saved = { ...lane, patch, patchHash: hash(patchText), environmentKey: environmentKey(lane.workspace) };
  ensure(validResult(saved), `result validation failed: ${task.id}`); return saved;
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
async function drive(state, { execute = executeDefault, retry = false, recoverInterrupted = false, verifyIntegration = verifyIntegrationDefault, prepare = prepareWorker } = {}) {
  const lock = path.join(state.session, 'coordinator.lock');
  if (fs.existsSync(lock)) {
    const owner = json(path.join(lock, 'owner.json'));
    ensure(!alive(owner.pid), 'queue coordinator is active');
    fs.rmSync(lock, { recursive: true });
    state.recoveryRequired = true;
    state.reason = 'Interrupted coordinator; confirm all workers stopped, then resume --retry --recover-interrupted';
    state.blockedPhase = state.phase === 'blocked' ? state.blockedPhase : state.phase;
    for (const slot of Object.values(state.queue)) if (slot.status === 'running') Object.assign(slot, { status: 'blocked', error: state.reason });
    if (state.phase !== 'blocked' && state.phase !== 'complete') move(state, 'BLOCK'); else save(state);
    return state.phase === 'complete' ? validateComplete(state, verifyIntegration) : state;
  }
  fs.mkdirSync(lock); fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid }));
  try {
    if (state.phase === 'complete') return validateComplete(state, verifyIntegration);
    ensure(!state.completionInvalidated, 'completed evidence invalidated; start a new queue session');
    ensure(!state.recoveryRequired || recoverInterrupted, 'interrupted queue requires --recover-interrupted after confirming workers stopped');
    if (state.recoveryRequired) { delete state.recoveryRequired; save(state); }
    if (state.phase === 'blocked') { ensure(retry, 'blocked queue needs --retry'); move(state, { queue: 'QUEUE', integrating: 'INTEGRATE', reviewing: 'REVIEW' }[state.blockedPhase]); }
    if (state.phase === 'queue') {
      const previous = state.queue;
      state.queue = await runQueue({ tasks: state.tasks, concurrency: state.concurrency, previous,
        validateCached: async (task, cached) => validResult(cached.result) && JSON.stringify(cached.result.upstream) === JSON.stringify(signature(dependencyResults({ ...state, queue: previous }, task))),
        onUpdate: async states => { state.queue = states; save(state); },
        execute: task => runTask(state, task, execute, prepare),
      });
      ensure(Object.values(state.queue).every(t => t.status === 'passed'), 'queue has failed or blocked tasks');
      move(state, 'INTEGRATE');
    }
    if (state.phase === 'integrating') {
      const results = state.tasks.map(t => [t.id, state.queue[t.id].result]);
      for (const [, result] of results) ensure(validResult(result), 'integration requires valid lane results');
      let integration = state.integration;
      if (!integration || integration.prepared) {
        let directory = path.join(state.session, 'integration');
        if (fs.existsSync(path.join(directory, 'workspace')) || fs.existsSync(path.join(directory, 'baseline'))) directory = path.join(directory, `revision-${randomUUID()}`);
        fs.mkdirSync(directory, { recursive: true });
        const seed = path.join(directory, 'baseline');
        git(state.source, 'worktree', 'add', '--detach', seed, state.base);
        for (const [, result] of results) apply(seed, result);
        const baseline = checkpoint(seed, 'Queue integrated candidate');
        git(state.source, 'worktree', 'remove', seed);
        integration = { directory, workspace: path.join(directory, 'workspace'), baseline, upstream: signature(results) };
        state.integration = integration; save(state);
      }
      if (state.probeModule) prepare({ source: state.source, worker: 'integration', ref: integration.baseline, probeModule: state.probeModule, directory: integration.directory });
      else if (fs.existsSync(integration.workspace)) ensure(head(integration.workspace) === integration.baseline && clean(integration.workspace), 'unfinished integration checkout changed; preserve and inspect');
      else git(state.source, 'worktree', 'add', '--detach', integration.workspace, integration.baseline);
      integration.prepared = true; save(state); move(state, 'REVIEW');
    }
    if (state.phase === 'reviewing') {
      const integration = state.integration;
      const result = await execute({ integration: true, workspace: integration.workspace, requestFile: path.join(state.session, 'request.txt'), scopeFile: path.join(state.session, 'scope.json'), run: integration.run, codexBin: state.codexBin, onRunCreated: run => { integration.run = run; save(state); } });
      integration.run = result.run ?? integration.run; save(state);
      ensure(result.phase === 'complete' && result.verified, result.reason ?? 'integration acceptance and fresh review required');
      integration.completedHead = head(integration.workspace); integration.fingerprint = fingerprint(integration.workspace); integration.verified = true; move(state, 'PASS');
    }
  } catch (error) {
    state.reason = error.message; state.blockedPhase = state.phase === 'blocked' ? state.blockedPhase : state.phase;
    if (!['blocked', 'complete'].includes(state.phase)) move(state, 'BLOCK'); else save(state);
  } finally { fs.rmSync(lock, { recursive: true, force: true }); }
  return state;
}
export async function startQueue({ source, planFile, requestFile, scopeFile, authority = 'read-only', codexBin = 'codex', concurrency = 2, ...options }) {
  ensure(authority === 'local-workspace', 'implementation queue requires explicit local-workspace authority');
  source = fs.realpathSync(source); ensure(clean(source), 'source must be clean including untracked files except .codex-delegate');
  ensure(git(source, 'rev-parse', '--show-toplevel').trim() === source, 'source must be a Git root');
  const plan = json(planFile), tasks = tasksFrom(plan, source), scope = validateScope(json(scopeFile), source);
  const probes = [...new Set(tasks.map(task => task.probeModule).filter(Boolean))];
  const probeModule = plan.probeModule ?? (probes.length === 1 ? probes[0] : undefined);
  ensure(probes.length < 2 || probeModule, 'multiple task probes require explicit plan.probeModule for integration');
  ensure(!fs.existsSync(path.join(source, 'pnpm-lock.yaml')) || probeModule, 'pnpm queue needs plan.probeModule for dependency preflight');
  if (probeModule) for (const task of tasks) task.probeModule ??= probeModule;
  const request = fs.readFileSync(requestFile, 'utf8'); ensure(request.trim(), 'integration request required');
  ensure(Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 2, 'queue supports concurrency 1 or 2');
  const session = path.join(source, '.codex-delegate', 'queues', randomUUID()); fs.mkdirSync(session, { recursive: true });
  const frozen = {};
  for (const [file, value] of Object.entries({ 'plan.json': JSON.stringify({ ...(Array.isArray(plan) ? {} : plan), tasks }, null, 2), 'request.txt': request + '\n\nVerify the integrated result through executable acceptance checks and a fresh independent Sol review. Do not stop after investigation.\n', 'scope.json': JSON.stringify(scope, null, 2) })) { fs.writeFileSync(path.join(session, file), value, { mode: 0o400 }); frozen[file] = hash(value); }
  const state = { version: 1, session, source, base: head(source), tasks, frozen, codexBin, concurrency, probeModule, phase: 'queue', queue: {}, lanes: {} }; save(state);
  options.onSessionCreated?.(session); return drive(state, options);
}
export const resumeQueue = ({ session, ...options }) => drive(load(session), options);
async function verifyIntegrationDefault(integration) {
  try {
    const outer = json(path.join(integration.run, 'state.json'));
    if (outer.phase !== 'complete' || !outer.nestedRun) return false;
    const nested = await runnerStatus(outer.nestedRun);
    return nested.phase === 'complete' && nested.review?.status === 'pass' && nested.review.requirements.every(r => r.status === 'pass');
  } catch { return false; }
}
async function validateComplete(state, verifyIntegration) {
  try {
    for (const task of state.tasks) {
      const result = state.queue[task.id]?.result;
      ensure(validResult(result) && JSON.stringify(result.upstream) === JSON.stringify(signature(dependencyResults(state, task))), 'completed lane evidence changed');
    }
    ensure(state.integration?.verified && fingerprint(state.integration.workspace) === state.integration.fingerprint, 'completed integration checkout changed');
    ensure(await verifyIntegration(state.integration), 'completed integration review evidence invalid');
  } catch (error) {
    state.phase = 'blocked'; state.blockedPhase = 'reviewing'; state.reason = error.message; state.completionInvalidated = true; save(state);
  }
  return state;
}
export async function queueStatus(session, { verifyIntegration = verifyIntegrationDefault } = {}) {
  const state = load(session); return state.phase === 'complete' ? validateComplete(state, verifyIntegration) : state;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, ...args] = process.argv.slice(2), get = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
    let state;
    if (command === 'start') state = await startQueue({ source: get('--source'), planFile: get('--plan-file'), requestFile: get('--request-file'), scopeFile: get('--scope-file'), authority: get('--authority'), codexBin: get('--codex-bin'), concurrency: Number(get('--concurrency') ?? 2), onSessionCreated: session => console.log(session) });
    else if (command === 'resume') state = await resumeQueue({ session: get('--session'), retry: args.includes('--retry'), recoverInterrupted: args.includes('--recover-interrupted') });
    else if (command === 'status') state = await queueStatus(get('--session'));
    else throw new Error('usage: start --source PATH --plan-file JSON --request-file FILE --scope-file JSON [--codex-bin PATH] [--concurrency 1|2] | resume --session PATH --retry [--recover-interrupted] | status --session PATH');
    console.log(JSON.stringify(state, null, 2)); if (state.phase === 'blocked') process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
