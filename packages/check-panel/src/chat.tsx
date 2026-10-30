/**
 * The chat with the run's AI beside the viewer: the run's conversation (`conversation` over the
 * run's event stream, live), the note box with the marks for the next message as chips, Send
 * (with a PNG of the view), and "Go ahead" once the AI has answered. Only the run's starter
 * talks to a finished run; everyone else sees one line saying why.
 */
import { type UseQueryResult, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ApiError,
  cancelRun,
  runMessageSnapshotUrl,
  sendRunMessage,
  subscribe,
} from "@voluma/api-client";
import type { Me } from "@voluma/contracts/auth";
import { type ConversationItem, conversation } from "@voluma/contracts/conversation";
import type { RunEvent } from "@voluma/contracts/events";
import { corrections } from "@voluma/contracts/fold";
import { MAX_MESSAGE_SNAPSHOT_BYTES, type Mark } from "@voluma/contracts/messages";
import type { ReviewRun } from "@voluma/contracts/review";
import type { Run } from "@voluma/contracts/run";
import { Button } from "@voluma/ui";
import { type StreamClosed, useStreamReopen, waitingOnYou } from "@voluma/ui/run";
import type { GridViewerHandle } from "@voluma/viewer/grid";
import { X } from "lucide-react";
import { type RefObject, useEffect, useMemo, useRef, useState } from "react";

/** A correction that failed or was stopped; the run kept its earlier results. */
type Stopped = {
  from: "stop";
  id: string;
  seq: number;
  cancelled: boolean;
  /** It was redoing a task (a go), not answering a note. */
  redo: boolean;
  error?: string;
};

/**
 * The chat as the stream has told it so far: the conversation with each abandoned correction's
 * end in place, and the latest correction unless it was abandoned (`corrections` in
 * `@voluma/contracts/fold`, the one reader of correction state).
 */
function chatLog(events: readonly RunEvent[]) {
  const { spans, open } = corrections(events);
  const stops = spans.flatMap((span): Stopped[] => {
    const e = events[span.to];
    if (span.closed !== "abandoned" || e?.type !== "correction.ended") return [];
    return [
      {
        from: "stop",
        id: e.id,
        seq: e.seq,
        cancelled: e.payload.status === "cancelled",
        redo: span.go !== undefined,
        ...(e.payload.error && { error: e.payload.error }),
      },
    ];
  });
  const items: (ConversationItem | Stopped)[] = [...conversation(events), ...stops].sort(
    (x, y) => x.seq - y.seq,
  );
  return { items, open, reopened: spans.length > 0 };
}

export type RunChat = ReturnType<typeof useRunChat>;

/**
 * The run's chat, live, while `on` (off: the chat isn't shown, no stream). One stream per run,
 * held by the panel so stepping between items doesn't replay the log. The stream closes when a
 * claim ends and opens again from where it stopped once a newer read of `run` says the run
 * isn't ended (`useStreamReopen`). `onActivity` hears of every event.
 */
export function useRunChat(
  runId: string,
  run: UseQueryResult<Run>,
  on: boolean,
  onActivity: () => void,
) {
  const [stream, setStream] = useState<{ runId: string; events: RunEvent[] }>({
    runId,
    events: [],
  });
  const [closed, setClosed] = useState<StreamClosed | null>(null);
  const [generation, setGeneration] = useState(0);
  const after = useRef({ runId, seq: 0 });
  const failures = useRef(0);
  const latest = useRef({ onActivity, refetch: run.refetch });
  latest.current = { onActivity, refetch: run.refetch };
  // biome-ignore lint/correctness/useExhaustiveDependencies: `generation` reopens the stream.
  useEffect(() => {
    if (!on) return;
    if (after.current.runId !== runId) {
      after.current = { runId, seq: 0 };
      failures.current = 0;
    }
    setClosed(null);
    // Buffer the replay of a long run's log: one render per animation frame, not per event.
    let pending: RunEvent[] = [];
    let frame = 0;
    const flush = () => {
      frame = 0;
      const batch = pending;
      pending = [];
      setStream((s) => ({ runId, events: s.runId === runId ? [...s.events, ...batch] : batch }));
      latest.current.onActivity();
    };
    const close = subscribe(
      runId,
      {
        onEvent(e) {
          after.current.seq = e.seq;
          failures.current = 0;
          pending.push(e);
          frame ||= requestAnimationFrame(flush);
        },
        onClosed(error) {
          failures.current = error ? failures.current + 1 : 0;
          setClosed({ at: Date.now(), failures: failures.current });
          void latest.current.refetch({ cancelRefetch: false });
          latest.current.onActivity();
        },
      },
      after.current.seq,
    );
    return () => {
      cancelAnimationFrame(frame);
      if (pending.length) flush();
      close();
    };
  }, [runId, generation, on]);
  const [reopen] = useState(() => () => setGeneration((g) => g + 1));
  useStreamReopen(on ? closed : null, run.data?.state.status, run.dataUpdatedAt, reopen);
  const events = stream.runId === runId ? stream.events : NO_EVENTS;
  const log = useMemo(() => chatLog(events), [events]);
  return { events, log };
}

