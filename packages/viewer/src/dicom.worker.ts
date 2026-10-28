/** Bounded ZIP expansion and metadata validation off the UI thread. Never infer geometry from filenames. */
import { BlobReader, ZipReader } from "@zip.js/zip.js";
import dicomParser from "dicom-parser";
import type { DicomArchive, DicomSeries, IntakeMessage, Orientation, Point3 } from "./dicom";

const MiB = 1024 * 1024;
// Expanded slices are held as Blobs for the session; this, not the ZIP size, bounds memory.
const maxExpanded = 2048 * MiB;
const maxEntry = 64 * MiB;
const maxEntries = 4096;
const nativeSyntaxes = new Set([
  "1.2.840.10008.1.2", // Implicit VR little endian
  "1.2.840.10008.1.2.1", // Explicit VR little endian
  "1.2.840.10008.1.2.2", // Explicit VR big endian
]);
const syntaxes = new Set([
  ...nativeSyntaxes,
  "1.2.840.10008.1.2.4.50", // JPEG baseline
  "1.2.840.10008.1.2.4.51", // JPEG extended
  "1.2.840.10008.1.2.4.57", // JPEG lossless
  "1.2.840.10008.1.2.4.70", // JPEG lossless selection 1
  "1.2.840.10008.1.2.4.80", // JPEG-LS lossless
  "1.2.840.10008.1.2.4.81", // JPEG-LS near-lossless
  "1.2.840.10008.1.2.4.90", // JPEG 2000 lossless
  "1.2.840.10008.1.2.4.91", // JPEG 2000
  "1.2.840.10008.1.2.5", // RLE
]);

class IntakeError extends Error {}

function fail(message: string): never {
  throw new IntakeError(message);
}

function numbers(value: string | undefined, length: number): number[] {
  const values = value?.split("\\").map((part) => (part.trim() ? Number(part) : Number.NaN)) ?? [];
  if (!value || values.length !== length || values.some((n) => !Number.isFinite(n))) {
    fail(
      "A DICOM image has missing or invalid geometry. Position, orientation and pixel spacing are required.",
    );
  }
  return values;
}

function dot(a: Point3, b: Point3) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(orientation: Orientation): Point3 {
  const [a, b, c, d, e, f] = orientation;
  return [b * f - c * e, c * d - a * f, a * e - b * d];
}

function same(a: number[], b: number[]) {
  return a.every((n, i) => Math.abs(n - (b[i] as number)) < 0.0001);
}

