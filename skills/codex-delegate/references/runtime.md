# Runtime contract

`runtime/orchestrator.mjs` is the public CLI. It creates a session under `<workspace>/.codex-delegate/sessions/`, invokes read-only classification, investigation, and design phases as needed, then hands code work to its internal nested runner.

## Commands

```bash
node ~/.codex/skills/codex-delegate/runtime/orchestrator.mjs start \
  --workspace ABS \
  --request-file ABS \
  [--scope-file ABS] \
  [--runtime-visual-evidence FILE] \
  [--runtime-visual-route ROUTE] \
  [--codex-bin PATH]

node ~/.codex/skills/codex-delegate/runtime/orchestrator.mjs status --run ABS
node ~/.codex/skills/codex-delegate/runtime/orchestrator.mjs resume --run ABS [--retry]
```

`--workspace` and `--request-file` are required for `start`. UI runs require both visual flags. The evidence path is an expected output path. `status` and `resume` require `--run`; `--retry` is only for blocked run.

## Routing and models

The classifier chooses one workflow from `runtime/workflows.mjs`: `investigation`, `simple-fix`, `bug-fix`, `feature`, `refactor`, `ui-change`, `performance`, `pr-maintenance`, or `skill-change`. The registry defines phase order, evidence types, side-effect ceiling, and review policy.

New public runs default to a persistent lead session. Classification starts with Terra; afterward low-risk, low-complexity work stays on Terra and other work defaults to Sol. A validated exact evaluated route can select the lead model. Investigation, design, acceptance, implementation, and repair resume the same explicit thread ID. Policy-triggered Astra escalation changes the model while retaining that thread. Reasoning is medium. Final Sol review is always fresh and receives explicit evidence, not the lead's conversation history.

`--execution-mode isolated` retains separate role sessions when explicitly needed. Old persisted runs without a lead session keep their prior behavior. Internally, the runner accepts `--lead-model MODEL [--lead-thread ID]`; no `--last` lookup or silent fresh-session fallback is allowed. Missing or mismatched resumed IDs block execution. Session reuse preserves phase ownership: authoring may update tests, implementation cannot edit frozen tests, and reviewer source edits invalidate completion.

Every default and generic task-class route is a hypothesis. A route is evaluated only when its evidence has matching skill version, passing result, at least two holdout cases, at least two repetitions, zero false completions, zero scope violations, and an evidence path. Evaluation may promote exact model selection, but cannot disable independent review.

## Evidence gates

Each phase must record every evidence type required by its workflow. Investigation can finish after findings and remains read-only. Code workflows pass through the nested runner, which creates an acceptance contract, captures a baseline, limits implementation paths, freezes contract and test hashes, verifies checks, and records integrity before fresh review. Investigation, design, and prior nested-run artifacts are hash-pinned context passed to every nested role; a changed artifact blocks resume.

`ui-change` requires `runtime-visual` evidence. Supply expected output path and route. Runner snapshots start state, then requires post-implementation regular PNG/JPEG with valid magic bytes, dimensions, fresh mtime, and changed content. It writes nested `evidence/runtime-visual.json`, hash-checks before and after review, and outer delivery uses only that manifest.

Performance acceptance contracts declare nonempty `performanceMeasurements`. Each linked check prints one `CODEX_DELEGATE_METRIC <id> <finite-number> <unit>` line at baseline and final verification. Runner writes `evidence/performance.json` and blocks missing, duplicate, mismatched, nonfinite, or insufficient metrics.

Required external verification cannot be relabeled as local evidence. The nested acceptance contract blocks it rather than treating a simulated or local result as external proof. Local authorization never implies remote mutation: commit, push, merge, deploy, publish, messaging, and account changes need explicit user authority.

## Block and recovery boundary

Use `status` before retrying. `resume --retry` resumes the failed phase, retaining investigation and design. Verification environment failures retain the implementation and rerun failed checks; successful checks are reused only when workspace, contract, test, runtime environment, and pnpm installation metadata fingerprints match. A review environment failure retries a fresh review only. Do not delete locks, journals, or evidence to force progress.

Baseline executes the acceptance commands before a worker starts. Reviewers use workspace-write to permit the same cache-producing tools; instructions forbid source edits and the runner checks the repository fingerprint afterward. Already-passing baseline checks skip a redundant implementation agent, then undergo verification and fresh Sol review. UI and performance work retain their implementation phase for fresh evidence.

Contract revisions preserve implementation and snapshot prior contract, red/green logs, review, and frozen tests. The author receives these through compact handoff.json. Previously fixed checks use a passing current baseline; original failing evidence stays in the prior snapshot. Only new missing conditions need new checks. Within one outer session revisions rerun acceptance without repeating investigation/design, with a bounded two-revision budget and Astra escalation on repetition.

Nested-run recovery is an internal exceptional path. It first requires inspection that its owner and child process group are no longer live, validates workspace and frozen-contract integrity, records a reason, and only then permits retry. A reviewer-requested contract revision is non-retryable and needs a new run with earlier evidence.

The final `delivery.json` names workflow and required evidence. Completion proves those recorded gates only; report unexecuted, manual, or external evidence separately.
