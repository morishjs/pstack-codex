# Dependency queue and targeted recovery

Use the queue when implementation separates into disjoint file owners. Keep a narrow fix in one ordinary run. The coordinator derives a plan from the request and existing investigation; do not create another investigation agent merely to split known work.

```sh
node ~/.codex/skills/codex-delegate/runtime/orchestrator.mjs start \
  --workspace /absolute/clean-repository \
  --authority local-workspace \
  --plan-file /absolute/plan.json \
  --request-file /absolute/original-request.txt \
  --scope-file /absolute/integration-scope.json
```

The plan has a tasks array. Each task specifies `id`, `dependsOn`, `owns`, `request`, and `scope`. Scope uses `allowedImplementationPaths`, `allowedTestPaths`, and `requiredRequirementIds`. Include both source and test paths in owns. Use literal relative files or directories in scope fields; glob suffixes such as `/**` are rejected. The separate owns field retains its legacy trailing `/**` support, but directory paths avoid ambiguity across fields. A shared contract belongs to one predecessor, with API and Web tasks depending on it. Cycles, missing dependencies, and overlapping ownership fail before work begins.

Set `probeModule` to a declared root dependency when pnpm installation is required, for example `typescript`. A task may override its probe; the plan-level probe prepares the integrated checkout too. Installations reuse the configured pnpm store and worker preparation cache. Two ready tasks run concurrently by default; `--concurrency 1` selects serial execution. A freed slot immediately starts another ready task.

The queue requires committed, clean source input and leaves that source checkout unchanged. It creates local checkpoint commits only in generated detached worktrees to convey dependency results. A lane sees its transitive dependencies' verified patches, not unrelated concurrent edits. Per-task lane worktrees persist across retries; completed lanes remain parked. The initial implementation limits active workers, not the total number of retained worktrees. It does not share node_modules across checkouts.

State is stored under `.codex-delegate/queues/<id>`. Use the public orchestrator `status --run PATH` and `resume --run PATH --retry`. Successful lane artifacts are reused only while their patch, commit, checkout, and dependency signatures remain valid. A stale predecessor invalidates descendants. Failed lane edits are preserved; independent lanes continue. Runtime nested-run locks still apply.

All successful patches are applied to a separate integration checkout. The original combined request must pass executable acceptance checks and a fresh Sol review there. A lane passing does not imply integration passed. If integration verification or review is blocked, resume that integration run without re-executing successful lanes.

After a coordinator crash, inspect child processes and preserved files. Recovery requires `resume --run PATH --retry --recover-interrupted` after confirming child processes stopped. Never remove locks or start duplicate workers to bypass it.

An immutable plan cannot be silently changed during execution. Contract omissions within a lane revise that lane's nested contract, preserving prior red evidence and implementation. If the task dependency graph or file ownership itself needs revision, create a reviewed replacement plan and preserve the old queue evidence; automatic graph editing is not supported.
