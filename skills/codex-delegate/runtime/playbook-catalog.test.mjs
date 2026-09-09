import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { PLAYBOOKS, getPlaybook, listPlaybooks } from './playbook-catalog.mjs';

const sourceDirectory = new URL('../poteto/playbooks/', import.meta.url);
const state = (book, id) => getPlaybook(book).steps.find((item) => item.id === id);
const before = (book, first, second) => {
  const ids = getPlaybook(book).steps.map((item) => item.id);
  assert.ok(ids.indexOf(first) >= 0 && ids.indexOf(first) < ids.indexOf(second), `${book}: ${first} before ${second}`);
};

test('catalog matches every source file and maps every numbered source step', async () => {
  const filenames = (await readdir(sourceDirectory)).filter((name) => name.endsWith('.md')).sort();
  assert.equal(filenames.length, 23);
  assert.deepEqual(Object.keys(PLAYBOOKS).map((id) => `${id}.md`).sort(), filenames);
  for (const filename of filenames) {
    const id = filename.slice(0, -3);
    const source = await readFile(new URL(filename, sourceDirectory), 'utf8');
    const numbered = [...source.matchAll(/^(\d+)\.\s/gm)].map((match) => Number(match[1]));
    const mapped = [...new Set(getPlaybook(id).steps.flatMap((item) => item.sourceSteps))].sort((a, b) => a - b);
    assert.deepEqual(mapped, [...new Set(numbered)].sort((a, b) => a - b), id);
    assert.equal(getPlaybook(id).source, `poteto/playbooks/${filename}`);
  }
});

test('states have source-addressed instructions, evidence and bounded authority; handoffs and loops resolve', () => {
  const authorities = new Set(['read-only', 'local-workspace', 'remote-write', 'destructive', 'scheduler']);
  for (const [id, playbook] of Object.entries(PLAYBOOKS)) {
    assert.equal(playbook.id, id);
    assert.ok(playbook.title && playbook.entry);
    const ids = new Set(playbook.steps.map((item) => item.id));
    assert.equal(ids.size, playbook.steps.length, `${id}: duplicate state`);
    for (const item of playbook.steps) {
      assert.ok(item.instruction.length > 30, `${id}/${item.id}`);
      assert.ok(item.instruction.includes(playbook.source));
      assert.ok(item.evidence.length && item.evidence.every((kind) => typeof kind === 'string' && kind.trim()));
      assert.ok(authorities.has(item.authority));
      assert.ok(item.sourceSteps.every((number) => Number.isInteger(number) && number > 0));
      if (item.when !== undefined) assert.ok(item.when.trim());
      for (const child of item.invokes ?? []) assert.ok(PLAYBOOKS[child], `${id}/${item.id}: unknown child ${child}`);
    }
    for (const edge of playbook.loops ?? []) {
      assert.ok(ids.has(edge.from) && ids.has(edge.to), `${id}: dangling loop`);
      assert.ok(edge.reason.trim());
    }
  }
  assert.equal(listPlaybooks().length, 23);
  assert.throws(() => getPlaybook('missing'), /Unknown playbook/);
});

test('measurement, reproduction and contract baselines precede implementation', () => {
  before('bug-fix', 'reproduce', 'cause');
  before('bug-fix', 'cause', 'fix');
  before('perf-issue', 'baseline', 'implement');
  before('hillclimb', 'baseline', 'attempt');
  before('refactoring', 'pin', 'move');
  before('visual-parity', 'baseline', 'migrate');
  assert.match(state('hillclimb', 'baseline').instruction, /sensitivity.*freeze.*baseline.*before any change/);
  assert.match(state('hillclimb', 'attempt').instruction, /beyond noise.*otherwise fully revert/);
  assert.match(state('refactoring', 'equivalence').instruction, /real-artifact.*delegate summary is insufficient/);
});

test('prototype and investigation preserve lightweight exceptions', () => {
  const scratch = state('prototype', 'scratch');
  assert.match(scratch.instruction, /isolated scratch.*outside production source/);
  assert.match(scratch.instruction, /No planning, production framework, tests, or abstractions/);
  assert.match(state('prototype', 'observe').instruction, /Observation is the test/);
  assert.ok(!getPlaybook('prototype').steps.some((item) => item.role === 'planner'));
  assert.ok(state('prototype', 'feature-handoff').when);
  assert.deepEqual(state('prototype', 'feature-handoff').invokes, ['feature']);
  assert.ok(getPlaybook('investigation').steps.every((item) => item.authority === 'read-only' && !item.invokes));
  assert.match(state('investigation', 'checkpoint').instruction, /No four-item code checkpoint, architect, PR, or babysit/);
});

