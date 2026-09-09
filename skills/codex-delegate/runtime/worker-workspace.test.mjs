import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { prepareWorker } from './worker-workspace.mjs';

test('worker reuses checkout and installation, invalidates inputs, and preserves dirty files', () => {
  const source = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'worker-pool-')));
  const git = (...args) => execFileSync('git', args, { cwd: source, stdio: 'pipe' });
  git('init'); fs.writeFileSync(path.join(source, 'package.json'), '{}'); git('add', '.');
  git('-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture');
  let installs = 0, fail = false, probeBroken = false;
  const run = (cwd, exe, args) => {
    if (args[0] === 'install') {
      installs++;
      if (fail) throw new Error('installation failed');
      fs.mkdirSync(path.join(cwd, 'node_modules'), { recursive: true }); probeBroken = false;
    } else if (exe === process.execPath && probeBroken) throw new Error('missing module');
    return args[0] === '--version' ? '10.0.0' : args[0] === 'store' ? '/shared/store' : '{}';
  };
  const options = { source, worker: 'api', probeModule: 'typescript', run };
  const first = prepareWorker(options);
  assert.equal(first.reusedDependencies, false);
  fs.writeFileSync(path.join(first.workspace, 'unfinished.ts'), 'preserve');
  assert.equal(prepareWorker(options).reusedDependencies, true); assert.equal(installs, 1);
  fs.writeFileSync(path.join(first.workspace, '.npmrc'), 'node-linker=isolated');
  assert.equal(prepareWorker(options).reusedDependencies, false); assert.equal(installs, 2);
  probeBroken = true; prepareWorker(options); assert.equal(installs, 3);
  fs.writeFileSync(path.join(first.workspace, 'package.json'), '{"private":true}');
  fail = true; assert.throws(() => prepareWorker(options), /installation failed/);
  fail = false; prepareWorker(options); assert.equal(installs, 5);
  assert.equal(fs.readFileSync(path.join(first.workspace, 'unfinished.ts'), 'utf8'), 'preserve');
  fs.mkdirSync(path.join(first.workspace, '.codex-delegate', 'lock'), { recursive: true });
  assert.throws(() => prepareWorker(options), /active/);
  assert.throws(() => prepareWorker({ ...options, worker: '../escape' }), /identifier/);
});
