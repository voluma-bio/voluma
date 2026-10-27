/** Task-scoped report and questions. Acceptance never changes scientific confidence. */
import { useMutation } from "@tanstack/react-query";
import type { Asset, ReviewRun, ReviewTask } from "@voluma/contracts";
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
import { Dialog } from "radix-ui";
import { useState } from "react";
import type { ReviewService } from "./service";

function Evidence({ asset }: { asset: Asset }) {
  const [failed, setFailed] = useState(false);
  return (
    <Dialog.Root>
      <Dialog.Trigger asChild>
        <button type="button" className="evidence-card">
          <div className="evidence-image">
            {asset.url && !failed ? (
              <img
                src={asset.url}
                alt={asset.label}
                onError={() => setFailed(true)}
              />
            ) : (
              <ImageOff size={25} strokeWidth={1.3} />
            )}
          </div>
          <span className="font-medium">{asset.label}</span>
          <span className="text-xs text-muted-foreground">
            {asset.url && !failed ? "Open evidence" : "Evidence unavailable"}
            <ArrowUpRight size={13} />
          </span>
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content evidence-dialog">
          <Dialog.Title className="text-xl font-semibold">
            {asset.label}
          </Dialog.Title>
          <Dialog.Description className="mt-3 text-muted-foreground">
            {failed
              ? "The evidence image could not be loaded."
              : asset.unavailableReason ||
                "Evidence attached to this task result."}
          </Dialog.Description>
          {asset.url && !failed ? (
            <img
              className="lightbox-image"
              src={asset.url}
              alt={asset.label}
              onError={() => setFailed(true)}
            />
          ) : (
            <div className="missing-evidence">
              <ImageOff size={40} strokeWidth={1} />
              <p>No scientific image is bundled for this evidence.</p>
            </div>
          )}
          <code className="file-path">{asset.path}</code>
          <div className="mt-6 flex justify-end">
            <Dialog.Close className="button">Close evidence</Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function TaskReport({
  task,
  taskNumber,
  runId,
  revisionId,
  readOnly,
  service,
  onResult,
  onCorrect,
}: {
  task: ReviewTask;
  taskNumber: number;
  runId: string;
  revisionId: string;
  readOnly: boolean;
  service: ReviewService;
  onResult(run: ReviewRun): void;
  onCorrect(text: string): void;
}) {
  const [question, setQuestion] = useState("");
  const accept = useMutation({
    mutationFn: (checkId: string) =>
      service.acceptCheck(runId, revisionId, task.id, checkId),
    onSuccess: onResult,
  });
  const ask = useMutation({
    mutationFn: () => service.ask(runId, revisionId, task.id, question),
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
          <span className="font-mono">
            {String(taskNumber).padStart(2, "0")}
          </span>
          <span>Task report</span>
          <span className="ml-auto">
            Result {task.resultRevisionId.toUpperCase()}
          </span>
        </div>
        <h1 className="text-2xl font-semibold mt-3">{task.title}</h1>
        <p className="text-muted-foreground mt-3 leading-relaxed">{task.ask}</p>
      </header>
      <section>
        <div className="section-heading">
          <h2>Measurements</h2>
          <span className="badge warning">Provisional</span>
        </div>
        <p className="text-xs text-muted-foreground mb-3">
          Demo fixture. Missing values are not zero. Values link to their
          evidence.
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
                  <a href={`#evidence-${m.evidenceIds[0]}`}>
                    {m.label}
                    <ArrowUpRight size={12} />
                  </a>
                  <span className="measurement-source">
                    {m.origin === "synthetic"
                      ? "Synthetic demo value"
                      : m.origin === "unavailable"
                        ? "Not supplied"
                        : "Documented fixture"}
                    {m.status === "candidate" ? " · Candidate" : ""}
                  </span>
                </th>
                <td className="font-mono">
                  {m.value === null
                    ? "—"
                    : new Intl.NumberFormat("en-US", {
                        maximumFractionDigits: 3,
                      }).format(m.value)}
                </td>
                <td className="text-muted-foreground">{m.unit || "ratio"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section>
        <div className="section-heading">
          <h2>To check</h2>
          <span className="text-sm text-muted-foreground">
            {task.checks.filter((c) => c.status === "open").length} open
          </span>
        </div>
        {task.checks.length === 0 && (
          <p className="notice">No checks were raised for this task.</p>
        )}
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
            <div className="flex flex-wrap items-center gap-2 mt-4">
              {check.status === "accepted" ? (
                <span className="font-medium text-primary">
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
          <ShieldCheck size={18} className="text-primary" />
        </div>
        <p className="leading-relaxed text-muted-foreground">
          {task.checker.text}
        </p>
        <p className="text-xs text-muted-foreground mt-2">
          {task.checker.verdict === "passed"
            ? "Technical check passed; anatomical decisions remain separate."
            : "Reviewer judgment still required."}
        </p>
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
                    {m.label}
                    <span className="measurement-source">
                      {reference.reader}
                    </span>
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
            Reader values are documented in the mockup. Demo measurements are
            not a validation result.
          </p>
        </section>
      )}
      <section>
        <div className="section-heading">
          <h2>What the agent did</h2>
        </div>
        <ol className="actions-list">
          {task.actions.map((action) => (
            <li key={action}>{action}</li>
          ))}
        </ol>
      </section>
      <section>
        <div className="section-heading">
          <h2>Evidence</h2>
          <span className="text-sm text-muted-foreground">
            {task.evidence.length} checkpoints
          </span>
        </div>
        <div className="evidence-grid">
          {task.evidence.map((asset) => (
            <div
              id={`evidence-${asset.id}`}
              key={asset.id}
              className="scroll-mt-6"
            >
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
                <p>{file.label}</p>
                <code className="file-path">{file.path}</code>
                <p className="text-xs text-muted-foreground mt-1">
                  {file.unavailableReason}
                </p>
              </div>
              {file.url && (
                <a
                  className="text-primary"
                  href={file.url}
                  download
                  aria-label={`Download ${file.label}`}
                >
                  <ArrowUpRight size={16} />
                </a>
              )}
            </li>
          ))}
        </ul>
      </section>
      <section className="task-assistant">
        <div className="section-heading">
          <h2>Ask about this task</h2>
          <MessageSquare size={17} />
        </div>
        <p className="text-xs text-muted-foreground mb-4">
          Scripted answers in this demo. A question never starts a rerun.
        </p>
        <div className="space-y-3" aria-live="polite">
          {task.messages.map((message) => (
            <div key={message.id} className={`message ${message.role}`}>
              <p className="font-medium text-xs mb-1">
                {message.role === "user" ? "You" : "Demo assistant"}
              </p>
              <p>{message.text}</p>
            </div>
          ))}
        </div>
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
