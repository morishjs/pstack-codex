import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { existsSync, chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn as nativeSpawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { start, resume, status, recover } from "./runner.mjs";
import { transition } from "./machine.mjs";

async function fixture({ missingMarker = false, missingIds = false, baselinePass = false, secondCheck = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "delegate-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  await writeFile(path.join(root, "check.mjs"), 'import {app} from "./app.mjs"; console.log(app ? "BASE PASS" : "BASE FAIL"); process.exit(app ? 0 : 1);');
  await writeFile(path.join(root, "app.mjs"), `export const app = ${baselinePass ? 1 : 0};`);
  await writeFile(path.join(root, "request.txt"), "make it work");
  const bin = path.join(root, "fake-codex.mjs");
  await writeFile(
    bin,
    `#!/usr/bin/env node
import {writeFileSync,mkdirSync,readFileSync} from 'node:fs'; import {randomUUID} from 'node:crypto'; const a=process.argv, out=a[a.indexOf('-o')+1], schema=JSON.parse(readFileSync(a[a.indexOf('--output-schema')+1],'utf8')), m=schema.properties.checks?'gpt-6-astra':schema.properties.summary?'gpt-5.6-terra':'gpt-5.6-sol', mode=process.env.FAKE_MODE; const thread=process.env.FAKE_THREAD_ID||(a.includes('resume')&&mode!=='wrong-thread'?a.at(-2):randomUUID()); if(mode!=='missing-thread') console.log(JSON.stringify({type:'thread.started',thread_id:thread}));
if(m==='gpt-6-astra'&&mode==='author-production') writeFileSync('app.mjs','export const app = 1;');
if(m==='gpt-5.6-terra') writeFileSync('app.mjs','export const app = 1;');
if(m==='gpt-5.6-terra'&&mode==='syntax') writeFileSync('app.mjs','export const app = ;');
if(m==='gpt-5.6-terra'&&mode==='frozen') writeFileSync('check.mjs','console.log("BASE PASS")// changed'); if(m==='gpt-5.6-sol'&&mode==='review-mutate') writeFileSync('app.mjs','export const app = 2;');
if(m==='gpt-5.6-terra'&&mode==='partial-worker') {writeFileSync('app.mjs','export const app = 3;'); process.exit(1);}
if(m==='gpt-5.6-sol'&&mode==='review-cache') {mkdirSync('.cache',{recursive:true});writeFileSync('.cache/result','cache');}
if(m==='gpt-5.6-sol'&&mode==='review-test') writeFileSync('check.mjs','console.log("PASS")');
if(mode==='slow') await new Promise(resolve=>setTimeout(resolve,100));
const c=m==='gpt-6-astra'?{status:'ready',reason:'fixture',requirements:[{id:'R1',description:'works',checkIds:${missingIds ? "[]" : "['C1']"}}],checks:[{id:'C1',argv:['node','check.mjs'],testFiles:['check.mjs'],baseline:'${baselinePass ? 'pass' : 'fail'}',baselineMarker:'${missingMarker ? "MISSING" : "BASE"}',passMarker:'PASS'}],implementationPaths:['app.mjs']} : m==='gpt-5.6-terra'?{status:'done',summary:'done'}:{status:mode==='review-env'?'blocked':mode==='review-repair'||(mode??'').startsWith('review-contract')?'changes_requested':'pass',nextAction:mode==='review-env'?'environment_repair':(mode??'').startsWith('review-contract')?'contract_revision':'repair',requirements:mode==='review-omit'?[]:[{id:'R1',status:mode==='review-contract-blocked'||mode==='review-env'?'blocked':'pass',evidence:'check'}],findings:mode==='review-repair'||(mode??'').startsWith('review-contract')?['repair requested']:[]}; if(m==='gpt-6-astra'&&${secondCheck}) {c.checks.push({...c.checks[0],id:'C2',argv:['node','check.mjs','C2']});c.requirements[0].checkIds.push('C2');} writeFileSync(out,JSON.stringify(c)); console.log(JSON.stringify({type:'turn.completed',thread_id:randomUUID()}));`,
  );
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-qm",
      "fixture",
    ],
    { cwd: root },
  );
  return { root, bin, requestFile: path.join(root, "request.txt") };
}
function fakeSpawn(f, mode = "normal") {
  return (cmd, args, opts) =>
    args.includes("-m")
      ? nativeSpawn(process.execPath, [f.bin, ...args], {
          ...opts,
          env: { ...process.env, FAKE_MODE: mode },
        })
      : nativeSpawn(cmd, args, opts);
}
test("XState routes only declared phases", () => {
  assert.equal(transition("authoring", "AUTHOR_OK"), "baseline");
  assert.throws(() => transition("authoring", "PASS"));
});
test("full run uses fixed models and is terminal-idempotent", async () => {
  const f = await fixture(),
    seen = [];
  const spawn = (cmd, args, opts) => {
    if (!args.includes("-m")) return nativeSpawn(cmd, args, opts);
    seen.push(args[args.indexOf("-m") + 1]);
    return nativeSpawn(process.execPath, [f.bin, ...args], opts);
  };
  const state = await start({
    workspace: f.root,
    requestFile: f.requestFile,
    codexBin: process.execPath,
    spawn,
  });
  assert.equal(state.phase, "complete", state.reason);
  assert.deepEqual(seen, ["gpt-6-astra", "gpt-5.6-terra", "gpt-5.6-sol"]);
  assert(existsSync(path.join(state.run, "events.jsonl")));
  assert.equal((await resume({ run: state.run, spawn })).phase, "complete");
  assert.equal((await status(state.run)).phase, "complete");
});
test("baseline needs exact marker", async () => {
  const f = await fixture({ missingMarker: true });
  const spawn = (cmd, args, opts) =>
    args.includes("-m")
      ? nativeSpawn(process.execPath, [f.bin, ...args], opts)
      : nativeSpawn(cmd, args, opts);
  const state = await start({
    workspace: f.root,
    requestFile: f.requestFile,
    codexBin: process.execPath,
    spawn,
  });
  assert.equal(state.phase, "blocked");
  assert.match(state.reason, /baseline failed/);
});
test("author prompt requires literal output markers", async () => {
  const f = await fixture();
  let prompt = "";
  const spawn = (cmd, args, opts) => {
    const child = fakeSpawn(f)(cmd, args, opts);
    if (args[args.indexOf("-m") + 1] === "gpt-6-astra") {
      const end = child.stdin.end.bind(child.stdin);
      child.stdin.end = (input, ...rest) => {
        prompt += input;
        return end(input, ...rest);
      };
    }
    return child;
  };
  const state = await start({
    workspace: f.root,
    requestFile: f.requestFile,
    spawn,
  });
  assert.equal(state.phase, "complete", state.reason);
  assert.match(prompt, /literal, stable substrings of that exact command output/);
  assert.match(prompt, /Prefer a test title or requirement ID/);
  assert.match(prompt, /Do not use a prose summary or synthesized description/);
});
test("author cannot omit a requirement check", async () => {
  const f = await fixture({ missingIds: true });
  const spawn = (cmd, args, opts) =>
    args.includes("-m")
      ? nativeSpawn(process.execPath, [f.bin, ...args], opts)
      : nativeSpawn(cmd, args, opts);
  const state = await start({
    workspace: f.root,
    requestFile: f.requestFile,
    codexBin: process.execPath,
    spawn,
  });
  assert.equal(state.phase, "blocked");
  assert.match(state.reason, /invalid requirement/);
});
test("worker cannot alter frozen acceptance test", async () => {
  const f = await fixture();
  const state = await start({
    workspace: f.root,
    requestFile: f.requestFile,
    codexBin: process.execPath,
    spawn: fakeSpawn(f, "frozen"),
  });
  assert.equal(state.phase, "blocked");
  assert.match(state.reason, /frozen test changed/);
});
test("review needs every requirement ID", async () => {
  const f = await fixture();
  const state = await start({
    workspace: f.root,
    requestFile: f.requestFile,
    codexBin: process.execPath,
    spawn: fakeSpawn(f, "review-omit"),
  });
  assert.equal(state.phase, "blocked");
  assert.match(state.reason, /review coverage incomplete/);
});
test("reviewer cannot mutate tree", async () => {
  const f = await fixture();
  const state = await start({
    workspace: f.root,
    requestFile: f.requestFile,
    codexBin: process.execPath,
    spawn: fakeSpawn(f, "review-mutate"),
  });
  assert.equal(state.phase, "blocked");
  assert.match(state.reason, /workspace changed since checkpoint/);
});
test("workspace lock refuses concurrent run", async () => {
  const f = await fixture();
  const lock = path.join(f.root, ".codex-delegate", "lock");
  mkdirSync(lock, { recursive: true });
  writeFileSync(
    path.join(lock, "owner.json"),
    JSON.stringify({ pid: process.pid, run: "other" }),
  );
  await assert.rejects(
    start({
      workspace: f.root,
      requestFile: f.requestFile,
      codexBin: process.execPath,
      spawn: fakeSpawn(f),
    }),
    /workspace locked/,
  );
});
test("child timeout blocks run", async () => {
  const f = await fixture();
  const state = await start({
    workspace: f.root,
    requestFile: f.requestFile,
    codexBin: process.execPath,
    spawn: fakeSpawn(f, "slow"),
    timeout: 20,
  });
  assert.equal(state.phase, "blocked");
  assert.match(state.reason, /failed or incomplete/);
});
test("complete status rejects stale workspace", async () => {
  const f = await fixture();
  const state = await start({
    workspace: f.root,
    requestFile: f.requestFile,
    codexBin: process.execPath,
    spawn: fakeSpawn(f),
  });
  writeFileSync(path.join(f.root, "app.mjs"), "export const app = 9;");
  const stale = await status(state.run);
  assert.equal(stale.phase, "blocked");
  assert.match(stale.reason, /workspace changed/);
});

