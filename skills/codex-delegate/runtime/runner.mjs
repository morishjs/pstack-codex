import { createHash, randomUUID } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { transition } from "./machine.mjs";

export const MODELS = Object.freeze({
  author: "gpt-6-astra",
  worker: "gpt-5.6-terra",
  reviewer: "gpt-5.6-sol",
});
function assignedModel(state, role) {
  return state.models?.[role] ?? MODELS[role];
}
const VERSION = 1;
const DEFAULT_TIMEOUT = 20 * 60_000;
const hash = (text) => createHash("sha256").update(text).digest("hex");
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const stamp = () => new Date().toISOString();
const ensure = (ok, message) => {
  if (!ok) throw new Error(message);
};
const text = (value) => typeof value === "string" && value.trim().length > 0;
const roleFiles = {
  author: "acceptance-author.md",
  worker: "implementer.md",
  reviewer: "reviewer.md",
};
const runtimeDir = path.dirname(fileURLToPath(import.meta.url));

function atomic(file, data) {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const fd = fs.openSync(tmp, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(data, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}
function persist(state, event, detail = {}) {
  state.sequence++;
  state.updatedAt = stamp();
  state.lastEvent = {
    sequence: state.sequence,
    at: state.updatedAt,
    event,
    phase: state.phase,
    ...detail,
  };
  atomic(path.join(state.run, "state.json"), state);
  fs.appendFileSync(
    path.join(state.run, "events.jsonl"),
    JSON.stringify(state.lastEvent) + "\n",
    { mode: 0o600 },
  );
}
function move(state, event) {
  state.phase = transition(state.phase, event);
  persist(state, event);
}
function reconcileJournal(state) {
  const file = path.join(state.run, "events.jsonl");
  const lines = fs.existsSync(file)
    ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean)
    : [];
  let last;
  try {
    last = lines.length ? JSON.parse(lines.at(-1)) : undefined;
  } catch {
    throw new Error("event journal corrupt; inspect before resuming");
  }
  if (!last || last.sequence < state.sequence) {
    fs.appendFileSync(file, JSON.stringify(state.lastEvent) + "\n");
  } else
    ensure(
      last.sequence === state.sequence,
      "journal is ahead of state; inspect before resuming",
    );
}
function git(root, args) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  }).trimEnd();
}
function fileHash(file) {
  const stat = fs.lstatSync(file);
  const content = stat.isSymbolicLink()
    ? fs.readlinkSync(file)
    : fs.readFileSync(file);
  return hash(
    Buffer.concat([Buffer.from(`${stat.mode}:`), Buffer.from(content)]),
  );
}
const SNAPSHOT_EXCLUSIONS = new Set([
  ".git",
  ".codex-delegate",
  ".agent-state",
  "node_modules",
  ".venv",
  "__pycache__",
  ".next",
  ".turbo",
  "coverage",
  "dist",
  ".cache",
]);
function ignoredSourceFiles(root, dir = root, result = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SNAPSHOT_EXCLUSIONS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) ignoredSourceFiles(root, full, result);
    else if (entry.isFile() || entry.isSymbolicLink())
      result.push(path.relative(root, full));
  }
  return result;
}
function tree(root) {
  const files = [
    ...new Set([
      ...git(root, [
        "ls-files",
        "-z",
        "--cached",
        "--others",
        "--exclude-standard",
      ])
        .split("\0")
        .filter(Boolean),
      ...ignoredSourceFiles(root),
    ]),
  ]
    .filter((f) => f !== ".codex-delegate" && !f.startsWith(".codex-delegate/"))
    .sort();
  const entries = {};
  for (const f of files) {
    const full = path.join(root, f);
    try {
      entries[f] = fileHash(full);
    } catch (e) {
      if (e.code === "ENOENT") entries[f] = "deleted";
      else throw e;
    }
  }
  return {
    head: git(root, ["rev-parse", "HEAD"]),
    entries,
    hash: hash(JSON.stringify(entries)),
  };
}
function difference(before, after) {
  return [
    ...new Set([...Object.keys(before.entries), ...Object.keys(after.entries)]),
  ].filter((f) => before.entries[f] !== after.entries[f]);
}
function safePath(root, value, mustExist = false) {
  ensure(
    text(value) && !path.isAbsolute(value),
    `relative path required: ${value}`,
  );
  const resolved = path.resolve(root, value);
  const rel = path.relative(root, resolved);
  ensure(
    rel &&
      rel !== ".." &&
      !rel.startsWith("../") &&
      rel !== ".git" &&
      !rel.startsWith(".git/") &&
      rel !== ".codex-delegate" &&
      !rel.startsWith(".codex-delegate/"),
    `unsafe path: ${value}`,
  );
  let cursor = resolved;
  while (cursor !== root) {
    if (fs.existsSync(cursor))
      ensure(
        !fs.lstatSync(cursor).isSymbolicLink(),
        `symlink ownership path rejected: ${value}`,
      );
    cursor = path.dirname(cursor);
  }
  if (mustExist)
    ensure(
      fs.existsSync(resolved) && fs.statSync(resolved).isFile(),
      `missing test: ${value}`,
    );
  return rel;
}
function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code !== "ESRCH";
  }
}
function lock(root, run, recovering = false) {
  const dir = path.join(root, ".codex-delegate");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(path.join(dir, ".gitignore")))
    fs.writeFileSync(path.join(dir, ".gitignore"), "*\n", {
      mode: 0o600,
      flag: "wx",
    });
  ensure(
    recovering || !fs.existsSync(path.join(dir, "recovery")),
    "workspace recovery in progress",
  );
  const lockDir = path.join(dir, "lock");
  try {
    fs.mkdirSync(lockDir, { mode: 0o700 });
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    let owner;
    try {
      owner = read(path.join(lockDir, "owner.json"));
    } catch {
      throw new Error(
        "workspace lock has no owner; inspect lock before recovery",
      );
    }
    if (alive(owner.pid))
      throw new Error(`workspace locked by pid ${owner.pid}`);
    throw new Error(
      `stale workspace lock for ${owner.run}; inspect child processes before removing ${lockDir}`,
    );
  }
  atomic(path.join(lockDir, "owner.json"), {
    pid: process.pid,
    run,
    at: stamp(),
  });
  return () => {
    fs.unlinkSync(path.join(lockDir, "owner.json"));
    fs.rmdirSync(lockDir);
  };
}
function validateScope(scope, root) {
  if (!scope) return undefined;
  ensure(
    Array.isArray(scope.allowedImplementationPaths) &&
      Array.isArray(scope.allowedTestPaths) &&
      Array.isArray(scope.requiredRequirementIds),
    "invalid scope contract",
  );
  const implementationPaths = scope.allowedImplementationPaths.map((file) =>
    safePath(root, file),
  );
  const testPaths = scope.allowedTestPaths.map((file) => safePath(root, file));
  const requirementIds = scope.requiredRequirementIds;
  ensure(
    requirementIds.length === new Set(requirementIds).size &&
      requirementIds.every(text),
    "duplicate or invalid scoped requirement IDs",
  );
  return { implementationPaths, testPaths, requirementIds };
}
function pathAllowed(file, allowedPaths) {
  return allowedPaths.some((allowed) =>
    file === allowed || file.startsWith(`${allowed}/`),
  );
}
function validateContract(c, root, scope, workflow) {
  ensure(
    c && c.status === "ready" && typeof c.reason === "string",
    c?.reason || "author blocked",
  );
  ensure(
    Array.isArray(c.requirements) &&
      c.requirements.length &&
      Array.isArray(c.checks) &&
      c.checks.length &&
      Array.isArray(c.implementationPaths),
    "empty/invalid acceptance contract",
  );
  const ids = c.requirements.map((r) => r.id),
    checkIds = c.checks.map((c) => c.id);
  ensure(
    new Set(ids).size === ids.length &&
      new Set(checkIds).size === checkIds.length,
    "duplicate requirement/check IDs",
  );
  if (scope?.requirementIds.length) {
    ensure(
      ids.length === scope.requirementIds.length &&
        scope.requirementIds.every((id) => ids.includes(id)),
      "acceptance contract omitted or added scoped requirement IDs",
    );
  }
  const used = new Set();
  for (const r of c.requirements) {
    const verification = r.verification ?? "automated";
    ensure(
      ["automated", "review", "external"].includes(verification),
      `invalid verification kind for ${r.id}`,
    );
    ensure(
      verification !== "external",
      `required external evidence unavailable: ${r.id}`,
    );
    ensure(
      text(r.id) &&
        text(r.description) &&
        Array.isArray(r.checkIds) &&
        (r.checkIds.length || verification === "review") &&
        new Set(r.checkIds).size === r.checkIds.length,
      `invalid requirement ${r.id}: automated behavior needs check IDs; review-only constraints need verification=review`,
    );
    for (const id of r.checkIds) {
      ensure(checkIds.includes(id), `unknown check ${id}`);
      used.add(id);
    }
  }
  ensure(
    checkIds.every((id) => used.has(id)),
    "unmapped acceptance check",
  );
  for (const check of c.checks) {
    ensure(
      /^[\w-]+$/.test(check.id) &&
        Array.isArray(check.argv) &&
        check.argv.length &&
        check.argv.every(text),
      "invalid check argv/ID",
    );
    ensure(
      Array.isArray(check.testFiles) &&
        check.testFiles.length &&
        ["fail", "pass"].includes(check.baseline) &&
        text(check.baselineMarker) &&
        text(check.passMarker),
      "missing check baseline or markers",
    );
    for (const file of check.testFiles) {
      const safe = safePath(root, file, true);
      ensure(
        !scope?.testPaths || pathAllowed(safe, scope.testPaths),
        `acceptance test outside scoped paths: ${safe}`,
      );
    }
  }
  for (const file of c.implementationPaths) {
    const safe = safePath(root, file);
    ensure(
      !scope?.implementationPaths ||
        pathAllowed(safe, scope.implementationPaths),
      `implementation path outside scoped paths: ${safe}`,
    );
  }
  const metrics = c.performanceMeasurements;
  if (workflow === "performance")
    ensure(Array.isArray(metrics) && metrics.length, "performance contract needs measurements");
  if (metrics !== undefined) {
    ensure(Array.isArray(metrics), "invalid performance measurements");
    const metricIds = metrics.map((metric) => metric.id);
    ensure(new Set(metricIds).size === metricIds.length, "duplicate performance metric IDs");
    for (const metric of metrics)
      ensure(text(metric.id) && checkIds.includes(metric.checkId) && text(metric.unit) && ["lower", "higher"].includes(metric.direction) && Number.isFinite(metric.requiredImprovementPercent) && metric.requiredImprovementPercent >= 0, "invalid performance measurement");
  }
}
function frozen(state) {
  ensure(
    JSON.stringify(read(path.join(state.run, "acceptance-hashes.json"))) ===
      JSON.stringify({
        contract: state.contractFileHash,
        tests: state.frozenTests,
      }),
    "acceptance hash manifest changed",
  );
  ensure(
    hash(fs.readFileSync(path.join(state.run, "contract.json"))) ===
      state.contractFileHash,
    "frozen contract changed",
  );
  for (const [file, digest] of Object.entries(state.frozenTests)) {
    safePath(state.workspace, file, true);
    ensure(
      fileHash(path.join(state.workspace, file)) === digest,
      `frozen test changed: ${file}`,
    );
  }
}
function validateContextArtifacts(state) {
  for (const artifact of state.contextArtifacts ?? []) {
    ensure(text(artifact.path) && text(artifact.hash) && fs.existsSync(artifact.path), "context artifact missing");
    ensure(hash(fs.readFileSync(artifact.path)) === artifact.hash, `context artifact changed: ${artifact.path}`);
  }
}
function unchanged(state) {
  validateContextArtifacts(state);
  const current = tree(state.workspace);
  ensure(
    current.hash === state.workspaceTree.hash &&
      current.head === state.workspaceTree.head,
    "workspace changed since checkpoint; evidence is stale",
  );
  if (state.contract) frozen(state);
  return current;
}
function imageInfo(file) {
  const stat = fs.lstatSync(file);
  ensure(stat.isFile(), "runtime visual evidence must be a regular file");
  const bytes = fs.readFileSync(file);
  let mediaType, width, height;
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.subarray(12, 16).equals(Buffer.from("IHDR"))) {
    mediaType = "image/png";
    width = bytes.readUInt32BE(16);
    height = bytes.readUInt32BE(20);
  } else if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    for (let i = 2; i + 8 < bytes.length;) {
      if (bytes[i] !== 0xff) { i++; continue; }
      while (bytes[i] === 0xff) i++;
      const marker = bytes[i++];
      if (marker === 0xd8 || marker === 0xd9) continue;
      const size = bytes.readUInt16BE(i);
      if (size < 2 || i + size > bytes.length) break;
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
        height = bytes.readUInt16BE(i + 3);
        width = bytes.readUInt16BE(i + 5);
        mediaType = "image/jpeg";
        break;
      }
      i += size;
    }
  }
  ensure(mediaType && width > 0 && height > 0, "runtime visual evidence is not a valid PNG or JPEG");
  return { sha256: hash(bytes), mediaType, width, height, mtimeMs: stat.mtimeMs, capturedAt: stat.mtime.toISOString() };
}
function recordVisualEvidence(state) {
  const visual = state.visualEvidence;
  if (!visual) return;
  ensure(fs.existsSync(visual.path), "runtime visual evidence file missing");
  const image = imageInfo(visual.path);
  ensure(!visual.start.exists || image.sha256 !== visual.start.sha256 || image.mtimeMs !== visual.start.mtimeMs, "runtime visual evidence unchanged from run start");
  ensure(image.mtimeMs > visual.implementationCheckpoint.mtimeMs, "runtime visual evidence predates implementation checkpoint");
  const manifest = { runId: state.id, workflow: state.workflow, route: visual.route, path: visual.path, sha256: image.sha256, mediaType: image.mediaType, width: image.width, height: image.height, capturedAt: image.capturedAt, implementationWorkspaceHash: state.workspaceTree.hash, verificationCompletedAt: stamp() };
  atomic(path.join(state.run, "evidence", "runtime-visual.json"), manifest);
  visual.sha256 = image.sha256;
  state.visualManifest = manifest;
  persist(state, "runtime-visual-recorded", { manifest });
}
function metricValue(logFile, metric) {
  const lines = fs.readFileSync(logFile, "utf8").split(/\r?\n/);
  const found = lines.map((line) => line.match(/^CODEX_DELEGATE_METRIC\s+(\S+)\s+(\S+)\s+(\S+)\s*$/)).filter(Boolean).filter((match) => match[1] === metric.id);
  ensure(found.length === 1, `performance metric ${metric.id} needs exactly one output line`);
  ensure(found[0][3] === metric.unit, `performance metric ${metric.id} has wrong unit`);
  const value = Number(found[0][2]);
  ensure(Number.isFinite(value), `performance metric ${metric.id} is not finite`);
  return value;
}
function recordPerformanceEvidence(state) {
  if (state.workflow !== "performance") return;
  const measurements = state.contract.performanceMeasurements;
  const metrics = measurements.map((metric) => {
    const baseline = state.baseline.find((result) => result.id === metric.checkId);
    const final = state.verification.find((result) => result.id === metric.checkId);
    ensure(baseline && final, `performance metric ${metric.id} check missing`);
    const baselineValue = metricValue(baseline.logFile, metric);
    const current = metricValue(final.logFile, metric);
    ensure(baselineValue !== 0, `performance metric ${metric.id} baseline is zero`);
    const delta = current - baselineValue;
    const deltaPercent = (delta / Math.abs(baselineValue)) * 100;
    const improvement = metric.direction === "lower" ? -deltaPercent : deltaPercent;
    return { ...metric, baseline: baselineValue, current, delta, deltaPercent, pass: improvement >= metric.requiredImprovementPercent, baselineLog: baseline.logFile, verificationLog: final.logFile };
  });
  ensure(metrics.every((metric) => metric.pass), "performance improvement requirement not met");
  const evidence = { runId: state.id, workflow: state.workflow, workspaceHashes: { baseline: state.baseline[0]?.workspaceHash, implementation: state.workspaceTree.hash, verification: state.verification[0]?.workspaceHash }, metrics, createdAt: stamp() };
  const evidencePath = path.join(state.run, "evidence", "performance.json");
  atomic(evidencePath, evidence);
  state.performance = { path: evidencePath, ...evidence };
  persist(state, "performance-recorded", { path: evidencePath, metrics });
}
const string = { type: "string" };
const array = (items) => ({ type: "array", items });
const object = (properties) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
function schema(role) {
  if (role === "author") {
    const author = object({
      status: { type: "string", enum: ["ready", "blocked"] },
      reason: string,
      requirements: array(
        object({
          id: string,
          description: string,
          verification: {
            type: "string",
            enum: ["automated", "review", "external"],
          },
          checkIds: array(string),
        }),
      ),
      checks: array(
        object({
          id: string,
          argv: array(string),
          testFiles: array(string),
          baseline: { type: "string", enum: ["fail", "pass"] },
          baselineMarker: string,
          passMarker: string,
        }),
      ),
      implementationPaths: array(string),
      performanceMeasurements: array(object({
        id: string,
        checkId: string,
        unit: string,
        direction: { type: "string", enum: ["lower", "higher"] },
        requiredImprovementPercent: { type: "number", minimum: 0 },
      })),
    });
    return author;
  }
  if (role === "worker")
    return object({
      status: { type: "string", enum: ["done", "blocked"] },
      summary: string,
    });
  return object({
    status: { type: "string", enum: ["pass", "changes_requested", "blocked"] },
    nextAction: {
      type: "string",
      enum: ["none", "repair", "contract_revision", "blocked"],
    },
    requirements: array(
      object({
        id: string,
        status: { type: "string", enum: ["pass", "fail", "blocked"] },
        evidence: string,
      }),
    ),
    findings: array(string),
  });
}
function phasePrompt(state, role, dir) {
  const guide = fs.readFileSync(
    path.join(runtimeDir, "..", "references", roleFiles[role]),
    "utf8",
  );
  let scope = state.scope
    ? `Scope policy is fixed. Requirement IDs: ${state.scope.requirementIds.join(", ")}. Allowed implementation paths: ${state.scope.implementationPaths.join(", ")}. Allowed acceptance test paths: ${state.scope.testPaths.join(", ")}.`
    : "";
  if (state.contextArtifacts?.length)
    scope += `\nFixed context artifacts (verify before relying on them):\n${state.contextArtifacts.map((a) => `${a.label}: ${a.path} (SHA-256 ${a.hash})`).join("\n")}`;
  const visual = state.visualEvidence;
  return `${guide}\n\nRun ${state.id}. Workspace ${state.workspace}. Phase output directory ${dir}.\nOriginal request:\n${state.request}\n\n${scope}\n\nRead ${path.join(state.run, "state.json")} for runner evidence. Contract: ${path.join(state.run, "contract.json")}. Return JSON matching schema. Never edit runner state, contract.json, request.txt, or other attempts. Do not commit, push, deploy, spawn subagents, or invoke codex-delegate recursively.\n${role === "author" ? `Create acceptance tests only in workspace test locations. Do not fix production. Return executable checks with exact markers and exact implementationPaths. ${state.workflow === "performance" ? "Return nonempty performanceMeasurements. Each measurement links one check and requires that check to print exactly one CODEX_DELEGATE_METRIC <id> <finite-number> <unit> line in baseline and final runs." : "Return performanceMeasurements as an empty array."}` : ""}\n${role === "worker" ? `Frozen tests must not change. Only implementationPaths from contract may change. ${visual ? `Produce post-implementation runtime screenshot at ${visual.path} for route ${visual.route} through executable verification. Valid PNG or JPEG. Create after ${visual.implementationCheckpoint.at}.` : ""}` : ""}\n${role === "reviewer" ? `Workspace and tests are read-only. Read runner evidence and original request. ${visual ? `Read ${path.join(state.run, "evidence", "runtime-visual.json")}, inspect ${visual.path}, verify SHA-256 ${visual.sha256}.` : ""}${state.performance ? ` Read ${state.performance.path}.` : ""} Every required ID needs direct evidence.` : ""}`;
}
function recordIntegrity(state) {
  unchanged(state);
  const integrity = { mode: "runner-fileHash", status: "verified", workspaceHash: state.workspaceTree.hash, contractHash: state.contractFileHash, frozenTests: state.frozenTests, at: stamp() };
  integrity.contentDigest = hash(JSON.stringify(integrity));
  atomic(path.join(state.run, "integrity.json"), integrity);
  state.integrity = integrity;
  persist(state, "integrity-recorded", { integrity: { status: integrity.status, workspaceHash: integrity.workspaceHash, contentDigest: integrity.contentDigest } });
}

