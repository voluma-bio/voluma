/**
 * The researcher's next message to a run's main AI on an agent-loop run (`sendRunMessage`), and
 * their answers to the calls main holds (`answerApproval`). A message carries the words, the mark
 * changes waiting for it (`useRunMarks`'s `changes`, by id: the API freezes them from the log), the
 * output in view, the view as Save view would keep it, a picture of the panes when the researcher
 * leaves "as you see it" on, and the To check item it answers ("Tell main what's wrong"). Nothing
 * reaches main until Send, and a send waits for the writes of the marks it names: if one fails,
 * the message stays unsent. A send or an answer to an ended run reopens it: the page reconnects its
 * stream and reads the run again (`onSent`).
 *
 * The page holds this, so closing the panel mid-message or mid-send loses nothing. Changing the
 * words, the marks, the item, the output or the picture choice makes a new message; otherwise a
 * retry resends the last (`useIdempotentSend`).
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ApiError, answerApproval } from "@voluma/api-client";
import { invalidateRun, runQuery } from "@voluma/api-client/query";
import { MAX_VIEW_BYTES } from "@voluma/contracts/agent-events";
import type { RunEvent } from "@voluma/contracts/events";
import { MAX_MARKS } from "@voluma/contracts/messages";
import type { RunRead } from "@voluma/contracts/run";
import { type OutputItem, type OutputRow, shownOf } from "@voluma/run-view";
import { storeView } from "@voluma/viewer/grid";
import { type RefObject, useState } from "react";
import type { MarkChange } from "./marks-panel";
import { refusalOf, useDraft, useIdempotentSend } from "./message-send";
import type { SceneHandle } from "./viewer";

/** A refusal in the API's own words when it gave some, else what the status means here. */
function refusal(error: Error, what: "message" | "answer"): string {
  // Every mark named is as main last saw it, and there are no words.
  if (error instanceof ApiError && error.serverMessage?.startsWith("Nothing new to send"))
    return "Main already has your marks as they are. Write something, or change a mark, to send.";
  return refusalOf(error, (status) => {
    switch (status) {
      case 400:
        return "The AI couldn't take this. Reload the page and try again.";
      case 403:
        return "You can't write to this run's AI.";
      case 404:
        return what === "answer"
          ? "The AI no longer asks this. It may have been answered in another tab."
          : "A mark or the item this names is gone. Reload the page and try again.";
      case 409:
        return what === "answer"
          ? "This was already answered the other way."
          : "This run can't take a message now.";
      case 413:
        return "The picture is too large. Untick “as you see it” and send again.";
      default:
        return undefined;
    }
  });
}

/** Writes a run state the API answered into the run's query, before the run is read again. */
function useRunState(runId: string) {
  const client = useQueryClient();
  return (state: RunRead["state"]) =>
    client.setQueryData<RunRead>(runQuery(runId).queryKey, (r) => r && { ...r, state });
}

/** The To check item a message answers, with its words for the composer. */
export type About = { item: OutputItem; name: string };

