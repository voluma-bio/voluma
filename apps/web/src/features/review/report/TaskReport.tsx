/** Task-scoped report and questions. Acceptance never changes scientific confidence. */
import { useMutation } from "@tanstack/react-query";
import { acceptCheck, reviewFileUrl } from "@voluma/api-client";
import type { Focus } from "@voluma/contracts/review";
import { StatusBadge } from "@voluma/ui";
import {
  ArrowUpRight,
  Check,
  CircleAlert,
  Download,
  FileText,
  ImageOff,
  MessageSquare,
  Send,
  ShieldCheck,
} from "lucide-react";
import { Dialog } from "radix-ui";
import { useState } from "react";
import { type Asset, type ReviewTask, taskStatus } from "./model";

/** The file name to save as: the last segment of the path the task gave it. */
const fileName = (asset: Asset) => asset.name.split("/").at(-1) ?? asset.name;

/** A downloadable file; the server sends anything that isn't an image as an attachment. */
function FileLink({ runId, asset }: { runId: string; asset: Asset }) {
  return (
    <a
      className="file-link"
      href={reviewFileUrl(runId, asset.sha256)}
      download={fileName(asset)}
      aria-label={`Download ${asset.name}`}
    >
      <FileText size={16} className="shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 break-all">{asset.name}</span>
      <Download size={15} className="shrink-0 text-primary-text" />
    </a>
  );
}

/**
 * A checkpoint image opens in a lightbox; other evidence (values, scripts) downloads. The
 * name only picks the card: the server decides what is an image from the bytes.
 */
