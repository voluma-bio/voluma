# Local DICOM viewer specification

The viewer opens a local ZIP of DICOM Part 10 images for acquired-slice viewing
and an on-demand raw 3D volume preview. It supports slice navigation, window/level,
camera rotation, zoom/reset and volume intensity/opacity controls. It does not
upload data, reconstruct orthogonal planes, produce meshes, segment anatomy or
calculate scientific measurements. It is not a validated diagnostic viewer.

## ZIP → validated series → decoded slice

```diagram
ZIP File → import worker → DicomArchive → selected DicomSeries
                                             │
                                             ▼
                                  Cornerstone → persistent viewport
```

`openDicomZip(file, signal, onProgress)` creates a dedicated worker. The worker
uses zip.js to enumerate and expand entries sequentially, checks ZIP CRCs, and
uses dicom-parser to validate the DICOM data. It returns Blobs and the geometry
needed for ordering; it never extracts files to disk. Aborting terminates the
worker. Failures return controlled messages, not raw parser objects or headers.

An archive groups images by **Study Instance UID + Series Instance UID**. A
single series opens automatically; the application asks the researcher to choose
when several exist. It never selects the largest series or concatenates series.

Slices sort by the dot product of Image Position Patient with the normal formed
from the two Image Orientation Patient vectors. ZIP order, filenames and Instance
Number do not determine order. This also works for oblique acquisitions. Pixel
Spacing is row/column spacing in millimetres. Cornerstone preserves that aspect
ratio and applies the DICOM modality and window transforms; the app does not
invent HU or mineral-density calibration. Uneven slice gaps are allowed for
individual slice viewing, not interpreted as a regularly sampled volume.

## Accepted input and rejection behavior

The current supported subset is single-frame, monochrome, 8-bit or 16-bit Part 10
DICOM with conventional high-bit placement. It requires study, series and SOP
instance identifiers, positive pixel spacing, finite positions, and approximately
orthonormal orientation vectors. Dimensions, spacing and orientation must match
within each series (spacing/orientation tolerance 0.0001). Duplicate instances
and projected slice positions less than 0.0001 mm apart are rejected.

Transfer syntaxes accepted by the reader are implicit/explicit little endian,
explicit big endian, JPEG baseline/extended/lossless, JPEG-LS, JPEG 2000 and RLE.
This is an allowlist of available decoders, **not a claim that every codec has
been validated**. Deflated datasets, enhanced/multi-frame images, RGB, floating
pixels and other syntaxes require a later extension. Standalone `.dcm` selection
is not supported; a ZIP containing one image is valid.

Directories, DICOMDIR and non-DICOM sidecars are ignored, with a count shown for
skipped files. A `.dcm`/`.dicom` entry without a valid Part 10 header rejects the
archive. Extensionless Part 10 files work. A malformed or unsupported DICOM
rejects the whole archive rather than silently dropping slices from an otherwise
plausible scan. Pixel boundary validation rejects truncated native data and
invalid fragment tables before decoding. Codec/render errors replace the image
with an error and retry action; they never leave a prior slice presented as the
requested one.

## Current resource limits and lifetime

| Resource | Current limit |
|---|---:|
| Compressed ZIP | 256 MiB |
| Entries, including directories | 4,096 |
| Expanded entry | 64 MiB |
| Total expanded content | 512 MiB |
| Pixels in one slice | 16,777,216 |
| Decoded image cache | 256 MiB |
| DICOM decode workers | 2 |

The import checks both declared sizes and actual streamed output. These limits
are provisional guardrails, not measured support for production micro-CT scans.
They do not bound total browser RSS: ZIP bytes, original DICOM Blobs, parsed
datasets, decoded images and GPU allocations have distinct lifetimes.

`dicomSession` owns local file IDs and serial decoding, shared by `DicomStack`
and `DicomVolume` for the selected series. It retains the displayed acquired
slice, evicts each other source image/dataset after consumption, and waits for
active non-cancellable decoding before releasing the last reference. Navigation
coalesces scrubbing to the newest requested slice. It may decode an evicted slice
again; it never retains an entire decoded source volume alongside the preview.
Each viewport owns its engine and resize observer. Resize/maximize preserve
engines and cameras. Nothing purges another viewer's global cache. The two-worker
decoder pool remains for the page lifetime.

