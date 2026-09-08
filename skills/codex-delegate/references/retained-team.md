# One worker, one independent reviewer

Keep every selected Poteto phase and evidence gate. Phase boundaries do not create sessions. The main thread normally acts as worker through investigation, design, acceptance, implementation, verification and repairs. Prefer Terra medium when the host can select it at task creation. The first independent review uses a fresh Sol medium participant; subsequent reviews resume that participant with prior findings and the changed diff. Native `followup_task`/equivalent resumes an idle reviewer; do not spawn another merely because a review returned findings.

`next` returns the shared root `reviewContext`, including participant IDs, fixed requirement IDs, findings, fix/resolve history and input-hashed checks. Child playbooks use the root team rather than acquiring a new worker/reviewer. The host executes native tools; the controller records identities, not proof of a model invocation. Verify actual host assignments. It cannot prevent tool calls made outside this protocol or force the host to keep its turn open.

## Commands

`team --run ABS --operation-file ABS` accepts `{ "operation": {...}, "evidence": [{"kind":"...","path":"..."}] }`. Each operation below is an example object for `operation`:

```json
{"type":"assign","role":"worker","agentId":"actual-main-thread-id"}
{"type":"assess-design","actorId":"actual-main-thread-id","clear":true,"reason":"Existing implementation path and behavior are explicit","questions":[]}
{"type":"acceptance","actorId":"actual-main-thread-id","requirements":[{"id":"tenant-send","text":"Use the current hospital's values when sending","implementationFiles":["src/sender.ts"],"verification":"Check tenant replacement in the actual sending path","decisionIds":[]}]}
{"type":"assign","role":"reviewer","agentId":"actual-independent-reviewer-id"}
{"type":"verify","actorId":"actual-main-thread-id","id":"sender-runtime","requirementIds":["tenant-send"],"inputFiles":["src/sender.ts","src/profile.ts","package.json","pnpm-lock.yaml"]}
{"type":"finding","actorId":"actual-independent-reviewer-id","id":"F1","kind":"implementation","basis":"change-regression","required":true,"requirementId":"tenant-send","summary":"Sending can precede organization loading","affectedFiles":["src/sender.ts"]}
{"type":"fixed","actorId":"actual-main-thread-id","id":"F1","summary":"Block send until required tokens resolve"}
{"type":"resolve","actorId":"actual-independent-reviewer-id","id":"F1"}
{"type":"approve","actorId":"actual-independent-reviewer-id","inputFiles":["src/sender.ts","src/profile.ts","package.json","pnpm-lock.yaml"]}
```

The worker defaults to the host's `CODEX_THREAD_ID` when available; otherwise bind it explicitly. Reviewer/specialist assignment requires `host-assignment` evidence JSON with `{agentId,parentAgentId,model,reasoningEffort,independent:true}` matching the actual native tool call/result. Capture it from host records, not invented IDs. Its hash remains checked through completion. Other operations require their real task evidence. Independent roles cannot share an ID, and a phase transition cannot replace either role. Requirement IDs are frozen once; a user-requested scope change needs a new linked contract. A missing test for an existing requirement is an acceptance finding, not a new product goal. Improvements cannot become required findings.

## Repair without starting over

After recording a finding, call `repair-finding --run ABS --finding-id F1`. XState uses its classification: implementation returns to the code step; design returns to design; acceptance returns to acceptance work in the existing code/design step; environment or format returns to verification. Unknown or forward-skipping targets are rejected. This preserves team IDs, findings and check records while archiving invalidated phase receipts and child links. Re-record phase evidence as the selected playbook requires; do not invent skipped phases.

Checks are reusable only while their explicit input files and evidence hashes match. Changing `sender.ts` invalidates a sender check, while a separately declared migration check remains reusable. Shared callers, lockfiles, environment/configuration and all other load-bearing inputs must be included. Undeclared dependencies are not mechanically inferred: the reviewer assesses coverage, and uncertainty requires broader verification. Use unique evidence filenames per attempt; do not overwrite earlier logs. Approval must cover every requirement, check input, required finding's affected files, and actual Git changes since task start. Previously dirty unchanged files are preserved. At non-Git/subdirectory workspaces the context explicitly reports `explicit-inputs-only`; the reviewer must supply the complete change surface. Keep operation/evidence files under run artifacts or outside the repository so they do not enter the product diff.

Fix/resolve evidence is hash-checked, and resolved findings whose affected files changed are marked `needsRecheck`. The same reviewer uses `{"type":"reopen","actorId":"...","id":"F1"}` with evidence, then the existing worker/fixed/reviewer/resolve cycle continues with the same finding ID. Approval and completion reject stale verification or unresolved required findings.

Formatting is ordinary worker work followed by the relevant checks and review. It does not rewrite requirement IDs. The legacy code executor ignores untracked `.pnpm-store` artifacts like other known caches while still protecting tracked files; do not bypass checks by hiding product files in a cache.

## Required exceptions

For a source-required panel or independent lane, register `{"type":"assign","role":"specialist","agentId":"...","sourceClause":"feature/design","reason":"Independent alternatives required by architect/Sketch"}` with host-assignment and source/need evidence. Resume registered participants when the same role is needed again. `next.panelRequirement` identifies panel gates: supply `data.panel={expectedCount,memberIds}` from the actual source configuration and matching registered participants. The minimum is only a structural floor; do not lower a larger configured panel. Feature design may use its original single-design exception with `data.panel={skipped:true,reason}` and scope-exclusion evidence. Eval/swarm required panels cannot omit participant records. Candidate participants cannot serve a differently scoped judge panel through the same assignment.

Preserve actual host concurrency limits. This is not a universal maximum of two agents; it makes additional participants and their reasons visible rather than spawning per phase by default. Unavailable sessions are a concrete recovery problem, not permission to silently replace identities. Host-assignment files and declared inputs are auditable evidence, not an OS-level attestation: native actions and semantic correctness still require inspection.

Eval assignments also declare the actual `modelFamily` from the selected model configuration. Candidate models must differ, and the judge's family must differ from every candidate family; missing family metadata blocks the judge. Do not invent a family label just to pass this gate. Other source-specific semantic obligations still require inspecting the original clause and the real evidence.

The original source library is unchanged. This execution adaptation was requested by the user: keep the procedure, retain ownership across phases, and perform independent review without repeated unrelated re-reading or contract regeneration.
