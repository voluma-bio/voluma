# Viewer follow-up

- Full-resolution volume inspection is a researcher requirement, not satisfied
  by the Standard/Compact preview caps. In `volume.ts` and `DicomVolume.tsx`,
  investigate native-grid storage/rendering, explicit memory admission and a
  way to inspect fine structures without silently substituting a reduced grid.
  Use the real scan and workstation measurements before choosing the approach.
- Performance investigation: use the real OA6-1RK ZIP and a representative large
  micro-CT acquisition. Measure import time, time to first visible slice, scrub
  latency, peak browser/GPU memory, repeated replacement and close. Use the
  volume preview's Performance → Measure rotation → Save timings in Standard
  and Compact, normal and maximized; the workstation recipe is in CONTEXT.md.
  Test on a hardware GPU; orb Chromium is not a performance proxy for a researcher's
  workstation. Revisit intake caps, disk-backed/streaming storage, worker
  lifetimes and the lazy viewer bundle using those measurements.
- Expand compatibility only with real inputs: compressed syntaxes beyond the
  exercised JPEG-LS sample, irregular/oblique acquisitions, multi-frame DICOM,
  standalone DCM, missing spatial metadata, and representative browser engines.
- Implement orthogonal reformats, linked navigation and segmented meshes
  separately. The raw volume preview is not anatomy segmentation. If accessible,
  use OA6-1RK's existing 18-structure web-review export for a separate mesh
  benchmark; volume ray-casting timings do not measure mesh performance.
- Downsampling is bounded trilinear display interpolation, not anti-aliased
  reconstruction. Validate small-structure visibility and tune ray sampling /
  interactive render resolution using workstation evidence before increasing
  preview or intake limits. Nonlinear modality LUTs remain unsupported in 3D.
