---
name: setup-pstack
description: Configure optional Codex model choices for pstack roles when requested.
---

# Setup pstack

1. Read the live Codex spawn tool schema and any exposed model inventory. It is the authority for available models and reasoning settings. If no inventory is available, use `inherit-parent`; do not guess slugs or edit Codex's global model configuration.
2. Read `~/.codex/pstack-models.md` if present. This is a pstack reference read by `runtime.md`, not a native always-applied Codex rule.
3. Show current choices and ask only for missing preferences. Preserve explicitly requested choices when supported. Panels are lists; each entry represents one independent reviewer even when entries repeat.
4. Write only this pstack-owned file, preserving unrelated user notes. Use one `role: value` per line. Default single-role entries to `inherit-parent`; default panels to four `inherit-parent` entries. `auto` and `inherit-parent` mean omit the model override. Keep reasoning separate from the actual model slug and set it only when the live tool supports it.
5. Re-read the saved file and report its path. It is used the next time this bundle runs. It neither registers native custom agents nor changes every Codex conversation.
6. If useful, offer the bundled `create-verification-skill` workflow for projects without a way to drive their real app.

Roles: feature, refactoring; bug-fix; perf-issue; hillclimb; judgment and prose; hardest tasks; how explorer; how explainer; how critics (panel); why investigators; why synthesizer; reflect tooling; reflect judgment, divergent, synthesizer; arena runners (panel); arena cross-judge pool (panel); swarm workers; architect runners (panel); interrogate reviewers (panel).
