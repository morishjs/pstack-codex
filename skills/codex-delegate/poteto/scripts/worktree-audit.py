#!/usr/bin/env python3
"""Read-only audit. Agent liveness and scoped task history require a separate host check."""
import json
from pathlib import Path
import subprocess
import sys
import time


def run(*args):
    result = subprocess.run(args, text=True, capture_output=True)
    return result.stdout.strip() if result.returncode == 0 else None


def audit(repo):
    listing = run('git', '-C', str(repo), 'worktree', 'list', '--porcelain')
    if listing is None:
        raise SystemExit('Cannot list worktrees; pass a git repository path.')
    base = run('git', '-C', str(repo), 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD')
    if not base:
        base = next((ref for ref in ('origin/main', 'origin/master', 'main', 'master')
                     if run('git', '-C', str(repo), 'rev-parse', '--verify', ref)), None)
    try:
        prs = json.loads(run('gh', 'pr', 'list', '--repo',
                            run('git', '-C', str(repo), 'remote', 'get-url', 'origin') or '.',
                            '--author', '@me', '--state', 'all', '--limit', '1000',
                            '--json', 'number,state,headRefName') or '[]')
    except (FileNotFoundError, json.JSONDecodeError):
        prs = []
    print('SIZE_KB\tAGE_DAYS\tMERGED_LOCAL_BASE\tDIRTY\tREMOTE\tPR\tLAST_CHAT\tBUCKET\tWORKTREE')
    for block in listing.split('\n\n'):
        fields = dict(line.split(' ', 1) for line in block.splitlines() if ' ' in line)
        if 'worktree' not in fields:
            continue
        wt = fields['worktree']
        status = run('git', '-C', wt, 'status', '--porcelain')
        head = fields.get('HEAD')
        branch = fields.get('branch', '').removeprefix('refs/heads/')
        upstream = run('git', '-C', wt, 'rev-parse', '--verify', '@{upstream}')
        merged = 'unknown'
        if base and head:
            probe = subprocess.run(['git', '-C', wt, 'merge-base', '--is-ancestor', head, base], capture_output=True)
            merged = {0: 'yes', 1: 'no'}.get(probe.returncode, 'unknown')
        pr = next((f"#{p['number']}/{p['state']}" for p in prs if p['headRefName'] == branch), '-')
        dirty = 'unknown' if status is None else 'dirty' if status else 'clean'
        bucket = 'hold-dirty' if dirty != 'clean' else 'hold-open-pr' if pr.endswith('/OPEN') else 'review-history-and-owner'
        size = (run('du', '-sk', wt) or '?').split()[0]
        timestamp = run('git', '-C', wt, 'log', '-1', '--format=%ct')
        age = str(int((time.time() - int(timestamp)) / 86400)) if timestamp else '?'
        remote = 'pushed' if upstream == head else 'differs' if upstream else 'unknown'
        print('\t'.join((size, age, merged, dirty, remote, pr, 'not-checked', bucket, wt)))


if __name__ == '__main__':
    audit(Path(sys.argv[1]) if len(sys.argv) > 1 else Path.cwd())
