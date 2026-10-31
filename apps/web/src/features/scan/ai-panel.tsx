/**
 * The AI: the conversation with this run's lead AI, read from the run's events
 * (`conversation`), and a box to write to it (`sendRunMessage`). A message is about the task in
 * view, or the item's task after Something's wrong; "The AI sees" names what goes with it: the
 * scan, the task, a picture of the views as they show (`snapshot`) and your marks. A
 * message reopens a finished run for one answer: the AI talks it through and, when a redo would
 * help, offers one (`reply.offer`); "Yes, redo <task>" under its latest reply accepts it (`go`).
 * Who may write, and when, is the API's rule (`messages.ts`); the box says why it is off.
 */
import { useMutation } from "@tanstack/react-query";
import { ApiError, sendRunMessage } from "@voluma/api-client";
import type { Me } from "@voluma/contracts/auth";
import { conversation } from "@voluma/contracts/conversation";
import {
  MAX_MESSAGE_SNAPSHOT_BYTES,
  MESSAGE_BODY_BYTES,
  type SendRunMessageRequest,
} from "@voluma/contracts/messages";
import type { Run } from "@voluma/contracts/run";
import { Markdown, type TaskView, useEvents } from "@voluma/run-view";
import { Button, Chip, EmptyState, StatusMark, TextAreaField } from "@voluma/ui";
import { RotateCcw, Send } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { describe, type YourMark } from "./marks-panel";

/** Why this person can't write to the run's AI now, or nothing when they can. */
function closedBecause(run: Run, me: Me): string | undefined {
  if (run.example) return "Example runs can't be changed.";
  if (run.startedBy !== me.userId)
    return "Only the person who started this run can write to its AI.";
  if (run.credentials === "visitor") return "A run on your own keys can't be reopened.";
  if (me.kind === "visitor") return "Guests can't reopen runs on Voluma's keys.";
  if (run.state.status !== "ended") return "The AI is working. You can write once it finishes.";
  if (run.state.outcome !== "completed")
    return "This run didn't finish, so its AI can't be reopened.";
  return undefined;
}

/** The API's refusal in plain words (a 403 or 409 carries the server's own); the text stays in the box. */
function refusal(error: Error): string {
  const status = error instanceof ApiError ? error.status : undefined;
  if (status === 409)
    return (
      (error as ApiError).serverMessage ??
      "The AI is still answering, or the run can't be reopened. Try again once it finishes."
    );
  if (status === 403)
    return (error as ApiError).serverMessage ?? "You can't write to this run's AI.";
  if (status === 429) return "Too many runs are going right now. Try again shortly.";
  return "Couldn't send. Check your connection and try again.";
}

/** PNG bytes as plain base64, as the message takes them. */
async function base64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

/**
 * The message being written to the run's AI: its words, its id and its send. The page holds it, so
 * closing the panel mid-message or mid-send loses nothing and can't send it twice.
 */
