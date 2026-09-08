---
name: codex-delegate
description: Execute the complete Poteto playbook library through per-playbook XState gates, retained task context, explicit authority, and evidence-backed completion. Use for investigation, implementation, planning, review, evaluation, PR lifecycle, monitoring, and scoped cleanup.
---

# Codex Delegate

Select a playbook for every new task. All 23 bundled Poteto playbooks have their own guarded XState step graph. Read [execution policy](references/playbook-execution.md) and the selected original playbook under [the source guide](poteto/GUIDE.md). Do not replace the selected playbook with the generic code executor. The complete source and supporting tools are bundled; `poteto-manifest.json` pins their original bytes.

## Select and start

Match the request to the catalog's entry descriptions. Explain/plan does not authorize implementation. Checking a PR is distinct from driving it; merge-ready is distinct from shipping. Preserve prototype, read-only, pause, and pickup exceptions.

```bash
node ~/.codex/skills/codex-delegate/runtime/orchestrator.mjs playbooks
node ~/.codex/skills/codex-delegate/runtime/orchestrator.mjs start \
  --workspace /absolute/workspace --playbook feature \
  --request-file /absolute/request.md --grants read-only,local-workspace
```

Derive grants from existing user authority. Available grants are `read-only`, `local-workspace`, `remote-write`, `destructive`, and `scheduler`. Grant labels never expand the user's exact scope. Ordinary reversible worktree preparation is local workspace work. Missing authority blocks the affected action; never silently drop a required step or ask again for authority already provided.

## Drive the selected machine

1. Call `next --run ABS`. Read the active original clause and its relevant linked guides. The returned generation identifies this attempt.
2. Perform the active action with actual host tools. Use Astra medium for complex initial investigation, design, and acceptance; retained Terra/Sol context for implementation; fresh Sol medium for independent final review. Preserve source exceptions such as prototypes. A model recommendation is not evidence that the model ran.
3. For required children, call `child --run ABS --playbook ID` and complete the linked child machine. Evaluate source conditions before choosing conditional alternatives.
4. Write a receipt outside controller state files, then call `record --run ABS --receipt-file ABS`. Include `stepId`, `generation`, `outcome`, and `evidence: [{kind, path}]`; include `data` for declared assertions. Passed steps need all required evidence. `not-applicable` requires a conditional step, concrete reason, and `scope-exclusion` evidence. Report excluded scope separately.
5. Continue until complete, explicit pause, or an unresolved concrete blocker. Use only declared `retry --run ABS --to STEP --reason TEXT` edges. Preserve completed work and evidence; do not restart or rewrite frozen artifacts to bypass a gate.

Starting a run is not completion. Keep ownership through terminal evidence. Answer status questions in commentary and continue. Use `pause` and `resume` to retain progress. Never promise a future wake without a real scheduler receipt.

The controller checks order, authority, child completion, hashes, and declared assertions. The host must inspect semantic correctness and actual tool results. A fabricated file or a successful unit test does not establish browser, model, forge, or production execution.

## Reuse the code executor

For an implementation substep, use [the subordinate code runtime](references/runtime.md) with `start --code-phase` when its model policy matches the assigned work. Its completion supplies substep evidence; it cannot complete the parent playbook. Its legacy classifier/model policy remains separate from the host playbook policy. When a specific model is required, use the host's explicit model selection and record the actual assignment.

Scope paths are literal relative files/directories; `/**` is rejected before model execution. Set `--authority local-workspace` only from existing authorization. Read [worker workspaces](references/worker-workspaces.md) for reused installations and [dependency queues](references/dependency-queue.md) for independent lanes. Use the original bundled plan checker, watcher, and ledger tools when the selected source requires them.

Existing code runs remain resumable with their saved status/wait/resume commands. New session-pickup work resumes existing progress rather than rebuilding it.
