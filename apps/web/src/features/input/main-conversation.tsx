/**
 * The conversation with an agent-loop run's main AI, the only place anything changes on the run
 * (review.md, "The conversation"): main's messages, yours with the marks they carried, the calls
 * main holds for your yes (`ApprovalCard`), and the views you saved, in log order. Under it the
 * box: your words, the mark changes waiting for them (each chip goes to its mark; x undoes the
 * change), and whether a picture of the panes goes too. The message itself is `useMainMessage`.
 */
import { type ConversationItem, conversation } from "@voluma/contracts/conversation";
import type { RunEvent } from "@voluma/contracts/events";
import { ApprovalCard, Markdown } from "@voluma/run-view";
import { Button, Chip, cx, EmptyState, IconButton, StatusMark, TextAreaField } from "@voluma/ui";
import { Bookmark, Send, X } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useMemo, useRef } from "react";
import type { MarkChange } from "./run-marks";
import type { SavedView } from "./saved-views";
import type { useAnswers, useMainMessage } from "./use-main-message";
import { clockOf } from "./version-report";

type Approval = Extract<ConversationItem, { from: "approval" }>;

/** A held call in words: what it is, and what Yes says. */
function callWords({ tool, args }: Approval): { title: string; yes: string } {
  const name = (args as { name?: unknown } | null)?.name;
  switch (tool) {
    case "start_worker":
      return {
        title: "Start a worker",
        yes: typeof name === "string" ? `Yes, start ${name}` : "Yes, start it",
      };
    case "report_output":
      return { title: "Publish a new version", yes: "Yes, publish it" };
    case "change_outputs":
      return { title: "Change the final outputs", yes: "Yes, change them" };
    case "keep_output":
      return { title: "Keep as they are", yes: "Yes, keep them" };
    default:
      return { title: tool, yes: "Yes" };
  }
}

const CHANGE_WORD: Record<MarkChange["change"], string | undefined> = {
  place: undefined,
  move: "moved",
  edit: "edited",
  delete: "deleted",
};