export function useMessage({
  run,
  me,
  tasks,
  task,
  about,
  marks,
  snapshot,
  viewKey,
  itemId,
  onSent,
}: {
  run: Run;
  me: Me;
  tasks: TaskView[];
  /** The task in view. */
  task: TaskView | undefined;
  /** Set by Something's wrong: the message is about this task. */
  about: { taskId: string } | undefined;
  /** Your marks on the subject's views: the next message carries them. */
  marks: readonly YourMark[];
  /**
   * The subject's views as one PNG of at most this many bytes: null when even the smallest is
   * larger, undefined when they aren't shown (also as the function's answer).
   */
  snapshot: ((maxBytes: number) => Promise<Blob | null | undefined>) | undefined;
  /** Identity of the image/grid being captured, independent of the current camera. */
  viewKey: string | undefined;
  /** The To check item open on the subject task, so the AI knows which one you mean. */
  itemId: string | undefined;
  /** The run reopened: reconnect its stream. `marks`: the ids of the marks the message carried. */
  onSent: (marks: string[]) => void;
}) {
  const subject = tasks.find((t) => t.id === (about?.taskId ?? task?.id));
  const [text, setText] = useState("");
  // The API deduplicates by id alone. A retry must keep the entire request, including its PNG.
  const tried = useRef<{
    fingerprint: string;
    note: string;
    marks: string[];
    prepared: Promise<{ body: SendRunMessageRequest; unseen: boolean }>;
  }>(undefined);
  const inFlight = useRef(false);
  // A message without the picture it meant to carry says so once sent.
  const [unseen, setUnseen] = useState(false);
  const send = useMutation({
    mutationFn: async (attempt: NonNullable<typeof tried.current>) => {
      const { body, unseen } = await attempt.prepared;
      await sendRunMessage(run.id, body);
      return { note: attempt.note, marks: attempt.marks, unseen };
    },
    onSuccess: (sent) => {
      // Words typed while it was sending stay.
      if (sent.note) setText((now) => (now.trim() === sent.note ? "" : now));
      setUnseen(sent.unseen);
      tried.current = undefined;
      onSent(sent.marks);
    },
    onSettled: () => {
      inFlight.current = false;
    },
  });
  const closed = closedBecause(run, me);
  /** Sends the words, or with `redo` accepts the AI's offer to redo that task (a `go`, nothing else). */
  const submit = (redo?: string) => {
    const go = redo !== undefined;
    if (closed !== undefined || inFlight.current || (!go && !text.trim())) return;
    inFlight.current = true;
    const note = go ? "" : text.trim();
    const carried = !go && subject ? marks : [];
    const fields = go
      ? { taskId: redo, go: true as const }
      : {
          text: note,
          ...(subject && { taskId: subject.id }),
          ...(subject && itemId && { itemId }),
          ...(carried.length > 0 && { marks: carried.map((m) => m.mark) }),
        };
    const fingerprint = JSON.stringify({
      ...fields,
      marks: carried,
      viewKey: !go && snapshot ? viewKey : undefined,
    });
    if (tried.current?.fingerprint !== fingerprint) {
      // Marks name a block of the task's results, so they go only with a task; a redo takes none.
      const body: SendRunMessageRequest = { id: crypto.randomUUID(), ...fields };
      // A redo has nothing to show the AI; a message carries the views as they are, in the room
      // the rest of the body leaves (base64 is 4 bytes per 3, plus the field's own JSON).
      const room = Math.floor(
        ((MESSAGE_BODY_BYTES - new Blob([JSON.stringify(body)]).size - 64) * 3) / 4,
      );
      // Invoke capture before mutate: a mutation can pause offline while the user changes tasks.
      const picture =
        go || !snapshot
          ? Promise.resolve(undefined)
          : room > 0
            ? snapshot(Math.min(MAX_MESSAGE_SNAPSHOT_BYTES, room))
            : Promise.resolve(null);
      const attempt = {
        fingerprint,
        note,
        marks: carried.map((m) => m.id),
        prepared: picture.then(async (png) => ({
          body: {
            ...body,
            ...(png && { snapshot: { mimeType: "image/png" as const, data: await base64(png) } }),
          },
          unseen: png === null,
        })),
      };
      // Preparation failures made no request: allow the next click to capture again.
      void attempt.prepared.catch(() => {
        if (tried.current === attempt) tried.current = undefined;
      });
      tried.current = attempt;
    }
    send.mutate(tried.current);
  };
  return { subject, text, setText, send, unseen, submit, closed };
}