function Evidence({ runId, asset }: { runId: string; asset: Asset }) {
  const [failed, setFailed] = useState(false);
  if (!/\.(jpe?g|png)$/i.test(asset.name)) return <FileLink runId={runId} asset={asset} />;
  const url = reviewFileUrl(runId, asset.sha256);
  return (
    <Dialog.Root>
      <Dialog.Trigger asChild>
        <button type="button" className="evidence-card">
          <div className="evidence-image">
            {failed ? (
              <ImageOff size={25} strokeWidth={1.3} />
            ) : (
              <img src={url} alt="" loading="lazy" onError={() => setFailed(true)} />
            )}
          </div>
          <span className="font-medium break-all">{asset.name}</span>
          <span className="text-xs text-muted-foreground">
            {failed ? "Image unavailable" : "Open evidence"}
          </span>
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content lightbox">
          <Dialog.Title className="text-xl font-semibold break-all">{asset.name}</Dialog.Title>
          <Dialog.Description className="mt-3 text-muted-foreground">
            {failed ? "The image could not be loaded." : `Evidence from ${asset.stage}.`}
          </Dialog.Description>
          {!failed && <img className="lightbox-image" src={url} alt={asset.name} />}
          <div className="mt-6 flex justify-end gap-2">
            <a className="button" href={url} download={fileName(asset)}>
              <Download size={15} />
              Download
            </a>
            <Dialog.Close className="button">Close evidence</Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

const format = (value: number) =>
  new Intl.NumberFormat("en-US", { maximumFractionDigits: 3 }).format(value);

export function TaskReport({
  task,
  structureName,
  resultLabel,
  taskNumber,
  runId,
  revisionId,
  readOnly,
  onFocus,
  onRefresh,
}: {
  task: ReviewTask;
  /** A structure id to its name, for To check items that point at structures. */
  structureName(id: string): string;
  /** The revision the task's result is from, as the revision picker names it ("R2"). */
  resultLabel: string;
  taskNumber: number;
  runId: string;
  revisionId: string;
  readOnly: boolean;
  onFocus(focus?: Focus): void;
  onRefresh(): Promise<void>;
}) {
  const accept = useMutation({
    mutationFn: (checkId: string) =>
      acceptCheck(runId, checkId, { baseRevisionId: revisionId, taskId: task.id }),
    onSuccess: onRefresh,
    onError: onRefresh,
  });
  const references = task.measurements.flatMap((m) =>
    m.references.map((reference) => ({ m, reference })),
  );
  const status = taskStatus(task);
  const header = (
    <header>
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <span className="font-mono">{String(taskNumber).padStart(2, "0")}</span>
        <span>Task report</span>
        {task.status !== "pending" && <span className="ml-auto">Result {resultLabel}</span>}
        <span className={task.status === "pending" ? "ml-auto" : undefined}>
          <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
        </span>
      </div>
      <h1 className="text-2xl font-semibold mt-3">{task.title}</h1>
      {task.ask && <p className="text-muted-foreground mt-3 leading-relaxed">{task.ask}</p>}
      {(task.models.worker || task.models.check) && (
        <p className="text-xs text-muted-foreground mt-3">
          {task.models.worker && <>Worker: {task.models.worker}</>}
          {task.models.worker && task.models.check && " · "}
          {task.models.check && <>Check: {task.models.check}</>}
        </p>
      )}
    </header>
  );
  if (task.status === "pending")
    return (
      <article className="task-report" aria-label={`${task.title} report`}>
        {header}
        <section role="status">
          <h2>{task.threads.worker ? "Started; no task result recorded" : "Not started"}</h2>
          <p className="text-muted-foreground mt-3 leading-relaxed">
            {task.threads.worker
              ? "A worker started this task, but no task result was recorded in this revision."
              : "This task is part of the run's plan, but it has not started in this revision."}
          </p>
        </section>
      </article>
    );
  return (
    <article className="task-report" aria-label={`${task.title} report`}>
      {header}
      <section>
        <div className="section-heading">
          <h2>Measurements</h2>
          {[...task.measurements, ...task.scores].some((m) => m.confidence === "provisional") && (
            <span className="badge warning">Provisional</span>
          )}
        </div>
        <p className="text-xs text-muted-foreground mb-3">
          Missing values are not zero. Values link to their evidence.
        </p>
        <table className="measurements">
          <thead>
            <tr>
              <th scope="col">Parameter</th>
              <th scope="col">Value</th>
              <th scope="col">Unit</th>
            </tr>
          </thead>
          <tbody>
            {task.measurements.map((m) => (
              <tr key={m.id}>
                <th scope="row">
                  {m.evidenceIds[0] ? (
                    <a href={`#evidence-${m.evidenceIds[0]}`}>
                      {m.title ?? m.id}
                      <ArrowUpRight size={12} />
                    </a>
                  ) : (
                    (m.title ?? m.id)
                  )}
                  <span className="measurement-source">
                    {m.value === null ? "Not supplied" : "Measured result"}
                    {m.confidence === "candidate" ? " · Candidate" : ""}
                    {m.note ? ` · ${m.note}` : ""}
                  </span>
                </th>
                <td className="font-mono">{m.value === null ? "—" : format(m.value)}</td>
                <td className="text-muted-foreground">
                  {m.unit === "1" || !m.unit ? "ratio" : m.unit}
                </td>
              </tr>
            ))}
            {task.scores.map((sc) => (
              <tr key={sc.id}>
                <th scope="row">
                  {sc.title ?? sc.id}
                  <span className="measurement-source">
                    Score{sc.scale ? ` (${sc.scale.join(", ")})` : ""}
                  </span>
                </th>
                <td className="font-mono">{sc.level}</td>
                <td className="text-muted-foreground">level</td>
              </tr>
            ))}
            {task.missing.map((o) => (
              <tr key={o.outputId}>
                <th scope="row">
                  {o.outputId}
                  <span className="measurement-source">
                    {o.kind === "measurement"
                      ? "Measurement"
                      : o.kind === "score"
                        ? "Score"
                        : "Output"}{" "}
                    {o.reason ? "missing" : "not reported"}
                    {o.required ? " · required" : ""}
                    {o.reason ? ` · ${o.reason}` : ""}
                  </span>
                </th>
                <td className="font-mono">—</td>
                <td className="text-muted-foreground" />
              </tr>
            ))}
          </tbody>
        </table>
        {task.measurements.length + task.scores.length + task.missing.length === 0 && (
          <p className="notice">This task reported no measurements.</p>
        )}
      </section>
      <section>
        <div className="section-heading">
          <h2>To check</h2>
          <button type="button" className="text-button" onClick={() => onFocus()}>
            Clear viewer focus
          </button>
          <span className="text-sm text-muted-foreground">
            {task.checks.filter((c) => c.status === "open").length} open
          </span>
        </div>
        {task.checks.length === 0 && <p className="notice">No checks were raised for this task.</p>}
        {task.checks.map((check) => (
          <div
            className={`check-card ${check.status === "accepted" ? "accepted" : ""}`}
            key={check.id}
          >
            <div className="flex items-start gap-2">
              {check.status === "accepted" ? (
                <Check size={17} className="shrink-0 mt-0.5" />
              ) : (
                <CircleAlert size={17} className="shrink-0 mt-0.5" />
              )}
              <h3 className="font-medium">
                {check.focus ? (
                  <button
                    type="button"
                    className="text-left underline decoration-dotted underline-offset-4"
                    onClick={() => onFocus({ ...check.focus! })}
                  >
                    {check.title}
                  </button>
                ) : (
                  check.title
                )}
              </h3>
            </div>
            <p className="mt-2 leading-relaxed">{check.detail}</p>
            {check.focus && check.focus.structureIds.length > 0 && (
              <p className="text-xs text-muted-foreground mt-2">
                About: {check.focus.structureIds.map((id) => structureName(id)).join(", ")}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2 mt-4">
              {check.focus && (
                <button
                  type="button"
                  className="button compact"
                  onClick={() => onFocus({ ...check.focus! })}
                >
                  Show in viewer
                </button>
              )}
              {check.status === "accepted" ? (
                <span className="font-medium text-primary-text">
                  Accepted · values remain provisional
                </span>
              ) : (
                <button
                  type="button"
                  className="button compact"
                  disabled={readOnly || accept.isPending}
                  onClick={() => accept.mutate(check.id)}
                >
                  <Check size={14} />
                  {accept.isPending && accept.variables === check.id
                    ? "Accepting…"
                    : "Accept check"}
                </button>
              )}
              <button type="button" className="button compact" disabled>
                Request correction
                <ArrowUpRight size={14} />
              </button>
            </div>
          </div>
        ))}
        {accept.error &&
          task.checks.some((check) => check.id === accept.variables && check.status === "open") && (
            <p className="error-message" role="alert">
              {accept.error.message}
            </p>
          )}
      </section>
      <section>
        <div className="section-heading">
          <h2>Second-agent check</h2>
          <ShieldCheck size={18} className="text-primary-text" />
        </div>
        {task.checker ? (
          <>
            <p className="leading-relaxed text-muted-foreground">{task.checker.text}</p>
            <p className="text-xs text-muted-foreground mt-2">
              {task.checker.verdict === "passed"
                ? "Technical check passed; anatomical decisions remain separate."
                : "Reviewer judgment still required."}
            </p>
          </>
        ) : (
          <p className="text-muted-foreground">No second agent checked this task.</p>
        )}
      </section>
      {references.length > 0 && (
        <section>
          <div className="section-heading">
            <h2>Reference comparison</h2>
          </div>
          <table className="references">
            <thead>
              <tr>
                <th scope="col">Parameter / reader</th>
                <th scope="col">Reference</th>
                <th scope="col">Difference</th>
              </tr>
            </thead>
            <tbody>
              {references.map(({ m, reference }) => (
                <tr key={`${m.id}-${reference.reader}`}>
                  <th scope="row">
                    {m.title ?? m.id}
                    <span className="measurement-source">{reference.reader}</span>
                  </th>
                  <td className="font-mono">
                    {reference.value.toFixed(3)}
                    <span className="unit">{m.unit}</span>
                  </td>
                  <td className="font-mono">
                    {m.value !== null && reference.value !== 0
                      ? `${((m.value / reference.value - 1) * 100).toFixed(2)}%`
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-xs text-muted-foreground mt-3">
            Reference comparisons do not change a measurement's review status.
          </p>
        </section>
      )}
      <section>
        <div className="section-heading">
          <h2>Evidence</h2>
          <span className="text-sm text-muted-foreground">{task.evidence.length} files</span>
        </div>
        <div className="evidence-grid">
          {task.evidence.map((asset) => (
            <div id={`evidence-${asset.id}`} key={asset.id} className="scroll-mt-6">
              <Evidence runId={runId} asset={asset} />
            </div>
          ))}
        </div>
      </section>
      <section>
        <div className="section-heading">
          <h2>Data files</h2>
        </div>
        <ul className="file-list">
          {task.files.map((file) => (
            <li key={file.id}>
              <FileLink runId={runId} asset={file} />
            </li>
          ))}
        </ul>
        {task.files.length === 0 && <p className="notice">This task reported no data files.</p>}
      </section>
      <section className="task-assistant">
        <div className="section-heading">
          <h2>Ask about this task</h2>
          <MessageSquare size={17} />
        </div>
        <p className="text-xs text-muted-foreground mb-4">A question never starts a rerun.</p>
        <form className="mt-4" onSubmit={(event) => event.preventDefault()}>
          <label className="sr-only" htmlFor="task-question">
            Question about {task.title}
          </label>
          <textarea
            id="task-question"
            className="text-input"
            placeholder="What needs checking in this result?"
            rows={3}
            maxLength={2000}
            required
            disabled
          />
          <div className="flex justify-between items-center mt-3 gap-2">
            <button type="button" className="text-button text-sm" disabled>
              Why provisional?
            </button>
            <button type="submit" className="button primary compact" disabled>
              Ask question
              <Send size={14} />
            </button>
          </div>
        </form>
      </section>
    </article>
  );
}
