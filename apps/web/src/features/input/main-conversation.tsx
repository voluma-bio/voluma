/**
 * The conversation with an agent-loop run's main AI, the only place anything changes on the run
 * (review.md, "The conversation"): main's messages, yours with the marks they carried, the calls
 * main holds for your yes (`ApprovalCard`), and the views you saved, in log order. Under it the
 * box: your words, the mark changes waiting for them (each chip goes to its mark; x undoes the
 * change), and whether a picture of the panes goes too. Main gets each mark with its change and
 * positions, so the box needs no words about them: while it is empty it shows what the marks say.
 * The message itself is `useMainMessage`.
 */
import type { ConversationItem } from "@voluma/contracts/conversation";
import { type AgentLinks, ApprovalCard, approvalWords, Markdown } from "@voluma/run-view";
import { Button, Chip, cx, EmptyState, IconButton, StatusMark, TextAreaField } from "@voluma/ui";
import { Bookmark, Send, X } from "lucide-react";
import { type ReactNode, useEffect, useId, useLayoutEffect, useMemo, useRef } from "react";
import type { MarkChange } from "./marking";
import type { SavedView } from "./saved-views";
import type { useAnswers, useMainMessage } from "./use-main-message";
import { clockOf } from "./version-report";

const CHANGE_WORD: Record<MarkChange["change"], string | undefined> = {
  place: undefined,
  move: "moved",
  delete: "deleted",
};

/** What a waiting change says to main, in the researcher's voice. */
function lineOf(c: MarkChange, nameOf: (id: string) => string): string {
  if (c.change === "place") return `I placed ${c.tag} on ${nameOf(c.output)}.`;
  return `I ${CHANGE_WORD[c.change]} ${c.tag}.`;
}

/** A mark and what changed of it; its tag shows the mark, unless it is gone (`onShow` absent). */
function MarkChangeChip({
  tag,
  change,
  onShow,
  children,
}: {
  tag: string;
  change: MarkChange["change"];
  onShow: (() => void) | undefined;
  /** Beside the tag: the chip's own action. */
  children?: ReactNode;
}) {
  const word = CHANGE_WORD[change];
  return (
    <Chip className={cx("text-mark-mine-text", !!children && "gap-0.5 pr-0.5")}>
      <button
        type="button"
        className="cursor-pointer font-mono disabled:cursor-default"
        disabled={!onShow}
        title={onShow && `Show ${tag}`}
        onClick={onShow}
      >
        <span className={cx(change === "delete" && "line-through")}>{tag}</span>
        {word && <span className="font-sans"> {word}</span>}
      </button>
      {children}
    </Chip>
  );
}

export function MainConversation({
  conversation,
  views,
  live,
  nameOf,
  agents,
  checkTitle,
  message,
  answers,
  markError,
  onMark,
  onDiscard,
}: {
  /** The run's `conversation()`. */
  conversation: readonly ConversationItem[];
  views: readonly SavedView[];
  /** The run is queued or running: main is at work on what it was sent. */
  live: boolean;
  nameOf: (id: string) => string;
  /** The agents main's replies can name in code to open their thread. */
  agents: AgentLinks;
  /** A To check item's title, by its place. */
  checkTitle: (item: { output: string; version: number; item: number }) => string | undefined;
  message: ReturnType<typeof useMainMessage>;
  answers: ReturnType<typeof useAnswers>;
  markError: string | undefined;
  /** Shows a mark of yours in the panes. */
  onMark: (id: string) => void;
  /** Undoes a waiting change. */
  onDiscard: (id: string) => void;
}) {
  const items = useMemo(() => {
    const said = conversation
      .filter((m): m is Exclude<ConversationItem, { from: "outcome" }> => m.from !== "outcome")
      .map((m) => ({ ...m, kind: "said" as const }));
    return [...said, ...views.map((v) => ({ ...v, kind: "view" as const }))].sort(
      (a, b) => a.seq - b.seq,
    );
  }, [conversation, views]);
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
                        {m.toCheck && (
                          <span className="w-full">
                            About{" "}
                            {checkTitle(m.toCheck) ?? `a To check of ${nameOf(m.toCheck.output)}`}
                          </span>
                        )}
                        {m.output && <span>looking at {nameOf(m.output)}</span>}
                        {m.attached.map((a) => {
                          const id = typeof a.mark.id === "string" ? a.mark.id : undefined;
                          return (
                            <MarkChangeChip
                              key={`${id ?? a.mark.tag}-${a.change}`}
                              tag={a.mark.tag}
                              change={a.change}
                              onShow={id && a.change !== "delete" ? () => onMark(id) : undefined}
                            />
                          );
                        })}
                      </p>
                    )}
                  </div>
                </li>
              ) : m.from === "agent" ? (
                <li key={m.id} className="grid gap-1">
                  <Said who="main" at={m.at} />
                  <Markdown text={m.text} className="text-sm" agents={agents} />
                </li>
              ) : (
                <li key={m.id}>
                  <ApprovalCard
                    {...approvalWords(m.tool, m.args)}
                    summary={m.summary}
                    changes={m.outputs?.map(nameOf)}
                    outOfDate={m.outOfDate?.map(nameOf)}
                    answer={m.answer && { ...m.answer, time: clockOf(m.answer.at) }}
                    settled={m.settled?.outcome}
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
        className="grid grid-cols-[minmax(0,1fr)] gap-2 border-t border-border p-3"
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
            attached.length > 0
              ? attached.map((c) => lineOf(c, nameOf)).join("\n")
              : about
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
              <label
                title={`With ${message.picture}, as you see it`}
                className="flex min-w-0 max-w-full items-center whitespace-nowrap"
              >
                <input
                  type="checkbox"
                  className="mr-1.5 shrink-0"
                  checked={withPicture}
                  disabled={send.isPending}
                  onChange={(e) => setWithPicture(e.target.checked)}
                />
                <span className="shrink-0">With&nbsp;</span>
                <span className="min-w-0 truncate">{message.picture}</span>
                <span className="shrink-0">, as you see it</span>
              </label>
            )}
            {attached.length > 0 && <span>{message.picture ? "and" : "With"} your marks:</span>}
            {attached.map((c) => (
              <MarkChangeChip
                key={c.id}
                tag={c.tag}
                change={c.change}
                onShow={c.change === "delete" ? undefined : () => onMark(c.id)}
              >
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
              </MarkChangeChip>
            ))}
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
