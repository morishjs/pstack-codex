#!/usr/bin/env python3
"""Bundle the complete tracked Poteto port, or verify its source correspondence."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / 'skills/poteto-mode'
TARGET = ROOT / 'skills/codex-delegate'
MANIFEST = TARGET / 'poteto-manifest.json'


def entries():
    files = subprocess.check_output(['git', 'ls-files', '-z', 'skills/poteto-mode'], cwd=ROOT).decode().split('\0')
    result = []
    for file in sorted(filter(None, files)):
        relative = (ROOT / file).relative_to(SOURCE)
        destination = Path('poteto') / ('GUIDE.md' if str(relative) == 'SKILL.md' else relative)
        result.append({'source': file, 'target': str(destination), 'sha256': hashlib.sha256((ROOT/file).read_bytes()).hexdigest()})
    return result


def verify():
    expected = entries()
    assert json.loads(MANIFEST.read_text()) == {'version': 1, 'files': expected}, 'Poteto source manifest drift'
    for entry in expected:
        assert hashlib.sha256((TARGET/entry['target']).read_bytes()).hexdigest() == entry['sha256'], entry['target']
    assert not list((TARGET/'poteto').rglob('SKILL.md')), 'Nested skill registration is not allowed'


def sync():
    files = entries()
    for entry in files:
        target = TARGET/entry['target']
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT/entry['source'], target)
    MANIFEST.write_text(json.dumps({'version': 1, 'files': files}, indent=2)+'\n')
    verify()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    verify() if args.check else sync()
    print('PASS: complete Poteto source correspondence')