test("baseline setup error is not an acceptance pass", async () => {
  const f = await fixture();
  await writeFile(
    path.join(f.root, "check.mjs"),
    'console.log("SyntaxError: mock setup failed BASE PASS")',
  );
  const s = await start({
    workspace: f.root,
    requestFile: f.requestFile,
    spawn: fakeSpawn(f),
  });
  assert.equal(s.phase, "blocked");
  assert.match(s.reason, /baseline failed/);
});

test("review retry does not consume exhausted implementation budget", async () => {
  const f = await fixture();
  const s = await start({
    workspace: f.root,
    requestFile: f.requestFile,
    spawn: fakeSpawn(f, "review-omit"),
    maxAttempts: 1,
  });
  assert.equal(s.blockedPhase, "reviewing");
  const retried = await resume({
    run: s.run,
    retry: true,
    spawn: fakeSpawn(f),
  });
  assert.equal(retried.phase, "complete", retried.reason);
  assert.equal(retried.attempt, 1);
});

test("permitted partial worker failure resumes without losing code", async () => {
  const f = await fixture();
  const s = await start({
    workspace: f.root,
    requestFile: f.requestFile,
    spawn: fakeSpawn(f, "partial-worker"),
  });
  assert.equal(s.phase, "blocked");
  assert.equal(s.blockedPhase, "implementing");
  assert.match(readFileSync(path.join(f.root, "app.mjs"), "utf8"), /app = 3/);
  const retried = await resume({
    run: s.run,
    retry: true,
    spawn: fakeSpawn(f),
  });
  assert.equal(retried.phase, "complete", retried.reason);
});

