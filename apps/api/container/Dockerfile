# Run sandbox image: the SDK's shim, s3fs for the R2 mounts, and the Python
# stack the micro-CT skills use. Keep the donor tag equal to the installed
# @cloudflare/sandbox version.
ARG SANDBOX_TOOLS_IMAGE=docker.io/cloudflare/sandbox:1.0.3
ARG UBUNTU_IMAGE=ubuntu:24.04

FROM ${SANDBOX_TOOLS_IMAGE} AS sandbox-tools

FROM ${UBUNTU_IMAGE}

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install --yes --no-install-recommends \
        ca-certificates fuse3 s3fs python3 python3-venv python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Commands run with an explicit PATH that puts /opt/venv/bin first (see run-sandbox.ts).
RUN python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir \
        numpy scipy scikit-image pydicom nibabel SimpleITK

COPY --from=sandbox-tools /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
CMD ["sleep", "infinity"]
