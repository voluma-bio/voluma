/**
 * The first worksheet of an Excel `.xlsx` sample sheet as rows of text: enough for a lab's
 * sample list (shared and inline strings, numbers, booleans; no formulas evaluated, their
 * cached value is read). An `.xlsx` is a zip of XML parts; `fflate` unzips it and the
 * browser's `DOMParser` reads the parts. Imported lazily by `intake.ts`.
 */
import { unzipSync } from "fflate";

const decoder = new TextDecoder();

export async function readXlsx(file: File): Promise<string[][]> {
  const parts = unzipSync(new Uint8Array(await file.arrayBuffer()), {
    filter: (f) =>
      (f.name.startsWith("xl/") && f.name.endsWith(".xml")) || f.name.endsWith(".rels"),
  });
  const xml = (path: string) => {
    const bytes = parts[path];
    return bytes ? new DOMParser().parseFromString(decoder.decode(bytes), "application/xml") : null;
  };
  const byTag = (doc: Document | Element | null, tag: string) =>
    doc ? [...doc.getElementsByTagNameNS("*", tag)] : [];

  // The workbook's first sheet, through its relationship id.
  const first = byTag(xml("xl/workbook.xml"), "sheet")[0];
  const relId =
    first?.getAttributeNS(
      "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
      "id",
    ) ?? first?.getAttribute("r:id");
  const target = byTag(xml("xl/_rels/workbook.xml.rels"), "Relationship")
    .find((r) => r.getAttribute("Id") === relId)
    ?.getAttribute("Target");
  const path = target ? `xl/${target.replace(/^\/?xl\//, "")}` : "xl/worksheets/sheet1.xml";
  const sheet = xml(path);
  if (!sheet) throw new Error("This Excel file has no worksheet.");

  const shared = byTag(xml("xl/sharedStrings.xml"), "si").map((si) =>
    byTag(si, "t")
      .map((t) => t.textContent ?? "")
      .join(""),
  );

  const rows: string[][] = [];
  for (const row of byTag(sheet, "row")) {
    const cells: string[] = [];
    for (const c of byTag(row, "c")) {
      const column = columnIndex(c.getAttribute("r") ?? "") ?? cells.length;
      const type = c.getAttribute("t");
      const v = byTag(c, "v")[0]?.textContent ?? "";
      cells[column] =
        type === "s"
          ? (shared[Number(v)] ?? "")
          : type === "inlineStr"
            ? byTag(c, "t")
                .map((t) => t.textContent ?? "")
                .join("")
            : type === "b"
              ? v === "1"
                ? "TRUE"
                : "FALSE"
              : v;
    }
    const filled = Array.from(cells, (cell) => cell ?? "");
    if (filled.some((cell) => cell.trim() !== "")) rows.push(filled);
  }
  return rows;
}

/** `C7` → 2. */
function columnIndex(ref: string): number | undefined {
  const letters = /^[A-Z]+/.exec(ref)?.[0];
  if (!letters) return undefined;
  return [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
}
