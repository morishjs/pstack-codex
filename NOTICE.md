# Attribution

This unofficial Codex adaptation derives from Lauren Tan's pstack in [cursor/plugins](https://github.com/cursor/plugins/tree/main/pstack), pinned at commit `93b00b89ef425a9c1bac0d0b317dfc49c930ac99`.

All files under `pstack/skills` and `pstack/agents` at that commit have destination entries in `UPSTREAM.json`. MIT copyright 2026 Lauren Tan is retained in the repository and installed bundle.

The `deslop`, `control-cli`, and `control-ui` guides derive from the same repository's `cursor-team-kit/skills` directory. Their MIT copyright 2026 Cursor notice is retained in `skills/poteto-mode/LICENSE.cursor-team-kit`.

Changes include Codex runtime routing, bundled reference packaging, host-aware model and agent selection, history and scheduler adaptation, permission boundaries, installation and validation tools, plan checker adaptation, and a read-only worktree audit that does not assume Cursor transcript storage.

The [FetchUpstream/pstack-plugin](https://github.com/FetchUpstream/pstack-plugin) repository was inspected for comparison. Its README describes a curated ChatGPT Web subset, not a full Codex execution port. Its files were not used as the source of this package.

Flavio Copes's [A deep dive into pstack](https://flaviocopes.com/pstack/) was consulted as an overview. No article text is bundled. The upstream repository, not the blog, is the authoritative source for this port.
