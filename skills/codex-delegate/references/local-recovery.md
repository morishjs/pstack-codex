# Continue authorized verification

Use `recovery --run ABS --action-file ABS` before turning a verification obstacle into a permission question. The decision uses the current run's grants and the proposed action's actual effect, not the page's URL alone.

Example for the reported login pause:

```json
{"kind":"test-login","inScope":true,"environment":"local","existingTestAccount":true}
```

The approved existing shared test account is already part of the UI verification scope. Log in and continue without asking again. Do not classify ordinary authentication as an account mutation. Missing credentials, an unknown account, or a production target require checking the exact existing authorization instead of assuming access.

Other scoped local actions are `install-browser`, `start-local-server`, `repair-local-api`, and `run-verification`. Use the project's pinned tooling and current worktree. Fix the concrete prerequisite, then run the original verification. API connection or compilation failure must be recovered before claiming that the login screen is the final obstacle. Keep environment repairs narrow and report their changes separately when they touch other files.

Account/password changes, remote data writes, deletion, and unknown effects do not acquire authorization from localhost or a PR grant. The helper flags these for exact authorization review. If exact user authorization already exists, follow it rather than asking for the same permission again; this helper is the routine local-recovery policy, not a universal permission system.

When a blocker receipt is based on this check, include the checked object as `recoveryAction`. The controller rejects marking an authorized local recovery as blocked. This does not prevent a host assistant from ending its turn without submitting a receipt; the skill's continuation instructions and behavior evaluations cover that failure separately.

## Checks

`npm test` covers local continuation, protected effects, out-of-scope work, missing grants, and false blocker rejection. The behavior grader rejects permission-only responses and claims of completion without recovery and verification events.

```sh
node recovery-eval.mjs --live --out /absolute/new-directory
```

This runs real Terra medium agents against four isolated scenarios using executable simulated workspace tools: existing test login, missing WebKit, local API recovery, and a protected account change behind a localhost UI. It records tool output, final answers, and action traces. No real account login, browser download, or API repair happens during this evaluation; those integrations still need native runtime verification. Ordinary CI runs the deterministic tests without AI calls.

The [2026-09-08 result](recovery-evaluation-result.json) passed 4/4 fixed scenarios. The grader checks successful command-execution events as well as helper state, so a final completion claim alone cannot pass. An earlier run recovered successfully after misusing the fixture command syntax but failed the strict action sequence; the final adapter clarifies its command interface. This is a small regression suite, not unseen-case or native-integration proof.
