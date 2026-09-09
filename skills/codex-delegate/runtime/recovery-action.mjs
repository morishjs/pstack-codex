const actions = new Set(['test-login', 'install-browser', 'start-local-server', 'repair-local-api', 'run-verification', 'account-change', 'remote-data-write', 'delete-data', 'unknown']);

export function assessRecovery(state, action) {
  if (!action || !actions.has(action.kind) || typeof action.inScope !== 'boolean') throw new Error('recovery action needs a known kind and inScope');
  if (state.status === 'paused' || state.phase === 'paused') return { decision: 'paused', reason: 'Respect the explicit pause; do not recover or resume automatically.' };
  const needs = reason => ({ decision: 'needs-user', reason });
  if (!action.inScope) return needs('Action is outside the authorized task.');
  if (['account-change', 'remote-data-write', 'delete-data', 'unknown'].includes(action.kind)) {
    return needs('Local UI location does not authorize this underlying effect; require exact action authorization or choose an authorized alternative.');
  }
  if (action.kind === 'test-login') {
    if (action.existingTestAccount !== true || !['local', 'dev', 'test'].includes(action.environment)) return needs('No confirmed existing test-account login scope.');
    return { decision: 'continue', reason: 'Use the existing approved test login and continue verification; do not create, reset, or change the account.' };
  }
  if (!state.grants?.includes('local-workspace') && state.authority !== 'local-workspace') return needs('Local modification is not included in the current task grant.');
  if (action.environment !== 'local') return needs('This recovery action is not confined to the local environment.');
  return { decision: 'continue', reason: 'Perform the scoped reversible local recovery and rerun verification without asking again.' };
}

export const recoveryInstructions = `Before asking permission or stopping for a verification obstacle, classify the actual effect with recovery --run ABS --action-file ABS. Existing approved test-account login for the requested UI, installing the project-matching browser, starting the current worktree server, scoped local API repair and rerunning tests are continuation actions within existing scope. Execute them; do not merely propose them. Localhost is not proof of a local effect: account creation/password changes, remote data writes and deletion are separate. Do not classify ordinary login as account-change. Never stop at the login page when the task requires authenticated UI proof. If API readiness fails, recover it before claiming that login alone will unblock verification. A continue decision is not completion evidence; perform the actual tools and retain their results.`;
