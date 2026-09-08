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

## Actual runtime verification

Keep the small deterministic policy tests in `npm test`: existing authority, protected effects, explicit pause, and false blocker rejection. The simulated recovery-tool grader and its four-case AI harness were removed. They did not prove real login or application recovery.

The opt-in Mevops integration command uses the project's Playwright package and installed Chrome. It has no route mocks, auth bypass, synthetic event log, or fixture data creation:

```sh
# Supply existing test credentials through MEVOPS_TEST_EMAIL and MEVOPS_TEST_PASSWORD.
node recovery-eval.mjs --live \
  --workspace /absolute/mevops \
  --base-url http://localhost:PORT \
  --date YYYY-MM-DD --out /absolute/new-evidence-directory
```

Start/recover the actual local API and web first using the project dev-server skill. Verify their real listeners and backing environment. Use a date with existing local reservations. The test logs in, requires a successful authenticated staff API response and app navigation, then compares right/bottom edge clicks against the same card's center-click detail panel. Arrival status can legitimately open either reservation information or admission status. It measures the outer card bounds, so the old excluded strip cannot pass by clicking inside the smaller hit area.

The test saves a JSON report and local screenshots. Do not publish screenshots containing patient information. It intentionally fails when the environment, credentials, data or UI behavior cannot be verified. CI keeps the deterministic tests; this integration run requires real local prerequisites and is opt-in.

[Recorded actual result](recovery-evaluation-result.json): real Chrome login succeeded, the original right-edge behavior failed, and the corrected right and bottom edges passed on the same local application and existing data. Three local API TypeScript errors were repaired first; existing focused API tests passed. This is actual integration evidence driven by the host assistant and Playwright, not a claim that a separate Terra agent independently repaired an application.
