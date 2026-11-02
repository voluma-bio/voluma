/**
 * The researcher's next message to a run's main AI on an agent-loop run (`sendRunMessage`), and
 * their answers to the calls main holds (`answerApproval`). A message carries the words, the mark
 * changes waiting for it (`useRunMarks`'s `changes`, by id: the API freezes them from the log), the
 * output in view, the view as Save view would keep it, a picture of the panes when the researcher
 * leaves "as you see it" on, and the To check item it answers ("Tell main what's wrong"). Nothing
 * reaches main until Send. A send or an answer to an ended run reopens it: the page reconnects its
 * stream and reads the run again (`onSent`).
 *
 * The page holds this, so closing the panel mid-message or mid-send loses nothing. A retry keeps
 * the message id and the exact request, picture included, so the API stores it once; changing the
 * words, the marks, the item, the output or the picture choice makes a new message.
 */
import { useMutation } from "@tanstack/react-query";
import { ApiError, answerApproval, sendRunMessage } from "@voluma/api-client";
import { MAX_VIEW_BYTES } from "@voluma/contracts/agent-events";
import type { RunEvent } from "@voluma/contracts/events";
import {
  MAX_MARKS,
  MAX_MESSAGE_SNAPSHOT_BYTES,
  MESSAGE_BODY_BYTES,
  type SendRunMessageRequest,
} from "@voluma/contracts/messages";
import type { RunRead } from "@voluma/contracts/run";
import { type OutputItem, type OutputRow, shownOf } from "@voluma/run-view";
import { storeView } from "@voluma/viewer/grid";
import { type RefObject, useRef, useState } from "react";
import { useDraft } from "./ai-panel";
import type { MarkChange } from "./run-marks";
import type { SceneHandle } from "./viewer";

/** PNG bytes as plain base64, as the message takes them. */
async function base64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

/** A refusal in the API's own words when it gave some, else what the status means here. */
function refusal(error: Error, what: "message" | "answer"): string {
  if (!(error instanceof ApiError)) return "Couldn't send. Check your connection and try again.";
  if (error.serverMessage) return error.serverMessage;
  switch (error.status) {
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
      return "Couldn't send. Try again.";
  }
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
  /** The run took a message or an answer: reconnect its stream and read it again. */
  onSent: () => void;
}) {
  const [text, setText] = useDraft(`voluma:main-draft:${run.id}`);
  // The lines the page wrote for edits, by mark: the box is rewritten only while it holds just them.
  const written = useRef(new Map<string, string>());
  const [about, setAbout] = useState<About>();
  const [withPicture, setWithPicture] = useState(true);
  // The changes a sent message carried leave the composer before its event is back on the stream.
  const [sent, setSent] = useState<{ eventId: string; marks: string[] }>();
  const inLog = sent && events.some((e) => e.id === sent.eventId);
  const attached = changes.filter((c) => inLog || !sent?.marks.includes(c.id));
  const tried = useRef<{
    fingerprint: string;
    marks: string[];
    prepared: Promise<{ body: SendRunMessageRequest; unseen: boolean }>;
  }>(undefined);
  const inFlight = useRef(false);
  const [unseen, setUnseen] = useState(false);
  const send = useMutation({
    mutationFn: async (attempt: NonNullable<typeof tried.current>) => {
      const { body, unseen } = await attempt.prepared;
      const { eventId } = await sendRunMessage(run.id, body);
      return { eventId, marks: attempt.marks, unseen };
    },
    onSuccess: ({ eventId, marks, unseen }) => {
      setText("");
      written.current = new Map();
      setAbout(undefined);
      setUnseen(unseen);
      setSent({ eventId, marks });
      tried.current = undefined;
      onSent();
    },
    onSettled: () => {
      inFlight.current = false;
    },
  });
  const closed = run.cannotMessage ?? undefined;
  const tooMany =
    attached.length > MAX_MARKS
      ? `A message carries up to ${MAX_MARKS} marks. Undo some changes, or send and then the rest.`
      : undefined;
  const empty = !text.trim() && attached.length === 0;

  const submit = () => {
    if (closed !== undefined || tooMany || empty || inFlight.current) return;
    inFlight.current = true;
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
    const fingerprint = JSON.stringify({ fields, picture: withPicture && picture });
    if (tried.current?.fingerprint !== fingerprint) {
      // The view as Save view keeps it, when it fits; a camera move alone keeps a retry's request.
      const now = inView && scene.current?.view();
      const view = now && storeView(now.state, now.grid, shownOf(inView));
      const fits = view && new Blob([JSON.stringify(view)]).size <= MAX_VIEW_BYTES;
      const body: SendRunMessageRequest = {
        id: crypto.randomUUID(),
        ...fields,
        ...(fits && { view }),
      };
      // The picture goes in the room the rest of the body leaves (base64 is 4 bytes per 3).
      const room = Math.floor(
        ((MESSAGE_BODY_BYTES - new Blob([JSON.stringify(body)]).size - 64) * 3) / 4,
      );
      // Taken before the mutation: one can pause offline while the researcher moves on.
      const png: Promise<string | null | undefined> =
        !withPicture || !picture
          ? Promise.resolve(undefined)
          : room > 0
            ? (
                scene.current?.snapshot(Math.min(MAX_MESSAGE_SNAPSHOT_BYTES, room)) ??
                Promise.resolve(null)
              )
                .then((blob) => blob && base64(blob))
                .catch(() => null)
            : Promise.resolve(null);
      tried.current = {
        fingerprint,
        marks: markIds,
        prepared: png.then((data) => ({
          body: { ...body, ...(data && { snapshot: { mimeType: "image/png" as const, data } }) },
          unseen: data === null,
        })),
      };
    }
    send.mutate(tried.current);
  };

  /**
   * Puts a line about an edit of mark `id` in the box ("I moved P1."), or takes it out (`null`, the
   * edit undone): only while the box is empty or holds just the page's lines, never over the
   * researcher's own words.
   */
  const say = (id: string, line: string | null) =>
    setText((had) => {
      const lines = written.current;
      if (had.trim() && had !== [...lines.values()].join("\n")) return had;
      const next = new Map(lines);
      next.delete(id);
      if (line) next.set(id, line);
      written.current = next;
      return [...next.values()].join("\n");
    });

  return {
    text,
    setText,
    say,
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

/** Answering the calls main holds: one at a time, its error kept on that call. */
export function useAnswers(run: RunRead, onSent: () => void) {
  const [error, setError] = useState<{ requestId: string; text: string }>();
  const answer = useMutation({
    mutationFn: (a: { requestId: string; answer: "yes" | "no"; text: string }) =>
      answerApproval(run.id, a.requestId, {
        answer: a.answer,
        ...(a.text && { text: a.text }),
      }),
    onMutate: (a) => setError((e) => (e?.requestId === a.requestId ? undefined : e)),
    onSuccess: onSent,
    onError: (e, a) => setError({ requestId: a.requestId, text: refusal(e, "answer") }),
  });
  const readOnly = run.example
    ? "Example runs can't be changed."
    : (run.cannotMessage ?? undefined);
  return {
    answer: readOnly
      ? undefined
      : (requestId: string, yes: "yes" | "no", text: string) =>
          answer.mutate({ requestId, answer: yes, text }),
    pending: answer.isPending ? answer.variables : undefined,
    error,
    readOnly,
  };
}
