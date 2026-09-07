# Workflow routing

Classify the request once, then select the matching entry in `runtime/workflows.mjs`. The listed phases run in order. Models may investigate, choose methods, edit within scope, and rerun checks autonomously inside a phase. XState advances only after the phase records every listed evidence type.

Use only relevant phases. Investigations remain read-only. Bug fixes reproduce before acceptance and implementation. Performance work records linked metric baseline/final outputs and required improvement. UI changes require post-implementation runtime screenshot at declared route.

`finishPhases` lists phases that may return a final result. A read-only investigation may return as soon as its findings answer the request, or continue to `deliver` for packaging. A return reports evidence and gaps; it does not imply permission for another phase or action.

`sideEffectCeiling` is the workflow's maximum built-in authority. `local-workspace` permits scoped local edits only. Push, merge, deploy, publish, external messages, account changes, and other remote mutations require explicit user authority even when a workflow mentions them. The user's explicit scope always sets the lower action ceiling.

`independentFinalReview` is `required` for every local-workspace workflow and records a fresh Sol review. Read-only investigation uses `none` and does not run code review.