async function readArchive(file: File): Promise<DicomArchive> {
  const reader = new ZipReader(new BlobReader(file), { useWebWorkers: false });
  try {
    // Bound enumeration too: a small ZIP can contain millions of empty entries.
    const entries = [];
    let declaredSize = 0;
    for await (const entry of reader.getEntriesGenerator()) {
      if (entries.length >= maxEntries) fail("This ZIP exceeds the current 4,096-entry limit.");
      declaredSize += entry.uncompressedSize;
      if (entry.uncompressedSize > maxEntry || declaredSize > maxExpanded) {
        fail("This ZIP exceeds the current limits: 64 MiB per file and 2 GiB expanded.");
      }
      if (entry.encrypted)
        fail("Encrypted ZIP files are not supported. Export an unencrypted ZIP.");
      entries.push(entry);
    }
    const series = new Map<string, DicomSeries>();
    const instances = new Set<string>();
    let ignoredFiles = 0;
    let expandedSize = 0;
    for (const [index, entry] of entries.entries()) {
      if (!entry.directory) {
        const chunks: Uint8Array<ArrayBuffer>[] = [];
        let size = 0;
        // Check actual output, not just the untrusted central directory's sizes.
        await entry.getData(
          new WritableStream<Uint8Array<ArrayBuffer>>({
            write(chunk) {
              size += chunk.length;
              expandedSize += chunk.length;
              if (size > maxEntry || expandedSize > maxExpanded) {
                fail("Expanded ZIP data exceeds the current memory limits.");
              }
              chunks.push(chunk);
            },
          }),
          { checkSignature: true },
        );
        const blob = new Blob(chunks);
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const part10 =
          bytes.length > 132 && String.fromCharCode(...bytes.subarray(128, 132)) === "DICM";
        if (!part10) {
          if (/\.(dcm|dicom)$/i.test(entry.filename)) {
            fail(
              "A DICOM file is corrupt or lacks a Part 10 header. Re-export the scan as DICOM Part 10.",
            );
          }
          ignoredFiles++;
        } else {
          let data: dicomParser.DataSet;
          try {
            // Native pixel boundaries are checked below. Parsing past them can
            // mistake scanner block padding for tags; compressed images still
            // need a full parse to validate their fragment tables.
            data = dicomParser.parseDicom(bytes, { untilTag: "x7fe00010" });
            if (!nativeSyntaxes.has(data.string("x00020010") ?? "")) {
              data = dicomParser.parseDicom(bytes);
            }
          } catch {
            fail(
              "A DICOM header could not be read. Corrupt and deflated DICOM files are not supported.",
            );
          }
          if (data.string("x00080016") === "1.2.840.10008.1.3.10") {
            ignoredFiles++; // DICOMDIR is an index, not an image.
          } else {
            if (!syntaxes.has(data.string("x00020010") ?? "")) {
              fail(
                "The scan uses an unsupported DICOM transfer syntax. Export uncompressed DICOM instead.",
              );
            }
            if (!data.elements.x7fe00010)
              fail("The ZIP contains a DICOM object without image pixels.");
            if (Number(data.string("x00280008") ?? "1") !== 1) {
              fail("Multi-frame DICOM is not supported yet. Export one image per DICOM file.");
            }
            if (
              data.uint16("x00280002") !== 1 ||
              !["MONOCHROME1", "MONOCHROME2"].includes(data.string("x00280004") ?? "")
            ) {
              fail("Only monochrome DICOM images are supported in this viewer.");
            }
            const bits = data.uint16("x00280100");
            const stored = data.uint16("x00280101");
            const high = data.uint16("x00280102");
            const representation = data.uint16("x00280103");
            if (
              ![8, 16].includes(bits ?? 0) ||
              !stored ||
              stored > (bits ?? 0) ||
              high !== stored - 1 ||
              ![0, 1].includes(representation ?? -1)
            ) {
              fail("Only conventional 8-bit or 16-bit monochrome pixels are supported.");
            }
            const study = data.string("x0020000d");
            const uid = data.string("x0020000e");
            const instance = data.string("x00080018");
            if (!study || !uid || !instance)
              fail("A DICOM image is missing its study, series or instance identifier.");
            if (instances.has(instance))
              fail("Duplicate DICOM instances were found. Remove duplicates before importing.");
            instances.add(instance);
            const rows = data.uint16("x00280010") ?? 0;
            const columns = data.uint16("x00280011") ?? 0;
            if (!rows || !columns || rows * columns > 4096 * 4096)
              fail("Image dimensions are invalid or exceed 16 million pixels per slice.");
            const pixels = data.elements.x7fe00010;
            const expectedBytes = rows * columns * ((bits as number) / 8);
            if (
              pixels &&
              !pixels.encapsulatedPixelData &&
              (pixels.length !== expectedBytes + (expectedBytes % 2) ||
                pixels.dataOffset + pixels.length > bytes.length)
            ) {
              fail("DICOM pixel data is truncated or does not match its declared dimensions.");
            }
            const spacing = numbers(data.string("x00280030"), 2);
            const orientation = numbers(data.string("x00200037"), 6) as Orientation;
            const position = numbers(data.string("x00200032"), 3) as Point3;
            const row = orientation.slice(0, 3) as Point3;
            const column = orientation.slice(3) as Point3;
            if (
              spacing.some((n) => n <= 0) ||
              Math.abs(dot(row, row) - 1) > 0.001 ||
              Math.abs(dot(column, column) - 1) > 0.001 ||
              Math.abs(dot(row, column)) > 0.001
            ) {
              fail("A DICOM image has invalid spacing or non-orthogonal orientation vectors.");
            }
            const id = `${study}/${uid}`;
            let stack = series.get(id);
            if (!stack) {
              stack = {
                id,
                modality: data.string("x00080060") ?? "Image",
                rows,
                columns,
                spacing,
                orientation,
                slices: [],
              };
              series.set(id, stack);
            } else if (
              stack.rows !== rows ||
              stack.columns !== columns ||
              !same(stack.spacing, spacing) ||
              !same(stack.orientation, orientation)
            ) {
              fail(
                "One series contains inconsistent image geometry. Export each reconstruction or localizer as a separate series.",
              );
            }
            stack.slices.push({
              // The decoder must not parse scanner padding after native pixels either.
              file:
                pixels && !pixels.encapsulatedPixelData
                  ? blob.slice(0, pixels.dataOffset + pixels.length)
                  : blob,
              position,
              frameOfReferenceUID: data.string("x00200052"),
              stored: {
                bits: stored,
                signed: representation === 1,
                slope: data.floatString("x00281053") ?? 1,
                intercept: data.floatString("x00281052") ?? 0,
              },
            });
          }
        }
      }
      self.postMessage({
        type: "progress",
        done: index + 1,
        total: entries.length,
      } satisfies IntakeMessage);
    }
    if (!series.size) fail("No supported DICOM Part 10 images were found in this ZIP.");
    for (const stack of series.values()) {
      const normal = cross(stack.orientation);
      stack.slices.sort((a, b) => dot(a.position, normal) - dot(b.position, normal));
      let previous: number | undefined;
      for (const slice of stack.slices) {
        const distance = dot(slice.position, normal);
        if (previous !== undefined && Math.abs(distance - previous) < 0.0001) {
          fail(
            "A series contains overlapping slice positions. Separate time points or repeated acquisitions before importing.",
          );
        }
        previous = distance;
      }
    }
    return { series: [...series.values()], ignoredFiles };
  } finally {
    await reader.close();
  }
}

self.onmessage = async ({ data }: MessageEvent<File>) => {
  try {
    self.postMessage({ type: "ready", archive: await readArchive(data) } satisfies IntakeMessage);
  } catch (error) {
    self.postMessage({
      type: "error",
      message:
        error instanceof IntakeError
          ? error.message
          : "Could not read this ZIP. Check that it is intact and unencrypted.",
    } satisfies IntakeMessage);
  }
};
