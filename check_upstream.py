#!/usr/bin/env python3
"""Compare a local cursor/plugins checkout with the pinned upstream manifest."""
import argparse
import hashlib
import json
from pathlib import Path


def compare(source, manifest):
    expected = {entry['source']: entry['sha256'] for entry in manifest['files']}
    actual = set(expected)
    for scope in manifest['scope']:
        actual.update(str(p.relative_to(source)) for p in (source/scope).rglob('*') if p.is_file())
    changes = []
    for name in sorted(actual):
        path = source/name
        if not path.is_file():
            changes.append(('removed', name))
        elif name not in expected:
            changes.append(('added', name))
        elif hashlib.sha256(path.read_bytes()).hexdigest() != expected[name]:
            changes.append(('changed', name))
    return changes


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path, help='Local checkout of https://github.com/cursor/plugins')
    args = parser.parse_args()
    manifest = json.loads((Path(__file__).parent/'UPSTREAM.json').read_text())
    changes = compare(args.source, manifest)
    print(f"Pinned upstream: {manifest['commit']}")
    for status, path in changes:
        print(f'{status}: {path}')
    if not changes:
        print('All scoped upstream files match.')
    raise SystemExit(bool(changes))
