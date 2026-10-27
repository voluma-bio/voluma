# Local DICOM viewer specification

The viewer opens a ZIP of DICOM Part 10 images and displays one acquired slice
at a time. It supports slice navigation, window/level, zoom and reset. It does
not upload data, reconstruct orthogonal planes, produce meshes, segment anatomy
or calculate scientific measurements. It is a research inspection tool, not a
validated diagnostic viewer.

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

`DicomStack` owns a rendering engine, registered local file IDs and its cached
images. It decodes on demand, serializes navigation, and coalesces scrubbing to
the newest requested slice. Resize/maximize preserve the engine and display
state. Close/unmount marks work obsolete, disconnects the resize observer, waits
for an active non-cancellable decode, then destroys the engine and releases its
cache entries, datasets and file references. It does not purge another viewer's
global cache. The bounded shared decoder worker pool remains for the page lifetime.

## Library choices and integration constraints

Cornerstone core and DICOM image loader are pinned together at **4.22.13**.
It supplies DICOM decoding, modality/VOI transforms, geometry and a stack
viewport, avoiding a custom pixel renderer. Three.js remains available for
future meshes but does not render the acquired DICOM stack.

The attempted 5.13.2 integration had a browser EventEmitter dependency failure
and then a local-file metadata path that returned no compressed frame data. The
verified 4.22.13 path avoids a deprecated-provider fallback. Upgrading requires
rerunning local-file and compressed-codec checks, not just building the bundle.

Two behaviors in 4.22.13 require explicit handling: GPU `setStack` can resolve
after an image load failure, and the convenience loader does not await cache
insertion. The component awaits the loader/cache operation before displaying a
slice. It removes the loader's `sharedCacheKey` hint because each supported file
contains one frame and has no volume owner; otherwise old slices cannot be
evicted when the cache fills. The load object's dataset-release callback remains.

Vite excludes the decoder from dependency optimization to preserve its worker
and WASM URLs, uses ES-module workers, and prebundles the viewer's nested CommonJS
parser and core dependencies. Rendering code is lazy-loaded only after selecting
a valid series. The production decoder assets are served by the app, not a CDN.

## Verification coverage and remaining work

Browser validation used Slicer's real, de-identified 130-slice MR head series,
pydicom's CT_small image and JPEG-LS MR sample. Independent pydicom/NumPy pixel
hashes and physical positions matched the browser for first/middle MR slices
and the rescaled CT image. The MR archive was also reordered to oppose physical
slice order. The browser exercised multi-series choice, native and compressed
decoding, navigation, window/level, zoom, maximize/restore, close and recovery.

Temporary fault-injection inputs covered corrupt ZIPs, missing geometry,
duplicate instances, multi-frame data, entry/count limits, truncated pixels and
a broken compressed frame. They are not application fixtures or committed data.
A deliberately reduced four-slice cache exercised eviction; normal close left
zero engines, decoded bytes, parsed datasets and registered file references.

These checks do not establish OA6-1RK compatibility, large-scan throughput,
peak memory, clinical correctness, every transfer syntax, Safari behavior or
hardware-GPU performance. The next investigation is scoped in [TODO.md](TODO.md).

Sources: [Cornerstone setup][cornerstone], [Slicer dataset test][slicer],
[pydicom test data][pydicom]. Slicer archive SHA-256:
`899f3f8617ca53bad7dca0b2908478319e708b48ff41dfa64b6bac1d76529928`.

[cornerstone]: https://www.cornerstonejs.org/docs/getting-started/vue-angular-react-etc/
[slicer]: https://github.com/Slicer/Slicer/blob/main/Applications/SlicerApp/Testing/Python/DICOMReaders.py
[pydicom]: https://github.com/pydicom/pydicom/tree/main/src/pydicom/data/test_files
