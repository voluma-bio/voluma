#!/bin/sh
# Lint and test the Python in workflows/ (needs uv). The venv holds the sandbox image's
# pinned environment, so tests run against what the agent gets.
set -eu
cd "$(dirname "$0")"
uvx --quiet ruff check .
uv venv --quiet --allow-existing --python 3.12 .venv
uv pip install --quiet --python .venv --no-deps -r microct-analysis/requirements.txt
uv pip install --quiet --python .venv pytest
.venv/bin/pytest --quiet
