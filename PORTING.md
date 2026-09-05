# Port coverage and evidence

## Source coverage

The pinned `pstack/skills` and `pstack/agents` trees contain 124 files, all represented in `UPSTREAM.json` and this package. Three supporting cursor-team-kit guides bring the mapped source total to 127. All 45 pstack skills are present as one registered entrypoint plus 44 library guides. All 23 playbooks and 21 principles are present.

This covers the complete skill and agent trees, not every asset, automation configuration, marketing document, or hosted Cursor service in the original plugin. File coverage is not a claim that every workflow has been exercised end to end.

## Platform mappings

| Upstream mechanism | Codex adaptation |
| --- | --- |
| Cursor mode/reminder metadata | Standard SKILL.md and agents/openai.yaml; conversation-scoped instructions |
| Separate named skills and slash commands | Self-contained library/index.md with on-demand GUIDE.md reads |
| Task / subagent_type / background flags | Live Codex tool schema, role prompts, bounded concurrency, explicit file ownership |
| Default Grok/Claude model slugs | Inherit parent by default; validated optional role config; no invented model aliases |
| Cross-model review | Preserve panels; disclose same-model fallback and any unmet diversity gate |
| Automatic cloud worktrees | Explicit local worktrees; remote execution only when available and authorized |
| Cursor transcript layout | Scoped Codex task APIs or verified rollout metadata; no cross-project history mining |
| Cursor /loop, sleeper chains, /goal | Current-turn execution plus supported scheduler when requested; durable checkpoint otherwise |
| User-level .mdc rule | Bundle-read ~/.codex/pstack-models.md; not a native global Codex rule |
| Cursor built-in create-skill | Installed Codex skill-creator when available, bundled authoring fallback otherwise |
| cursor-team-kit dependencies | Included deslop, control-cli, control-ui guides with their MIT license |
| Automatic external side effects | User scope and host authorization; monitor-only requests stay read-only |
| Cursor bot routines and secret cards | Require a real documented backend; explicit mock if absent |
| Worktree transcript scan and safe label | Read-only git/PR audit plus separate host-history/ownership check; no automatic safe-to-delete claim |
| Plan checker vendor-model and path constants | Codex model policy and installed bundle paths; matching template and positive/negative check |

`runtime.md` defines these mappings for every guide. Local project instructions, installed tool restrictions, user choices, and permissions remain authoritative. The package does not register native custom agents, install a cloud executor, create a scheduler, enable global modes, or provision third-party services.

## Validation performed

- Codex skill-creator `quick_validate.py` passed on the registered skill.
- `python3 test_port.py` passed, including isolated installation and refusal to overwrite local edits.
- `check_upstream.py` matched every mapped file against the pinned checkout.
- Original Bun watcher/orchestrator test suite passed: **52 tests, 206 assertions**.
- Watcher TypeScript check passed.
- An independent agent read the package for a read-only explanation and a shell-only future CI monitor request. It found a decision-log path mismatch and missing monitor-mode mapping. Both were corrected. A follow-up found that plan validation required an unresolved installation-path placeholder; that was fixed and the resolved-path case was added to the check.
- Plan checker was exercised with the bundled template and with a missing live lane; the valid structure passed and the missing lane failed.

These checks do not prove an actual deployment, production PR merge, future scheduler wake, cross-vendor model panel, or live bot webhook. Those depend on the consuming host and task. No such service was provisioned or claimed by this port.

## Updating the port

Read each changed upstream file beside its mapped destination. Keep platform-neutral workflow content close to upstream. Update the Codex-specific mapping where an upstream change touches execution. Preserve attribution. Use `check_upstream.py` against a freshly fetched source checkout; added files must be mapped as well as changed files reviewed. Update the recorded commit and hashes only after that review.
