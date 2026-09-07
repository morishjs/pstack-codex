---
name: codex-delegate
description: Route a bounded workspace request through Codex Delegate's autonomous classifier, workflow registry, dynamic model policy, evidence gates, and repair/block loop. Use when a task needs an evidence-backed investigation, fix, feature, UI change, performance change, refactor, PR maintenance, or skill change without granting remote mutations.
---

# Codex Delegate

Use the orchestrator as the entry point. It classifies the request, selects a registered workflow, assigns models through `runtime/model-policy.json`, records required evidence, then repairs or blocks on failed gates.

Read [references/runtime.md](references/runtime.md) before invoking it. Read [references/workflows.md](references/workflows.md) for workflow-specific phases and [references/model-routing.md](references/model-routing.md) for routing and promotion rules.

## Run

Create a request file. Optionally provide a scope contract with `allowedImplementationPaths`, `allowedTestPaths`, and `requiredRequirementIds`.

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

The runner freezes acceptance tests and contracts, constrains changed paths, records workspace integrity, and uses a fresh read-only reviewer. A failed verification or review either repairs within the frozen contract or blocks. A contract revision requires a new run.

UI workflows require a post-implementation PNG/JPEG at supplied path and route. Runner rejects stale, renamed, invalid, or review-drifted images and writes manifest. Required external verification blocks nested runner; do not relabel it as local evidence.

Do not call a route evaluated by default. All generic routes begin as hypotheses. Evaluation evidence may promote exact model selection, but every local-workspace workflow always records a fresh independent Sol review.
