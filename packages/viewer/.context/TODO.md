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
- Validate small-structure visibility and tune ray sampling / interactive render
  resolution using workstation evidence before increasing resource or intake
  limits. Nonlinear modality LUTs remain unsupported in 3D.

## Grid viewer

- Review picks the grid per task with `taskScene` (`review-scene.ts`, used by the check panel);
  then `grid-page.tsx`'s URL parameters and the DICOM path, Cornerstone, zip.js and dicom-parser go.
- Surfaces show only as meshes: a height field's line in the slices is not drawn.
- Rulers and points (world mm through the grid's inverse affine), selection framing (frame the
  `on` blocks, move the slices only on a user's selection), the amber outline under check,
  structure visibility and opacity, 3D Slicer's mouse and keyboard map (#146).
- Chunk reads cost one API redirect each. A full-resolution coronal plane of the scan plus its
  labels is about 250 chunk requests; through the orb portal a cold scan grid took 26 s to first
  paint and about 50 s to full resolution while 75 MB of bone meshes loaded beside it. If staging
  is as slow, sign many asset paths in one call or shard the levels.
- Measure scroll and 3D frame times on a hardware GPU: orb Chromium renders with SwiftShader, where
  the 3D pane with the ROI meshes costs hundreds of milliseconds per frame.
