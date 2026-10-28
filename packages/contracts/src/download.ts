/**
 * File delivery for scans, evidence and other downloadable resources.
 * GET /api/review/inputs/:inputId/download returns a downloadDescriptorSchema
 * for the input's scan archive. The server resolves its storage key and checks
 * the caller's input access (run.ts); no raw R2 key is accepted. Other resource
 * lookups may return the same descriptor without changing the transfer code.
 *
 * The descriptor URL is an opaque same-origin /api/ path, not a storage URL.
 * Its GET independently authorizes the caller and streams exactly byteLength
 * bytes, with matching Content-Type and Content-Length, no HTTP content encoding,
 * and Cache-Control: private, no-store, no-transform. No redirects or endpoint
 * compression; do not forward R2 Content-Encoding metadata blindly.
 *
 * Missing session: 401; service principal: 403; missing or inaccessible resource:
 * 404; unconfigured storage: 503; storage failure before headers: 502. A failure
 * after streaming starts terminates the response instead of changing its status.
 *
 * The caller chooses accepted media types and its download size limit. ZIP and
 * Part 10 DICOM downloads also check their byte signatures before reading the
 * rest; other types have header/length validation only. Signatures do not prove
 * ZIP contents, DICOM validity, or safety: the importer validates those. Download
 * limits and expanded-data limits are independent, not a browser memory budget.
 */
import { z } from "zod";

export const downloadDescriptorSchema = z.object({
  url: z
    .string()
    .startsWith("/api/")
    .refine(
      (url) =>
        !/[\\\s#]/.test(url) && new URL(url, "https://voluma.invalid").pathname.startsWith("/api/"),
      "must stay under the same-origin /api/ path",
    ),
  filename: z.string().min(1),
  /** Lowercase media type without parameters; used for validation, not inferred from a filename. */
  mediaType: z.string().regex(/^[a-z0-9!#$%&'*+.^_`|~-]+\/[a-z0-9!#$%&'*+.^_`|~-]+$/),
  byteLength: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
export type DownloadDescriptor = z.infer<typeof downloadDescriptorSchema>;