async function processRun(state, argv, input, logFile, options, markers = []) {
  const job = {
    id: randomUUID(),
    phase: state.phase,
    argv,
    startedAt: stamp(),
    logFile,
    pid: null,
  };
  state.inFlight = job;
  persist(state, "dispatch", { job });
  const logFd = fs.openSync(logFile, "wx", 0o600);
  const found = markers.map(() => false);
  let tail = "",
    pendingLine = "",
    threadId,
    turnComplete = false,
    setupFailure = false;
  let child,
    timedOut = false,
    interrupted = false,
    killTimer;
  const timeout = options.timeout ?? state.timeout;
  try {
    return await new Promise((resolve, reject) => {
      function kill() {
        if (!child?.pid) return;
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {}
        killTimer = setTimeout(() => {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {}
        }, 1000);
      }
      function signal() {
        interrupted = true;
        kill();
      }
      function consume(data) {
        fs.writeSync(logFd, data);
        const chunk = tail + data.toString();
        markers.forEach((marker, i) => {
          if (chunk.includes(marker)) found[i] = true;
        });
        if (
          /Cannot find module|ERR_MODULE_NOT_FOUND|SyntaxError:|command not found|No test files found|No tests found|# tests 0\b|0 passing/i.test(
            chunk,
          )
        )
          setupFailure = true;
        tail = chunk.slice(-Math.max(4096, ...markers.map((x) => x.length)));
      }
      function events(data) {
        consume(data);
        pendingLine += data.toString();
        const lines = pendingLine.split("\n");
        pendingLine = lines.pop().slice(-1024 * 1024);
        for (const line of lines) {
          try {
            const e = JSON.parse(line);
            if (e.type === "thread.started") threadId = e.thread_id;
            if (e.type === "turn.completed") turnComplete = true;
          } catch {}
        }
      }
      child = (options.spawn ?? spawn)(argv[0], argv.slice(1), {
        cwd: state.workspace,
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
      });
      job.pid = child.pid ?? null;
      persist(state, "child-started", { job });
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, timeout);
      for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"])
        process.on(sig, signal);
      const clean = () => {
        clearTimeout(timer);
        clearTimeout(killTimer);
        if ((timedOut || interrupted) && child?.pid) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {}
        }
        for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"])
          process.off(sig, signal);
      };
      child.stdout.on("data", events);
      child.stderr.on("data", consume);
      child.stdin.on("error", (e) => {
        if (e.code !== "EPIPE") reject(e);
      });
      child.on("error", (e) => {
        clean();
        reject(e);
      });
      child.on("close", (code, signalName) => {
        clean();
        resolve({
          code,
          signal: signalName,
          timedOut,
          interrupted,
          found,
          setupFailure,
          threadId,
          turnComplete,
          logFile,
          completedAt: stamp(),
        });
      });
      child.stdin.end(input);
    });
  } finally {
    fs.fsyncSync(logFd);
    fs.closeSync(logFd);
  }
}
async function call(state, role, options) {
  const dir = path.join(
    state.run,
    "attempts",
    `${state.sequence}-${role}-${randomUUID()}`,
  );
  fs.mkdirSync(dir, { mode: 0o700 });
  const schemaFile = path.join(dir, "schema.json"),
    output = path.join(dir, "result.json");
  atomic(schemaFile, schema(role));
  const prompt = phasePrompt(state, role, dir);
  fs.writeFileSync(path.join(dir, "prompt.txt"), prompt, { mode: 0o600 });
  const argv = [
    state.codexBin,
    "exec",
    "-C",
    state.workspace,
    "-m",
    assignedModel(state, role),
    "-c",
    'model_reasoning_effort="medium"',
    "-s",
    role === "reviewer" ? "read-only" : "workspace-write",
    "--json",
    "--output-schema",
    schemaFile,
    "-o",
    output,
    "-",
  ];
  const receipt = await processRun(
    state,
    argv,
    prompt,
    path.join(dir, "child.jsonl"),
    options,
  );
  delete state.inFlight;
  const attempt = {
    role,
    model: assignedModel(state, role),
    reasoning: "medium",
    dir,
    ...receipt,
  };
  state.agents.push(attempt);
  atomic(path.join(state.run, "agents.json"), state.agents);
  persist(state, "agent-result", { attempt });
  ensure(
    receipt.code === 0 &&
      !receipt.timedOut &&
      !receipt.interrupted &&
      receipt.turnComplete &&
      text(receipt.threadId),
    `${role} CLI failed or incomplete; inspect ${dir}`,
  );
  ensure(
    state.agents.filter((a) => a.threadId === receipt.threadId).length === 1,
    "agent session reused across phases",
  );
  ensure(fs.existsSync(output), `${role} produced no result`);
  return read(output);
}
async function checks(state, baseline, options) {
  const before = unchanged(state),
    results = [];
  for (const check of state.contract.checks) {
    const file = path.join(
      state.run,
      "evidence",
      `${state.sequence}-${check.id}-${randomUUID()}.log`,
    );
    const marker = baseline ? check.baselineMarker : check.passMarker;
    const result = await processRun(state, check.argv, "", file, options, [
      marker,
    ]);
    delete state.inFlight;
    const expectedFailure = baseline && check.baseline === "fail";
    const ok =
      !result.interrupted &&
      !result.timedOut &&
      Number.isInteger(result.code) &&
      result.code >= 0 &&
      result.found[0] &&
      !result.setupFailure &&
      (expectedFailure ? result.code !== 0 : result.code === 0);
    results.push({
      id: check.id,
      ok,
      baseline,
      marker,
      workspaceHash: before.hash,
      ...result,
    });
    state.checkResults.push(results.at(-1));
    persist(state, "check-result", { check: results.at(-1) });
    ensure(
      !result.interrupted && !result.timedOut,
      "check interrupted or timed out",
    );
  }
  unchanged(state);
  return results;
}
async function advance(state, options) {
  unchanged(state);
  if (state.phase === "authoring") {
    const before = state.authorBaseline ?? state.workspaceTree;
    const c = await call(state, "author", options);
    validateContract(c, state.workspace, state.scope, state.workflow);
    const after = tree(state.workspace);
    const tests = [
      ...new Set(
        c.checks.flatMap((c) =>
          c.testFiles.map((f) => safePath(state.workspace, f, true)),
        ),
      ),
    ];
    ensure(
      after.head === before.head &&
        difference(before, after).every((f) => tests.includes(f)),
      "author changed non-test files",
    );
    state.contract = c;
    atomic(path.join(state.run, "contract.json"), c);
    state.contractFileHash = hash(
      fs.readFileSync(path.join(state.run, "contract.json")),
    );
    state.frozenTests = Object.fromEntries(
      tests.map((f) => [f, fileHash(path.join(state.workspace, f))]),
    );
    atomic(path.join(state.run, "acceptance-hashes.json"), {
      contract: state.contractFileHash,
      tests: state.frozenTests,
    });
    state.workspaceTree = after;
    move(state, "AUTHOR_OK");
  } else if (state.phase === "baseline") {
    const result = await checks(state, true, options);
    ensure(
      result.every((x) => x.ok),
      "baseline failed for wrong reason or expected marker absent",
    );
    state.baseline = result;
    move(state, "BASELINE_OK");
  } else if (state.phase === "implementing") {
    ensure(
      state.attempt < state.maxAttempts,
      "implementation attempt budget exhausted",
    );
    const before = state.workspaceTree;
    if (state.visualEvidence) {
      state.visualEvidence.implementationCheckpoint = { at: stamp(), mtimeMs: Date.now() };
      persist(state, "runtime-visual-checkpoint", { checkpoint: state.visualEvidence.implementationCheckpoint });
    }
    state.attempt++;
    persist(state, "implementation-attempt");
    const result = await call(state, "worker", options);
    frozen(state);
    const after = tree(state.workspace);
    ensure(after.head === before.head, "worker changed git HEAD");
    const allowed = state.contract.implementationPaths.map((p) =>
      safePath(state.workspace, p),
    );
    ensure(
      difference(before, after).every((f) =>
        allowed.some((p) => f === p || f.startsWith(p + "/")),
      ),
      "worker changed outside implementation paths",
    );
    state.workspaceTree = after;
    state.implementation = result;
    ensure(
      result.status === "done" && text(result.summary),
      "worker blocked or invalid output",
    );
    move(state, "IMPLEMENTED");
  } else if (state.phase === "verifying") {
    const result = await checks(state, false, options);
    state.verification = result;
    if (!result.every((x) => x.ok)) move(state, "REPAIR");
    else {
      recordVisualEvidence(state);
      recordPerformanceEvidence(state);
      move(state, "VERIFIED");
    }
  } else if (state.phase === "reviewing") {
    recordIntegrity(state);
    const review = await call(state, "reviewer", options);
    unchanged(state);
    if (state.visualManifest) {
      const image = imageInfo(state.visualManifest.path);
      ensure(image.sha256 === state.visualManifest.sha256, "runtime visual evidence changed during review");
    }
    const ids = state.contract.requirements.map((r) => r.id);
    ensure(
      Array.isArray(review.requirements) &&
        review.requirements.length === ids.length &&
        new Set(review.requirements.map((r) => r.id)).size === ids.length &&
        review.requirements.every(
          (r) =>
            ids.includes(r.id) &&
            ["pass", "fail", "blocked"].includes(r.status) &&
            text(r.evidence),
        ) &&
        Array.isArray(review.findings) &&
        review.findings.every(text),
      "review coverage incomplete or invalid evidence",
    );
    state.review = review;
    ensure(
      ["pass", "changes_requested"].includes(review.status),
      "invalid review status",
    );
    if (review.nextAction === "contract_revision") {
      state.blockedPhase = "reviewing";
      state.nonRetryable = true;
      state.reason =
        "Sol requires an acceptance contract revision; start a new run with the prior evidence.";
      move(state, "REVISE_CONTRACT");
      return;
    }
    ensure(
      review.status !== "blocked" &&
        !review.requirements.some((r) => r.status === "blocked"),
      "review has blocked requirements",
    );
    const passed =
      review.status === "pass" &&
      review.requirements.every((r) => r.status === "pass") &&
      !review.findings.length;
    if (passed) move(state, "PASS");
    else if (review.nextAction === "repair") move(state, "REPAIR");
    else throw new Error("review did not provide a repair or contract revision action");
  }
}
function acceptPartialWorker(state) {
  frozen(state);
  const current = tree(state.workspace);
  ensure(
    current.head === state.workspaceTree.head,
    "partial worker changed git HEAD",
  );
  const allowed = state.contract.implementationPaths.map((p) =>
    safePath(state.workspace, p),
  );
  ensure(
    difference(state.workspaceTree, current).every((f) =>
      allowed.some((p) => f === p || f.startsWith(p + "/")),
    ),
    "partial worker changed outside ownership",
  );
  state.workspaceTree = current;
}
function processGroupAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (e) {
    return e.code !== "ESRCH";
  }
}
export async function recover({ run, reason, authorTestFiles = [] }) {
  ensure(text(reason), "recovery needs an inspection reason");
  const state = load(run);
  const recoveryDir = path.join(state.workspace, ".codex-delegate", "recovery");
  fs.mkdirSync(recoveryDir, { mode: 0o700 });
  let release;
  try {
    const lockDir = path.join(state.workspace, ".codex-delegate", "lock");
    if (fs.existsSync(lockDir)) {
      const owner = read(path.join(lockDir, "owner.json"));
      ensure(
        owner.run === state.run && !alive(owner.pid),
        "run still owned by a live or different runner",
      );
      ensure(
        !alive(state.inFlight?.pid) && !processGroupAlive(state.inFlight?.pid),
        "child process group still active",
      );
      fs.unlinkSync(path.join(lockDir, "owner.json"));
      fs.rmdirSync(lockDir);
    }
    release = lock(state.workspace, state.run, true);
    ensure(
      !alive(state.inFlight?.pid) && !processGroupAlive(state.inFlight?.pid),
      "child process group still active",
    );
    ensure(
      state.phase !== "complete",
      "completed runs cannot be recovered; start a new run for new changes",
    );
    const interruptedPhase =
      state.inFlight?.phase ?? state.blockedPhase ?? state.phase;
    if (interruptedPhase === "implementing") acceptPartialWorker(state);
    else if (interruptedPhase === "authoring" && !state.contract) {
      const current = tree(state.workspace);
      const allowed = authorTestFiles.map((p) =>
        safePath(state.workspace, p, true),
      );
      ensure(
        current.head === state.workspaceTree.head &&
          difference(state.workspaceTree, current).every((f) =>
            allowed.includes(f),
          ),
        "author recovery needs explicit --author-test for every partial test edit",
      );
      state.authorBaseline ??= state.workspaceTree;
      state.workspaceTree = current;
    } else unchanged(state);
    const job = state.inFlight;
    delete state.inFlight;
    state.blockedPhase = interruptedPhase;
    state.reason = `Recovered interruption: ${reason}. Resume with --retry.`;
    if (state.phase !== "blocked")
      state.phase = transition(state.phase, "BLOCK");
    persist(state, "recovered", {
      reason,
      interruptedJob: job,
      authorTestFiles,
    });
    return state;
  } finally {
    release?.();
    fs.rmdirSync(recoveryDir);
  }
}
async function drive(state, options) {
  try {
    while (!["complete", "blocked"].includes(state.phase))
      await advance(state, options);
  } catch (e) {
    state.blockedPhase = state.phase;
    state.reason = e.message;
    if (!state.inFlight && state.phase === "implementing") {
      try {
        acceptPartialWorker(state);
      } catch (scopeError) {
        state.reason += `; ${scopeError.message}`;
      }
    }
    if (state.phase !== "blocked") move(state, "BLOCK");
  }
  return state;
}
function load(run) {
  const s = read(path.join(path.resolve(run), "state.json"));
  ensure(
    s.version === VERSION && s.run === path.resolve(run),
    "run identity/version mismatch",
  );
  ensure(
    hash(fs.readFileSync(path.join(s.run, "request.txt"))) === hash(s.request),
    "request changed",
  );
  ensure(
    JSON.stringify(read(path.join(s.run, "config.json"))) ===
      JSON.stringify(s.config),
    "run config changed",
  );
  validateContextArtifacts(s);
  return s;
}
export async function start({ workspace, requestFile, scopeFile, ...options }) {
  workspace = fs.realpathSync(workspace);
  ensure(
    git(workspace, ["rev-parse", "--show-toplevel"]) === workspace,
    "workspace must be git root",
  );
  const run = path.join(workspace, ".codex-delegate", "runs", randomUUID());
  const release = lock(workspace, run);
  try {
    for (const sub of ["", "attempts", "evidence"])
      fs.mkdirSync(path.join(run, sub), { recursive: true, mode: 0o700 });
    const scope = scopeFile ? validateScope(read(scopeFile), workspace) : undefined;
    const models = { ...MODELS, ...(options.models ?? {}), reviewer: MODELS.reviewer };
    ensure(Object.values(models).every(text), "invalid model assignments");
    const workflow = options.workflow ?? "simple-fix";
    const state = {
      version: VERSION,
      id: path.basename(run),
      run,
      workspace,
      request: fs.readFileSync(requestFile, "utf8"),
      phase: "authoring",
      sequence: 0,
      attempt: 0,
      maxAttempts: options.maxAttempts ?? 2,
      timeout: options.timeout ?? DEFAULT_TIMEOUT,
      codexBin: options.codexBin ?? "codex",
      models,
      reviewRequired: true,
      workflow,
      visualEvidence: options.visualEvidence,
      contextArtifacts: options.contextArtifacts,
      agents: [],
      checkResults: [],
      workspaceTree: tree(workspace),
      scope,
      createdAt: stamp(),
    };
    ensure(
      text(state.request) &&
        Number.isInteger(state.maxAttempts) &&
        state.maxAttempts > 0 &&
        Number.isInteger(state.timeout) &&
        state.timeout > 0,
      "invalid request or run limits",
    );
    state.config = {
      workspace,
      models,
      reasoning: "medium",
      codexBin: state.codexBin,
      maxAttempts: state.maxAttempts,
      timeout: state.timeout,
      scope,
      reviewRequired: state.reviewRequired,
      workflow: state.workflow,
      visualEvidence: state.visualEvidence,
      contextArtifacts: state.contextArtifacts,
    };
    fs.writeFileSync(path.join(run, "request.txt"), state.request, {
      mode: 0o600,
    });
    atomic(path.join(run, "config.json"), state.config);
    persist(state, "start");
    options.onRunCreated?.(run);
    return await drive(state, options);
  } finally {
    release();
  }
}
export async function resume({ run, retry = false, ...options }) {
  const state = load(run),
    release = lock(state.workspace, state.run);
  try {
    reconcileJournal(state);
    ensure(
      !state.inFlight,
      "unresolved in-flight command; inspect child and reconcile files before starting a new run",
    );
    unchanged(state);
    if (state.phase === "complete") return state;
    if (state.phase === "blocked") {
      if (!retry) return state;
      ensure(!state.nonRetryable, "contract revision requires a new run");
      const event = {
        authoring: "RETRY_AUTHOR",
        baseline: "RETRY_BASELINE",
        implementing: "RETRY_IMPLEMENT",
        verifying: "RETRY_VERIFY",
        reviewing: "RETRY_REVIEW",
      }[state.blockedPhase];
      ensure(
        event &&
          (state.blockedPhase !== "implementing" ||
            state.attempt < state.maxAttempts),
        "cannot retry exhausted or unknown phase; inspect and start a new run",
      );
      delete state.reason;
      move(state, event);
    }
    return await drive(state, options);
  } finally {
    release();
  }
}
export async function status(run) {
  const state = load(run);
  if (state.inFlight) {
    const active =
      alive(state.inFlight.pid) || processGroupAlive(state.inFlight.pid);
    return active
      ? { ...state, evidenceStatus: "pending" }
      : {
          ...state,
          phase: "blocked",
          persistedPhase: state.phase,
          reason: "in-flight execution needs recovery inspection",
        };
  }
  try {
    unchanged(state);
    return state;
  } catch (e) {
    return {
      ...state,
      phase: "blocked",
      persistedPhase: state.phase,
      reason: e.message,
    };
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const [command, ...args] = process.argv.slice(2);
    const value = (key) => {
      const i = args.indexOf(key);
      return i < 0 ? undefined : args[i + 1];
    };
    let state;
    if (command === "start") {
      ensure(
        value("--workspace") && value("--request-file"),
        "start needs --workspace and --request-file",
      );
      state = await start({
        workspace: value("--workspace"),
        requestFile: value("--request-file"),
        scopeFile: value("--scope-file"),
        codexBin: value("--codex-bin"),
        onRunCreated: (run) => console.log(run),
      });
    } else if (command === "recover")
      state = await recover({
        run: value("--run"),
        reason: value("--reason"),
        authorTestFiles: args.flatMap((v, i) =>
          v === "--author-test" ? [args[i + 1]] : [],
        ),
      });
    else if (command === "resume")
      state = await resume({
        run: value("--run"),
        retry: args.includes("--retry"),
      });
    else if (command === "status") state = await status(value("--run"));
    else
      throw new Error(
        "usage: start --workspace ABS --request-file ABS [--scope-file ABS] [--codex-bin ABS] | resume --run ABS [--retry] | recover --run ABS --reason TEXT [--author-test REL] | status --run ABS",
      );
    console.log(
      JSON.stringify({
        run: state.run,
        phase: state.phase,
        reason: state.reason,
        attempt: state.attempt,
      }),
    );
    if (state.phase === "blocked") process.exitCode = 1;
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
