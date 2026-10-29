/**
 * What the researcher dropped or picked, grouped into scans and a sample sheet. No AI: the
 * rule is by file type and folder.
 *
 *   - A sample sheet (`.csv`, `.tsv`, `.xlsx`) is the sheet, wherever it sits.
 *   - An archive (`.zip`, `.tar`, `.tgz`, `.tar.gz`) or a volume file (`.isq`, `.aim`,
 *     `.nii`, `.nii.gz`, `.nrrd`, `.mha`, `.vff`, with or without a VMS version such as
 *     Scanco's `;1`) is one scan on its own, named after the file.
 *   - Any other file is a slice (DICOM with or without `.dcm`, TIFF, BMP, PNG). A folder is one
 *     scan when every slice under it sits in one folder (`OA6-1RK/` of slices, or
 *     `OA6-1RK/DICOM/` of slices), with its whole subtree. Otherwise each of its subfolders is
 *     looked at the same way (a folder of scans).
 *   - A folder with slices of its own and one `*_rec` folder of slices is a Skyscan export: the
 *     scan is the folder without the projections beside the reconstruction.
 *   - Loose slices dropped together, outside any folder, are one scan.
 *   - Preview folders (`thumbs`, `preview`...) and documents (`.pdf`, `.txt`, `.docx`...) are
 *     not used, except that documents inside a scan's folder go with it.
 *   - Hidden files (`.DS_Store`, `._` forks) are never part of a scan.
 *
 * A folder scan is named after its nearest folder that isn't a generic one (`DICOM`, `rec`,
 * `images`...), without a `_rec` suffix: `OA6-1RK/DICOM/` and `M1_rec/` give `OA6-1RK` and `M1`.
 *
 * A scan's paths are relative to its folder (the folder becomes the name): what the run sees
 * under `/inputs`.
 */

export interface Dropped {
  file: File;
  /** `/` separated, starting with the dropped folder's name when there is one. */
  path: string;
}

export interface ScanFile {
  file: File;
  /** Relative to the scan's folder. */
  path: string;
}

export interface DroppedScan {
  name: string;
  files: ScanFile[];
}

export interface Grouped {
  scans: DroppedScan[];
  sheets: File[];
  /** Paths of files that are neither a scan nor a sheet. */
  skipped: string[];
}

const SHEET = /\.(csv|tsv|xlsx)$/i;
const SCAN_FILE = /\.(zip|tar|tgz|tar\.gz|isq|aim|nii|nii\.gz|nrrd|mha|vff)(;\d+)?$/i;
const DOCUMENT = /\.(pdf|txt|md|rtf|doc|docx|ppt|pptx|xls|json|log|html?)$/i;

const PREVIEW = /^(thumbs?|thumbnails?|previews?)$/i;
const GENERIC =
  /^(dicom|dcm|images?|slices?|series|rec|recon|reconstructions?|data|scans?|tiffs?|bmps?|raw|export(ed)?|volume)$/i;
const REC = /_rec$/i;

/** The nearest folder on `path` that names the scan (`OA6-1RK/DICOM` → `OA6-1RK`), else its last folder. */
function scanName(path: string): string {
  const parts = path.split("/");
  for (const part of [...parts].reverse()) {
    const name = part.replace(REC, "");
    if (name && !GENERIC.test(name)) return name;
  }
  return parts.at(-1) ?? "Scan";
}

type Kind = "sheet" | "scan" | "document" | "slice";
const kindOf = (name: string): Kind =>
  SHEET.test(name)
    ? "sheet"
    : SCAN_FILE.test(name)
      ? "scan"
      : DOCUMENT.test(name)
        ? "document"
        : "slice";

/** A file name without its scan or sheet extension (`OA6-1RK.nii.gz` → `OA6-1RK`). */
export const stem = (name: string) =>
  name
    .replace(SCAN_FILE, "")
    .replace(SHEET, "")
    .replace(/\.(dcm|tiff?|bmp|png)$/i, "");

interface Dir {
  name: string;
  files: Dropped[];
  dirs: Map<string, Dir>;
}

function tree(dropped: Dropped[]): Dir {
  const root: Dir = { name: "", files: [], dirs: new Map() };
  for (const d of dropped) {
    const parts = d.path.normalize("NFC").split("/").filter(Boolean);
    if (parts.some((p) => p.startsWith("."))) continue;
    let dir = root;
    for (const part of parts.slice(0, -1)) {
      let next = dir.dirs.get(part);
      if (!next) {
        next = { name: part, files: [], dirs: new Map() };
        dir.dirs.set(part, next);
      }
      dir = next;
    }
    dir.files.push({ file: d.file, path: parts.join("/") });
  }
  return root;
}

/** The folders under (and including) `dir` that hold slices directly; scan files count as many. */
function sliceFolders(dir: Dir): number {
  let n = dir.files.some((f) => kindOf(f.file.name) === "slice") ? 1 : 0;
  n += dir.files.filter((f) => kindOf(f.file.name) === "scan").length * 2;
  for (const sub of dir.dirs.values()) n += sliceFolders(sub);
  return n;
}

