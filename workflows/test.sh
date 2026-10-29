#!/bin/sh
# Lint and test the Python in workflows/ (needs uv). The venv holds the sandbox image's
# pinned environment, so tests run against what the agent gets. vtk-osmesa has wheels only for
# linux/x86_64, so anywhere else the Python tests run in a linux/amd64 container (needs Docker).
set -eu
cd "$(dirname "$0")"
RUFF=0.17.3
# pytest and its dependencies not already in requirements.txt (packaging, pygments)
PYTEST="pytest==9.2.0 pluggy==1.7.0 iniconfig==2.3.1"
uvx --quiet ruff@$RUFF check .
if [ "$(uname -s)-$(uname -m)" != "Linux-x86_64" ]; then
  exec docker run --rm --platform linux/amd64 -v "$PWD:/w:ro" -w /tmp python:3.12-slim sh -ec "
    pip install -q --disable-pip-version-check --no-deps -r /w/core/requirements.txt $PYTEST
    python -m pytest -q -c /w/pyproject.toml --rootdir /w /w"
fi
uv venv --quiet --allow-existing --python 3.12 .venv
printf '%s\n' $PYTEST | cat core/requirements.txt - >.venv/requirements.sync.txt
uv pip sync --quiet --python .venv .venv/requirements.sync.txt
# --no-deps leaves nothing to resolve a missing transitive package; pyvista's own `vtk`
# requirement is the one expected gap.
if uv --color never pip check --python .venv 2>&1 | grep -v -e '`vtk[!<>=]' -e '^Checked' -e '^Found' | grep .; then
  exit 1
fi
.venv/bin/pytest --quiet