test("review changes request dispatches another Terra and a fresh Sol", async () => {
  const f = await fixture();
  let reviews = 0;
  const injected = (cmd, args, opts) => {
    if (!args.includes("-m")) return nativeSpawn(cmd, args, opts);
    const model = args[args.indexOf("-m") + 1];
    const mode =
      model === "gpt-5.6-sol" && reviews++ === 0 ? "review-repair" : "normal";
    return fakeSpawn(f, mode)(cmd, args, opts);
  };
  const s = await start({
    workspace: f.root,
    requestFile: f.requestFile,
    spawn: injected,
  });
  assert.equal(s.phase, "complete", s.reason);
  assert.deepEqual(
    s.agents.map((a) => a.role),
    ["author", "worker", "reviewer", "worker", "reviewer"],
  );
  assert.equal(new Set(s.agents.map((a) => a.threadId)).size, 5);
});

test("review contract revision blocks instead of retrying Terra", async () => {
  const f = await fixture();
  const s = await start({
    workspace: f.root,
    requestFile: f.requestFile,
    spawn: fakeSpawn(f, "review-contract"),
  });
  assert.equal(s.phase, "blocked");
  assert.equal(s.blockedPhase, "reviewing");
  assert.match(s.reason, /new run/);
  assert.deepEqual(s.agents.map((agent) => agent.role), ["author", "worker", "reviewer"]);
});