function everyFile(dir: Dir): Dropped[] {
  return [...dir.files, ...[...dir.dirs.values()].flatMap(everyFile)];
}

/** Paths under `dir`, made relative to it. */
const relativeTo = (files: Dropped[], dir: Dropped["path"]) =>
  files
    .map((f) => ({ file: f.file, path: dir ? f.path.slice(dir.length + 1) : f.path }))
    .sort((a, b) => a.path.localeCompare(b.path));

export function groupDropped(dropped: Dropped[]): Grouped {
  const out: Grouped = { scans: [], sheets: [], skipped: [] };
  const used: Dropped[] = [];
  for (const d of dropped) {
    const folders = d.path.split("/").slice(0, -1);
    if (folders.some((f) => PREVIEW.test(f))) out.skipped.push(d.path);
    else used.push(d);
  }

  /** `dir` (at `path`) as one scan, less `drop`: its sheets go to the sheets, the rest is the scan. */
  function whole(dir: Dir, path: string, name: string, drop: Dropped[] = []) {
    const files = everyFile(dir).filter((f) => !drop.includes(f));
    out.sheets.push(...files.filter((f) => kindOf(f.file.name) === "sheet").map((f) => f.file));
    const scan = files.filter((f) => kindOf(f.file.name) !== "sheet");
    out.scans.push({ name, files: relativeTo(scan, path) });
  }

  function visit(dir: Dir, path: string) {
    const isRoot = path === "";
    const folders = sliceFolders(dir);
    // A named folder whose slices all sit in one folder is one scan.
    if (!isRoot && folders === 1) return whole(dir, path, scanName(path));
    // Skyscan: projections here, the reconstruction in `<name>_rec/`.
    const subs = [...dir.dirs.values()];
    const rec = subs.filter((d) => REC.test(d.name) && sliceFolders(d) === 1);
    const own = dir.files.filter((f) => kindOf(f.file.name) === "slice");
    if (!isRoot && rec.length === 1 && rec[0] && own.length > 0 && folders === 2) {
      out.skipped.push(...own.map((f) => f.path));
      // The rest of the folder (Skyscan's `.log` holds the pixel size) goes with the scan.
      return whole(dir, path, scanName(path), own);
    }
    const loose: Dropped[] = [];
    for (const f of dir.files) {
      const kind = kindOf(f.file.name);
      if (kind === "sheet") out.sheets.push(f.file);
      else if (kind === "scan")
        out.scans.push({ name: stem(f.file.name), files: [{ file: f.file, path: f.file.name }] });
      else if (kind === "document") out.skipped.push(f.path);
      else loose.push(f);
    }
    // Slices beside other scans' folders: one scan, named after where they sit.
    if (loose.length > 0) {
      out.scans.push({
        name: isRoot ? looseName(loose) : scanName(path),
        files: relativeTo(loose, path),
      });
    }
    for (const sub of dir.dirs.values()) visit(sub, isRoot ? sub.name : `${path}/${sub.name}`);
  }

  visit(tree(used), "");
  out.scans.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return out;
}

/** Loose slices' shared name prefix (`OA6-1RK_0001.dcm`... → `OA6-1RK`), else "Scan". */
function looseName(files: Dropped[]): string {
  const names = files.map((f) => stem(f.file.name));
  let prefix = names[0] ?? "";
  for (const n of names) while (!n.startsWith(prefix)) prefix = prefix.slice(0, -1);
  if (files.length === 1) return prefix || "Scan";
  return prefix.replace(/[\d_\-. ]+$/, "") || "Scan";
}

/** A picker's files: a folder pick carries `webkitRelativePath`, a files pick only names. */
export const fromFileList = (list: FileList): Dropped[] =>
  [...list].map((file) => ({ file, path: file.webkitRelativePath || file.name }));

/** A drop's files, walking dropped folders. Reads every entry before the event's data goes stale. */
export async function fromDataTransfer(data: DataTransfer): Promise<Dropped[]> {
  const entries = [...data.items]
    .filter((item) => item.kind === "file")
    .map((item) => item.webkitGetAsEntry())
    .filter((entry): entry is FileSystemEntry => entry !== null);
  if (entries.length === 0) return [...data.files].map((file) => ({ file, path: file.name }));
  const out: Dropped[] = [];
  async function walk(entry: FileSystemEntry, path: string): Promise<void> {
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) =>
        (entry as FileSystemFileEntry).file(resolve, reject),
      );
      out.push({ file, path });
      return;
    }
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    // readEntries returns at most 100 entries a call; read until it returns none.
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
        reader.readEntries(resolve, reject),
      );
      if (batch.length === 0) break;
      await Promise.all(batch.map((child) => walk(child, `${path}/${child.name}`)));
    }
  }
  await Promise.all(entries.map((entry) => walk(entry, entry.name)));
  return out;
}
