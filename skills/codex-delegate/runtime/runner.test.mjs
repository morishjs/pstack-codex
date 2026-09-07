import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn as nativeSpawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { start, resume, status, recover } from "./runner.mjs";
import { transition } from "./machine.mjs";

async function fixture({ missingMarker = false, missingIds = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "delegate-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  await writeFile(path.join(root, "check.mjs"), 'console.log("BASE PASS")');
  await writeFile(path.join(root, "app.mjs"), "export const app = 1;");
  await writeFile(path.join(root, "request.txt"), "make it work");
  const bin = path.join(root, "fake-codex.mjs");
  await writeFile(
    bin,
    `#!/usr/bin/env node
import {writeFileSync} from 'node:fs'; import {randomUUID} from 'node:crypto'; const a=process.argv, out=a[a.indexOf('-o')+1], m=a[a.indexOf('-m')+1], mode=process.env.FAKE_MODE; console.log(JSON.stringify({type:'thread.started',thread_id:randomUUID()}));
if(m==='gpt-5.6-terra'&&mode==='frozen') writeFileSync('check.mjs','console.log("BASE PASS")// changed'); if(m==='gpt-5.6-sol'&&mode==='review-mutate') writeFileSync('app.mjs','export const app = 2;');
if(m==='gpt-5.6-terra'&&mode==='partial-worker') {writeFileSync('app.mjs','export const app = 3;'); process.exit(1);}
if(mode==='slow') await new Promise(resolve=>setTimeout(resolve,100));
const c=m==='gpt-6-astra'?{status:'ready',reason:'fixture',requirements:[{id:'R1',description:'works',checkIds:${missingIds ? "[]" : "['C1']"}}],checks:[{id:'C1',argv:['node','check.mjs'],testFiles:['check.mjs'],baseline:'pass',baselineMarker:'${missingMarker ? "MISSING" : "BASE"}',passMarker:'PASS'}],implementationPaths:['app.mjs']} : m==='gpt-5.6-terra'?{status:'done',summary:'done'}:{status:mode==='review-repair'||(mode??'').startsWith('review-contract')?'changes_requested':'pass',nextAction:(mode??'').startsWith('review-contract')?'contract_revision':'repair',requirements:mode==='review-omit'?[]:[{id:'R1',status:mode==='review-contract-blocked'?'blocked':'pass',evidence:'check'}],findings:mode==='review-repair'||(mode??'').startsWith('review-contract')?['repair requested']:[]}; writeFileSync(out,JSON.stringify(c)); console.log(JSON.stringify({type:'turn.completed',thread_id:randomUUID()}));`,
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

test("CLI roles retain medium reasoning and read-only review", async () => {
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
    ["gpt-5.6-sol", 'model_reasoning_effort="medium"', "read-only"],
  ]);
  const untracked = execFileSync("git", ["status", "--porcelain"], {
    cwd: f.root,
    encoding: "utf8",
  });
  assert(!untracked.includes(".codex-delegate"));
});
