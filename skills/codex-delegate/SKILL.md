---
name: codex-delegate
description: Route a bounded workspace request through Codex Delegate's autonomous classifier, workflow registry, dynamic model policy, evidence gates, and repair/block loop. Use when a task needs an evidence-backed investigation, fix, feature, UI change, performance change, refactor, PR maintenance, or skill change without granting remote mutations.
---

# Codex Delegate

Use one lead session to retain the task's context across investigation, acceptance, implementation, and repair. The orchestrator still controls phase boundaries and evidence gates. Only final Sol review starts a fresh independent session. Delegate narrow independent tasks through the queue when their size justifies separate workers.

Read [references/runtime.md](references/runtime.md) before invoking it. Read [references/workflows.md](references/workflows.md) for workflow-specific phases and [references/model-routing.md](references/model-routing.md) for routing and promotion rules.

## Run

Create a request file. Optionally provide a scope contract with `allowedImplementationPaths`, `allowedTestPaths`, and `requiredRequirementIds`.

For isolated code workers, prepare a reusable checkout as described in [worker-workspaces.md](references/worker-workspaces.md). Use the returned workspace with the orchestrator. Reuse the same worker ID for repairs; read-only investigation uses the existing checkout without installation.

For independent API/Web or other disjoint implementation lanes, use the [dependency queue](references/dependency-queue.md) with `--plan-file`. Establish shared contracts as predecessors. The queue runs up to two ready lanes, preserves successful work across retries, then verifies the integrated artifact with Sol.

A phase transition does not require a new model session. Reuse completed investigation and the lead's conversation. Read handoff.json for changes and verification outcomes, and reopen code only when relevant input changed or evidence is missing. Queue lanes each keep their own lead session; use one ordinary run for small fixes.

```bash
node ~/.codex/skills/codex-delegate/runtime/orchestrator.mjs start \
  --workspace /absolute/workspace \
  --request-file /absolute/request.txt \
  --scope-file /absolute/scope.json \
  --runtime-visual-evidence /absolute/ui-evidence.png \
  --runtime-visual-route /settings/profile
```

For `ui-change`, supply both visual flags. Evidence path is expected output path, not pre-captured proof. Omit both when irrelevant. Use `--codex-bin /absolute/codex` only when executable is not on `PATH`.

Use `status --run /absolute/run` to inspect a run. Use `resume --run /absolute/run --retry` only after resolving its recorded blocker. The nested runner is internal; do not start it as the normal workflow.

## Authority and delivery

Classification grants only `read-only` or `local-workspace` actions. Investigation workflow is read-only. A PR-maintenance workflow permits local workspace changes only; it never authorizes commit, push, merge, deploy, publish, messages, account changes, or other external writes.

The runner freezes acceptance tests and contracts, constrains changed paths, records workspace integrity, and uses a fresh Sol reviewer. Reviewers may execute cache-producing tests but must preserve source and contracts; post-review fingerprints enforce this. Environment failures retry verification or review only. Contract revisions preserve implementation and prior evidence without repeating investigation.

UI workflows require a post-implementation PNG/JPEG at supplied path and route. Runner rejects stale, renamed, invalid, or review-drifted images and writes manifest. Required external verification blocks nested runner; do not relabel it as local evidence.

Do not call a route evaluated by default. All generic routes begin as hypotheses. Evaluation evidence may promote exact model selection, but every local-workspace workflow always records a fresh independent Sol review.
