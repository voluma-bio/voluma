/** CSV exports carry provenance and confidence alongside values, including missing values. */
import type { ReviewRun, Revision } from "./model";

export function reviewCsv(run: ReviewRun, revision: Revision): string {
  const rows: (string | number | null)[][] = [
    [
      "sample",
      "snapshot",
      "task",
      "result_revision",
      "measurement",
      "value",
      "unit",
      "confidence",
      "origin",
      "evidence",
    ],
  ];
  for (const task of revision.tasks) {
    for (const m of task.measurements)
      rows.push([
        run.sample,
        revision.id,
        task.title,
        task.resultRevisionId,
        m.label,
        m.value,
        m.unit,
        m.status,
        m.origin,
        m.evidenceIds.join(";"),
      ]);
  }
  // Spreadsheet formula prefixes must remain text even when future task labels are user-authored.
  return `\uFEFF${rows
    .map((row) =>
      row
        .map((value) => {
          const text = String(value ?? "");
          const safe = typeof value === "string" && /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
          return `"${safe.replaceAll('"', '""')}"`;
        })
        .join(","),
    )
    .join("\r\n")}`;
}

export function downloadCsv(run: ReviewRun, revision: Revision) {
  const url = URL.createObjectURL(
    new Blob([reviewCsv(run, revision)], { type: "text/csv;charset=utf-8" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = `${run.sample}-${revision.id}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
