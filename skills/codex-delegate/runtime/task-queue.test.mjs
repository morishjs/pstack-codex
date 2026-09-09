import test from 'node:test';
import assert from 'node:assert/strict';
import { runQueue, validatePlan } from './task-queue.mjs';

const task = (id, dependsOn = [], owns = [`src/${id}`]) => ({ id, dependsOn, owns });
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('rejects missing ids, duplicate ids, missing dependencies, cycles and overlapping ownership', () => {
  for (const tasks of [[{}], [task('a'), task('a')], [task('a', ['missing'])],
    [task('a', ['b']), task('b', ['a'])],
    [task('a', [], ['src/**']), task('b', [], ['src/nested/file.js'])],
    [task('a', [], ['./src/a']), task('b', [], ['src/a/'])],
    [task('a', [], ['src/*.js'])], [task('a', [], ['../outside'])]]) {
    assert.throws(() => validatePlan(tasks));
  }
  assert.deepEqual(validatePlan([task('b', ['a']), task('a')]).map(t => t.id), ['a', 'b']);
  assert.doesNotThrow(() => validatePlan([task('a', [], ['src/a']), task('b', [], ['src/ab'])]));
});

test('default two workers overlap, reuse the free slot, and dispatch without batch barriers', { timeout: 2000 }, async () => {
  const gates = Object.fromEntries(['a', 'b', 'c', 'd'].map(id => [id, deferred()]));
  const started = Object.fromEntries(['a', 'b', 'c', 'd'].map(id => [id, deferred()]));
  const workers = {};
  let active = 0;
  let maximum = 0;
  const running = runQueue({ tasks: ['a', 'b', 'c', 'd'].map(id => task(id)), execute: async (t, { worker }) => {
    workers[t.id] = worker;
    maximum = Math.max(maximum, ++active);
    started[t.id].resolve();
    await gates[t.id].promise;
    active--;
    return t.id;
  } });
  await Promise.all([started.a.promise, started.b.promise]);
  assert.equal(active, 2);
  gates.b.resolve();
  await started.c.promise;
  assert.equal(active, 2);
  assert.equal(workers.c, workers.b);
  gates.c.resolve();
  await started.d.promise;
  assert.equal(workers.d, workers.b);
  gates.a.resolve();
  gates.d.resolve();
  const states = await running;
  assert.equal(maximum, 2);
  assert.ok(Object.values(states).every(s => s.status === 'passed'));
});

test('awaits cache validation and persistence before dispatch and dependent execution', { timeout: 2000 }, async () => {
  const validating = deferred();
  const validation = deferred();
  const persisting = deferred();
  const persistence = deferred();
  const calls = [];
  let updatesActive = 0;
  let maxUpdates = 0;
  const running = runQueue({ tasks: [task('a'), task('b', ['a'])],
    previous: { a: { status: 'passed', result: 'old' } },
    validateCached: async () => { validating.resolve(); await validation.promise; return false; },
    onUpdate: async (_states, event) => {
      maxUpdates = Math.max(maxUpdates, ++updatesActive);
      if (event.taskId === 'a' && event.status === 'passed') {
        persisting.resolve();
        await persistence.promise;
      }
      updatesActive--;
    },
    execute: async (t, context) => { calls.push(t.id); if (t.id === 'b') assert.equal(context.dependencies.a, 'new'); return 'new'; },
  });
  await validating.promise;
  assert.deepEqual(calls, []);
  validation.resolve();
  await persisting.promise;
  assert.deepEqual(calls, ['a']);
  persistence.resolve();
  await running;
  assert.deepEqual(calls, ['a', 'b']);
  assert.equal(maxUpdates, 1);
});

test('failure blocks only descendants; independent work continues and failed tasks retry next run', async () => {
  const tasks = [task('a'), task('b', ['a']), task('c'), task('d', ['b'])];
  const calls = [];
  const first = await runQueue({ tasks, execute: async t => { calls.push(t.id); if (t.id === 'a') throw Error('boom'); return t.id; } });
  assert.deepEqual(calls.sort(), ['a', 'c']);
  assert.equal(first.a.status, 'failed');
  assert.equal(first.b.status, 'blocked');
  assert.equal(first.d.status, 'blocked');
  assert.equal(first.c.status, 'passed');
  calls.length = 0;
  const second = await runQueue({ tasks, previous: first, validateCached: async () => true, execute: async t => { calls.push(t.id); return t.id; } });
  assert.deepEqual(calls, ['a', 'b', 'd']);
  assert.ok(Object.values(second).every(s => s.status === 'passed'));
});

test('invalid cached ancestors invalidate descendants; unrelated valid successes survive', async () => {
  const tasks = [task('a'), task('b', ['a']), task('c'), task('d', ['b'])];
  const previous = Object.fromEntries(tasks.map(t => [t.id, { status: 'passed', result: `old-${t.id}` }]));
  const checked = [];
  const executed = [];
  const states = await runQueue({ tasks, previous,
    validateCached: async t => { checked.push(t.id); return t.id !== 'a'; },
    execute: async t => { executed.push(t.id); return `new-${t.id}`; },
  });
  assert.deepEqual(checked, ['a', 'c']);
  assert.deepEqual(executed, ['a', 'b', 'd']);
  assert.equal(states.c.result, 'old-c');
});

test('cached success is untrusted by default; explicit failed result does not pass', async () => {
  const states = await runQueue({ tasks: [task('a'), task('b', ['a'])],
    previous: { a: { status: 'passed', result: 'old' } }, execute: async () => ({ status: 'failed', reason: 'proof missing' }) });
  assert.equal(states.a.status, 'failed');
  assert.equal(states.a.result.reason, 'proof missing');
  assert.equal(states.b.status, 'blocked');
});

test('invalid plans and concurrency cause no execution', async () => {
  let calls = 0;
  const execute = async () => { calls++; };
  await assert.rejects(runQueue({ tasks: [task('a', ['a'])], execute }), /cycle/);
  for (const concurrency of [0, -1, 1.5, Infinity]) {
    await assert.rejects(runQueue({ tasks: [task('a')], concurrency, execute }), /concurrency/);
  }
  assert.equal(calls, 0);
});


test('blocked execution stays blocked, blocks descendants, and does not block independent tasks', async () => {
  const executed = [];
  const states = await runQueue({ tasks: [task('a'), task('b', ['a']), task('c'), task('d', ['b'])],
    execute: async t => { executed.push(t.id); return { status: t.id === 'a' ? 'blocked' : 'passed' }; },
  });
  assert.deepEqual(executed.sort(), ['a', 'c']);
  assert.equal(states.a.status, 'blocked');
  assert.equal(states.b.status, 'blocked');
  assert.equal(states.d.status, 'blocked');
  assert.equal(states.c.status, 'passed');
});

test('rejects duplicate dependencies and unsafe object or filesystem task ids before execution', async () => {
  let executions = 0;
  const execute = async () => { executions++; };
  await assert.rejects(runQueue({ tasks: [task('a'), task('b', ['a', 'a'])], execute }), /Duplicate dependency/);
  for (const id of ['__proto__', 'constructor', 'toString', '../x', 'x/y', '.', '..', '/tmp/x', 'x\\y', 'a b']) {
    await assert.rejects(runQueue({ tasks: [task(id)], execute }), /Unsafe task id/);
  }
  assert.equal(executions, 0);
  assert.doesNotThrow(() => validatePlan([task('task-1'), task('task_2')]));
});