const NO_EVENTS: RunEvent[] = [];

/**
 * Why this run's AI can't be asked here, or null when it may be. A run still on its first pass
 * is told apart from a reopened one by the log (`reopened`): its `Run.review` is null
 * either way.
 */
export function chatBlocked(run: Run, me: Me | null): string | null {
  if (run.example) return "This is an example run, so the AI can't change it.";
  if (run.credentials === "visitor")
    return "Runs on your own model keys can't be reopened yet, so the AI can't change this one.";
  if (!me) return "Sign in to ask this run's AI to change it.";
  if (me.userId !== run.startedBy)
    return "Only the person who started this run can ask its AI to change it.";
  if (run.state.status === "ended" && run.state.outcome !== "completed")
    return "This run didn't finish, so it can't be reopened. Start a new run to try again.";
  return null;
}

export const markLabel = (mark: Mark) =>
  mark.point
    ? `Point z ${mark.point[0]}, y ${mark.point[1]}, x ${mark.point[2]}`
    : `Box z ${mark.box!.min[0]}–${mark.box!.max[0]}, y ${mark.box!.min[1]}–${mark.box!.max[1]}, x ${mark.box!.min[2]}–${mark.box!.max[2]}`;

export function Chat({
  run,
  review,
  taskId,
  marks,
  onMarksSent,
  removeMark,
  viewer,
  chat,
  onRunChanged,
}: {
  run: Run;
  review: ReviewRun;
  /** The item's task: what a note is about. */
  taskId: string;
  /** Marked in the viewer, for the next message. */
  marks: Mark[];
  onMarksSent: () => void;
  removeMark: (index: number) => void;
  /** The viewer, for a snapshot of the view; null when none is shown. */
  viewer: RefObject<GridViewerHandle | null>;
  chat: RunChat;
  /** A send or a cancel changed the run's state. */
  onRunChanged: () => void;
}) {
  const client = useQueryClient();
  const { log, events } = chat;
  const [note, setNote] = useState("");
  // One id per message, kept across retries of it so a retry stores nothing twice; another
  // message (new text or marks, or a go) gets its own.
  const message = useRef<{ key: string; id: string }>(undefined);
  const idFor = (key: string) => {
    if (message.current?.key !== key) message.current = { key, id: crypto.randomUUID() };
    return message.current.id;
  };
  // Set when a note went without the view: its picture was over the size limit.
  const [noPicture, setNoPicture] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);

  const { items, open } = log;
  // A go redoes the task the open correction's note was about, whichever item is on screen.
  const asked = open && items.find((i) => i.id === open.message);
  const goTask = (asked?.from === "person" && asked.taskId) || taskId;

  const send = useMutation({
    mutationFn: async ({ go }: { go: boolean }) => {
      const text = note.trim();
      const id = idFor(go ? `go:${goTask}` : JSON.stringify([text, marks]));
      const blob = go ? null : await viewer.current?.snapshot(MAX_MESSAGE_SNAPSHOT_BYTES);
      const response = await sendRunMessage(run.id, {
        id,
        ...(go ? { taskId: goTask, go: true } : { taskId, text }),
        ...(!go && marks.length > 0 && { marks }),
        ...(blob && { snapshot: { mimeType: "image/png", data: await base64(blob) } }),
      });
      return { response, noPicture: !go && blob === null };
    },
    onSuccess: ({ response, noPicture }, { go }) => {
      client.setQueryData<Run>(["run", run.id], (r) => r && { ...r, state: response.state });
      onRunChanged();
      message.current = undefined;
      setNoPicture(noPicture);
      if (!go) {
        setNote("");
        onMarksSent();
      }
    },
    // A conflict may mean the run moved on (it is answering already): read it again.
    onError: () => void client.invalidateQueries({ queryKey: ["run", run.id] }),
  });

  // Abandons the correction: its threads end, its files are restored, the run keeps its
  // earlier results.
  const cancel = useMutation({
    mutationFn: () => cancelRun(run.id),
    onSuccess: (next) => {
      client.setQueryData<Run>(["run", run.id], next);
      onRunChanged();
    },
  });

  const active = run.state.status === "queued" || run.state.status === "running";
  // The latest correction asked for a go: the task is being redone, or was.
  const go = open?.go;
  const redoing = active && go !== undefined;
  const redone = !active && go?.redone === true;
  const waiting = useMemo(() => waitingOnYou(run.state.status, events), [run.state.status, events]);
  const titleOf = (id: string) => review.revisions.at(-1)?.tasks.find((t) => t.id === id)?.title;

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when the chat grows.
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "nearest" });
  }, [items.length, active]);

  let status: string | undefined;
  if (send.isPending) status = "Sending…";
  else if (redoing)
    status = `Redoing ${titleOf(go.taskId) ?? "the task"}. The new result shows here when it's checked.`;
  else if (active) status = "The AI is answering…";
  else if (redone)
    status = `Redone ${titleOf(go.taskId) ?? "the task"}. Its new result is in To check.`;
  else if (waiting) status = "Waiting on you";

  return (
    <section className="flex flex-col gap-3" aria-label="Talk to the run's AI">
      <h3 className="text-meta font-semibold text-muted-foreground">Ask the run's AI</h3>
      {items.length > 0 && (
        <ol className="flex flex-col gap-2.5">
          {items.map((item) => (
            <li key={item.id}>
              {item.from === "agent" ? (
                <p className="text-ui whitespace-pre-wrap text-foreground">{item.text}</p>
              ) : item.from === "stop" ? (
                <p role="alert" className="text-ui text-destructive">
                  {stoppedText(item)} The run keeps its earlier results.
                </p>
              ) : (
                <Said
                  item={item}
                  runId={run.id}
                  about={item.taskId !== taskId && item.taskId ? titleOf(item.taskId) : undefined}
                />
              )}
            </li>
          ))}
        </ol>
      )}
      {noPicture && !send.isPending && (
        <p role="status" className="text-meta text-muted-foreground">
          The view was too large to attach, so your last message went without a picture.
        </p>
      )}
      {status && (
        <p
          role="status"
          className={`text-ui ${redoing ? "text-info" : waiting ? "font-medium text-foreground" : "text-muted-foreground"}`}
        >
          {status}
        </p>
      )}
      {waiting && go === undefined && (
        <div className="flex flex-col gap-1.5">
          <Button
            variant="primary"
            size="sm"
            disabled={send.isPending}
            onClick={() => send.mutate({ go: true })}
          >
            Go ahead
          </Button>
          <p className="text-meta text-muted-foreground">
            The AI redoes {titleOf(goTask) ?? "the task"} as a new attempt; the current one is kept.
          </p>
        </div>
      )}
      <form
        className="flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (note.trim()) send.mutate({ go: false });
        }}
      >
        {marks.length > 0 && (
          <ul className="flex flex-wrap gap-1.5" aria-label="Marks for this message">
            {marks.map((mark, i) => (
              <li
                key={markLabel(mark)}
                className="flex items-center gap-1 rounded-full border border-border bg-muted py-0.5 pr-1 pl-2 font-mono text-meta"
              >
                <span aria-hidden className="size-2 rounded-full bg-mark" />
                {markLabel(mark)}
                <button
                  type="button"
                  aria-label={`Remove ${markLabel(mark)}`}
                  className="rounded-full p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                  onClick={() => removeMark(i)}
                >
                  <X size={13} />
                </button>
              </li>
            ))}
          </ul>
        )}
        <label className="sr-only" htmlFor="chat-note">
          Note to the AI
        </label>
        <textarea
          id="chat-note"
          rows={3}
          value={note}
          placeholder="What looks wrong here?"
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey))
              e.currentTarget.form?.requestSubmit();
          }}
          className="w-full resize-y rounded-md border border-input bg-card px-2.5 py-2 text-ui text-foreground placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        />
        <div className="flex items-center justify-end gap-2">
          {(send.isError || cancel.isError) && (
            <p role="alert" className="mr-auto text-meta text-destructive">
              {send.error
                ? sendError(send.error, active)
                : `Couldn't cancel: ${cancel.error?.message}`}
            </p>
          )}
          {active && (
            <Button size="sm" disabled={cancel.isPending} onClick={() => cancel.mutate()}>
              {redoing ? "Cancel the redo" : "Cancel"}
            </Button>
          )}
          {/* One message per claim: the draft waits while the AI answers. */}
          <Button type="submit" size="sm" disabled={!note.trim() || send.isPending || active}>
            Send
          </Button>
        </div>
      </form>
      <div ref={bottom} />
    </section>
  );
}

