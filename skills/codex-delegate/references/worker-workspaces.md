# Reuse worker workspaces

Create worker checkouts on demand. This helper prepares and reuses a checkout; the [dependency queue](dependency-queue.md) schedules up to two active lanes and preserves per-task worktrees across repairs.

```sh
node ~/.codex/skills/codex-delegate/runtime/worker-workspace.mjs \
  --source /absolute/repository --worker task-api \
  --ref COMMIT --probe-module typescript
```

Use the returned `workspace` in `orchestrator.mjs start`. Choose a root dependency actually declared by the project for the resolution probe. The helper checks out committed input only. Preserve uncommitted source changes separately when they are required task input.

Reuse the same worker ID and base commit for repairs. Each checkout keeps its own node_modules and unfinished edits. The helper never resets or deletes a checkout. Another base needs another worker ID; integration of predecessor changes remains the coordinator's responsibility.

Preparation hashes package manifests, pnpm lock/workspace/config files, patches, effective pnpm config, store location, and runtime versions. A matching successful installation and working module-resolution probe skip installation. Changed inputs or a missing dependency trigger a frozen offline install. Only missing offline package errors permit a prefer-offline retry; other failures remain failures. pnpm's configured shared store is reused without symlinking whole node_modules directories.

Installation scripts follow the project's existing pnpm policy. Build and code generation remain separate verification steps. Preparation refuses an active nested runner lock and concurrent preparation for the same worker. A crash leaves its preparation lock for inspection. Coordinate checkout use serially per worker; this helper is not a scheduler or a cross-process lease for arbitrary editors.

Read-only investigation reads the source checkout directly. Do not prepare a worker or install dependencies merely to read files.