export function AiPanel({
  run,
  scan,
  tasks,
  about,
  marks,
  views,
  message: { subject, text, setText, send, unseen, submit, closed },
}: {
  run: Run;
  scan: string;
  tasks: TaskView[];
  /** Set by Something's wrong: the box takes focus. */
  about: { taskId: string; at: number } | undefined;
  /** Your marks the next message carries, shown under "The AI sees". */
  marks: readonly YourMark[];
  /** The views are shown, so the message carries a picture of them. */
  views: boolean;
  message: ReturnType<typeof useMessage>;
}) {
  const events = useEvents();
  const items = useMemo(() => conversation(events), [events]);
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (about) form.current?.querySelector("textarea")?.focus();
  }, [about]);
  const closedId = useId();
  const answering =
    run.state.status !== "ended" && items.length > 0 && items.at(-1)?.from === "person";

  const log = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = log.current;
    if (el && items.length > 0) el.scrollTop = el.scrollHeight;
  }, [items.length]);

  return (
    <div className="flex h-full flex-col">
      <p className="flex flex-wrap items-center gap-1 border-b border-border px-3 py-2 text-xs text-muted-foreground">
        <span className="mr-0.5">The AI sees</span>
        <Chip>{scan}</Chip>
        {subject && <Chip>{subject.title}</Chip>}
        {views && <Chip>the views</Chip>}
        {marks.length === 0 ? (
          <Chip>no marks of yours</Chip>
        ) : (
          marks.map((m) => (
            <Chip key={m.id} className="text-mark-mine">
              your {m.tag}
            </Chip>
          ))
        )}
      </p>
      <div ref={log} role="log" className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {items.length === 0 ? (
          <EmptyState title="No messages yet" />
        ) : (
          <ol className="grid gap-3">
            {items.map((m) =>
              m.from === "person" ? (
                <li key={m.id} className="ml-6 grid gap-1 rounded-lg bg-muted px-3 py-2">
                  <span className="text-xs text-muted-foreground">
                    You
                    {m.taskId &&
                      `, about ${tasks.find((t) => t.id === m.taskId)?.title ?? m.taskId}`}
                  </span>
                  {m.text && <p className="text-sm whitespace-pre-wrap">{m.text}</p>}
                  {m.marks.length > 0 && (
                    <span className="flex flex-wrap gap-1">
                      {m.marks.map((mark, i) => {
                        const { title, measure } = describe(mark);
                        return (
                          // biome-ignore lint/suspicious/noArrayIndexKey: a sent message's marks never change.
                          <Chip key={i}>
                            {title}
                            {measure && ` ${measure}`}
                          </Chip>
                        );
                      })}
                    </span>
                  )}
                  {m.go && <StatusMark status="running" label="Asked for a redo" />}
                </li>
              ) : (
                <li key={m.id} className="grid gap-1">
                  <span className="text-xs text-muted-foreground">The AI</span>
                  <Markdown text={m.text} className="text-sm" />
                  {m.offer && m === items.at(-1) && closed === undefined && (
                    <Button
                      type="button"
                      size="sm"
                      className="justify-self-start"
                      disabled={send.isPending}
                      onClick={() => submit(m.offer?.taskId)}
                    >
                      <RotateCcw aria-hidden />
                      Yes, redo {tasks.find((t) => t.id === m.offer?.taskId)?.title ?? "it"}
                    </Button>
                  )}
                </li>
              ),
            )}
            {answering && (
              <li>
                <StatusMark status="running" label="The AI is answering" />
              </li>
            )}
          </ol>
        )}
      </div>
      <form
        ref={form}
        className="grid gap-2 border-t border-border p-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <TextAreaField
          label="Message to the AI"
          hideLabel
          placeholder="What's wrong and why? What does the AI need to do to get it right?"
          rows={3}
          maxLength={10_000}
          value={text}
          disabled={closed !== undefined || send.isPending}
          aria-describedby={closed ? closedId : undefined}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              if (!e.repeat && !e.nativeEvent.isComposing) submit();
            }
          }}
        />
        {closed && (
          <p id={closedId} className="text-xs text-muted-foreground">
            {closed}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <span className="flex-1" />
          <Button
            type="submit"
            variant="primary"
            size="sm"
            disabled={closed !== undefined || send.isPending || !text.trim()}
            aria-describedby={closed ? closedId : undefined}
          >
            <Send aria-hidden />
            {send.isPending ? "Sending…" : "Send"}
          </Button>
        </div>
        {send.isSuccess && unseen && (
          <p className="text-xs text-muted-foreground">
            Sent without a picture of the views: they were not ready or the picture was too large.
          </p>
        )}
        {send.isError && (
          <p role="alert" className="text-sm text-destructive">
            {refusal(send.error)}
          </p>
        )}
      </form>
    </div>
  );
}
