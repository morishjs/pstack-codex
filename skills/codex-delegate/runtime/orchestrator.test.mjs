import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync, spawn as nativeSpawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cliValue, start, transition } from "./orchestrator.mjs";
import { canonicalRouteKey } from "./model-policy.mjs";

async function fixture(route) {
  const root = await mkdtemp(path.join(os.tmpdir(), "delegate-orchestrator-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  await writeFile(path.join(root, "check.mjs"), 'console.log("BASE PASS")');
  await writeFile(path.join(root, "app.mjs"), "export const app = 1;");
  await writeFile(path.join(root, "request.txt"), "make it work");
  const bin = path.join(root, "fake-codex.mjs");
  await writeFile(bin, `#!/usr/bin/env node
import {readFileSync,writeFileSync} from 'node:fs'; import {randomUUID} from 'node:crypto';
const a=process.argv,out=a[a.indexOf('-o')+1],schema=JSON.parse(readFileSync(a[a.indexOf('--output-schema')+1])); const p=schema.properties, m=a[a.indexOf('-m')+1];
console.log(JSON.stringify({type:'thread.started',thread_id:randomUUID()}));
let result;
if(m==='gpt-5.6-terra'&&process.env.FAKE_VISUAL) writeFileSync(process.env.FAKE_VISUAL,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwI/2xwQ7QAAAABJRU5ErkJggg==','base64'));
if(p.workflow) result=${JSON.stringify(route)};
else if(p.findings&&!p.status) result={findings:['found'],evidence:['app.mjs:1'],unknowns:[]};
else if(p.decisions) result={decisions:['small change'],evidence:['app.mjs:1'],unknowns:[]};
else if(p.checks) result={status:'ready',reason:'fixture',requirements:[{id:'R1',description:'works',verification:'automated',checkIds:['C1']}],checks:[{id:'C1',argv:['node','check.mjs'],testFiles:['check.mjs'],baseline:'pass',baselineMarker:'BASE',passMarker:'PASS'}],implementationPaths:['app.mjs'],...(process.env.FAKE_PERFORMANCE?{performanceMeasurements:[{id:'latency',checkId:'C1',unit:'ms',direction:'lower',requiredImprovementPercent:0}]}:{})};
else if(p.summary) result={status:'done',summary:'done'};
else result=process.env.FAKE_MODE==='review-contract'?{status:'changes_requested',nextAction:'contract_revision',requirements:[{id:'R1',status:'pass',evidence:'check'}],findings:['contract change']}:{status:'pass',nextAction:'repair',requirements:[{id:'R1',status:'pass',evidence:'check'}],findings:[]};
writeFileSync(out,JSON.stringify(result)); console.log(JSON.stringify({type:'turn.completed',thread_id:randomUUID()}));`);
  execFileSync("git", ["add", "."], { cwd: root }); execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@e", "commit", "-qm", "fixture"], { cwd: root });
  return { root, bin, requestFile: path.join(root, "request.txt") };
}
function spawnFor(f, seen) { return (cmd, args, options) => { if (!args.includes("-m")) return nativeSpawn(cmd, args, options); seen.push(args[args.indexOf("-m") + 1]); return nativeSpawn(process.execPath, [f.bin, ...args], options); }; }
const simple = { workflow: "simple-fix", taskClass: "simple-fix", risk: "low", complexity: "low", signals: ["known-failing-deterministic-check", "explicit-expected-behavior", "bounded-implementation-allowlist"], reason: "known", authorizedActions: ["local-workspace"], finishAfterInvestigation: false };

test("orchestrator has declared XState transitions", () => {
  assert.equal(transition("classifying", "CLASSIFIED"), "investigating");
  assert.throws(() => transition("classifying", "COMPLETE"));
});
test("CLI omits absent optional values", () => {
  const args = ["--workspace", "/tmp/project", "--request-file", "/tmp/request"];
  assert.equal(cliValue(args, "--workspace"), "/tmp/project");
  assert.equal(cliValue(args, "--runtime-visual-evidence"), undefined);
  assert.equal(cliValue(args, "--runtime-visual-route"), undefined);
});
test("investigation route stops after read-only findings", async () => {
  const f = await fixture({ ...simple, workflow: "investigation", taskClass: "investigation", authorizedActions: ["read-only"], finishAfterInvestigation: true }), seen = [];
  const state = await start({ workspace: f.root, requestFile: f.requestFile, codexBin: process.execPath, spawn: spawnFor(f, seen) });
  assert.equal(state.phase, "complete", state.reason);
  assert.deepEqual(seen, ["gpt-5.6-terra", "gpt-5.6-sol"]);
  assert.equal(state.agents.every((agent) => agent.sandbox === "read-only"), true);
});
test("simple fix uses Terra worker and still gets unevaluated Sol review", async () => {
  const f = await fixture(simple), seen = [];
  const state = await start({ workspace: f.root, requestFile: f.requestFile, codexBin: process.execPath, spawn: spawnFor(f, seen) });
  assert.equal(state.phase, "complete", state.reason);
  assert.deepEqual(seen, ["gpt-5.6-terra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-sol"]);
  assert.equal(state.assignments.implement.model, "gpt-5.6-terra");
});
test("bug fixes investigate with Sol and contradictions escalate acceptance to Astra", async () => {
  const route = { ...simple, workflow: "bug-fix", taskClass: "bug-fix", risk: "medium", complexity: "medium", signals: ["unresolved-contradiction"], finishAfterInvestigation: false };
  const f = await fixture(route), seen = [];
  const state = await start({ workspace: f.root, requestFile: f.requestFile, codexBin: process.execPath, spawn: spawnFor(f, seen) });
  assert.equal(state.phase, "complete", state.reason);
  assert.deepEqual(seen, ["gpt-5.6-terra", "gpt-5.6-sol", "gpt-6-astra", "gpt-5.6-terra", "gpt-5.6-sol"]);
  assert.equal(state.assignments.acceptance.model, "gpt-6-astra");
  const nested = JSON.parse(readFileSync(path.join(state.nestedRun, "state.json"), "utf8"));
  assert.equal(nested.contextArtifacts.some((artifact) => artifact.label === "investigation"), true);
  for (const agent of nested.agents)
    assert.match(readFileSync(path.join(agent.dir, "prompt.txt"), "utf8"), /Fixed context artifacts/);
});
test("malformed route and missing UI visual evidence block", async () => {
  const malformed = await fixture({ ...simple, workflow: "nope" });
  const bad = await start({ workspace: malformed.root, requestFile: malformed.requestFile, codexBin: process.execPath, spawn: spawnFor(malformed, []) });
  assert.equal(bad.phase, "blocked"); assert.match(bad.reason, /malformed route/);
  const ui = await fixture({ ...simple, workflow: "ui-change", taskClass: "ui-change", signals: [], complexity: "medium" });
  const blocked = await start({ workspace: ui.root, requestFile: ui.requestFile, codexBin: process.execPath, spawn: spawnFor(ui, []) });
  assert.equal(blocked.phase, "blocked"); assert.match(blocked.reason, /runtime-visual/);
});
test("classifier taskClass must equal its registered workflow key", async () => {
  const f = await fixture({ ...simple, workflow: "bug-fix", taskClass: "controller error mapping" });
  const state = await start({ workspace: f.root, requestFile: f.requestFile, codexBin: process.execPath, spawn: spawnFor(f, []) });
  assert.equal(state.phase, "blocked");
  assert.match(state.reason, /taskClass\/workflow mismatch/);
});
test("mutation workflow rejects read-only authorization", async () => {
  const f = await fixture({ ...simple, authorizedActions: ["read-only"] });
  const state = await start({ workspace: f.root, requestFile: f.requestFile, codexBin: process.execPath, spawn: spawnFor(f, []) });
  assert.equal(state.phase, "blocked");
  assert.match(state.reason, /local-workspace authorization/);
});
test("contract revisions restart with Sol then Astra and stop at the budget", async () => {
  const f = await fixture(simple), seen = [];
  const spawn = (cmd, args, options) => {
    if (!args.includes("-m")) return nativeSpawn(cmd, args, options);
    seen.push(args[args.indexOf("-m") + 1]);
    return nativeSpawn(process.execPath, [f.bin, ...args], { ...options, env: { ...process.env, FAKE_MODE: "review-contract" } });
  };
  const state = await start({ workspace: f.root, requestFile: f.requestFile, codexBin: process.execPath, spawn });
  assert.equal(state.phase, "blocked");
  assert.match(state.reason, /revision budget exhausted/);
  assert.equal(state.contractRevisions, 2);
  assert.deepEqual(seen, ["gpt-5.6-terra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-sol", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-sol", "gpt-6-astra", "gpt-5.6-terra", "gpt-5.6-sol"]);
});

test("UI route accepts post-implementation valid runtime visual evidence", async () => {
  const f = await fixture({ ...simple, workflow: "ui-change", taskClass: "ui-change", signals: [], complexity: "medium" });
  const visual = path.join(f.root, "runtime.png");
  const spawn = (cmd, args, options) => args.includes("-m")
    ? nativeSpawn(process.execPath, [f.bin, ...args], { ...options, env: { ...process.env, FAKE_VISUAL: visual } })
    : nativeSpawn(cmd, args, options);
  const state = await start({ workspace: f.root, requestFile: f.requestFile, runtimeVisualEvidenceFile: visual, runtimeVisualRoute: "/settings", codexBin: process.execPath, spawn });
  assert.equal(state.phase, "complete", state.reason);
  assert.equal(state.evidence["runtime-visual"].path, visual);
  assert.match(state.evidence["runtime-visual"].sha256, /^[a-f0-9]{64}$/);
  const nested = JSON.parse(readFileSync(path.join(state.nestedRun, "state.json"), "utf8"));
  assert.equal(nested.visualManifest.path, visual);
  const reviewer = nested.agents.find((agent) => agent.role === "reviewer");
  const prompt = readFileSync(path.join(reviewer.dir, "prompt.txt"), "utf8");
  assert.match(prompt, new RegExp(visual.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(prompt, /verify SHA-256/);
});
test("UI route blocks when visual evidence drifts during nested review", async () => {
  const f = await fixture({ ...simple, workflow: "ui-change", taskClass: "ui-change", signals: [], complexity: "medium" });
  const visual = path.join(os.tmpdir(), `delegate-visual-${Date.now()}-${Math.random()}.png`);
  let solCalls = 0;
  const spawn = (cmd, args, options) => {
    if (args.includes("-m") && args[args.indexOf("-m") + 1] === "gpt-5.6-sol" && ++solCalls && existsSync(visual))
      writeFileSync(visual, Buffer.concat([readFileSync(visual), Buffer.from([0])]));
    return args.includes("-m")
      ? nativeSpawn(process.execPath, [f.bin, ...args], { ...options, env: { ...process.env, FAKE_VISUAL: visual } })
      : nativeSpawn(cmd, args, options);
  };
  const state = await start({ workspace: f.root, requestFile: f.requestFile, runtimeVisualEvidenceFile: visual, runtimeVisualRoute: "/settings", codexBin: process.execPath, spawn });
  assert.equal(state.phase, "blocked");
  assert.match(state.reason, /runtime visual evidence changed/);
});
test("performance delivers nested baseline and measurement evidence", async () => {
  const f = await fixture({ ...simple, workflow: "performance", taskClass: "performance", signals: [], complexity: "medium" });
  writeFileSync(path.join(f.root, "check.mjs"), 'console.log("BASE PASS"); console.log("CODEX_DELEGATE_METRIC latency 10 ms")');
  const spawn = (cmd, args, options) => args.includes("-m")
    ? nativeSpawn(process.execPath, [f.bin, ...args], { ...options, env: { ...process.env, FAKE_PERFORMANCE: "1" } })
    : nativeSpawn(cmd, args, options);
  const state = await start({ workspace: f.root, requestFile: f.requestFile, codexBin: process.execPath, spawn });
  assert.equal(state.phase, "complete", state.reason);
  assert.equal(Array.isArray(state.evidence["performance-measurement"].metrics), true);
});
test("evaluated simple-fix route still invokes Sol and records independent review", async () => {
  const f = await fixture(simple), policy = JSON.parse(readFileSync(new URL("./model-policy.json", import.meta.url), "utf8"));
  const artifact = { version: 1, taskClass: "simple-fix", workflow: "simple-fix", risk: "low", complexity: "low", signals: simple.signals, capability: "implement", model: "gpt-5.6-terra", reasoning: "medium", skillVersion: policy.skillVersion, passed: true, caseCount: 4, holdoutCount: 2, repetitions: 2, falseCompletionCount: 0, scopeViolationCount: 0, evaluatedAt: "2026-09-07T00:00:00.000Z", independentReview: true };
  artifact.routeKey = canonicalRouteKey(artifact);
  const evidencePath = path.join(f.root, "evaluation.json"), raw = JSON.stringify(artifact); writeFileSync(evidencePath, raw);
  policy.evaluatedRoutes.push({ ...artifact, evaluationVersion: 1, evidencePath, evidenceHash: createHash("sha256").update(raw).digest("hex"), status: "evaluated" });
  const seen = [], state = await start({ workspace: f.root, requestFile: f.requestFile, policy, codexBin: process.execPath, spawn: spawnFor(f, seen) });
  assert.equal(state.phase, "complete", state.reason);
  assert.deepEqual(seen, ["gpt-5.6-terra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-sol"]);
  assert.equal(state.evidence["independent-review"].status, "pass");
  assert.equal(state.assignments.review.model, "gpt-5.6-sol");
});
test("PR maintenance remains local-workspace only", async () => {
  const route = { ...simple, workflow: "pr-maintenance", taskClass: "pr-maintenance", signals: [], complexity: "medium" };
  const f = await fixture(route), state = await start({ workspace: f.root, requestFile: f.requestFile, codexBin: process.execPath, spawn: spawnFor(f, []) });
  assert.equal(state.phase, "complete", state.reason);
  assert.equal(state.classification.authorizedActions.includes("local-workspace"), true);
  assert.equal(state.classification.authorizedActions.some((x) => /push|merge|commit/.test(x)), false);
  const prompts = state.agents.map((agent) => readFileSync(path.join(agent.dir, "prompt.txt"), "utf8")).join("\n");
  assert.match(prompts, /Do not write workspace files, commit, push, deploy/);
});
