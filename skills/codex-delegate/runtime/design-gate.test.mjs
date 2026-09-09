import test from 'node:test';
import assert from 'node:assert/strict';
import { newDesignGate, updateDesign, designContext, validateDesignCoverage } from './design-gate.mjs';

const roles = { worker: 'worker', reviewer: 'reviewer' };
const proof = [{ kind: 'code', path: 'source-observation' }];
const requirement = decisionIds => [{ id: 'tenant-send', text: 'Use current tenant fields', implementationFiles: ['sender.ts'], verification: 'Sender integration test', decisionIds }];
test('clear work skips grilling but retains implementation and verification mapping', () => {
  const gate = newDesignGate();
  updateDesign(gate, { worker: 'worker' }, { type: 'assess-design', actorId: 'worker', clear: true, reason: 'Existing behavior and requested change are explicit', questions: [] }, proof);
  assert.equal(gate.state, 'ready');
  assert.deepEqual(designContext(gate).userQuestions, []);
  validateDesignCoverage(gate, requirement([]));
  assert.throws(() => validateDesignCoverage(gate, [{ id: 'missing', text: 'No map', decisionIds: [] }]), /implementation locations/);
});
test('technical grilling follows dependency rounds and accepted decisions cannot disappear from the plan', () => {
  const gate = newDesignGate(); const op = operation => updateDesign(gate, roles, operation, proof);
  op({ type: 'assess-design', actorId: 'worker', clear: false, reason: 'Caller and failure contracts are unclear', questions: [
    { id: 'callers', question: 'Which producers call this boundary?', kind: 'technical', dependsOn: [] },
    { id: 'failures', question: 'How do those callers handle failure?', kind: 'technical', dependsOn: ['callers'] },
  ] });
  assert.deepEqual(designContext(gate).agentQuestions.map(q => q.id), ['callers']);
  assert.throws(() => op({ type: 'grill-answer', actorId: 'worker', id: 'failures', answer: 'Guess', source: 'code', disposition: 'requirement' }), /frontier/);
  assert.throws(() => op({ type: 'design-ready', actorId: 'reviewer' }), /transition rejected/);
  for (const id of ['callers', 'failures']) {
    op({ type: 'grill-answer', actorId: 'worker', id, answer: 'Confirmed from the code', source: 'code', disposition: 'requirement' });
    op({ type: 'grill-confirm', actorId: 'reviewer', id, accepted: true });
  }
  op({ type: 'design-ready', actorId: 'reviewer' });
  assert.throws(() => validateDesignCoverage(gate, requirement(['callers'])), /missing from acceptance: failures/);
  validateDesignCoverage(gate, requirement(['callers', 'failures']));
});
test('product, authority and irreversible choices require real user evidence, including previously supplied decisions', () => {
  for (const kind of ['product-policy', 'authority', 'irreversible']) {
    const gate = newDesignGate();
    updateDesign(gate, roles, { type: 'assess-design', actorId: 'worker', clear: false, reason: 'Unsettled user choice', questions: [{ id: 'choice', kind, question: 'Which policy is authorized?', dependsOn: [] }] }, proof);
    assert.equal(designContext(gate).userQuestions.length, 1);
    const answer = { type: 'grill-answer', actorId: 'worker', id: 'choice', answer: 'Selected policy', disposition: 'requirement' };
    assert.throws(() => updateDesign(gate, roles, { ...answer, source: 'code' }, proof), /actual existing or new user input/);
    updateDesign(gate, roles, { ...answer, source: 'user', userQuote: 'Previously authorized exact policy' }, [{ kind: 'user-decision', path: 'user-message' }]);
    updateDesign(gate, roles, { type: 'grill-confirm', actorId: 'reviewer', id: 'choice', accepted: true }, proof);
    updateDesign(gate, roles, { type: 'design-ready', actorId: 'reviewer' }, proof);
    assert.equal(gate.state, 'ready');
  }
});

test('accepted assumptions also require a verification mapping', () => {
  const gate = newDesignGate(); const op = operation => updateDesign(gate, roles, operation, proof);
  op({ type: 'assess-design', actorId: 'worker', clear: false, reason: 'Confirm a load-bearing assumption', questions: [{ id: 'tenant-source', kind: 'technical', question: 'Which tenant source applies?', dependsOn: [] }] });
  op({ type: 'grill-answer', actorId: 'worker', id: 'tenant-source', answer: 'Current organization profile', source: 'code', disposition: 'assumption' });
  op({ type: 'grill-confirm', actorId: 'reviewer', id: 'tenant-source', accepted: true });
  op({ type: 'design-ready', actorId: 'reviewer' });
  assert.throws(() => validateDesignCoverage(gate, requirement([])), /missing from acceptance/);
  validateDesignCoverage(gate, requirement(['tenant-source']));
});
