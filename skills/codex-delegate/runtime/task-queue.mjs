import path from 'node:path';

/** Validate the whole plan before any execution; return dependency-first tasks. */
export function validatePlan(tasks) {
  if (!Array.isArray(tasks)) throw new Error('tasks must be an array');
  const byId = new Map();
  const owners = [];
  for (const task of tasks) {
    if (!task || typeof task.id !== 'string' || !task.id.trim()) throw new Error('Task id is required');
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(task.id) || Object.hasOwn(Object.prototype, task.id)) {
      throw new Error(`Unsafe task id: ${task.id}`);
    }
    if (byId.has(task.id)) throw new Error(`Duplicate task id: ${task.id}`);
    byId.set(task.id, task);
    if (!Array.isArray(task.dependsOn ?? [])) throw new Error(`Invalid dependsOn: ${task.id}`);
    if (new Set(task.dependsOn ?? []).size !== (task.dependsOn ?? []).length) {
      throw new Error(`Duplicate dependency: ${task.id}`);
    }
    if (!Array.isArray(task.owns ?? [])) throw new Error(`Invalid owns: ${task.id}`);
    for (const owned of task.owns ?? []) {
      if (typeof owned !== 'string' || !owned.trim()) throw new Error(`Invalid ownership: ${task.id}`);
      const literal = owned.replace(/\/\*\*$/, '');
      if (/[\*?\[\]{}\\]/.test(literal) || path.posix.isAbsolute(owned) || literal.split('/').includes('..')) {
        throw new Error(`Unsupported ownership path: ${owned}`);
      }
      const normalized = path.posix.normalize(literal).replace(/\/$/, '');
      for (const owner of owners) {
        if (owner.id !== task.id && (normalized === '.' || owner.path === '.' || normalized === owner.path ||
          normalized.startsWith(`${owner.path}/`) || owner.path.startsWith(`${normalized}/`))) {
          throw new Error(`Overlapping ownership: ${owner.id} and ${task.id}`);
        }
      }
      owners.push({ id: task.id, path: normalized });
    }
  }
  const visiting = new Set();
  const visited = new Set();
  const ordered = [];
  function visit(id) {
    if (!byId.has(id)) throw new Error(`Missing dependency: ${id}`);
    if (visiting.has(id)) throw new Error(`Dependency cycle: ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    const task = byId.get(id);
    for (const dependency of task.dependsOn ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
    ordered.push(task);
  }
  for (const task of tasks) visit(task.id);
  return ordered;
}

/** The coordinator owns persistence through awaited onUpdate snapshots. */
export async function runQueue({ tasks, concurrency = 2, previous = {}, execute, validateCached = async () => false, onUpdate = async () => {} }) {
  const ordered = validatePlan(tasks);
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('concurrency must be a positive integer');
  if (typeof execute !== 'function') throw new Error('execute must be a function');
  const states = Object.fromEntries(tasks.map(({ id }) => [id, { status: 'pending' }]));
  const update = async event => onUpdate(structuredClone(states), event);
  // Validate ancestors first: a stale ancestor invalidates every descendant.
  for (const task of ordered) {
    const cached = Object.hasOwn(previous, task.id) ? previous[task.id] : undefined;
    if (cached?.status === 'passed' && (task.dependsOn ?? []).every(id => states[id].status === 'passed') &&
      await validateCached(task, cached)) {
      states[task.id] = { ...cached };
    }
  }
  await update({ status: 'initialized' });
  const active = new Map();
  while (Object.values(states).some(state => state.status === 'pending') || active.size) {
    for (const task of ordered) {
      if (states[task.id].status !== 'pending') continue;
      const dependencies = task.dependsOn ?? [];
      if (dependencies.some(id => ['failed', 'blocked'].includes(states[id].status))) {
        states[task.id] = { status: 'blocked', error: 'Dependency failed' };
        await update({ taskId: task.id, status: 'blocked' });
        continue;
      }
      if (active.size >= concurrency || !dependencies.every(id => states[id].status === 'passed')) continue;
      let slot = 1;
      while (active.has(`worker-${slot}`)) slot++;
      const worker = `worker-${slot}`;
      states[task.id] = { status: 'running', worker };
      await update({ taskId: task.id, status: 'running', worker });
      const context = { worker, dependencies: Object.fromEntries(dependencies.map(id => [id, states[id].result])) };
      active.set(worker, Promise.resolve().then(() => execute(task, context)).then(
        result => ({ id: task.id, worker, state: { status: ['failed', 'blocked'].includes(result?.status) ? result.status : 'passed', worker, result } }),
        error => ({ id: task.id, worker, state: { status: 'failed', worker, error: String(error?.message ?? error) } }),
      ));
    }
    if (active.size) {
      const { id, worker, state } = await Promise.race(active.values());
      states[id] = state;
      await update({ taskId: id, status: state.status, worker });
      active.delete(worker);
    }
  }
  return states;
}
