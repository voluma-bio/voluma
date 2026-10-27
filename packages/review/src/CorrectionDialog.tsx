/** Confirmation gates every rerun. Failure retains the proposal for an idempotent retry. */
import { useMutation } from "@tanstack/react-query";
import type {
  CorrectionProposal,
  ReviewRun,
  ReviewTask,
} from "@voluma/contracts";
import { ArrowRight, Check, LoaderCircle, X } from "lucide-react";
import { Dialog } from "radix-ui";
import { useState } from "react";
import type { ReviewService } from "./service";

export function CorrectionDialog({
  service,
  runId,
  revisionId,
  task,
  tasks,
  initialText,
  onClose,
  onAttempt,
  onResult,
  returnFocus,
}: {
  service: ReviewService;
  runId: string;
  revisionId: string;
  task: ReviewTask;
  tasks: ReviewTask[];
  initialText: string;
  onClose(): void;
  onAttempt(): void;
  onResult(run: ReviewRun): void;
  returnFocus: HTMLElement | null;
}) {
  const [text, setText] = useState(initialText);
  const [proposal, setProposal] = useState<CorrectionProposal | null>(null);
  const propose = useMutation({
    mutationFn: () =>
      service.proposeCorrection({
        runId,
        baseRevisionId: revisionId,
        taskId: task.id,
        instruction: text,
      }),
    onSuccess: setProposal,
  });
  const confirm = useMutation({
    mutationFn: (proposalId: string) => service.confirmCorrection(proposalId),
    onMutate: onAttempt,
    onSuccess: onResult,
  });
  const busy = propose.isPending || confirm.isPending;
  const error = propose.error || confirm.error;
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content
          className="dialog-content"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            returnFocus?.focus();
          }}
          onEscapeKeyDown={(event) => {
            if (busy) event.preventDefault();
          }}
          onPointerDownOutside={(event) => event.preventDefault()}
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm text-muted-foreground mb-2">
                {task.title} / {revisionId.toUpperCase()}
              </p>
              <Dialog.Title className="text-xl font-semibold">
                {confirm.isPending
                  ? "Rerunning affected tasks"
                  : proposal
                    ? "Review correction"
                    : "Request a correction"}
              </Dialog.Title>
            </div>
            <Dialog.Close
              className="icon-button"
              disabled={busy}
              aria-label="Close correction"
            >
              <X size={18} />
            </Dialog.Close>
          </div>
          <Dialog.Description className="text-muted-foreground mt-3">
            This demo records your instruction and returns scripted results. It
            does not interpret anatomy or run an analysis.
          </Dialog.Description>
          {!proposal ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                propose.mutate();
              }}
              className="mt-6 space-y-4"
            >
              <label
                className="block font-medium"
                htmlFor="correction-instruction"
              >
                What should change?
              </label>
              <textarea
                id="correction-instruction"
                className="text-input"
                rows={4}
                maxLength={2000}
                required
                value={text}
                onChange={(event) => setText(event.target.value)}
                disabled={busy}
              />
              {error && (
                <p role="alert" className="error-message">
                  {error.message}
                </p>
              )}
              <div className="flex justify-end gap-2">
                <Dialog.Close className="button" disabled={busy}>
                  Cancel
                </Dialog.Close>
                <button
                  type="submit"
                  className="button primary"
                  disabled={busy || !text.trim()}
                >
                  {busy ? "Preparing…" : "Preview affected tasks"}
                  <ArrowRight size={16} />
                </button>
              </div>
            </form>
          ) : (
            <div className="mt-6 space-y-5">
              <blockquote className="instruction">
                {proposal.instruction}
              </blockquote>
              <div>
                <h3 className="font-medium mb-3">
                  {proposal.affectedTaskIds.length}{" "}
                  {proposal.affectedTaskIds.length === 1
                    ? "task will"
                    : "tasks will"}{" "}
                  rerun
                </h3>
                <ul className="affected-tasks">
                  {proposal.affectedTaskIds.map((id) => (
                    <li key={id}>
                      <span>{tasks.find((item) => item.id === id)?.title}</span>
                      <span className="text-sm text-muted-foreground">
                        {id === task.id
                          ? "Requested change"
                          : "Depends on this result"}
                      </span>
                      {confirm.isPending ? (
                        <LoaderCircle size={16} className="animate-spin" />
                      ) : (
                        <Check size={16} />
                      )}
                    </li>
                  ))}
                </ul>
              </div>
              <p className="text-sm text-muted-foreground">
                Earlier results and their evidence remain available. This
                changes this sample only, not the workflow.
              </p>
              {error && (
                <p role="alert" className="error-message">
                  {error.message}
                </p>
              )}
              {confirm.isPending && (
                <p role="status" className="notice">
                  Simulated rerun in progress. No results have been replaced
                  yet.
                </p>
              )}
              <div className="flex justify-end gap-2">
                <Dialog.Close className="button" disabled={busy}>
                  Cancel
                </Dialog.Close>
                <button
                  type="button"
                  className="button primary"
                  disabled={busy}
                  onClick={() => confirm.mutate(proposal.id)}
                >
                  {confirm.isPending
                    ? "Rerunning…"
                    : confirm.isError
                      ? "Retry rerun"
                      : "Confirm simulated rerun"}
                  <ArrowRight size={16} />
                </button>
              </div>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
