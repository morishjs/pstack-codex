# Codex Delegate for Codex

The primary skill is `codex-delegate`. All 23 Poteto playbooks have separate XState step graphs, backed by the complete bundled source library. The host performs each action with native tools; the controller gates step order, authority, evidence hashes, linked child completion, and declared assertions.

## Codex Delegate

Install it:

```sh
python3 install.py --skill codex-delegate
```

Start new work with `orchestrator.mjs intake --request-file ORIGINAL --out ABS`, then `start --workspace ABS --request-file ORIGINAL --intent-file ABS/intent.json`. Intake freezes the requested outcome before selecting a playbook. The operator-configured bug-report default is fix, verify, PR and passing CI; explicit report-only, plan-only and no-PR restrictions override it. Set `task-policy.json` to `report` or `verified-change` without that standing PR authorization. Resume retains the existing goal and evidence. Drive `next`, perform the actual action, and `record` its evidence. Investigation, prototype, planning, evaluation, monitoring, shipping, and cleanup retain distinct source conditions and completion boundaries. Complex initial planning uses Astra medium; implementation retains Terra/Sol context; independent final review uses fresh Sol medium. The existing nine-route code executor remains available as `start --code-phase` for code substeps and legacy runs.

`python3 sync_playbooks.py --check` verifies the bundled source against all tracked original files. Deterministic tests validate machine behavior; they do not prove that every playbook has executed real models, browsers, GitHub operations, or production actions.

[Intent evaluation](skills/codex-delegate/references/intent-evaluation.md) separately runs the same production classifier against synthetic request variants. Ordinary CI validates contracts, completion gates, and the dataset without AI calls. `node intent-eval.mjs --live --out ABS --repeat 2` runs actual model calls and fails any wrong or missing outcome; it does not exercise application fixes or remote publication.

UI workflows require a post-implementation PNG/JPEG path and route. Performance workflows require numeric baseline/current metric evidence. The runtime records phase context, frozen contracts, hashes, verification output, and recovery state under the target workspace's ignored `.codex-delegate/` directory.

Run its deterministic suite:

```sh
cd skills/codex-delegate/runtime
npm ci --ignore-scripts --no-audit --no-fund
npm test
```

See [`skills/codex-delegate/SKILL.md`](skills/codex-delegate/SKILL.md) for invocation and runtime boundaries.

Implementation starts require `--authority local-workspace`, derived from the existing user request. Scope paths are literal files/directories; unsupported glob syntax is rejected before any model call. The coordinator tracks the execution through completion or an unresolved blocker. `wait --run PATH` reports pending timeouts explicitly instead of treating a successful status query as completion.

Independent implementation tasks can use a [dependency queue](skills/codex-delegate/references/dependency-queue.md) with up to two active lanes. Each lane keeps an isolated worktree across retries; successful patches are reused only while their evidence remains valid. The integrated checkout must pass combined checks and a fresh Sol review. Environment failures resume verification or review without restarting investigation; contract revisions preserve prior failure evidence and already-fixed implementation.

## Legacy Poteto Mode

A self-contained Codex port of Lauren Tan's [pstack](https://github.com/cursor/plugins/tree/main/pstack), including **poteto-mode**, all **45 upstream skills**, **23 playbooks**, **21 principles**, both agent prompts, and the original PR watcher and orchestrator tools.

Install one skill. Its workflow library ships inside the same directory, so `how`, `architect`, `swarm`, and other dependencies cannot go missing or collide with skills you already installed.

This is an unofficial port. It preserves the upstream workflows while adapting execution to the Codex host. It does not recreate Cursor's cloud infrastructure, vendor models, webhook routine service, or UI. See [PORTING.md](PORTING.md) for the differences and verification boundaries.

## Install

Requires Python 3.9+ for the installer. In a terminal:

```sh
git clone https://github.com/morishjs/pstack-codex.git
python3 pstack-codex/install.py --skill poteto-mode
```

The installer copies only `skills/poteto-mode` into `$CODEX_HOME/skills/poteto-mode` (or `~/.codex/skills/poteto-mode`). It refuses to replace an existing directory or symlink, and excludes development dependencies. No global configuration is changed.

For project-only installation, run from your project directory:

```sh
python3 /path/to/pstack-codex/install.py --skill poteto-mode --dest .agents/skills
```

