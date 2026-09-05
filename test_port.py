#!/usr/bin/env python3
"""Offline regression checks for packaging, installation, and ported helpers."""
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tempfile

from check_upstream import compare
from install import install

ROOT = Path(__file__).resolve().parent
BUNDLE = ROOT/'skills/poteto-mode'


def run(*args, cwd=None):
    return subprocess.run(args, cwd=cwd, capture_output=True, text=True)


def main():
    manifest = json.loads((ROOT/'UPSTREAM.json').read_text())
    assert len({e['source'] for e in manifest['files']}) == len(manifest['files'])
    assert all((ROOT/e['target']).is_file() for e in manifest['files'])
    assert list(BUNDLE.glob('**/SKILL.md')) == [BUNDLE/'SKILL.md']
    for path in BUNDLE.rglob('*.md'):
        if 'node_modules' in path.parts:
            continue
        for link in re.findall(r'\]\(([^)]+)\)', path.read_text()):
            target = link.split('#')[0]
            if target and target != 'url' and not re.match(r'https?://|mailto:', target) and '<' not in target:
                assert (path.parent/target).exists(), (path, link)

    with tempfile.TemporaryDirectory(prefix='pstack port ') as temporary:
        tmp = Path(temporary).resolve()
        target = install(tmp/'installed skills')
        assert (target/'runtime.md').is_file()
        assert not list(target.rglob('node_modules'))
        for entry in manifest['files']:
            relative = Path(entry['target']).relative_to('skills/poteto-mode')
            assert (target/relative).read_bytes() == (BUNDLE/relative).read_bytes()
        sentinel = target/'local-notes.txt'
        sentinel.write_text('keep user edits')
        try:
            install(target.parent)
        except FileExistsError:
            pass
        else:
            raise AssertionError('Existing skill must not be overwritten')
        assert sentinel.read_text() == 'keep user edits'

        source = tmp/'upstream'
        source.mkdir()
        (source/'one.md').write_text('original')
        fixture = {'scope': ['.'], 'files': [{'source': 'one.md', 'sha256': hashlib.sha256(b'original').hexdigest()}]}
        assert compare(source, fixture) == []
        (source/'one.md').write_text('edited')
        (source/'two.md').write_text('new')
        assert compare(source, fixture) == [('changed', 'one.md'), ('added', 'two.md')]
        (source/'one.md').unlink()
        assert compare(source, fixture)[0] == ('removed', 'one.md')

        log = tmp/'decisions.tsv'
        result = run('bash', str(target/'library/show-me-your-work/scripts/log.sh'), str(log), '=x', 'one\ntwo', 'why', 'proof', 'passed')
        assert result.returncode == 0, result.stderr
        rows = log.read_text().splitlines()
        assert len(rows) == 2 and len(rows[1].split('\t')) == 6
        assert rows[1].split('\t')[1:3] == ["'=x", 'one two']

        repository = tmp/'repository with spaces'
        repository.mkdir()
        assert run('git', 'init', '-b', 'main', str(repository)).returncode == 0
        (repository/'file.txt').write_text('baseline')
        assert run('git', 'add', '.', cwd=repository).returncode == 0
        assert run('git', '-c', 'user.name=Port Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture', cwd=repository).returncode == 0
        (repository/'file.txt').write_text('uncommitted')
        result = run('bash', str(target/'scripts/worktree-audit.sh'), str(repository))
        assert result.returncode == 0, result.stderr
        assert '\thold-dirty\t'+str(repository) in result.stdout, result.stdout
        assert (repository/'file.txt').read_text() == 'uncommitted'
        assert not (repository/'.cursor').exists()

        template = (target/'playbooks/multi-phase-plan.md').read_text().split('````markdown\n', 1)[1].split('````', 1)[0]
        plan = tmp/'plan.md'
        plan.write_text(template)
        check = str(target/'scripts/check-plan.mjs')
        result = run('node', check, str(plan))
        assert result.returncode == 0, result.stdout+result.stderr
        plan.write_text(re.sub(r'^- \[ \] Lane 10\..*\n', '', template, flags=re.M))
        result = run('node', check, str(plan))
        assert result.returncode == 1 and 'expected 1 to 10' in result.stderr
    print('PASS: source coverage, reference links, isolated install, overwrite refusal, upstream drift, decision log, dirty worktree, plan positive/negative checks')


if __name__ == '__main__':
    main()