export function MainConversation({
  events,
  views,
  live,
  nameOf,
  message,
  answers,
  markError,
  onMark,
  onDiscard,
}: {
  events: readonly RunEvent[];
  views: readonly SavedView[];
  /** The run is queued or running: main is at work on what it was sent. */
  live: boolean;
  nameOf: (id: string) => string;
  message: ReturnType<typeof useMainMessage>;
  answers: ReturnType<typeof useAnswers>;
  markError: string | undefined;
  /** Shows a mark of yours in the panes. */
  onMark: (id: string) => void;
  /** Undoes a waiting change. */
  onDiscard: (id: string) => void;
}) {
  const items = useMemo(() => {
    const said = conversation(events)
      .filter((m): m is Exclude<ConversationItem, { from: "outcome" }> => m.from !== "outcome")
      .map((m) => ({ ...m, kind: "said" as const }));
    return [...said, ...views.map((v) => ({ ...v, kind: "view" as const }))].sort(
      (a, b) => a.seq - b.seq,
    );
  }, [events, views]);
  // Main is at work while the run goes and the last word was yours: a message, or a yes or no.
  const last = [...items].reverse().find((m) => m.kind === "said");
  const working =
    live &&
    last?.kind === "said" &&
    (last.from === "person" || (last.from === "approval" && !!last.answer && !last.settled));

  const log = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = log.current;
    if (el && items.length > 0) el.scrollTop = el.scrollHeight;
  }, [items.length]);
  const form = useRef<HTMLFormElement>(null);
  // "Tell main what's wrong" puts you in the box.
  useEffect(() => {
    if (message.about) form.current?.querySelector("textarea")?.focus();
  }, [message.about]);
  const closedId = useId();
  const {
    text,
    setText,
    attached,
    about,
    setAbout,
    withPicture,
    setWithPicture,
    send,
    submit,
    unseen,
    closed,
    blocked,
    empty,
  } = message;

  return (
    <div className="flex h-full flex-col">
      <div ref={log} role="log" className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {items.length === 0 ? (
          <EmptyState title="No messages yet">
            {live ? "The AI writes here when it has something for you." : undefined}
          </EmptyState>
        ) : (
          <ol className="grid gap-4">
            {items.map((m) =>
              m.kind === "view" ? (
                <li key={m.id} className="flex gap-2 text-xs text-muted-foreground">
                  <Bookmark aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                  <span>
                    You saved {m.title.toLowerCase()} of {nameOf(m.output)}
                    {m.words && `, ${m.words.charAt(0).toLowerCase()}${m.words.slice(1)}`}.
                  </span>
                </li>
              ) : m.from === "person" ? (
                <li key={m.id} className="grid gap-1">
                  <Said who="You" at={m.at} />
                  <div className="grid gap-1.5 rounded-lg bg-muted px-3 py-2">
                    {m.text && <p className="text-sm whitespace-pre-wrap">{m.text}</p>}
                    {(m.attached.length > 0 || m.toCheck || m.output) && (
                      <p className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                        {m.output && <span>sent with {nameOf(m.output)}</span>}
                        {m.toCheck && <span>on a To check of {nameOf(m.toCheck.output)}</span>}
                        {m.attached.map((a) => {
                          const id = typeof a.mark.id === "string" ? a.mark.id : undefined;
                          const word = CHANGE_WORD[a.change];
                          return (
                            <Chip
                              key={`${id ?? a.mark.tag}-${a.change}`}
                              className="text-mark-mine-text"
                            >
                              <button
                                type="button"
                                className="cursor-pointer font-mono disabled:cursor-default"
                                disabled={!id || a.change === "delete"}
                                title={`Show ${a.mark.tag}`}
                                onClick={() => id && onMark(id)}
                              >
                                <span className={cx(a.change === "delete" && "line-through")}>
                                  {a.mark.tag}
                                </span>
                                {word && <span className="font-sans"> {word}</span>}
                              </button>
                            </Chip>
                          );
                        })}
                      </p>
                    )}
                  </div>
                </li>
              ) : m.from === "agent" ? (
                <li key={m.id} className="grid gap-1">
                  <Said who="main" at={m.at} />
                  <Markdown text={m.text} className="text-sm" />
                </li>
              ) : (
                <li key={m.id}>
                  <ApprovalCard
                    {...callWords(m)}
                    summary={m.summary}
                    answer={m.answer && { ...m.answer, time: clockOf(m.answer.at) }}
                    settled={m.settled}
                    onAnswer={
                      answers.answer && ((yes, words) => answers.answer?.(m.id, yes, words))
                    }
                    pending={
                      answers.pending?.requestId === m.id ? answers.pending.answer : undefined
                    }
                    readOnly={answers.readOnly}
                    error={answers.error?.requestId === m.id ? answers.error.text : undefined}
                  />
                </li>
              ),
            )}
            {working && (
              <li>
                <StatusMark status="running" label="main is on it" />
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
        {markError && (
          <p role="alert" className="text-xs text-destructive">
            {markError}
          </p>
        )}
        {about && (
          <div className="flex items-center gap-2 text-xs">
            <span className="text-muted-foreground">About</span>
            <span className="min-w-0 flex-1 truncate font-medium" title={about.item.title}>
              {about.item.title}
            </span>
            <IconButton
              label="Not about this item"
              size="sm"
              disabled={send.isPending}
              onClick={() => setAbout(undefined)}
            >
              <X aria-hidden />
            </IconButton>
          </div>
        )}
        <TextAreaField
          label="Message to main"
          hideLabel
          placeholder={
            about
              ? "What's wrong with it, and what should change?"
              : "Ask about what you're looking at, or say what should change"
          }
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
        <div className="flex items-start gap-2">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1 text-xs text-muted-foreground">
            {message.picture && (
              <label className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={withPicture}
                  disabled={send.isPending}
                  onChange={(e) => setWithPicture(e.target.checked)}
                />
                With {message.picture}, as you see it
              </label>
            )}
            {attached.length > 0 && <span>{message.picture ? "and" : "With"} your marks:</span>}
            {attached.map((c) => {
              const word = CHANGE_WORD[c.change];
              return (
                <Chip key={c.id} className="gap-0.5 pr-0.5 text-mark-mine-text">
                  <button
                    type="button"
                    className="cursor-pointer font-mono disabled:cursor-default"
                    disabled={c.change === "delete"}
                    title={`Show ${c.tag}`}
                    onClick={() => onMark(c.id)}
                  >
                    <span className={cx(c.change === "delete" && "line-through")}>{c.tag}</span>
                    {word && <span className="font-sans"> {word}</span>}
                  </button>
                  <IconButton
                    size="sm"
                    label={
                      c.change === "place"
                        ? `Remove ${c.tag}`
                        : c.change === "delete"
                          ? `Keep ${c.tag}`
                          : `Undo the change to ${c.tag}`
                    }
                    disabled={send.isPending}
                    onClick={() => onDiscard(c.id)}
                  >
                    <X />
                  </IconButton>
                </Chip>
              );
            })}
          </div>
          <Button
            type="submit"
            variant="primary"
            size="sm"
            disabled={closed !== undefined || send.isPending || empty || !!blocked}
            aria-describedby={closed ? closedId : undefined}
          >
            <Send aria-hidden />
            {send.isPending ? "Sending…" : "Send"}
          </Button>
        </div>
        {blocked && <p className="text-xs text-muted-foreground">{blocked}</p>}
        {send.isSuccess && unseen && (
          <p className="text-xs text-muted-foreground">
            Sent without a picture of the panes: it couldn't be made, or was too large.
          </p>
        )}
        {message.error && (
          <p role="alert" className="text-sm text-destructive">
            {message.error}
          </p>
        )}
      </form>
    </div>
  );
}

/** Who wrote, and when. */
function Said({ who, at }: { who: string; at: string }) {
  return (
    <p className="flex items-baseline gap-2 text-xs">
      <span className="font-semibold">{who}</span>
      <span className="text-muted-foreground">{clockOf(at)}</span>
    </p>
  );
}
