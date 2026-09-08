import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveIntent } from './task-intent.mjs';

const cli = fileURLToPath(new URL('./orchestrator.mjs', import.meta.url));
const call = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
const json = (...args) => {
  const result = call(...args);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
};

test('public CLI selects a playbook, preserves pause, rejects stale receipts and completes read-only investigation', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-entry-'));
  try {
    const request = path.join(workspace, 'request.md');
    fs.writeFileSync(request, 'Explain the existing code path without changing it.');
    assert.equal(json('playbooks').length, 23);
    const missing = call('start', '--workspace', workspace, '--request-file', request);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /select --playbook/);
    assert.equal(call('start', '--workspace', workspace, '--request-file', request, '--playbook', 'investigation', '--scope-file', request).status, 1);
    const intentFile = path.join(workspace, 'intent.json');
    fs.writeFileSync(intentFile, JSON.stringify(resolveIntent(fs.readFileSync(request, 'utf8'), {
      kind: 'explanation', restriction: 'read-only', requestedDelivery: 'unspecified', playbook: 'investigation', reason: 'Explanation only',
    })));
    assert.equal(call('start', '--workspace', workspace, '--request-file', request, '--playbook', 'investigation').status, 1);
    let current = json('start', '--workspace', workspace, '--request-file', request, '--intent-file', intentFile);
    const run = current.run;
    assert.equal(current.completed, false);
    const passiveWait = call('wait', '--run', run, '--timeout-ms', '60000');
    assert.equal(passiveWait.status, 1);
    assert.match(passiveWait.stderr, /next\/action\/record/);
    assert.equal(json('pause', '--run', run, '--reason', 'operator pause').status, 'paused');
    json('resume', '--run', run);
    current = json('next', '--run', run);
    const artifact = path.join(workspace, 'observation.md');
    fs.writeFileSync(artifact, 'Synthetic CLI fixture: this checks routing and receipts, not actual model investigation.');
    const receiptFile = path.join(workspace, 'receipt.json');
    let steps = 0;
    while (!current.completed) {
      assert.equal(current.requiredChildren.length, 0);
      const receipt = { stepId: current.stepId, generation: current.generation,
        outcome: current.when ? 'not-applicable' : 'passed', reason: 'Fixture excludes optional source branch',
        evidence: (current.when ? ['scope-exclusion'] : current.evidence).map(kind => ({ kind, path: artifact })) };
      fs.writeFileSync(receiptFile, JSON.stringify({ ...receipt, generation: -1 }));
      assert.equal(call('record', '--run', run, '--receipt-file', receiptFile).status, 1);
      fs.writeFileSync(receiptFile, JSON.stringify(receipt));
      json('record', '--run', run, '--receipt-file', receiptFile);
      current = json('next', '--run', run);
      assert.ok(++steps < 30);
    }
    assert.equal(json('status', '--run', run).completed, true);
    assert.equal(json('wait', '--run', run, '--timeout-ms', '0').completed, true);
  } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
});
