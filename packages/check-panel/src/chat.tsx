/**
 * The chat with the run's AI beside the viewer: the run's conversation (`conversation` over the
 * run's event stream, live), the note box with the marks for the next message as chips, Send
 * (with a PNG of the view), and "Go ahead" once the AI has answered. Only the run's starter
 * talks to a finished run; everyone else sees one line saying why.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
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
import { MAX_MESSAGE_SNAPSHOT_BYTES, type Mark } from "@voluma/contracts/messages";
import type { ReviewRun } from "@voluma/contracts/review";
import type { Run } from "@voluma/contracts/run";
import { Button } from "@voluma/ui";
import type { GridViewerHandle } from "@voluma/viewer/grid";
import { X } from "lucide-react";
import { type RefObject, useEffect, useRef, useState } from "react";

/** A correction claim that failed or was stopped; the run kept its earlier results. */
type Stopped = {
  from: "stop";
  id: string;
  seq: number;
  cancelled: boolean;
  /** It was redoing a task (a go), not answering a note. */
  redo: boolean;
  error?: string;
};

/** The chat as the stream has told it so far. */
type ChatLog = {
  items: (ConversationItem | Stopped)[];
  /** The root thread, whose `thread.ended` ends each claim of the run. */
  root?: string;
  /** The `seq` of the latest claim end (the root's end or a `correction.ended`), 0 for none. */
  endedAt: number;
  /** A message has reopened the run: it is being corrected, not on its first pass. */
  reopened: boolean;
};

const EMPTY: ChatLog = { items: [], endedAt: 0, reopened: false };

function fold(log: ChatLog, e: RunEvent): ChatLog {
  if (e.type === "person.message" || e.type === "reply")
    return { ...log, items: [...log.items, ...conversation([e])] };
  if (e.type === "correction.ended")
    return {
      ...log,
      endedAt: e.seq,
      items: [
        ...log.items,
        {
          from: "stop",
          id: e.id,
          seq: e.seq,
          cancelled: e.payload.status === "cancelled",
          redo: log.items.filter((i) => i.from === "person").at(-1)?.go === true,
          ...(e.payload.error && { error: e.payload.error }),
        },
      ],
    };
  if (e.type === "run.reopened") return { ...log, reopened: true };
  if (e.type === "thread.started" && e.payload.kind === "supervisor" && !log.root)
    return { ...log, root: e.threadId };
  if (e.type === "thread.ended" && e.threadId === log.root) return { ...log, endedAt: e.seq };
  return log;
}

export type RunChat = ReturnType<typeof useRunChat>;

/**
 * The run's chat, live, while `run` is given (null: the chat isn't shown, no stream). The stream
 * closes when a claim ends; it opens again from where it stopped once the run is no longer
 * ended (a message reopened it). `onActivity` hears of every event.
 */
export function useRunChat(runId: string, run: Run | null, onActivity: () => void) {
  const [log, setLog] = useState<ChatLog>(EMPTY);
  const [closed, setClosed] = useState(false);
  const [generation, setGeneration] = useState(0);
  const after = useRef(0);
  const latest = useRef(onActivity);
  latest.current = onActivity;
  const on = run !== null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `generation` reopens the stream.
  useEffect(() => {
    if (!on) return;
    // Buffer the replay of a long run's log: one render per animation frame, not per event.
    let pending: RunEvent[] = [];
    let frame = 0;
    const flush = () => {
      frame = 0;
      const events = pending;
      pending = [];
      setLog((l) => events.reduce(fold, l));
      latest.current();
    };
    const close = subscribe(
      runId,
      {
        onEvent(e) {
          after.current = e.seq;
          pending.push(e);
          frame ||= requestAnimationFrame(flush);
        },
        onClosed() {
          setClosed(true);
          latest.current();
        },
      },
      after.current,
    );
    return () => {
      cancelAnimationFrame(frame);
      if (pending.length) flush();
      close();
    };
  }, [runId, generation, on]);
  const reconnect = () => {
    if (!closed) return;
    setClosed(false);
    setGeneration((g) => g + 1);
  };
  // A note sent mid-claim queues the run again at once; a send reopens an ended one.
  const status = run?.state.status;
  // biome-ignore lint/correctness/useExhaustiveDependencies: reconnect is fresh each render.
  useEffect(() => {
    if (closed && status !== undefined && status !== "ended") reconnect();
  }, [closed, status]);
  return { log, reconnect };
}

/**
 * Why this run's AI can't be asked here, or null when it may be. A run still on its first pass
 * is told apart from a reopened one by the log (`ChatLog.reopened`): its `Run.review` is null
 * either way.
 */
