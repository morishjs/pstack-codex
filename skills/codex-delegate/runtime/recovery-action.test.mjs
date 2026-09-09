import test from 'node:test';
import assert from 'node:assert/strict';
import { assessRecovery, recoveryInstructions } from './recovery-action.mjs';

const state = { grants: ['read-only', 'local-workspace', 'remote-write'] };
test('scoped verification recovery continues without another approval', () => {
  for (const kind of ['install-browser', 'start-local-server', 'repair-local-api', 'run-verification']) {
    assert.equal(assessRecovery(state, { kind, inScope: true, environment: 'local' }).decision, 'continue', kind);
  }
  assert.equal(assessRecovery(state, { kind: 'test-login', inScope: true, environment: 'local', existingTestAccount: true }).decision, 'continue');
  assert.match(recoveryInstructions, /Execute them/);
  assert.equal(assessRecovery({ authority: 'local-workspace' }, { kind: 'install-browser', inScope: true, environment: 'local' }).decision, 'continue');
});
test('localhost and a PR grant do not authorize credential changes, remote writes or deletion', () => {
  for (const kind of ['account-change', 'remote-data-write', 'delete-data', 'unknown']) {
    assert.equal(assessRecovery(state, { kind, inScope: true, environment: 'local' }).decision, 'needs-user', kind);
  }
  assert.equal(assessRecovery(state, { kind: 'test-login', inScope: true, environment: 'local', existingTestAccount: false }).decision, 'needs-user');
  assert.equal(assessRecovery(state, { kind: 'repair-local-api', inScope: false, environment: 'local' }).decision, 'needs-user');
  assert.equal(assessRecovery({ grants: ['read-only'] }, { kind: 'repair-local-api', inScope: true, environment: 'local' }).decision, 'needs-user');
  assert.throws(() => assessRecovery(state, { kind: 'login' }), /known kind/);
  assert.equal(assessRecovery({ ...state, status: 'paused' }, { kind: 'install-browser', inScope: true, environment: 'local' }).decision, 'paused');
});