test('babysit distinguishes read-only monitor, repair loop and forge-specific terminal gates', () => {
  before('babysit', 'mode', 'poll');
  before('babysit', 'order', 'ci-classify');
  assert.equal(state('babysit', 'mode').authority, 'read-only');
  assert.match(state('babysit', 'mode').instruction, /read-only check per wake, never fixes, reruns, replies, or merges/);
  assert.equal(state('babysit', 'monitor-schedule').authority, 'scheduler');
  assert.ok(state('babysit', 'ci-retrigger').when && state('babysit', 'push-reply').when);
  assert.match(state('babysit', 'wake').instruction, /rearm after every push wave.*never a second sleep loop/);
  assert.ok(getPlaybook('babysit').loops.some((edge) => edge.from === 'push-reply' && edge.to === 'wake'));
  assert.ok(getPlaybook('babysit').loops.some((edge) => edge.from === 'terminal' && edge.to === 'frontier'));
  const terminal = state('babysit', 'terminal').instruction;
  for (const token of ['READY', 'WAITING', 'merge-queue', 'COMPLETE', 'ADVANCE', 'Origin', 'Owner approval waits']) assert.ok(terminal.includes(token), token);
  assert.match(state('babysit', 'shipping-handoff').when, /explicitly requested landing/);
});

test('visual parity requires numeric zero-diff and protects the baseline', () => {
  assert.deepEqual(state('visual-parity', 'pixel-diff').assertions, [{ field: 'pixelDiff', equals: 0 }]);
  assert.match(state('visual-parity', 'anti-shortcut').instruction, /no harness modifications, baseline tampering/);
  assert.match(state('visual-parity', 'pixel-diff').instruction, /Nonzero diff fails/);
  assert.ok(getPlaybook('visual-parity').loops.some((edge) => edge.from === 'pixel-diff' && edge.to === 'migrate'));
});

test('PR delivery honors authorization and checks current CI without automatically babysitting', () => {
  before('opening-a-pr', 'verify', 'publish');
  before('opening-a-pr', 'publish', 'ci');
  assert.equal(state('opening-a-pr', 'commit').authority, 'local-workspace');
  assert.ok(state('opening-a-pr', 'commit').when);
  assert.equal(state('opening-a-pr', 'publish').authority, 'remote-write');
  assert.ok(state('opening-a-pr', 'publish').when);
  assert.deepEqual(state('opening-a-pr', 'ci').evidence, ['head-sha', 'ci-status']);
  assert.match(state('opening-a-pr', 'ci').instruction, /passed, failed, pending or unavailable/);
  assert.match(state('opening-a-pr', 'babysit-handoff').when, /whole requested phase\/stack.*separately requested/);
  assert.ok(getPlaybook('shipping').loops.some((edge) => edge.from === 'watch' && edge.to === 'confirm-forge'));
  assert.match(state('shipping', 'watch').instruction, /READY.*not shipping terminal/);
  before('shipping', 'watch', 'recompute');
});

test('long playbooks preserve substantial unnumbered contracts and conditional exits', () => {
  for (const id of ['program-contract', 'verification-contract', 'perf-contract', 'review-contract', 'appendices']) assert.ok(state('multi-phase-plan', id));
  assert.match(state('multi-phase-plan', 'verification-contract').instruction, /ten inherit-parent live lanes/);
  assert.match(state('multi-phase-plan', 'perf-contract').instruction, /trunk baseline measured first/);
  assert.ok(getPlaybook('multi-phase-plan').steps.filter((item) => !['size-gate', 'reply'].includes(item.id)).every((item) => item.when));
  for (const id of ['roles', 'store', 'brief', 'stack-safety', 'verify', 'liveness', 'restart', 'escalation']) assert.ok(state('orchestrate', id));
  assert.match(state('orchestrate', 'liveness').instruction, /two retries then abandon\/replan/);
  assert.match(state('orchestrate', 'stack-safety').instruction, /missing supported gt metadata is a blocker/);
  assert.ok(getPlaybook('orchestrate').steps.filter((item) => !['frame', 'collapse', 'reply'].includes(item.id)).every((item) => item.when));
  before('autopilot-stack', 'operator-gates', 'owner-loop');
  assert.match(state('autopilot-stack', 'append-rule').instruction, /No owner merges, arms auto-merge, or closes/);
});

test('live forensics is distinguished from fixed-capture analysis and cleanup keeps deletion authority', () => {
  assert.match(state('runtime-forensics', 'mechanism').instruction, /temporary live-process instrumentation/);
  assert.equal(state('runtime-forensics', 'mechanism').authority, 'local-workspace');
  assert.match(state('trace-forensics', 'load').instruction, /fixed data, do not recapture/);
  assert.match(state('trace-forensics', 'paired').instruction, /Without a pair.*not confirmed cause/);
  for (const id of ['remove', 'simulators']) {
    assert.equal(state('worktree-cleanup', id).authority, 'destructive');
    assert.ok(state('worktree-cleanup', id).when);
  }
  before('worktree-cleanup', 'loss-gate', 'remove');
});
