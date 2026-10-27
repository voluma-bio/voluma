# Viewer follow-up

- Performance investigation: use the real OA6-1RK ZIP and a representative large
  micro-CT acquisition. Measure import time, time to first visible slice, scrub
  latency, peak browser/GPU memory, repeated replacement and close. Test on a
  hardware GPU; orb Chromium is not a performance proxy for a researcher's
  workstation. Revisit intake caps, disk-backed/streaming storage, worker
  lifetimes and the lazy viewer bundle using those measurements.
- Expand compatibility only with real inputs: compressed syntaxes beyond the
  exercised JPEG-LS sample, irregular/oblique acquisitions, multi-frame DICOM,
  standalone DCM, missing spatial metadata, and representative browser engines.
- Implement orthogonal reformats, linked navigation and 3D outputs separately.
  A valid acquired stack does not prove regular spacing or a reconstructable
  volume. Preserve the distinction between rendering and scientific analysis.
