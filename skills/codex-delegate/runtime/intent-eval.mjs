import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { classifyRequest, resolveIntent, routingPrompt, normalizeClassification } from './task-intent.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const cases = JSON.parse(fs.readFileSync(path.join(here, 'cases/intent-routing.json'), 'utf8'));
const defaultPolicy = JSON.parse(fs.readFileSync(path.join(here, 'task-policy.json'), 'utf8'));
export function gradeDecision(item, decision) {
  decision = normalizeClassification(decision);
  let actual;
  try { actual = resolveIntent(item.request, decision, item.policy ?? defaultPolicy); }
  catch (error) {
    if (decision.kind === 'resume' && error.message.startsWith('resume requires')) actual = { goal: 'resume', playbook: null };
    else return { passed: false, error: error.message };
  }
  // Judge the authorized outcome and route, not interchangeable taxonomy labels.
  const passed = actual.goal === item.expected.goal && actual.playbook === item.expected.playbook;
  return { passed, actual: { kind: decision.kind, goal: actual.goal, playbook: actual.playbook, grants: actual.grants } };
}
export function gradeRun(results, repetitions = 1) {
  const expected = new Set(cases.flatMap(item => Array.from({ length: repetitions }, (_, repeat) => `${item.id}:${repeat}`)));
  const seen = new Set();
  for (const result of results) {
    const key = `${result.id}:${result.repeat}`;
    if (!expected.has(key) || seen.has(key) || !result.passed) return { passed: false, total: expected.size, reason: 'failed, unexpected, or duplicate result' };
    seen.add(key);
  }
  return { passed: seen.size === expected.size, total: expected.size, observed: seen.size };
}
export async function runIntentEval({ outDir, model = 'gpt-5.6-terra', repetitions = 1, codexBin = 'codex' }) {
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 10) throw new Error('repetitions must be 1..10');
  fs.mkdirSync(outDir, { recursive: true });
  const queue = cases.flatMap(item => Array.from({ length: repetitions }, (_, repeat) => ({ item, repeat })));
  const results = [];
  // Two isolated read-only classifier calls at a time; no application or remote writes.
  await Promise.all(Array.from({ length: 2 }, async () => {
    while (queue.length) {
      const { item, repeat } = queue.shift();
      const directory = path.resolve(outDir, randomUUID());
      let result;
      try {
        const decision = await classifyRequest({ request: item.request, policy: item.policy ?? defaultPolicy, outDir: directory, model, codexBin });
        result = { id: item.id, repeat, directory, decision, ...gradeDecision(item, decision) };
      } catch (error) { result = { id: item.id, repeat, directory, passed: false, error: error.message }; }
      results.push(result);
      fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(results, null, 2));
    }
  }));
  const report = { live: true, model, repetitions, datasetSha256: createHash('sha256').update(JSON.stringify(cases)).digest('hex'),
    routingSourceSha256: createHash('sha256').update(fs.readFileSync(path.join(here, 'task-intent.mjs'))).digest('hex'),
    ...gradeRun(results, repetitions), results };
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  return report;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2); const value = key => args[args.indexOf(key) + 1];
  try {
    if (!args.includes('--live')) {
      for (const item of cases) if (!item.id || !item.expected || !routingPrompt(item.request, item.policy ?? defaultPolicy)) throw new Error('invalid case');
      console.log(JSON.stringify({ live: false, cases: cases.length, note: 'Dry run; no model calls.' }));
    } else {
      if (!args.includes('--out')) throw new Error('--live requires --out ABS');
      const report = await runIntentEval({ outDir: path.resolve(value('--out')), model: args.includes('--model') ? value('--model') : undefined,
        repetitions: args.includes('--repeat') ? Number(value('--repeat')) : 1, codexBin: args.includes('--codex-bin') ? value('--codex-bin') : undefined });
      console.log(JSON.stringify({ live: report.live, passed: report.passed, total: report.total, outDir: value('--out') }));
      if (!report.passed) process.exitCode = 1;
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
