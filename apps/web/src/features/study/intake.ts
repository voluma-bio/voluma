/**
 * Intake for the mouse OA knee workflow, deterministic (no AI): each scan's mouse and knee
 * from its name, joined with the lab's sample sheet for the group. What neither fills is
 * left empty for the researcher to answer in the table.
 *
 * Names: the lab writes `<mouse><R|L>K`, e.g. `OA6-1RK` (mouse OA6-1, right knee), with an
 * optional separator (`OA6-1_LK`); otherwise a `left` or `right` word gives the knee only.
 *
 * The sheet: the first row is the header. Columns are found by header words: the scan or file
 * name, the mouse (`mouse`, `subject`, `animal`, `specimen`, `id`), the knee (`knee`, `side`,
 * `leg`) and the group (`group`, `treatment`, `condition`, `cohort`). A scan takes the row
 * that names its file; else the row with its mouse and knee; else, in a sheet without a knee
 * column, its mouse's row. Ids compare without case, spaces, `-` or `_`.
 */

import { stem } from "./scan-files";

export type Knee = "Right" | "Left";

export interface Sample {
  subject: string;
  knee: Knee | "";
  group: string;
}

export function parseName(name: string): Partial<Sample> {
  const base = stem(name).trim();
  const lab = /^([A-Za-z]*\d+(?:[-.]\d+)*)[-_ ]?([RL])K(?=$|[-_ .])/i.exec(base);
  if (lab?.[1] && lab[2])
    return { subject: lab[1], knee: lab[2].toUpperCase() === "R" ? "Right" : "Left" };
  const word = /(?:^|[-_ .])(left|right)(?=$|[-_ .])/i.exec(base)?.[1];
  return word ? { knee: word.toLowerCase() === "right" ? "Right" : "Left" } : {};
}

export function kneeOf(value: string): Knee | "" {
  const v = value.trim().toLowerCase();
  if (["r", "rk", "right", "right knee"].includes(v)) return "Right";
  if (["l", "lk", "left", "left knee"].includes(v)) return "Left";
  return "";
}

const idKey = (value: string) => value.toLowerCase().replace(/[\s_-]+/g, "");

export interface Sheet {
  name: string;
  rows: string[][];
}

/** RFC 4180 CSV (quoted fields, doubled quotes, CRLF), or TSV with `tab`. */
export function parseDelimited(text: string, delimiter = ","): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === delimiter) {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length > 0) rows.push([...row, field]);
  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

export async function readSheet(file: File): Promise<Sheet> {
  const name = file.name;
  if (/\.xlsx$/i.test(name)) {
    // Loaded only when a lab drops an Excel sheet.
    const { readXlsx } = await import("./xlsx");
    return { name, rows: await readXlsx(file) };
  }
  return { name, rows: parseDelimited(await file.text(), /\.tsv$/i.test(name) ? "\t" : ",") };
}

const COLUMNS = {
  file: /scan|file|image|sample name/i,
  subject: /mouse|subject|animal|specimen|^\s*id\s*$/i,
  knee: /knee|side|leg|limb/i,
  group: /group|treatment|condition|cohort/i,
} as const;

export interface SheetColumns {
  file: number;
  subject: number;
  knee: number;
  group: number;
}

/** Each column's index in the header, or -1. The file column wins a header that names both. */
export function sheetColumns(header: string[]): SheetColumns {
  const find = (re: RegExp, taken: number[] = []) =>
    header.findIndex((h, i) => !taken.includes(i) && re.test(h));
  const file = find(COLUMNS.file);
  const subject = find(COLUMNS.subject, [file]);
  return {
    file,
    subject,
    knee: find(COLUMNS.knee, [file, subject]),
    group: find(COLUMNS.group, [file, subject]),
  };
}

/** The sample `name` reads as: its parsed name, filled and overridden by its sheet row. */
export function intake(name: string, sheet: Sheet | undefined): Sample {
  const parsed = parseName(name);
  const sample: Sample = { subject: parsed.subject ?? "", knee: parsed.knee ?? "", group: "" };
  if (!sheet || sheet.rows.length < 2) return sample;
  const [header = [], ...rows] = sheet.rows;
  const col = sheetColumns(header);
  const cell = (row: string[], i: number) => (i < 0 ? "" : (row[i] ?? "").trim());
  const row =
    (col.file >= 0 && rows.find((r) => idKey(stem(cell(r, col.file))) === idKey(stem(name)))) ||
    (sample.subject &&
      col.subject >= 0 &&
      rows.find(
        (r) =>
          idKey(cell(r, col.subject)) === idKey(sample.subject) &&
          (col.knee < 0 || kneeOf(cell(r, col.knee)) === sample.knee),
      ));
  if (!row) return sample;
  return {
    subject: cell(row, col.subject) || sample.subject,
    knee: kneeOf(cell(row, col.knee)) || sample.knee,
    group: cell(row, col.group),
  };
}
