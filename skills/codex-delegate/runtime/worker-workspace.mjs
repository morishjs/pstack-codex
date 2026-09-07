import * as fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const command = (cwd, executable, args) => execFileSync(executable, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 }).trim();
const git = (cwd, ...args) => command(cwd, 'git', args);
const digest = value => createHash('sha256').update(value).digest('hex');
function save(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, file);
}
export function dependencyKey(workspace, versions) {
  const inputs = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['.git', '.codex-delegate', 'node_modules', 'dist', 'build', '.next', '.turbo', '.cache', 'coverage'].includes(entry.name)) continue;
      const file = path.join(dir, entry.name), relative = path.relative(workspace, file);
      if (entry.isDirectory()) walk(file);
      else if (['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc', '.pnpmfile.cjs', 'pnpmfile.cjs'].includes(entry.name) || entry.name.endsWith('.patch')) {
        inputs.push([relative, digest(fs.readFileSync(file))]);
      }
    }
  }
  walk(workspace);
  return digest(JSON.stringify({ versions, inputs: inputs.sort(([a], [b]) => a.localeCompare(b)) }));
}

// A worker is reused within one task. Different baselines get different worker IDs.
export function prepareWorker({ source, worker, ref = 'HEAD', probeModule, run = command }) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(worker ?? '')) throw new Error('worker must be a simple identifier');
  if (!probeModule || probeModule.startsWith('.') || path.isAbsolute(probeModule)) throw new Error('probe-module must name an installed root dependency');
  source = fs.realpathSync(source);
  const base = git(source, 'rev-parse', '--verify', `${ref}^{commit}`);
  const root = path.join(source, '.codex-delegate');
  fs.mkdirSync(root, { recursive: true });
  const ignore = path.join(root, '.gitignore');
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n');
  const directory = path.join(root, 'workers', worker);
  fs.mkdirSync(directory, { recursive: true });
  const lock = path.join(directory, 'prepare.lock');
  try { fs.mkdirSync(lock); } catch (error) { if (error.code === 'EEXIST') throw new Error('worker preparation already locked; inspect owner before recovery'); throw error; }
  try {
    save(path.join(lock, 'owner.json'), { pid: process.pid });
    const manifest = path.join(directory, 'worker.json'), workspace = path.join(directory, 'workspace');
    let state;
    if (fs.existsSync(manifest)) {
      state = JSON.parse(fs.readFileSync(manifest));
      if (state.source !== source || state.base !== base || state.workspace !== workspace) throw new Error('worker baseline mismatch; preserve this worker and select a new ID');
      if (git(workspace, 'rev-parse', '--show-toplevel') !== workspace) throw new Error('worker checkout missing');
    } else {
      if (fs.existsSync(workspace)) throw new Error('unregistered worker checkout; inspect before recovery');
      git(source, 'worktree', 'add', '--detach', workspace, base);
      state = { source, workspace, base };
      save(manifest, state);
    }
    if (fs.existsSync(path.join(workspace, '.codex-delegate', 'lock'))) throw new Error('worker run is active; preparation refused');
    const modules = path.join(workspace, 'node_modules');
    if (fs.existsSync(modules) && fs.lstatSync(modules).isSymbolicLink()) throw new Error('shared node_modules symlink is not supported');
    const versions = { node: process.version, platform: process.platform, arch: process.arch, pnpm: run(workspace, 'pnpm', ['--version']), store: run(workspace, 'pnpm', ['store', 'path']), userConfig: run(workspace, 'pnpm', ['config', 'list', '--json']) };
    const key = dependencyKey(workspace, versions);
    const probe = () => run(workspace, process.execPath, ['-e', 'require.resolve(process.argv[1])', probeModule]);
    let reused = false;
    if (state.dependencyKey === key && state.probeModule === probeModule && fs.existsSync(modules)) {
      try { probe(); reused = true; } catch {}
    }
    if (!reused) {
      delete state.dependencyKey;
      save(manifest, state);
      try { run(workspace, 'pnpm', ['install', '--offline', '--frozen-lockfile']); }
      catch (error) {
        const output = `${error.stdout ?? ''}\n${error.stderr ?? ''}`;
        if (!/ERR_PNPM_(NO_OFFLINE_META|NO_OFFLINE_TARBALL|MISSING_PACKAGE)/.test(output)) throw error;
        run(workspace, 'pnpm', ['install', '--prefer-offline', '--frozen-lockfile']);
      }
      probe();
      if (dependencyKey(workspace, versions) !== key) throw new Error('dependency inputs changed during installation');
      Object.assign(state, { dependencyKey: key, probeModule });
      save(manifest, state);
    }
    return { workspace, reusedDependencies: reused, base };
  } finally { fs.rmSync(lock, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), allowed = new Set(['--source', '--worker', '--ref', '--probe-module']), values = {};
    for (let index = 0; index < args.length; index += 2) {
      if (!allowed.has(args[index]) || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error('use --source PATH --worker ID --probe-module NAME [--ref REF]');
      values[args[index]] = args[index + 1];
    }
    console.log(JSON.stringify(prepareWorker({ source: values['--source'], worker: values['--worker'], ref: values['--ref'], probeModule: values['--probe-module'] })));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
