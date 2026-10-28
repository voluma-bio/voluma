/** Task-scoped report and questions. Acceptance never changes scientific confidence. */
import { useMutation } from "@tanstack/react-query";
import { StatusBadge } from "@voluma/ui";
import {
  ArrowUpRight,
  Check,
  CircleAlert,
  FileText,
  ImageOff,
  MessageSquare,
  Send,
  ShieldCheck,
} from "lucide-react";
import { useState } from "react";
import { type Asset, type ReviewRun, type ReviewTask, taskStatus } from "./model";
import type { ReviewService } from "./service";

/** Evidence and files are R2 keys; the API doesn't serve them to the browser yet. */
function Evidence({ asset }: { asset: Asset }) {
  return (
    <div className="evidence-card">
      <div className="evidence-image">
        <ImageOff size={25} strokeWidth={1.3} />
      </div>
      <span className="font-medium">{asset.name}</span>
      <span className="text-xs text-muted-foreground">Image not served yet</span>
    </div>
  );
}

const format = (value: number) =>
  new Intl.NumberFormat("en-US", { maximumFractionDigits: 3 }).format(value);

export function TaskReport({
  task,
  structureName,
  taskNumber,
  runId,
  revisionId,
  readOnly,
  service,
  onResult,
  onCorrect,
}: {
  task: ReviewTask;
  /** A structure id to its name, for To check items that point at structures. */
  structureName(id: string): string;
  taskNumber: number;
  runId: string;
  revisionId: string;
  readOnly: boolean;
  service?: ReviewService;
  onResult(run: ReviewRun): void;
  onCorrect(text: string): void;
}) {
  const [question, setQuestion] = useState("");
  const accept = useMutation({
    mutationFn: (checkId: string) => {
      if (!service) throw new Error("Review commands are not connected.");
      return service.acceptCheck(runId, revisionId, task.id, checkId);
    },
    onSuccess: onResult,
  });
  const ask = useMutation({
    mutationFn: () => {
      if (!service) throw new Error("Review commands are not connected.");
      return service.ask(runId, revisionId, task.id, question);
    },
    onSuccess: (run) => {
      onResult(run);
      setQuestion("");
    },
  });
  const references = task.measurements.flatMap((m) =>
    m.references.map((reference) => ({ m, reference })),
  );
  return (
    <article className="task-report" aria-label={`${task.title} report`}>
      <header>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span className="font-mono">{String(taskNumber).padStart(2, "0")}</span>
          <span>Task report</span>
          <span className="ml-auto">
            <StatusBadge tone={taskStatus[task.status].tone}>
              {taskStatus[task.status].label}
            </StatusBadge>
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
      <section>
        <div className="section-heading">
          <h2>Measurements</h2>
          {task.measurements.some((m) => m.confidence) && (
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
                <td className="text-muted-foreground">{m.unit || "ratio"}</td>
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
                    Not reported{o.required ? " · required" : ""}
                  </span>
                </th>
                <td className="font-mono">—</td>
                <td className="text-muted-foreground">{o.kind}</td>
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
              <h3 className="font-medium">{check.title}</h3>
            </div>
            <p className="mt-2 leading-relaxed">{check.detail}</p>
            {check.focus && check.focus.structureIds.length > 0 && (
              <p className="text-xs text-muted-foreground mt-2">
                About: {check.focus.structureIds.map((id) => structureName(id)).join(", ")}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2 mt-4">
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
              <button
                type="button"
                className="button compact"
                disabled={readOnly || accept.isPending}
                onClick={() => onCorrect(`Review and correct: ${check.title}.`)}
              >
                Request correction
                <ArrowUpRight size={14} />
              </button>
            </div>
          </div>
        ))}
        {accept.error && (
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
              <Evidence asset={asset} />
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
              <FileText size={16} className="shrink-0 text-muted-foreground" />
              <div>
                <p>{file.name}</p>
                <p className="text-xs text-muted-foreground mt-1">Download not served yet</p>
              </div>
            </li>
          ))}
        </ul>
      </section>
      <section className="task-assistant">
        <div className="section-heading">
          <h2>Ask about this task</h2>
          <MessageSquare size={17} />
        </div>
        <p className="text-xs text-muted-foreground mb-4">A question never starts a rerun.</p>
        <form
          className="mt-4"
          onSubmit={(event) => {
            event.preventDefault();
            ask.mutate();
          }}
        >
          <label className="sr-only" htmlFor="task-question">
            Question about {task.title}
          </label>
          <textarea
            id="task-question"
            className="text-input"
            placeholder="What needs checking in this result?"
            rows={3}
            value={question}
            maxLength={2000}
            required
            disabled={readOnly || ask.isPending}
            onChange={(event) => setQuestion(event.target.value)}
          />
          {ask.error && (
            <p role="alert" className="error-message">
              {ask.error.message}
            </p>
          )}
          <div className="flex justify-between items-center mt-3 gap-2">
            <button
              type="button"
              className="text-button text-sm"
              disabled={readOnly}
              onClick={() => setQuestion("Why is this result provisional?")}
            >
              Why provisional?
            </button>
            <button
              type="submit"
              className="button primary compact"
              disabled={readOnly || ask.isPending || !question.trim()}
            >
              {ask.isPending ? "Answering…" : "Ask question"}
              <Send size={14} />
            </button>
          </div>
        </form>
      </section>
    </article>
  );
}
