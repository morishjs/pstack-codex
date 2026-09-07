import { createMachine, transition as step } from "xstate";

export const delegateMachine = createMachine({
  id: "codex-delegate",
  initial: "authoring",
  states: {
    authoring: { on: { AUTHOR_OK: "baseline", BLOCK: "blocked" } },
    baseline: { on: { BASELINE_OK: "implementing", BASELINE_SATISFIED: "verifying", BLOCK: "blocked" } },
    implementing: { on: { IMPLEMENTED: "verifying", BLOCK: "blocked" } },
    verifying: {
      on: { VERIFIED: "reviewing", REPAIR: "implementing", BLOCK: "blocked" },
    },
    reviewing: {
      on: {
        PASS: "complete",
        REPAIR: "implementing",
        REVISE_CONTRACT: "blocked",
        BLOCK: "blocked",
      },
    },
    blocked: {
      on: {
        RETRY_AUTHOR: "authoring",
        RETRY_BASELINE: "baseline",
        RETRY_IMPLEMENT: "implementing",
        RETRY_VERIFY: "verifying",
        RETRY_REVIEW: "reviewing",
      },
    },
    complete: { type: "final" },
  },
});

export function transition(value, type) {
  const snapshot = delegateMachine.resolveState({ value, context: {} });
  const [next] = step(delegateMachine, snapshot, { type });
  if (next.value === value)
    throw new Error(`invalid transition ${value} --${type}`);
  return next.value;
}
