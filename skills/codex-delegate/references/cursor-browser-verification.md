# Browser verification through Cursor ACP

Use Cursor ACP as the default browser execution provider when a selected playbook requires real UI verification. Keep the existing XState step, acceptance criteria, main worker and independent reviewer. This delegates browser execution only; it does not start a second implementation workflow. The host must dispatch and follow the bridge in the current turn. The controller itself does not launch Cursor.

## Dispatch and resume

Read the installed `cursor-acp/SKILL.md` from the host's skill catalog (normally `~/.codex/skills/cursor-acp/SKILL.md`). Use its existing bridge, PTY, stdin protocol and authentication check. The bridge supplies Cursor's installed Poteto skill link; do not add a second link or copy that playbook into the prompt. Retain Cursor's configured model unless the user selected another supported model.

Pass a compact handoff containing:

- Absolute worktree, actual running URL, revision and dirty diff identity, and a unique absolute evidence directory outside tracked product files.
- Frozen requirement IDs, concrete scenarios and expected results, relevant changed files, and previous failures or unchanged checks to reuse.
- Existing login skill/credential source and exact permitted effects. Keep passwords and tokens out of the handoff, report and captured logs; use the authorized local credential source.
- This role: execute the supplied browser scenarios, save evidence, and return failures to Codex. Do not edit product code, create commits/PRs, run an unrelated audit or delegate the task again. Infrastructure repairs requiring code return to the main worker.

Use one ACP session for the browser work in this task. Save the actual `session` event with the handoff and bridge transcript in the evidence directory; resume that exact ID for retests. Send only the changed requirements, new revision/input identity and prior failing cases. Reuse other checks only when their declared inputs remain unchanged. Never replace a failed session load silently. An uncertain turn result requires inspection before retrying an action.

For this scoped verification role, omit `--full-access` and answer advertised permission requests through the attached bridge. The main worker allows already-authorized local server/browser preparation and existing test-account login without asking the user again. Reject out-of-scope code edits, account changes, remote writes or business actions. A localhost URL does not establish where data is stored. Supply exact authorization for any scenario that needs a real write; otherwise return that specific scenario as blocked. These instructions and permission decisions do not provide an OS sandbox.

## Evidence and completion

Ask Cursor to save a report with the ACP session ID, tested revision/input identity, URL, and one result per requirement/scenario: steps performed, expected and actual behavior, pass/fail/blocked, and absolute screenshot/network evidence paths. For authenticated UI work, require real login, a relevant authenticated API response, and the requested interaction. Mocks, auth bypass, screenshots of only the login page, or static source inspection cannot satisfy those checks. Redact credentials and sensitive patient data; retain sensitive screenshots locally rather than publishing them.

Continue reading the same bridge until its turn returns. A successful handshake or `done` event is transport evidence only. The main worker checks scenario coverage, opens the relevant screenshots, inspects the API evidence, verifies files and input freshness, and records accepted evidence with the existing worker `team verify` and step receipt. Preserve the Cursor transcript/report as provenance; do not invent a native reviewer/specialist assignment or claim that Codex performed Cursor's clicks. The separate Sol reviewer retains the final independent decision.

On a failing scenario, Codex repairs within the existing contract and resumes the same Cursor session for the affected checks. On missing Cursor authentication, bridge, plugin or browser capability, capture the exact failure. Use an available host browser as a disclosed fallback within existing authority, preserving the same required evidence; do not silently skip verification. Respect an explicit Cursor-only constraint. If neither path can run, report the concrete remaining blocker.

This saves repeated browser-operation context in the main conversation; Cursor still incurs its own usage. Do not claim measured token or time savings without comparing actual runs.
