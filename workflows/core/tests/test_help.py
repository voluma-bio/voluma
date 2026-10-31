"""Every resource script's `--help` is its contract: it runs, and no option lacks help text.

The planned tool index in the agent's prompt is the first docstring line of each script, so that line must be there and short.
Options are checked on the parser the script builds, captured at the `parse_args` call when the script runs as `__main__`, not on
the printed text: a missing help string is then a fact, not a layout guess.
"""
import argparse
import ast
import os
import runpy
import subprocess
import sys
from pathlib import Path

import pytest
from sidecar import existing as sidecar_existing

ROOT = Path(__file__).resolve().parents[2]  # workflows/
RESOURCES = sorted(ROOT.glob('*/skills/*/resources'))  # core and each workflow


def env_of(script):
    """What a run of the script's workflow sets (runLayout): core's resources/ and the workflow's own."""
    workflow = script.relative_to(ROOT).parts[0]
    dirs = [d for d in RESOURCES if d.relative_to(ROOT).parts[0] in ('core', workflow)]
    return {**os.environ, 'PYTHONPATH': os.pathsep.join(map(str, dirs))}


# Libraries have no CLI; sidecar.py has one and is checked with the other scripts.
LIBRARIES = {'frame.py', 'viewlib.py', 'envelope.py', 'annotations.py', 'objects.py'}
# Every other resources/*.py is a script: a new file is checked without anyone listing it.
SCRIPTS = sorted(
    p for d in RESOURCES for p in d.glob('*.py') if not p.name.startswith('test_') and p.name not in LIBRARIES
)
INDEX_LINE_MAX = 110


def ids(paths):
    return [str(p.relative_to(ROOT)) for p in paths]


@pytest.mark.parametrize('script', SCRIPTS, ids=ids(SCRIPTS))
def test_help_exits_0(script):
    r = subprocess.run([sys.executable, str(script), '--help'], check=False, capture_output=True, text=True, timeout=120, cwd='/', env=env_of(script))
    assert r.returncode == 0, r.stderr
    assert r.stdout.startswith('usage:')


@pytest.mark.parametrize('script', SCRIPTS, ids=ids(SCRIPTS))
def test_index_line(script):
    doc = ast.get_docstring(ast.parse(script.read_text())) or ''
    first = doc.split('\n')[0]
    assert first, 'the first docstring line is the tool index entry: a sentence saying what the script does'
    assert len(first) <= INDEX_LINE_MAX, f'index line is {len(first)} characters, over {INDEX_LINE_MAX}'


class _Captured(Exception):
    pass


def build_parser(script, monkeypatch):
    """The script's parser: run it as __main__ up to its parse_args call and keep the parser."""

    def capture(self, *args, **kwargs):
        raise _Captured(self)

    monkeypatch.setattr(argparse.ArgumentParser, 'parse_args', capture)
    monkeypatch.setattr(sys, 'argv', [str(script)])
    with pytest.raises(_Captured) as e:
        runpy.run_path(str(script), run_name='__main__')
    return e.value.args[0]


def first_input(parser, argv=()):
    """(argv prefix, flag) of an argument that names an input file: the first one the parser, or a subcommand's, declares."""
    for action in parser._actions:
        if isinstance(action, argparse._SubParsersAction):
            for name, sub in action.choices.items():
                found = first_input(sub, (*argv, name))
                if found:
                    return found
        # runpy defines sidecar.py's own `existing` again when checking its CLI.
        elif (action.type is sidecar_existing or (
            getattr(action.type, '__module__', None) == '__main__'
            and getattr(action.type, '__name__', None) == 'existing'
        )) and action.option_strings:
            return argv, action.option_strings[0]
    return None


def undocumented(parser, prefix=''):
    for action in parser._actions:
        if isinstance(action, argparse._SubParsersAction):
            for name, sub in action.choices.items():
                yield from undocumented(sub, f'{prefix}{name} ')
        elif not action.help or action.help == argparse.SUPPRESS:
            yield prefix + '/'.join(action.option_strings or [action.dest])


@pytest.mark.parametrize('script', SCRIPTS, ids=ids(SCRIPTS))
def test_every_option_has_help(script, monkeypatch):
    assert not list(undocumented(build_parser(script, monkeypatch)))


@pytest.mark.parametrize('script', SCRIPTS, ids=ids(SCRIPTS))
def test_docstring_is_the_help(script, monkeypatch):
    """The parser prints the whole docstring, and the docstring has the contract's lines."""
    doc = ast.get_docstring(ast.parse(script.read_text()), clean=False)
    parser = build_parser(script, monkeypatch)
    assert parser.description == doc, 'build the parser with sidecar.parser(__doc__)'
    for line in ('Writes:', 'Prints:', 'Example:'):
        assert f'\n{line}' in doc, f'the docstring has no {line} line (a script that writes nothing says "Writes: nothing")'


@pytest.mark.parametrize('script', SCRIPTS, ids=ids(SCRIPTS))
def test_missing_input_is_one_sentence(script, monkeypatch, tmp_path):
    """A path argument that must exist is refused right after parsing: exit 2, one stderr line naming the flag and path."""
    found = first_input(build_parser(script, monkeypatch), ())
    assert found, 'no argument declares type=sidecar.existing: an input path is checked by the parser'
    prefix, flag = found
    missing = str(tmp_path / 'missing.npy')
    r = subprocess.run([sys.executable, str(script), *prefix, flag, missing], check=False, capture_output=True, text=True, timeout=120, cwd='/', env=env_of(script))
    assert r.returncode == 2, r.stderr
    assert r.stdout == '' and len(r.stderr.strip().splitlines()) == 1, r.stderr
    assert flag in r.stderr and missing in r.stderr
