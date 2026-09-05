#!/usr/bin/env python3
"""Install the self-contained skill without replacing an existing installation."""
import argparse
import os
from pathlib import Path
import shutil


def install(destination):
    source = Path(__file__).resolve().parent / 'skills' / 'poteto-mode'
    target = destination.expanduser().resolve() / 'poteto-mode'
    if target.exists() or target.is_symlink():
        raise FileExistsError(f'Installation exists; preserve or remove it explicitly before updating: {target}')
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(source, target, ignore=shutil.ignore_patterns('node_modules', '__pycache__', '*.pyc'))
    return target


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dest', type=Path, default=Path(os.environ.get('CODEX_HOME', str(Path.home()/'.codex')))/'skills', help='Skill parent directory; use .agents/skills for project scope')
    args = parser.parse_args()
    try:
        target = install(args.dest)
    except FileExistsError as error:
        parser.exit(1, str(error)+'\n')
    print(f'Installed {target}\nInvoke $poteto-mode with a task on the next turn. If your host caches discovery, reopen the session.')
