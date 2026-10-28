# The sandbox image every run uses, ours and visitors': the analysis packages the
# prompts promise. CI builds it (.github/workflows/sandbox-image.yml) and pushes it to
# ghcr.io/voluma-bio/voluma-sandbox; the runner pins the digest in src/config.ts.
# Bump the base or a package here, run the workflow, then update that digest.
FROM python:3.12-slim@sha256:aa943ce411423c7582288f18707ff66eddcbaeb510502d747a72aeb34f30d159
RUN pip install --no-cache-dir numpy==2.5.4 scipy==1.18.1 scikit-image==0.26.0 pydicom==3.0.2 nibabel==5.4.2 SimpleITK==2.5.6
