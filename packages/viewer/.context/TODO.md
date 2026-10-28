# Viewer follow-up

- Full resolution now builds the native grid in 16-bit stored values where
  possible. Still open: measure it on a hardware GPU with Andrew's 604×604×412
  scan and a real micro-CT; check whether the GPU texture is norm16, half float
  or Float32 there; for scans past the 2 GiB / texture-size limits, bricked or
  region-of-interest loading.
- Performance instrumentation was removed for the hackathon. Reintroduce it only
  when a concrete investigation needs it. Use real OA6-1RK data and a hardware GPU;
  orb Chromium is not a performance proxy for a researcher's workstation.
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