test("blocked requirement still routes an explicit contract revision", async () => {
  const f = await fixture();
  const s = await start({ workspace: f.root, requestFile: f.requestFile, spawn: fakeSpawn(f, "review-contract-blocked") });
  assert.equal(s.phase, "blocked");
  assert.equal(s.nonRetryable, true);
  assert.match(s.reason, /acceptance contract revision/);
});

test("ignored configuration change invalidates completed evidence", async () => {
  const f = await fixture();
  await writeFile(path.join(f.root, ".gitignore"), ".env\n");
  await writeFile(path.join(f.root, ".env"), "SYNTHETIC_MODE=one");
  const s = await start({
    workspace: f.root,
    requestFile: f.requestFile,
    spawn: fakeSpawn(f),
  });
  await writeFile(path.join(f.root, ".env"), "SYNTHETIC_MODE=two");
  assert.equal((await status(s.run)).phase, "blocked");
});

test("explicit recovery records interrupted work before retry", async () => {
  const f = await fixture();
  const s = await start({
    workspace: f.root,
    requestFile: f.requestFile,
    spawn: fakeSpawn(f, "review-omit"),
  });
  s.phase = "reviewing";
  s.inFlight = { phase: "reviewing", pid: 2147483647 };
  writeFileSync(path.join(s.run, "state.json"), JSON.stringify(s));
  await assert.rejects(
    resume({ run: s.run, spawn: fakeSpawn(f) }),
    /in-flight/,
  );
  const recovered = await recover({
    run: s.run,
    reason: "test child confirmed terminated",
  });
  assert.equal(recovered.phase, "blocked");
  assert.equal(recovered.inFlight, undefined);
  assert.equal(
    (await resume({ run: s.run, retry: true, spawn: fakeSpawn(f) })).phase,
    "complete",
  );
});

test("recovery refuses a live child process", async () => {
  const f = await fixture();
  const s = await start({
    workspace: f.root,
    requestFile: f.requestFile,
    spawn: fakeSpawn(f, "review-omit"),
  });
  s.inFlight = { phase: "reviewing", pid: process.pid };
  writeFileSync(path.join(s.run, "state.json"), JSON.stringify(s));
  await assert.rejects(
    recover({ run: s.run, reason: "should not run" }),
    /still active/,
  );
});

test("zero executed tests cannot count as passing acceptance", async () => {
  const f = await fixture();
  await writeFile(
    path.join(f.root, "check.mjs"),
    'console.log("# tests 0 BASE PASS")',
  );
  const s = await start({
    workspace: f.root,
    requestFile: f.requestFile,
    spawn: fakeSpawn(f),
  });
  assert.equal(s.phase, "blocked");
  assert.match(s.reason, /baseline failed/);
});

test("frozen hash manifest cannot be replaced after completion", async () => {
  const f = await fixture();
  const s = await start({
    workspace: f.root,
    requestFile: f.requestFile,
    spawn: fakeSpawn(f),
  });
  await writeFile(path.join(s.run, "acceptance-hashes.json"), "{}");
  const result = await status(s.run);
  assert.equal(result.phase, "blocked");
  assert.match(result.reason, /manifest changed/);
});

