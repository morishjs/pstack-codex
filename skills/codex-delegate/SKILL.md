---
name: codex-delegate
description: Execute the complete Poteto playbook library through per-playbook XState gates, retained task context, explicit authority, and evidence-backed completion. Use for investigation, implementation, planning, review, evaluation, PR lifecycle, monitoring, and scoped cleanup.
---

# Codex Delegate

## Main coordinator

Start work in the current turn. Never end the turn merely to request a model change, and never emit a model-handoff status message instead of acting on the task. A skill is loaded after the host has selected the current turn's model, so it cannot silently replace that model. If the caller creates a new task and can select its model up front, prefer **gpt-5.6-terra / medium** for the main coordinator. Otherwise retain the current main model and apply the role-specific model policy below through explicit delegated roles. Do not create a new thread, send a message back to the same thread, or restart intake only to change the main model.

Freeze the user's intended outcome before selecting a playbook. All 23 bundled Poteto playbooks have their own guarded XState step graph. Read [execution policy](references/playbook-execution.md) and the selected original playbook under [the source guide](poteto/GUIDE.md). Do not replace the selected playbook with the generic code executor. The complete source and supporting tools are bundled; `poteto-manifest.json` pins their original bytes.

## Select and start

Copy the actual user request and relevant user-authorized context into a request file. Do not rewrite a bug report into "investigate read-only" or invent "do not modify". Run intake on that original file; inspect its classification and frozen delivery goal before starting. This operator explicitly selected `task-policy.json`'s bug-report default: investigate, fix, verify, publish a scoped PR, and pass CI. A concrete defect phrased "why?" follows that policy. General conceptual questions stay explanatory. Explicit investigation-only, plan-only, no-code, or no-PR limits take precedence. Merge, deploy, messages, and account changes are not covered by the PR default.

If intake misreads the request, correct the classification with direct user-text evidence before starting; never silently lower the goal to bypass work. A later explicit scope change needs a new documented contract referencing the preserved prior run. For simple continuation, use the existing run's `resume` and `next`; do not run intake again or restart the investigation. Checking a PR remains distinct from driving it, and merge-ready from shipping.

```bash
node ~/.codex/skills/codex-delegate/runtime/orchestrator.mjs playbooks
node ~/.codex/skills/codex-delegate/runtime/orchestrator.mjs intake \
  --request-file /absolute/original-request.md --out /absolute/task-intake
node ~/.codex/skills/codex-delegate/runtime/orchestrator.mjs start \
  --workspace /absolute/workspace --intent-file /absolute/task-intake/intent.json \
  --request-file /absolute/original-request.md
```

Intake derives grants for report, plan, verified-change, and PR goals. Other specialized playbooks retain the existing exact user authority supplied with `--grants`. Available grants are `read-only`, `local-workspace`, `remote-write`, `destructive`, and `scheduler`. Grant labels never expand the user's exact scope. Ordinary reversible worktree preparation is local workspace work. Missing authority blocks the affected action; never silently drop a required step or ask again for authority already provided.

## Drive the selected machine

Use [the retained team protocol](references/retained-team.md). The default worker is the current main thread (Terra medium preferred when selectable); it owns investigation, design, acceptance, implementation and verification without new sessions at each phase. Bind one independent Sol medium reviewer at the first review and resume that same reviewer for repairs. Do not spawn an acceptance author or an implementation replacement simply because the phase changed. Source-required independent panels/parallel lanes remain supported with explicit additional-participant records.

1. Call `next --run ABS`. Read the active original clause and its relevant linked guides. The returned generation identifies this attempt.
2. Perform the active action with the retained worker and actual host tools. Freeze requirement IDs once with the worker; map verification evidence to those IDs. Use registered Astra planning specialists only when source-required independent design work or a concrete task need warrants one. The reviewer begins independently, then receives the review context on every resumed review. A model recommendation is not evidence that the model ran.
3. For required children, call `child --run ABS --playbook ID` and complete the linked child machine with the same team. A child playbook is not a new agent. Evaluate source conditions before choosing conditional alternatives.
4. Write a receipt outside controller state files, then call `record --run ABS --receipt-file ABS`. Include `stepId`, `generation`, `outcome`, and `evidence: [{kind, path}]`; include `data` for declared assertions. Passed steps need all required evidence. `not-applicable` requires a conditional step, concrete reason, and `scope-exclusion` evidence. Report excluded scope separately.
5. Continue until complete, explicit pause, or an unresolved concrete blocker. Use only declared `retry --run ABS --to STEP --reason TEXT` edges. Preserve completed work and evidence; do not restart or rewrite frozen artifacts to bypass a gate.

For review findings use `team` to record stable IDs, existing requirement IDs, affected files and evidence. Worker marks fixed; only the retained reviewer resolves. Use `repair-finding` for a guarded return to implementation, design, acceptance work or verification. Environment and formatting failures return to verification, never a fresh acceptance-author run. Unrelated improvements remain optional. `next` includes prior findings and reusable/stale checks; pass this context to the reviewer with the actual diff. Reuse evidence only for unchanged declared inputs; include shared callers, configuration and dependency manifests when they affect the check. Independent approval and all required findings must be resolved before typed implementation goals complete.

Starting a run is not completion. Retain the frozen task goal through child playbooks and repairs. PR tasks cannot skip publication or accept pending/failed CI as complete; follow the current-head evidence format returned by `next`. Repair authorized failures and reverify before accepting completion. Keep ownership through terminal evidence. Answer status questions in commentary and continue. Use `pause` and `resume` to retain progress. Never promise a future wake without a real scheduler receipt.

Do not ask again to perform scoped reversible local recovery: install the project's browser runtime, start the current worktree server, repair a local API startup error, or rerun tests. Use the approved existing test account to log in and finish the requested UI verification. Normal login is not account creation or password mutation. For a verification obstacle, use `recovery --run ABS --action-file ABS` with `{kind, inScope, environment}` (and `existingTestAccount` for `test-login`). Follow `next`'s recovery instructions, execute the actual action, and retain proof. If recording a blocker from this decision, include the same `recoveryAction` in its receipt; an allowed recovery cannot be recorded as an approval blocker. Explicit user pauses remain valid. Localhost does not authorize remote DB writes, credential changes, deletion, or unrelated fixes; check the underlying effect and existing exact authorization.

The controller checks order, authority, child completion, hashes, and declared assertions. The host must inspect semantic correctness and actual tool results. A fabricated file or a successful unit test does not establish browser, model, forge, or production execution.

## Reuse the code executor

The [subordinate code runtime](references/runtime.md) and its separate frozen-test author are opt-in, for an explicit request requiring that isolation. Do not start it for ordinary implementation steps; use the retained worker and team protocol. Existing saved executor runs remain resumable under their original contract. Executor completion can supply evidence but cannot complete a parent playbook or replace its independent review.

Scope paths are literal relative files/directories; `/**` is rejected before model execution. Set `--authority local-workspace` only from existing authorization. Read [worker workspaces](references/worker-workspaces.md) for reused installations and [dependency queues](references/dependency-queue.md) for independent lanes. Use the original bundled plan checker, watcher, and ledger tools when the selected source requires them.

Existing code runs remain resumable with their saved status/wait/resume commands. New session-pickup work resumes existing progress rather than rebuilding it.

See [intent evaluation](references/intent-evaluation.md) for deterministic completion tests and the separate live model regression suite.

See [local recovery](references/local-recovery.md) for action inputs, authorization boundaries, and the actual local browser integration command. For authenticated UI work, require real login, an authenticated API response, and the requested UI interaction before completion. Simulated recovery tools or model classification scores cannot satisfy that runtime requirement.