export function chatBlocked(run: Run, me: Me | null): string | null {
  if (run.example) return "This is an example run, so the AI can't change it.";
  if (run.credentials === "visitor")
    return "Runs on your own model keys can't be reopened yet, so the AI can't change this one.";
  if (me && me.userId !== run.startedBy)
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
}: {
  run: Run;
  review: ReviewRun;
  taskId: string;
  /** Marked in the viewer, for the next message. */
  marks: Mark[];
  onMarksSent: () => void;
  removeMark: (index: number) => void;
  /** The viewer, for a snapshot of the view; null when none is shown. */
  viewer: RefObject<GridViewerHandle | null>;
  chat: RunChat;
}) {
  const client = useQueryClient();
  const { log } = chat;
  const [note, setNote] = useState("");
  // Kept across retries of one message, so a retry stores nothing twice.
  const [messageId, setMessageId] = useState(() => crypto.randomUUID());
  const bottom = useRef<HTMLDivElement>(null);

  const send = useMutation({
    mutationFn: async ({ go }: { go: boolean }) => {
      const blob = go ? null : await viewer.current?.snapshot(MAX_MESSAGE_SNAPSHOT_BYTES);
      return sendRunMessage(run.id, {
        id: messageId,
        taskId,
        ...(go ? { go: true } : { text: note.trim() }),
        ...(!go && marks.length > 0 && { marks }),
        ...(blob && { snapshot: { mimeType: "image/png", data: await base64(blob) } }),
      });
    },
    onSuccess: (response, { go }) => {
      client.setQueryData<Run>(["run", run.id], (r) => r && { ...r, state: response.state });
      setMessageId(crypto.randomUUID());
      if (!go) {
        setNote("");
        onMarksSent();
      }
    },
  });

  // Abandons the correction: its threads end, its files are restored, the run keeps its
  // earlier results.
  const cancel = useMutation({
    mutationFn: () => cancelRun(run.id),
    onSuccess: (next) => client.setQueryData<Run>(["run", run.id], next),
  });

  const { items } = log;
  const last = items.at(-1);
  const active = run.state.status === "queued" || run.state.status === "running";
  const said = items.filter(
    (i): i is Extract<ConversationItem, { from: "person" }> => i.from === "person",
  );
  const lastGo = said.filter((i) => i.go).at(-1);
  // A go whose claim hasn't ended yet: the task is being redone.
  const redoing = active && lastGo !== undefined && lastGo.seq > log.endedAt;
  const lastPerson = said.at(-1);
  // The AI has answered a note: it waits for another note, or a go.
  const waiting = !active && last?.from === "agent" && lastPerson?.go === false;
  const redone = !active && lastPerson?.go === true;
  const titleOf = (id: string) => review.revisions.at(-1)?.tasks.find((t) => t.id === id)?.title;

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when the chat grows.
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "nearest" });
  }, [items.length, active]);

  let status: string | undefined;
  if (send.isPending) status = "Sending…";
  else if (redoing)
    status = `Redoing ${titleOf(lastGo.taskId ?? taskId) ?? "the task"}. The new result shows here when it's checked.`;
  else if (active) status = "The AI is answering…";
  else if (waiting) status = "Waiting on you";
  else if (redone)
    status = `Redone ${titleOf(lastPerson.taskId ?? taskId) ?? "the task"}. Its new result is in To check.`;

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
      {status && (
        <p
          role="status"
          className={`text-ui ${redoing ? "text-info" : waiting ? "font-medium text-foreground" : "text-muted-foreground"}`}
        >
          {status}
        </p>
      )}
      {waiting && (
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
            The AI redoes {titleOf(taskId) ?? "this task"} as a new attempt; the current one is
            kept.
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
              {send.error ? sendError(send.error) : `Couldn't cancel: ${cancel.error?.message}`}
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
      {item.snapshotKey && (
        <img
          // The event id is `<runId>.person:<the id the panel sent>`.
          src={runMessageSnapshotUrl(runId, item.id.slice(item.id.indexOf(".person:") + 8))}
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

function sendError(error: Error) {
  if (error instanceof ApiError && error.status === 403)
    return "You can't change this run: only its starter can, and never an example.";
  if (error instanceof ApiError && error.status === 409)
    return "The AI is still answering your last message. Wait for its reply, or cancel it.";
  if (error instanceof ApiError && error.status === 413) return "The view snapshot is too large.";
  return `Couldn't send: ${error.message}`;
}