test("CLI roles retain medium reasoning and workspace-write review", async () => {
  const f = await fixture(),
    seen = [];
  const spawn = (cmd, args, opts) => {
    if (args.includes("-m"))
      seen.push([
        args[args.indexOf("-m") + 1],
        args[args.indexOf("-c") + 1],
        args[args.indexOf("-s") + 1],
      ]);
    return fakeSpawn(f)(cmd, args, opts);
  };
  const s = await start({
    workspace: f.root,
    requestFile: f.requestFile,
    spawn,
  });
  assert.equal(s.phase, "complete", s.reason);
  assert.deepEqual(seen, [
    ["gpt-6-astra", 'model_reasoning_effort="medium"', "workspace-write"],
    ["gpt-5.6-terra", 'model_reasoning_effort="medium"', "workspace-write"],
    ["gpt-5.6-sol", 'model_reasoning_effort="medium"', "workspace-write"],
  ]);
  const untracked = execFileSync("git", ["status", "--porcelain"], {
    cwd: f.root,
    encoding: "utf8",
  });
  assert(!untracked.includes(".codex-delegate"));
});


test("all baseline behavior passes skips worker through declared event", async () => {
  const f = await fixture({ baselinePass: true });
  const s = await start({ workspace: f.root, requestFile: f.requestFile, spawn: fakeSpawn(f) });
  assert.equal(s.phase, "complete", s.reason);
  assert.equal(s.attempt, 0);
  assert.deepEqual(s.agents.map((a) => a.role), ["author", "reviewer"]);
  assert.equal(transition("baseline", "BASELINE_SATISFIED"), "verifying");
});

test("verification environment failure retries failed checks without another worker", async () => {
  const f = await fixture();
  let checks = 0;
  const injected = (cmd, args, opts) => {
    if (!args.includes("-m") && ++checks === 2)
      return nativeSpawn(process.execPath, ["-e", 'console.error("EACCES cache blocked");process.exit(1)'], opts);
    return fakeSpawn(f)(cmd, args, opts);
  };
  const s = await start({ workspace: f.root, requestFile: f.requestFile, spawn: injected, maxAttempts: 1 });
  assert.equal(s.phase, "blocked");
  assert.equal(s.blockedPhase, "verifying");
  assert.equal(s.verification[0].category, "environment");
  assert.equal(s.attempt, 1);
  const result = await resume({ run: s.run, retry: true, spawn: fakeSpawn(f) });
  assert.equal(result.phase, "complete", result.reason);
  assert.equal(result.agents.filter((a) => a.role === "worker").length, 1);
});

test('worker syntax errors request code repair rather than environment retry', async () => {
  const f = await fixture(); let workers = 0;
  const spawn = (cmd, args, opts) => {
    const worker = args.includes('-m') && args[args.indexOf('-m') + 1] === 'gpt-5.6-terra';
    return fakeSpawn(f, worker && workers++ === 0 ? 'syntax' : 'normal')(cmd, args, opts);
  };
  const result = await start({ workspace: f.root, requestFile: f.requestFile, spawn });
  assert.equal(result.phase, 'complete', result.reason);
  assert.equal(workers, 2);
  assert.equal(result.checkResults.some(check => !check.baseline && check.category === 'behavior'), true);
});

test("review environment repair resumes only reviewer with intact contract", async () => {
  const f = await fixture();
  const s = await start({ workspace: f.root, requestFile: f.requestFile, spawn: fakeSpawn(f, "review-env") });
  assert.equal(s.blockedPhase, "reviewing");
  assert.equal(s.blockedCategory, "environment");
  assert.equal(s.nonRetryable, undefined);
  const result = await resume({ run: s.run, retry: true, spawn: fakeSpawn(f) });
  assert.equal(result.phase, "complete", result.reason);
  assert.equal(result.contractFileHash, s.contractFileHash);
  assert.deepEqual(result.agents.map((a) => a.role), ["author", "worker", "reviewer", "reviewer"]);
});