## Raw volume preview and its limits

The researcher chooses **Build 3D preview**; importing a ZIP does not allocate
the volume automatically. **Release 3D** leaves acquired slices open. Cancel,
close, replacement and route changes abort sampling, wait for active decoding,
destroy the engine and volume texture, then remove local preview images.
Replacement previews wait for the previous preview's cleanup. There is one
preview slot per page, not a concurrent multi-volume API.

`volume.ts` requires at least two pixels per axis and two slices, matching
Frame of Reference UIDs, and regular positions along the orientation normal.
If every slice lacks the UID, the series is treated as one local frame; mixing
present and absent UIDs or different UIDs is rejected.
Each position must be within max(0.001 mm, 1% of slice interval) of the regular
grid. Missing slices, uneven gaps, mixed frames and in-plane drift/gantry tilt
disable 3D without disabling acquired slices. This does not establish acquisition
completeness: a regularly subsampled series cannot reveal omitted source slices.

**Full resolution** (the default) keeps the acquired grid, every voxel, with no
interpolation. When every slice shares one increasing linear rescale (and the
modality is not PT or RTDOSE), voxels hold the stored integers (Uint8/Uint16/Int16) rather
than Float32: a half or a quarter of the bytes, and display maps intensities by range so the
affine offset does not show. Otherwise voxels are Float32 modality values. Before
allocation the panel shows dimensions, voxel bytes and type. Build is refused
when WebGL2 is missing, an axis exceeds the browser's `MAX_3D_TEXTURE_SIZE`, or
the estimated texture exceeds 2 GiB. The Cornerstone cache cap is raised to 256 MiB of slices **plus** the
admitted volume while it exists, and restored on release.

**Standard/Compact previews** cap every axis at 256/128 (Float32, at most
64/8 MiB) and are labelled **Downsampled**. Trilinear interpolation preserves the
first and last voxel centres in patient space, row/column spacing, orientation
and modality rescale. This is display resampling, not an anti-aliased scientific
reconstruction: small structures may disappear. There are no structure IDs,
femur/tibia meshes or derived measurements.

While dragging, ray sampling distance doubles and returns to full on release; the
voxel grid never changes. Cornerstone 4.22 disables vtk.js half float, so 16-bit
voxels upload as norm16 only where Cornerstone detects support, and otherwise as
an R32F texture, converted one slice at a time. Admission therefore assumes 4 GPU
bytes per 16-bit or Float32 voxel and refuses textures over 2 GiB; the panel shows
that estimate when it exceeds the voxel bytes. vtk's `allocatedGPUMemoryInBytes`
under-reports the R32F case. Prescale reversal is checked per voxel and the build
fails rather than store a wrong integer.

One voxel buffer backs the volume's local-image subarrays and GPU
texture upload. The original DICOM Blobs remain available for slices. A displayed
source slice plus a transient decoded slice and parsed dataset can also be live.
Sampling consumes each contributing source slice once, in order, accumulating
its weights into adjacent output planes before eviction. Unused slices are not
decoded. Completed output planes yield for progress, cancellation and navigation.
The 256 MiB cache includes preview image subarrays, but **not** ZIP/Blob storage,
all decoder scratch memory, browser overhead or GPU allocations. GPU format and
driver copies vary. These limits do not guarantee that any micro-CT scan fits;
the existing ZIP intake limits still apply before downsampling.

### Measuring on a researcher's workstation

Open `/runs/local` on the preview or local web app in Chrome with hardware
acceleration enabled. Files stay in that browser, even when the app is served
from an orb. Use a de-identified real scan within the intake caps:

1. Open the ZIP and select the intended series. Keep Full resolution and build 3D.
2. Drag to rotate, use arrow keys, zoom/reset and adjust intensity/opacity.
   Maximize/restore both viewports; check slice navigation still works.
