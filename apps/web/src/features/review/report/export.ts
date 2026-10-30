/** Revision-scoped CSV and review reports; screenshots retain their immutable pixels and view state. */
import { downloadFile, listReviewSnapshots, reviewFileUrl } from "@voluma/api-client";
import { MAX_REVIEW_SNAPSHOT_BYTES, type ReviewSnapshot } from "@voluma/contracts/snapshot";
import { BlobReader, BlobWriter, TextReader, ZipWriter } from "@zip.js/zip.js";
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
        m.title ?? m.id,
        m.value,
        m.unit,
        m.confidence,
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

const escapeHtml = (value: string | number) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

/** No authored HTML enters a report; snapshot references resolve only inside this run/revision. */
export function reviewReport(run: ReviewRun, revision: Revision, snapshots: ReviewSnapshot[]) {
  const scoped = snapshots.filter((s) => s.runId === run.id && s.revisionId === revision.id);
  const ids = new Set(scoped.map((s) => s.id));
  const text = (value: string) =>
    escapeHtml(value).replace(/\{snapshot:([^}]+)\}/g, (_, id: string) =>
      ids.has(id)
        ? `<a href="#snapshot-${id}">Snapshot ${id}</a>`
        : "<strong>Unresolved snapshot reference</strong>",
    );
  const tasks = revision.tasks.map(
    (task) => `<section><h2>${text(task.title)}</h2><p>${text(task.ask)}</p>
      <p>Status: ${escapeHtml(task.status)}. Result revision: ${escapeHtml(task.resultRevisionId)}</p>
      <h3>Measurements</h3><ul>${task.measurements.map((m) => `<li>${text(m.title ?? m.id)}: ${m.value === null ? "Missing" : escapeHtml(m.value)} ${escapeHtml(m.unit)} (confidence: ${escapeHtml(m.confidence ?? "not supplied")})${m.note ? ` — ${text(m.note)}` : ""}</li>`).join("")}</ul>
      <h3>Scores</h3><ul>${task.scores.map((s) => `<li>${text(s.title ?? s.id)}: ${text(s.level)}${s.note ? ` — ${text(s.note)}` : ""}</li>`).join("")}</ul>
      <h3>Checks</h3><ul>${task.checks.map((c) => `<li>${text(c.title)} (${escapeHtml(c.status)}): ${text(c.detail)}</li>`).join("")}</ul>
      ${task.checker ? `<h3>Checker</h3><p>${escapeHtml(task.checker.verdict)}: ${text(task.checker.text)}</p>` : ""}
      <h3>Snapshots</h3><ul>${scoped
        .filter((s) => s.taskId === task.id)
        .map((s) => `<li>${text(`{snapshot:${s.id}}`)}</li>`)
        .join("")}</ul></section>`,
  );
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(run.sample)} review report</title></head>
    <body><main><h1>${escapeHtml(run.sample)} review report</h1>
    <p>Run: ${escapeHtml(run.id)}. Revision: ${escapeHtml(revision.id)} (${escapeHtml(revision.label)}).</p>
    <p>Review report only: measurements, checks and saved screenshots. Raw scan, masks and other analysis files are not included.</p>
    ${tasks.join("")}
    <h2>Saved screenshots</h2>${scoped.map((s) => `<figure id="snapshot-${s.id}"><img src="snapshots/${s.id}.png" width="${Math.min(s.viewState.viewport.width, 960)}" alt="Snapshot ${s.id}"><figcaption>Snapshot ${s.id}; task ${escapeHtml(s.taskId)}; ${escapeHtml(s.createdAt)}; saved by ${escapeHtml(s.by)}. <a href="snapshots/${s.id}.json">View state</a></figcaption></figure>`).join("")}
    </main></body></html>`;
}

export async function downloadReviewReport(run: ReviewRun, revision: Revision) {
  const snapshots = (await listReviewSnapshots(run.id)).filter((s) => s.revisionId === revision.id);
  const writer = new ZipWriter(new BlobWriter("application/zip"), { useWebWorkers: false });
  await writer.add("report.html", new TextReader(reviewReport(run, revision, snapshots)));
  await writer.add("measurements.csv", new TextReader(reviewCsv(run, revision)));
  await writer.add(
    "revision.json",
    new TextReader(JSON.stringify({ runId: run.id, revision }, null, 2)),
  );
  for (const snapshot of snapshots) {
    const png = await downloadFile(
      {
        url: reviewFileUrl(run.id, snapshot.png.sha256),
        filename: `${snapshot.id}.png`,
        byteLength: snapshot.png.byteLength,
        mediaType: "image/png",
      },
      {
        acceptedMediaTypes: ["image/png"],
        maxBytes: MAX_REVIEW_SNAPSHOT_BYTES,
        signal: new AbortController().signal,
      },
    );
    const digest = await crypto.subtle.digest("SHA-256", await png.arrayBuffer());
    const hash = Array.from(new Uint8Array(digest), (n) => n.toString(16).padStart(2, "0")).join(
      "",
    );
    if (hash !== snapshot.png.sha256) throw new Error("Screenshot bytes changed during export.");
    await writer.add(`snapshots/${snapshot.id}.png`, new BlobReader(png));
    await writer.add(
      `snapshots/${snapshot.id}.json`,
      new TextReader(JSON.stringify(snapshot, null, 2)),
    );
  }
  const url = URL.createObjectURL(await writer.close());
  const link = document.createElement("a");
  link.href = url;
  link.download = `${run.sample}-${revision.id}-review.zip`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
