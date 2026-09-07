import { mkdtempSync, cpSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { start } from "./orchestrator.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, "cases", "patient-lookup");
const grader = path.join(fixture, "grader.mjs");

function command(file, args, cwd) {
  return execFileSync(file, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function commandResult(file, args, cwd) {
  try {
    return { ok: true, output: command(file, args, cwd) };
  } catch (error) {
    return {
      ok: false,
      output: `${error.stdout ?? ""}${error.stderr ?? ""}`,
    };
  }
}

function snapshot(root) {
  return command("git", ["status", "--porcelain", "--untracked-files=all"], root)
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3))
    .filter((file) => !file.startsWith(".codex-delegate/"))
    .sort();
}

export function prepare(outDir) {
  const workspace = path.join(outDir, "customer-lookup");
  const oracleDir = path.join(fixture, "workspace", "oracle");
  cpSync(path.join(fixture, "workspace"), workspace, {
    recursive: true,
    filter: (source) => source !== oracleDir,
  });
  command("git", ["init", "-q"], workspace);
  command("git", ["add", "."], workspace);
  command(
    "git",
    [
      "-c",
      "user.name=Codex Delegate Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "baseline",
    ],
    workspace,
  );
  const requestFile = path.join(workspace, "request.txt");
  writeFileSync(
    requestFile,
    [
      "A customer identifier lookup returns HTTP 500 for a known missing identifier error.",
      "Return HTTP 400 with code IDENTIFIER_MISSING for that error.",
      "Keep successful lookup responses unchanged and keep unexpected errors as HTTP 500.",
      "Change only src/controller.mjs and add test/controller.acceptance.test.mjs.",
      "Do not change src/service.mjs, package setup, or Git history.",
      "Use the Node built-in test runner. Do not commit, push, or call external services.",
    ].join("\n"),
  );
  const scopeFile = path.join(workspace, "scope.json");
  writeFileSync(
    scopeFile,
    JSON.stringify(
      {
        allowedImplementationPaths: ["src/controller.mjs"],
        allowedTestPaths: ["test/controller.acceptance.test.mjs"],
        requiredRequirementIds: ["HTTP-400", "SUCCESS", "UNKNOWN", "SCOPE"],
      },
      null,
      2,
    ),
  );
  return { workspace, requestFile, scopeFile };
}

export function grade(workspace) {
  const executed = commandResult("node", [grader, workspace], workspace);
  const changed = snapshot(workspace);
  const allowed = new Set(["src/controller.mjs", "test/controller.acceptance.test.mjs", "request.txt", "scope.json"]);
  const unexpected = changed.filter((file) => !allowed.has(file));
  return {
    passed: executed.ok && unexpected.length === 0,
    output: executed.output,
    unexpected,
  };
}

export async function run({ outDir, codexBin }) {
  const prepared = prepare(outDir);
  const state = await start({
    ...prepared,
    codexBin,
    onRunCreated: () => {},
  });
  const result = {
    state: { phase: state.phase, reason: state.reason, run: state.run },
    grade: grade(prepared.workspace),
  };
  result.passed = state.phase === "complete" && result.grade.passed;
  return result;
}

function parse(argv) {
  const args = { mode: "", out: "", codexBin: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (["--prepare", "--grade", "--run"].includes(value)) args.mode = value;
    else if (value === "--out") args.out = argv[++index] ?? "";
    else if (value === "--codex-bin") args.codexBin = argv[++index];
    else throw new Error(`unknown argument: ${value}`);
  }
  if (!args.mode) throw new Error("use --prepare, --grade, or --run");
  return args;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parse(process.argv.slice(2));
    const outDir = args.out ? path.resolve(args.out) : mkdtempSync(path.join(os.tmpdir(), "customer-lookup-"));
    if (args.mode === "--prepare") console.log(JSON.stringify(prepare(outDir), null, 2));
    else if (args.mode === "--grade") console.log(JSON.stringify(grade(path.join(outDir, "customer-lookup")), null, 2));
    else {
      const result = await run({ outDir, codexBin: args.codexBin });
      console.log(JSON.stringify({ outDir, ...result }, null, 2));
      if (!result.passed) process.exitCode = 1;
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
