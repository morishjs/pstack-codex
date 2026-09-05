# Codex runtime contract

Read this before a routed workflow. This file defines the host-specific meaning of every playbook step. Follow system/developer instructions, project instructions, the user's scope and existing authorization. When an upstream workflow expects an unavailable capability, preserve its intended check and record the missing capability; never claim an equivalent result without evidence.

## Loading and planning

Resolve named workflows through `library/index.md`, and read the matching `GUIDE.md` directly with file tools. Do not call a nonexistent Skill tool or assume a slash command loaded anything. `poteto-mode` resolves to the root `SKILL.md`. Root-relative paths starting with `scripts/`, `playbooks/`, or `roles/` stay relative to this installed bundle even when mentioned in another guide. A guide's own `references/` stays beside that guide.

Use the host's plan/todo tool when available. Otherwise maintain a Markdown checklist in the task's workspace or response. Keep the Principles read first, then the selected playbook's steps in order. Mark an unavailable or out-of-scope step with a concrete reason; do not silently erase it. A task without code, commits, or publishing does not acquire those actions from a playbook.

Only `poteto-mode` is registered. Example: `$poteto-mode use how to explain the billing request path`. Leaf guides are deliberately not standalone skills, preventing name collisions and ensuring one-directory installation includes every dependency. Installation does not modify AGENTS.md or make the mode a default across sessions.

## Delegation and models

Use the live host tool schema. Desktop may expose `collaboration.spawn_agent`, `send_message`, `followup_task`, `list_agents`, `wait_agent`, and `interrupt_agent`; other Codex hosts may expose `spawn_agent`, `send_input`, `wait`, and `close_agent`. These are examples, not commands to call blindly. Match arguments to the actual callable tool. Do not pass Cursor's Task fields, role types, environment selector, readonly flag, or background flag.

Where the environment permits delegation, preserve each workflow's independent roles and coverage. Pass the role/guide file path, this runtime file, the task, scope, write ownership, and acceptance checks. Pass `roles/poteto-agent.md` to implementation delegates and the named reference prompt to reviewers. Spawn only concrete independent work; serialize dependent outputs. Read-only is a prompt constraint plus the host sandbox, not a guarantee that a magic flag removes MCP tools. Never relax permissions to make a reviewer run.

Default every role to the parent's model. If `~/.codex/pstack-models.md` exists, read its per-role choices. Treat `inherit-parent` and `auto` as omission of the model argument, not real model IDs. Validate explicit choices against the host inventory; model and reasoning effort are separate fields when supported. Never pass an upstream vendor slug or manufacture a slug by adding a reasoning suffix. A configured panel has one run per entry, including repeated entries. Respect available slots; queue the remaining roles. Same-model independent runs are not cross-model verification. Disclose that limit. If a required different model is unavailable, report the unmet diversity gate rather than treating a same-model vote as that gate.

If subagents are forbidden or unavailable, execute the workflow serially with separate recorded passes. State that independent review was unavailable. Do not label self-review independent. If independence is a required release gate, leave that gate unmet. Do not create user-visible Codex tasks as hidden substitute subagents. Use task-creation tools only on an explicit request for new tasks.

Shared checkout is the default. Assign disjoint files or create separate git worktrees for competing writers; pass their exact paths. A subagent does not implicitly get a private branch, worktree, cloud VM, extra concurrency, or persistence across app restarts. Inspect live status before reuse or retry. Resume/follow-up may start work; use status/wait tools to inspect without restarting a worker.

## Questions and authorization

Use an available question tool within its documented mode and option limits. Otherwise ask a short normal-language question. An experiment answers an observable fact; the user answers a product preference or missing authorization. Time passing never answers a required question.

Continue authorized reversible work. PRs, commits, messages, issue filing, deployment, destructive cleanup, and network exposure must stay within the actual user request and host rules. Prior authorization persists; do not ask again. "Autonomous" changes persistence, not permission. Keep unrelated findings as local follow-ups unless fixing them is necessary and in scope. Prepare a concrete reviewable result before requesting permission to publish it.

## History and durable state

Prefer the Codex app's task listing and reading tools when exposed. Match task ID, project/workspace, and requested time window before reading content. Follow pagination only as needed. Read archived tasks only when in scope. Never use Cursor transcripts as a substitute.

For local history, use an explicit rollout path or task ID supplied by the user/host, or paths returned by a scoped task lookup. Codex versions can store JSONL rollout events or paginated histories; do not assume one filesystem layout. Inspect metadata first. JSONL `session_meta` and `turn_context` identify context; `response_item` holds messages/tool calls and `event_msg` holds status. A text summary cannot prove a particular tool ran or a file was read. If the full trace is unavailable, label that evidence gap and use the visible conversation as a digest. Do not scan other projects or publish private history in this distributable bundle.

Pick an explicit durable task directory for decision logs, orchestrator state, and handoff notes; report it. The current agent does not have an assumed Cursor store path. Protect unrelated files, and keep credentials and private artifacts out of git. A prior transcript provides historical context; verify drift-prone claims against the current artifact without redoing already-proven stable work.

## Long runs and wakeups

For work that can finish now, continue in the current turn, using bounded event waits for children or shell jobs. When the user explicitly requests scheduling, monitoring, or continuing later, discover the Codex app automation tool, inspect existing matching automations, and create/update a thread heartbeat using its actual schema. Save the stop predicate, task state path, and notification intent. Stay quiet while monitored state is unchanged; notify on meaningful change, completion, failure, or required user action. Disable the monitor when its predicate is fulfilled.

No scheduler available means no durable wake promise. Finish current executable work, write a checkpoint, and report that future resumption requires the user or an external scheduler. Do not invent `/loop`, run an unbounded shell sleep loop, edit internal automation state directly, or imply a background promise after the turn ends.

## Runtime proof and optional tools

Reuse repository checks, browser/terminal tools, and the bundled control-ui/control-cli guides. Respect the particular browser tool's restrictions and available surfaces. A passing unit test is not UI proof or deployment proof. Record the command, artifact/head SHA, result, and any gap.

Core reading and routing require no runtime dependency. Python 3 is used only for installation and package checks. The original advanced PR watcher and orchestrator require Bun; their bootstrap installs pinned lockfile dependencies in the skill's scripts directory. Run those only when the workflow needs them. `gh` must be authenticated for GitHub operations. The orchestrator's stack frontier uses Graphite `gt`; check it before choosing that program workflow. If absent, use the simpler base-branch workflow with `git`/`gh`, and do not claim to have run the Graphite frontier verifier. Browser, MCP services, simulator, profiler, Tailscale, and remote execution are optional capabilities, not bundled services.

The original bot routine webhook and secret-request UI have no assumed Codex equivalent. The make-bot-ui guide requires a real documented backend; otherwise it produces a clearly labeled local mock. Never invent a service endpoint or report a mock as live integration.
