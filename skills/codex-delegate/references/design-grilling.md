# Conditional design grilling

Use the dependency-frontier approach from the installed `grilling` / `grill-me` skill when available. This operator's policy overrides its default of asking the human every decision: the retained worker researches facts and proposes technical decisions; the retained reviewer challenges and confirms them. Only product-policy, authority, or irreversible choices need actual user decisions. Existing explicit user decisions are reusable; never ask for the same authorization again.

Before acceptance, record `assess-design` through `team`. Decide whether anything remains undecided, not whether the diff seems large. For a clear request using an established implementation path, use `{type:"assess-design",actorId:WORKER,clear:true,reason:"...",questions:[]}` with evidence and proceed immediately. Do not create a reviewer merely to approve this bypass. Preserve the normal post-implementation independent review.

For unresolved decisions use `clear:false` and prerequisite-first questions with `{id,question,kind,dependsOn}`. Kinds are `technical`, `product-policy`, `authority`, and `irreversible`. Examples include the complete producer/caller inventory, error behavior, affected tenants, data retention, or a backward-incompatible API choice. Ask only questions relevant to the current request; do not turn grilling into an unrelated redesign.

`next.reviewContext.design` exposes the current frontier and splits `agentQuestions` from `userQuestions`. The same reviewer may add questions via `grill-question`. The worker answers via `grill-answer` with `{id,answer,source,disposition}`, using actual evidence. Technical answers use code/existing user evidence. User-only decisions additionally require `source:"user"`, the exact `userQuote`, and `user-decision` evidence from the actual conversation. A source label is not new authority; the reviewer must inspect that evidence. Batch the currently answerable human questions with recommendations, and continue independent fact-finding while waiting.

The reviewer records `grill-confirm` with `{id,accepted:true|false}`. Rejected answers return to the same frontier; accepted answers unlock dependent questions. `design-ready` is allowed only when all declared questions are resolved. This uses XState's unassessed/grilling/ready gate. It does not prove that an AI identified every possible question.

## Turn decisions into an implementation checklist

Answer dispositions are `requirement`, `assumption`, or `out-of-scope`. Acceptance entries require `{id,text,implementationFiles,verification,decisionIds}`. Every resolved requirement or assumption must be mapped by at least one entry; missing mappings are rejected. An assumption may map to existing code and a verification-only check, without requiring a code change. Enumerate the concrete producer/caller locations rather than writing “connect everything.” `implementationFiles` are review anchors, not an allowlist forbidding necessary caller changes. Final review covers these anchors plus actual changed files.

Once acceptance is frozen, do not repeat all grilling for every review finding. Review design compliance, the actual change, and regressions it introduced. Reuse prior findings, resolved answers and unaffected verification. A user-requested scope change still needs a new linked contract.

## Constrain re-review

Every new finding declares `basis`:

| Basis | Treatment |
|---|---|
| `design-omission` | Required; link to an existing agreed requirement and fix it |
| `change-regression` | Required; link to the affected requirement and fix it |
| `preexisting` | Existing issue outside the agreement; followup only |
| `improvement` | New improvement outside the agreement; followup only |
| `blocking-dependency` | Required obstacle to safe operation; decide scope before repair |

Followup-only findings do not revoke an otherwise valid approval, cannot enter `fixed`, and cannot trigger `repair-finding`. Do not silently repair them through native tools either. A blocker must not be relabeled optional merely to finish.

For an open blocking dependency, the retained reviewer records `scope-decision` with `{id,choice,reason,checkIds}`. `within-scope` requires evidence of a safe solution within the existing request and grants. `include` requires an actual user decision/quote before expanding work; it does not modify frozen grants by itself. Both identify the checks that must verify the affected dependency after its fix, mapped to the finding's existing requirement. An unrelated older check cannot satisfy that gate. `defer` keeps the requested work blocked if the dependency is still essential; it is not permission to mark unsafe functionality complete. If the user already gave the exact decision, record it instead of asking again.

Technical grilling and review stay with the same two participants. This feature adds no standing panel, mandatory multi-round debate for clear work, or automatic implementation of newly discovered improvements.