test("revision snapshots historical red baseline and skips already completed implementation", async () => {
  const f = await fixture();
  const prior = await start({ workspace: f.root, requestFile: f.requestFile, spawn: fakeSpawn(f, "review-contract") });
  // The new author accurately describes current behavior as passing.
  const revisedBin = readFileSync(f.bin, "utf8").replace("baseline:'fail'", "baseline:'pass'");
  writeFileSync(f.bin, revisedBin);
  const revision = await start({ workspace: f.root, requestFile: f.requestFile, revisionOf: prior.run, spawn: fakeSpawn(f) });
  assert.equal(revision.phase, "complete", revision.reason);
  assert.equal(revision.attempt, 0);
  assert.deepEqual(revision.agents.map((a) => a.role), ["author", "reviewer"]);
  const snapshot = readFileSync(revision.revisionSnapshot.path, "utf8");
  assert.equal(JSON.parse(snapshot).state.baseline[0].code, 1);
  assert.match(JSON.parse(snapshot).files[prior.baseline[0].logFile], /BASE FAIL/);
  writeFileSync(prior.baseline[0].logFile, "rewritten");
  assert.equal(readFileSync(revision.revisionSnapshot.path, "utf8"), snapshot);
  assert.equal((await status(revision.run)).phase, "complete");
  const prompt = readFileSync(path.join(revision.agents[0].dir, "prompt.txt"), "utf8");
  assert.match(prompt, /legitimately remain baseline=pass/);
});


for (const changed of [false, true]) test(`verification retry ${changed ? "invalidates passes after code change" : "reuses unchanged passed checks"}`, async () => {
  const f = await fixture({ secondCheck: true });
  const counts = { C1: 0, C2: 0 };
  const injected = (cmd, args, opts) => {
    if (!args.includes("-m")) {
      const id = args.includes("C2") ? "C2" : "C1";
      counts[id]++;
      if (id === "C2" && counts[id] === 2)
        return nativeSpawn(process.execPath, ["-e", 'console.error("EPERM cache");process.exit(1)'], opts);
    }
    return fakeSpawn(f)(cmd, args, opts);
  };
  const s = await start({ workspace: f.root, requestFile: f.requestFile, spawn: injected });
  assert.equal(s.blockedPhase, "verifying");
  if (changed) writeFileSync(path.join(f.root, "app.mjs"), "export const app = 2;");
  const result = await resume({ run: s.run, retry: true, spawn: injected });
  assert.equal(result.phase, "complete", result.reason);
  assert.deepEqual(counts, { C1: changed ? 3 : 2, C2: 3 });
  assert.equal(result.attempt, 1);
});

test("reviewer may create untracked cache but cannot edit frozen tests", async () => {
  const f = await fixture();
  const s = await start({ workspace: f.root, requestFile: f.requestFile, spawn: fakeSpawn(f, "review-cache") });
  assert.equal(s.phase, "complete", s.reason);
  assert(existsSync(path.join(f.root, ".cache/result")));
  const f2 = await fixture();
  const blocked = await start({ workspace: f2.root, requestFile: f2.requestFile, spawn: fakeSpawn(f2, "review-test") });
  assert.equal(blocked.phase, "blocked");
  assert.match(blocked.reason, /workspace changed|frozen test changed/);
});

test("model handoff omits repository fingerprint entries", async () => {
  const f = await fixture();
  const s = await start({ workspace: f.root, requestFile: f.requestFile, spawn: fakeSpawn(f) });
  for (const agent of s.agents) {
    const handoff = JSON.parse(readFileSync(path.join(agent.dir, "handoff.json"), "utf8"));
    assert.equal(handoff.workspaceTree, undefined);
    assert(!JSON.stringify(handoff).includes('"entries"'));
    const prompt = readFileSync(path.join(agent.dir, "prompt.txt"), "utf8");
    assert.match(prompt, /handoff.json/);
    assert.match(prompt, /Never read state.json/);
  }
});

