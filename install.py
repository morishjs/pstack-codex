#!/usr/bin/env python3
"""Install the self-contained skill without replacing an existing installation."""
import argparse
import os
from pathlib import Path
import shutil


SKILLS = ('poteto-mode', 'codex-delegate')


def install(destination, skill='poteto-mode'):
    if skill not in SKILLS:
        raise ValueError(f'Unknown skill: {skill}')
    source = Path(__file__).resolve().parent / 'skills' / skill
    target = destination.expanduser().resolve() / skill
    if target.exists() or target.is_symlink():
        raise FileExistsError(f'Installation exists; preserve or remove it explicitly before updating: {target}')
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(source, target, ignore=shutil.ignore_patterns('node_modules', '__pycache__', '*.pyc'))
    return target


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dest', type=Path, default=Path(os.environ.get('CODEX_HOME', str(Path.home()/'.codex')))/'skills', help='Skill parent directory; use .agents/skills for project scope')
    parser.add_argument('--skill', choices=SKILLS, default='poteto-mode', help='Skill to install')
    args = parser.parse_args()
    try:
        target = install(args.dest, args.skill)
    except FileExistsError as error:
        parser.exit(1, str(error)+'\n')
    print(f'Installed {target}\nInvoke ${args.skill} with a task on the next turn. If your host caches discovery, reopen the session.')
