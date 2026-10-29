# The sandbox image every run uses, ours and visitors': the analysis packages the
# prompts promise. CI builds it (.github/workflows/sandbox-image.yml) and pushes it to
# ghcr.io/voluma-bio/voluma-sandbox; the runner pins the digest in src/config.ts.
# The packages are workflows/core/requirements.txt, passed as the build context
# `reqs` (docker build --build-context reqs=workflows/core apps/runner/sandbox). `voluma-sam`
# (packages/voluma-sam) is the bundle `pnpm --filter @voluma/sam build` writes, passed as the
# build context `sam` (--build-context sam=packages/voluma-sam/dist); it runs on the Node and
# ffmpeg installed here.
# Bump the base, Node or a package, change voluma-sam, run the workflow, then update that digest.
FROM python:3.12-slim@sha256:aa943ce411423c7582288f18707ff66eddcbaeb510502d747a72aeb34f30d159
# --no-deps: the file pins every transitive package, and pyvista's own vtk dependency would
# replace the headless vtk-osmesa (see the file's header).
RUN --mount=from=reqs,target=/reqs pip install --no-cache-dir --no-deps -r /reqs/requirements.txt
# ffmpeg and Node 24 are for `voluma-sam`, which segment_sam runs in the sandbox.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*
COPY --from=node:24-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c /usr/local/bin/node /usr/local/bin/node
COPY --from=sam voluma-sam.mjs /usr/local/lib/voluma-sam.mjs
RUN printf '#!/bin/sh\nexec node /usr/local/lib/voluma-sam.mjs "$@"\n' > /usr/local/bin/voluma-sam \
    && chmod +x /usr/local/bin/voluma-sam