function Said({
  item,
  runId,
  about,
}: {
  item: Extract<ConversationItem, { from: "person" }>;
  runId: string;
  /** Another task's title, when the message was about that one. */
  about?: string;
}) {
  return (
    <div className="ml-6 flex flex-col gap-1.5 rounded-lg bg-muted px-3 py-2">
      {about && <p className="text-meta text-muted-foreground">About {about}</p>}
      {item.go ? (
        <p className="text-ui font-medium text-foreground">Go ahead</p>
      ) : (
        <p className="text-ui whitespace-pre-wrap text-foreground">{item.text}</p>
      )}
      {item.marks.length > 0 && (
        <ul className="flex flex-col gap-0.5 font-mono text-meta text-muted-foreground">
          {item.marks.map((mark) => (
            <li key={markLabel(mark)} className="flex items-center gap-1.5">
              <span aria-hidden className="size-2 shrink-0 rounded-full bg-mark" />
              {markLabel(mark)}
            </li>
          ))}
        </ul>
      )}
      {item.hasSnapshot && (
        <img
          src={runMessageSnapshotUrl(runId, item.messageId)}
          alt="The view sent with this message"
          className="max-h-28 self-start rounded border border-border"
        />
      )}
    </div>
  );
}

function stoppedText(item: Stopped) {
  const what = item.redo ? "The redo" : "The AI's answer";
  const head = `${what} ${item.cancelled ? "was stopped" : "failed"}`;
  return item.error ? `${head}: ${item.error.replace(/\.$/, "")}.` : `${head}.`;
}

/** A blob's bytes as plain base64 (not a data URL). */
async function base64(blob: Blob): Promise<string> {
  const url = await new Promise<string>((done, fail) => {
    const reader = new FileReader();
    reader.onload = () => done(reader.result as string);
    reader.onerror = () => fail(reader.error);
    reader.readAsDataURL(blob);
  });
  return url.slice(url.indexOf(",") + 1);
}

/** `active`: the run is queued or running, which is what a conflict on a send usually means. */
function sendError(error: Error, active: boolean) {
  if (error instanceof ApiError && error.status === 409 && active)
    return "The AI is still answering your last message. Wait for its reply, or cancel it.";
  if (error instanceof ApiError && error.detail) return error.detail;
  if (error instanceof ApiError && error.status === 403)
    return "You can't change this run: only its starter can, and never an example.";
  if (error instanceof ApiError && error.status === 413) return "The view snapshot is too large.";
  return `Couldn't send: ${error.message}`;
}