3. Expand **Performance**, choose **Measure rotation**, then **Save timings**.
   Repeat maximized. Release 3D and repeat with Standard and Compact, then repeat from a
   fresh page three times to separate cold starts from warm runs.
4. Record scan dimensions and compressed/expanded sizes, browser/OS, GPU,
   display scaling and any visible stutter. Do not send patient identifiers.
   Use Chrome Task Manager and the OS GPU monitor to record baseline, peak and
   post-close memory; repeat replacement/close five times. Allocators may retain
   reserved memory even after application references have been released.

The JSON contains dimensions, spacing, renderer, canvas pixels, DPR, build time,
first render time, 24 sequential 15° rotation render latencies (p50/p95 and mean
throughput) at full and at drag sampling, cache peak and a sampled JS heap peak where Chrome exposes it.
It contains no image pixels, filenames, patient identifiers or DICOM UIDs.
First-visible time starts at Build, excludes ZIP intake, and ends at Cornerstone's
render-complete event; it is not a GPU fence or a guarantee of compositor display.
Heap sampling runs every 100 ms during builds and rotation measurements only,
and can miss peaks. No portable browser API here
measures GPU/process memory. Keep the canvas visible while measuring; save the
normal and maximized results separately because their pixel workloads differ.

## Library choices and integration constraints

Cornerstone core and DICOM image loader are pinned together at **4.22.13**.
It supplies DICOM decoding, modality/VOI transforms, geometry, stack and VOLUME_3D
viewports. `createLocalVolume` receives the bounded resampled buffer rather than
streaming the unrestricted source grid. Three.js remains available for future
meshes; volume timings say nothing about 18-structure mesh-rendering performance.

The attempted 5.13.2 integration had a browser EventEmitter dependency failure
and then a local-file metadata path that returned no compressed frame data. The
verified 4.22.13 path avoids a deprecated-provider fallback. Upgrading requires
rerunning local-file and compressed-codec checks, not just building the bundle.

The pinned loader has a pnpm patch in `patches/`: fractional rescale parameters
require Float32 storage before scaling, and the main thread must preserve that
buffer. Choosing an integer type from integral extrema loses fractional interior
values. Prescaling stays enabled so GPU slice VOI and volume intensities agree.
This patches the ESM decoder's default-buffer path used by local DICOM decoding;
it does not change caller-specified target buffers. Fractional source slices now
use four bytes per pixel within the same cache cap; integer transforms retain
their existing storage. On a loader upgrade, reassess the patch and compare
decoded slices, GPU input, native volume and downsampled samples against independent
rescaling, including integral extrema with fractional interiors and signed pixels.

Two behaviors in 4.22.13 require explicit handling: GPU `setStack` can resolve
after an image load failure, and the convenience loader does not await cache
insertion. The component awaits the loader/cache operation before displaying a
slice. The shared session removes the source loader's `sharedCacheKey` hint:
source DICOM images are not preview-volume owners. The preview's own local
images remain pinned by Cornerstone until the volume is removed. The load
object's dataset-release callback remains.

Additional 4.22 constraints: `removeVolumeLoadObject` does not release the volume
GL texture, so cleanup also calls `volume.destroy()`. The local-image generic
metadata provider has no per-ID removal; the single preview slot reuses a bounded
set of IDs (at most 256), not an accumulating random namespace. Supply the middle
preview image's VOI metadata to avoid the default volume VOI helper attempting
to load a synthetic image ID through the DICOM loader. Obtain the render window
through `getOffscreenMultiRenderWindow(viewportId)`; the declared public
`offscreenMultiRenderWindow` property is absent on the runtime wrapper.

Vite excludes the decoder from dependency optimization to preserve its worker
and WASM URLs, uses ES-module workers, and prebundles the viewer's nested CommonJS
parser and core dependencies. Rendering code is lazy-loaded only after selecting
a valid series. The production decoder assets are served by the app, not a CDN.

Compatibility and capacity limits still need real micro-CT and workstation
validation; this viewer does not establish clinical correctness. Deferred work
is scoped in [TODO.md](TODO.md). Run-specific evidence belongs in the PR body.