test("lead author, worker and repair reuse one session with fresh Sol reviews", async () => {
  const f = await fixture(), calls = [], seed = { model: "lead-model" };
  let reviews = 0;
  const spawn = (cmd, args, opts) => {
    if (args.includes("-m")) calls.push(args);
    const review = args.includes("-m") && args[args.indexOf("-m") + 1] === "gpt-5.6-sol";
    return fakeSpawn(f, review && reviews++ === 0 ? "review-repair" : "normal")(cmd, args, opts);
  };
  const s = await start({ workspace: f.root, requestFile: f.requestFile, leadSession: seed, spawn });
  assert.equal(s.phase, "complete", s.reason);
  assert.deepEqual(s.agents.map((a) => a.role), ["author", "worker", "reviewer", "worker", "reviewer"]);
  assert.deepEqual(s.agents.filter((a) => a.role !== "reviewer").map((a) => a.threadId), Array(3).fill(s.leadSession.threadId));
  assert.equal(new Set(s.agents.map((a) => a.threadId)).size, 3);
  assert.deepEqual(s.agents.map((a) => a.model), ["lead-model", "lead-model", "gpt-5.6-sol", "lead-model", "gpt-5.6-sol"]);
  for (const [i, args] of calls.entries()) {
    assert(!args.includes("--last"));
    if (i === 1 || i === 3) {
      const dir = s.agents[i].dir;
      assert.deepEqual(args, ["exec", "-C", s.workspace, "-s", "workspace-write", "resume", "-m", "lead-model", "-c", 'model_reasoning_effort="medium"', "--json", "--output-schema", path.join(dir, "schema.json"), "-o", path.join(dir, "result.json"), s.leadSession.threadId, "-"]);
    } else assert(!args.includes("resume"));
  }
  assert.deepEqual(seed, { model: "lead-model" });
  assert.deepEqual(s.config.leadSession, seed);
  assert.notEqual(s.config.leadSession, s.leadSession);
  assert.deepEqual(JSON.parse(readFileSync(path.join(s.run, "config.json"), "utf8")).leadSession, seed);
  assert.equal((await status(s.run)).phase, "complete");
  assert.equal((await resume({ run: s.run, spawn })).phase, "complete");
  for (const agent of s.agents.filter((a) => a.role !== "reviewer")) {
    const prompt = readFileSync(path.join(agent.dir, "prompt.txt"), "utf8");
    assert.match(prompt, agent.role === "author" ? /this turn is author tests-only/ : /this turn is worker production-only/);
    assert.match(prompt, /current run contract and handoff; never broaden the fixed scope/);
  }
});

for (const mode of ["missing-thread", "wrong-thread"]) test(`lead resume fails closed on ${mode}`, async () => {
  const f = await fixture();
  const s = await start({ workspace: f.root, requestFile: f.requestFile, leadSession: { model: "lead-model", threadId: "expected-lead" }, spawn: fakeSpawn(f, mode) });
  assert.equal(s.phase, "blocked");
  assert.equal(s.blockedPhase, "authoring");
  assert.match(s.reason, /failed or incomplete|session ID mismatch/);
  assert.equal(s.leadSession.threadId, "expected-lead");
  assert.equal(s.agents.length, 1);
});

test("missing first lead receipt cannot establish a session", async () => {
  const f = await fixture();
  const s = await start({ workspace: f.root, requestFile: f.requestFile, leadSession: { model: "lead-model" }, spawn: fakeSpawn(f, "missing-thread") });
  assert.equal(s.phase, "blocked");
  assert.equal(s.leadSession.threadId, undefined);
});

test("failed resumed worker preserves lead identity and retry resumes the same thread", async () => {
  const f = await fixture();
  const s = await start({ workspace: f.root, requestFile: f.requestFile, leadSession: { model: "lead-model" }, spawn: fakeSpawn(f, "partial-worker") });
  assert.equal(s.blockedPhase, "implementing");
  const result = await resume({ run: s.run, retry: true, spawn: fakeSpawn(f) });
  assert.equal(result.phase, "complete", result.reason);
  assert.equal(result.leadSession.threadId, s.leadSession.threadId);
  assert(result.agents.filter((a) => a.role !== "reviewer").every((a) => a.threadId === s.leadSession.threadId));
});

for (const mode of ["author-production", "frozen", "review-test"]) test(`lead sessions retain phase ownership guard: ${mode}`, async () => {
  const f = await fixture();
  const s = await start({ workspace: f.root, requestFile: f.requestFile, leadSession: { model: "lead-model" }, spawn: fakeSpawn(f, mode) });
  assert.equal(s.phase, "blocked");
  assert.match(s.reason, /author changed non-test|frozen test changed|workspace changed/);
});

