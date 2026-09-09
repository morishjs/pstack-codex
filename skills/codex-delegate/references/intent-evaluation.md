# Request-to-completion evaluation

`task-intent.mjs` is shared by live intake and its evaluator. Classification distinguishes concrete failures from conceptual questions, and a deterministic resolver applies operator policy and explicit restrictions. The classifier sees the request and policy, never expected labels. Contracts freeze the original request hash, selected playbook, delivery goal, and grants; children and resumed runs preserve them.

The default `task-policy.json` reflects this operator's explicit preference: concrete bug reports end at a verified PR with passing CI, even when phrased as questions. Set `bugReportGoal` to `report` or `verified-change` for operators without that standing PR authorization. This does not authorize merges, deployment, unrelated remote changes, or messages.

## Deterministic CI

`npm test` runs routing-policy and completion-gate regression tests alongside the existing runtime suite. It rejects rewritten requests, report-route downgrades, expanded grants, skipped required publication, pending CI as completion, and loss of goal on resume. The evaluator grader rejects failed, missing, duplicate, or unexpected results. A fake classifier tests the CLI's input/output plumbing; it is not model-quality evidence.

```sh
node intent-eval.mjs
```

This dry run validates the dataset without model calls. The dataset includes the reported calendar wording, paraphrases, CI failures, explicit restrictions, conceptual questions, continuation, untrusted quoted instructions, and a policy-disabled case.

## Live model evaluation

```sh
node intent-eval.mjs --live --model gpt-5.6-terra --repeat 2 --out /absolute/new-report-directory
```

The live runner uses two isolated read-only classifier calls concurrently. It saves each prompt, raw structured decision, execution output, and a deterministic grade. `report.json` records the model, repetitions, dataset/source hashes and all cases; any failed or missing case exits nonzero. It does not modify application code, create PRs, or run deployment scenarios. It measures request interpretation, while controller tests separately measure end-to-end completion gates. A passing finite sample is regression evidence, not a guarantee on all future requests.

This follows the existing `eval.mjs` prepare/run/grade separation and Mevops' AI-eval contract: invoke the same production boundary, keep expected outcomes separate, grade deterministically, and fail incomplete results. Langfuse is unnecessary for this local skill test; JSON artifacts retain the evidence without new credentials or dependencies.

The [2026-09-08 recorded result](intent-evaluation-result.json) passed all 12 fixed requests twice (24/24) with real `gpt-5.6-terra` medium calls. An earlier run found a local-only routing error and a continuation-label mismatch; the final result follows their fixes. These are regression cases used during development, not unseen holdout evidence or a model promotion claim.