export function useMainMessage({
  run,
  events,
  changes,
  inView,
  picture,
  scene,
  settled,
  onSent,
}: {
  run: RunRead;
  events: readonly RunEvent[];
  /** Your mark changes not yet sent to main. */
  changes: readonly MarkChange[];
  /** The output in view: the message is about it. */
  inView: OutputRow | undefined;
  /** What the panes show, by name, when they show it: a picture of them can go. */
  picture: string | undefined;
  /** The panes, for the view and the picture. */
  scene: RefObject<SceneHandle | null>;
  /** Resolves once these marks' writes are in the log; a message naming them waits for it. */
  settled: (ids: readonly string[]) => Promise<void>;
  /** The run took a message or an answer: reconnect its stream and read it again. */
  onSent: () => void;
}) {
  const [text, setText] = useDraft(`voluma:main-draft:${run.id}`);
  const [about, setAbout] = useState<About>();
  const [withPicture, setWithPicture] = useState(true);
  // The changes a sent message carried leave the composer before its event is back on the stream.
  const [sent, setSent] = useState<{ eventId: string; marks: string[] }>();
  const inLog = sent && events.some((e) => e.id === sent.eventId);
  const closed = run.cannotMessage ?? undefined;
  // Someone who can't write to main has no changes waiting for it.
  const attached = closed ? [] : changes.filter((c) => inLog || !sent?.marks.includes(c.id));
  const [unseen, setUnseen] = useState(false);
  const setState = useRunState(run.id);
  const { send, submit: post } = useIdempotentSend<{ marks: string[] }>({
    runId: run.id,
    before: ({ marks }) => settled(marks),
    onSuccess: ({ response, unseen, meta }) => {
      setText("");
      setAbout(undefined);
      setUnseen(unseen);
      setSent({ eventId: response.eventId, marks: meta.marks });
      setState(response.state);
      onSent();
    },
  });
  const tooMany =
    attached.length > MAX_MARKS
      ? `A message carries up to ${MAX_MARKS} marks. Undo some changes, or send and then the rest.`
      : undefined;
  const empty = !text.trim() && attached.length === 0;

  const submit = () => {
    if (closed !== undefined || tooMany || empty) return;
    const note = text.trim();
    const markIds = attached.map((c) => c.id);
    const toCheck = about && {
      output: about.item.output,
      version: about.item.version,
      item: about.item.item,
    };
    const fields = {
      ...(note && { text: note }),
      ...(markIds.length > 0 && { markIds }),
      ...(inView && { output: inView.id }),
      ...(toCheck && { toCheck }),
    };
    const pictured = withPicture && picture;
    post(JSON.stringify({ fields, pictured }), () => {
      // The view as Save view keeps it, when it fits; a camera move alone keeps a retry's request.
      const now = inView && scene.current?.view();
      const view = now && storeView(now.state, now.grid, shownOf(inView));
      const fits = view && new Blob([JSON.stringify(view)]).size <= MAX_VIEW_BYTES;
      return {
        fields: { ...fields, ...(fits && { view }) },
        ...(pictured && {
          picture: (maxBytes: number) => scene.current?.snapshot(maxBytes) ?? Promise.resolve(null),
        }),
        meta: { marks: markIds },
      };
    });
  };

  return {
    text,
    setText,
    attached,
    picture,
    about,
    setAbout,
    withPicture,
    setWithPicture,
    send,
    submit,
    unseen,
    closed,
    blocked: tooMany,
    empty,
    error: send.error ? refusal(send.error, "message") : undefined,
  };
}

/**
 * Answering the calls main holds: one at a time, its error kept on that call. An answer stays
 * pending until the card shows it from the stream.
 */
export function useAnswers(run: RunRead, onSent: () => void) {
  const [error, setError] = useState<{ requestId: string; text: string }>();
  const client = useQueryClient();
  const answer = useMutation({
    mutationFn: (a: { requestId: string; answer: "yes" | "no"; text: string }) =>
      answerApproval(run.id, a.requestId, {
        answer: a.answer,
        ...(a.text && { text: a.text }),
      }),
    onMutate: (a) => setError((e) => (e?.requestId === a.requestId ? undefined : e)),
    // The studies' reads carry the run's open calls (`waiting`): they clear with the answer.
    onSuccess: () => {
      onSent();
      void invalidateRun(client, run.id);
    },
    onError: (e, a) => setError({ requestId: a.requestId, text: refusal(e, "answer") }),
  });
  // The API's rule, examples included.
  const readOnly = run.cannotMessage ?? undefined;
  return {
    answer: readOnly
      ? undefined
      : (requestId: string, yes: "yes" | "no", text: string) =>
          answer.mutate({ requestId, answer: yes, text }),
    pending: answer.isPending || answer.isSuccess ? answer.variables : undefined,
    error,
    readOnly,
  };
}