for (const duplicate of ["lead", "reviewer"]) test(`reviewer cannot reuse ${duplicate} session`, async () => {
  const f = await fixture();
  let reviews = 0;
  const spawn = (cmd, args, opts) => {
    if (!args.includes("-m")) return nativeSpawn(cmd, args, opts);
    const review = args[args.indexOf("-m") + 1] === "gpt-5.6-sol";
    return nativeSpawn(process.execPath, [f.bin, ...args], { ...opts, env: { ...process.env,
      FAKE_THREAD_ID: review && duplicate === "reviewer" ? "repeated-review" : "lead-id",
      FAKE_MODE: review && reviews++ === 0 ? "review-repair" : "normal",
    } });
  };
  const s = await start({ workspace: f.root, requestFile: f.requestFile, leadSession: { model: "lead-model", threadId: "lead-id" }, spawn });
  assert.equal(s.phase, "blocked");
  assert.equal(s.blockedPhase, "reviewing");
  assert.match(s.reason, /reviewer session must be fresh/);
});

test("contract revision resumes prior lead and rejects prior reviewer sessions", async () => {
  const f = await fixture();
  const prior = await start({ workspace: f.root, requestFile: f.requestFile, leadSession: { model: "lead-model" }, spawn: fakeSpawn(f, "review-contract") });
  writeFileSync(f.bin, readFileSync(f.bin, "utf8").replace("baseline:'fail'", "baseline:'pass'"));
  await assert.rejects(start({ workspace: f.root, requestFile: f.requestFile, revisionOf: prior.run, leadSession: { model: 'lead-model', threadId: 'unrelated-thread' }, spawn: fakeSpawn(f) }), /retain the prior lead thread/);
  const revision = await start({ workspace: f.root, requestFile: f.requestFile, revisionOf: prior.run, spawn: fakeSpawn(f) });
  assert.equal(revision.phase, "complete", revision.reason);
  assert.equal(revision.agents[0].threadId, prior.leadSession.threadId);
  assert.deepEqual(revision.config.leadSession, prior.leadSession);
  assert.equal((await status(revision.run)).phase, "complete");
  const oldReviewer = prior.agents.find((a) => a.role === "reviewer").threadId;
  const spawn = (cmd, args, opts) => args.includes("-m") && args[args.indexOf("-m") + 1] === "gpt-5.6-sol"
    ? nativeSpawn(process.execPath, [f.bin, ...args], { ...opts, env: { ...process.env, FAKE_THREAD_ID: oldReviewer } })
    : fakeSpawn(f)(cmd, args, opts);
  const blocked = await start({ workspace: f.root, requestFile: f.requestFile, revisionOf: revision.run, leadSession: revision.leadSession, spawn });
  assert.equal(blocked.phase, "blocked");
  assert.match(blocked.reason, /reviewer session must be fresh/);
});

test("internal CLI lead opt-in preserves an explicit thread and rejects incomplete flags", async () => {
  const f = await fixture();
  chmodSync(f.bin, 0o700);
  const args = [fileURLToPath(new URL("./runner.mjs", import.meta.url)), "start", "--workspace", f.root, "--request-file", f.requestFile, "--codex-bin", f.bin];
  const output = execFileSync(process.execPath, [...args, "--lead-model", "lead-model", "--lead-thread", "cli-lead"], { encoding: "utf8" });
  const result = JSON.parse(output.trim().split("\n").at(-1));
  assert.equal(result.phase, "complete", result.reason);
  const state = await status(result.run);
  assert.equal(state.leadSession.threadId, "cli-lead");
  assert.equal(state.agents[0].threadId, "cli-lead");
  assert.equal(state.agents[1].threadId, "cli-lead");
  for (const flags of [["--lead-thread", "cli-lead"], ["--lead-model"], ["--lead-model", "lead-model", "--lead-thread"]]) {
    assert.throws(() => execFileSync(process.execPath, [...args, ...flags], { encoding: "utf8", stdio: "pipe" }), /lead session needs|explicit session ID/);
  }
});