You can also ask Codex's built-in skill installer:

```text
Install the skill from https://github.com/morishjs/pstack-codex/tree/main/skills/poteto-mode
```

The entire skill is that directory; copying it with a skill installer preserves its dependencies and licenses. Use it on the next turn. If your host caches skill discovery, reopen the session.

## Use

```text
$poteto-mode Fix this bug and verify it.
$poteto-mode use how to explain the request flow. Do not edit files.
$poteto-mode use architect to compare designs before implementing.
$poteto-mode use interrogate to review this diff.
$poteto-mode use setup-pstack to configure model roles.
```

한국어로도 요청할 수 있습니다.

```text
$poteto-mode 이 버그의 원인을 찾고 수정한 뒤 검증해줘.
```

The entrypoint selects the playbook, reads the applicable principles and guides, and uses the actual tools exposed by your Codex host. The mode lasts within the current conversation until you opt out. It is not automatically enabled in every conversation.

Only `poteto-mode` is a registered skill. The 48 [library guides](skills/poteto-mode/library/index.md) include 44 remaining pstack skills, three supporting cursor-team-kit skills, and one Codex authoring fallback. Invoke a leaf through `$poteto-mode use <name> ...`; these are not separate slash commands.

Subagents use the parent's model by default. Optional role choices live in `~/.codex/pstack-models.md` and are read by this bundle. Same-model independent review is labeled honestly. A host without subagents can perform serial passes but cannot satisfy an independent-review gate that requires another agent.

## Optional runtimes

Reading, planning, and routing need no Bun installation. Advanced helpers have additional requirements:

| Workflow | Requirement |
| --- | --- |
| Installation and worktree audit | Python 3.9+; audit also uses Git and `du` |
| Plan checker | Node.js 18+ |
| PR watcher | Bun and authenticated `gh` |
| Orchestrator store | Bun; Graphite `gt` for its stack-frontier command |
| Browser or CLI proof | An available host tool or project harness |
| Future monitoring | A supported Codex scheduler; never promised when absent |
| Bot UI | A real documented backend; otherwise a labeled mock |

The Bun tools bootstrap their lockfile dependencies on first use. Strict read-only requests use direct status queries when bootstrap would write files. macOS/Linux are tested targets for the shell helpers; on Windows use WSL or an equivalent shell environment.

## Verify

From the repository directory:

```sh
python3 test_port.py
python3 check_upstream.py /path/to/cursor-plugins-checkout
```

The first command exercises installation in an isolated directory, duplicate-install protection, reference and upstream-file coverage, upstream drift detection, TSV safety, worktree paths containing spaces, and positive/negative plan validation. It requires Python, Git, Bash, Node, and `du`. It makes no package changes outside its temporary directory.

For the upstream tools:

```sh
cd skills/poteto-mode/scripts
bun install --frozen-lockfile
bun run test
bun run typecheck
```

See [PORTING.md](PORTING.md) for what these checks do and do not prove.

## Track upstream changes

Pinned source: [`93b00b89ef425a9c1bac0d0b317dfc49c930ac99`](https://github.com/cursor/plugins/commit/93b00b89ef425a9c1bac0d0b317dfc49c930ac99).

[UPSTREAM.json](UPSTREAM.json) records each source path, original SHA-256, and destination path. Compare against a fresh checkout:

```sh
git clone --depth 1 https://github.com/cursor/plugins.git /tmp/cursor-plugins-latest
python3 check_upstream.py /tmp/cursor-plugins-latest
```

Exit 0 means all scoped sources match the recorded baseline. Exit 1 lists added, changed, or removed sources. This detects drift; it does not automatically overwrite the reviewed Codex adaptations. Review differences, update the port and manifest, and rerun checks before publishing a new version.

To update an installation, preserve or rename its current directory, then run the installer again. To uninstall, remove only the installed `poteto-mode` directory. Role configuration, if you created it, remains separately in `~/.codex/pstack-models.md`.

## License and attribution

MIT. Original pstack copyright 2026 Lauren Tan. Supporting cursor-team-kit guides copyright 2026 Cursor. See [NOTICE.md](NOTICE.md), [LICENSE](LICENSE), and [the bundled supporting license](skills/poteto-mode/LICENSE.cursor-team-kit). No endorsement by the original authors, Cursor, or OpenAI is implied.
