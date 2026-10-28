# The sandbox image every run uses, ours and visitors': the analysis packages the
# prompts promise. CI builds it (.github/workflows/sandbox-image.yml) and pushes it to
# ghcr.io/voluma-bio/voluma-sandbox; the runner pins the digest in src/config.ts.
# The packages are workflows/microct-analysis/requirements.txt, passed as the build context
# `reqs` (docker build --build-context reqs=workflows/microct-analysis apps/runner/sandbox).
# Bump the base or a package, run the workflow, then update that digest.
FROM python:3.12-slim@sha256:aa943ce411423c7582288f18707ff66eddcbaeb510502d747a72aeb34f30d159
# --no-deps: the file pins every transitive package, and pyvista's own vtk dependency would
# replace the headless vtk-osmesa (see the file's header).
RUN --mount=from=reqs,target=/reqs pip install --no-cache-dir --no-deps -r /reqs/requirements.txt
