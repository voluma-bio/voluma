/**
 * The Conversation tab: main's whole thread (`AgentThread`: its prose and replies, the workers it
 * starts and the outputs it reports, its other tool calls folded under its status lines, its
 * instructions and the run's news collapsed), with what only the researcher's
 * side holds put in by log position: your messages with the marks they carried (and what main got
 * with them), the calls main holds for your yes (`ApprovalCard`), and a request that didn't
 * finish. The live line follows the run: waiting in the queue, else main's newest status line
 * while it works, else a call you approved while its job runs, else nothing.
 * Under it the box: your words, the mark changes waiting for them (each chip goes to its mark; x
 * undoes the change), and whether a picture of the panes goes too. Main gets each mark with its
 * change and positions; the placeholder prompts for your words, while the chips show the
 * attached marks. The message itself is `useMainMessage`.
 */

import { agentLog, givenApprovals } from "@voluma/contracts/agents";
import type { ConversationItem } from "@voluma/contracts/conversation";
import type { RunEvent } from "@voluma/contracts/events";
import type { RunRead } from "@voluma/contracts/run";
import {
  type AgentEntry,
  type AgentLinks,
  AgentThread,
  ApprovalCard,
  approvalWords,
  clockOf,
  plainError,
  type Slot,
} from "@voluma/run-view";
import { Button, Chip, cx, IconButton, TextAreaField } from "@voluma/ui";
import { Send, X } from "lucide-react";
import { type ReactNode, useEffect, useId, useMemo, useRef } from "react";
import type { MarkChange } from "./marking";
import type { useAnswers, useMainMessage } from "./use-main-message";

const CHANGE_WORD: Record<MarkChange["change"], string | undefined> = {
  place: undefined,
  move: "moved",
  delete: "deleted",
};

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
  events,
  main,
  conversation,
  state,
  nameOf,
  agents,
  checkTitle,
  message,
  answers,
  markError,
  onMark,
  onDiscard,
}: {
  events: readonly RunEvent[];
  /** Main's entry (`agentEntries`), once it has started. */
  main: AgentEntry | undefined;
  /** The run's `conversation()`. */
  conversation: readonly ConversationItem[];
  /** Where the run stands: queued, running or ended. */
  state: RunRead["state"];
  nameOf: (id: string) => string;
  /** The workers main's replies can name in code to open their thread. */
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
  // The thread shows main's replies; the page adds what the thread doesn't hold. A finished
  // request's reply is the answer; only one that didn't finish gets a line of its own.
  const { slots, byId } = useMemo(() => {
    const own = conversation.filter((m) => m.from !== "outcome" || m.status !== "completed");
    return {
      slots: own.map((m): Slot => ({ id: m.id, seq: m.seq, person: m.from === "person" })),
      byId: new Map(own.map((m) => [m.id, m])),
    };
  }, [conversation]);
  // The live line says only what is true of the run: in the queue nothing works yet; while it
  // runs, main is at work only when it is. A call you approved runs as a job outside any thread,
  // with main idle until it settles.
  const live = state.status !== "ended";
  const working = state.status === "running" && main?.state === "working";
  const approved = givenApprovals(agentLog(events).approvals).length > 0;
  const line =
    state.status === "queued"
      ? { text: `Waiting to start · place ${state.position} in line`, quiet: true }
      : state.status === "running" && !working && approved
        ? { text: "Doing what you approved" }
        : undefined;

  const slot = (id: string): ReactNode => {
    const m = byId.get(id);
    if (!m) return null;
    switch (m.from) {
      case "person":
        return (
          <div className="grid gap-1">
            <p className="flex items-baseline gap-2 text-meta">
              <span className="font-semibold">You</span>
              <span className="text-muted-foreground">{clockOf(m.at)}</span>
            </p>
            <div className="grid gap-1.5 rounded-lg bg-muted px-3 py-2">
              {m.text && <p className="text-ui whitespace-pre-wrap">{m.text}</p>}
              {(m.attached.length > 0 || m.toCheck || m.output) && (
                <p className="flex flex-wrap items-center gap-1 text-meta text-muted-foreground">
                  {m.toCheck && (
                    <span className="w-full">
                      About {checkTitle(m.toCheck) ?? `a To check of ${nameOf(m.toCheck.output)}`}
                    </span>
                  )}
                  {m.output && <span>looking at {nameOf(m.output)}</span>}
                  {m.attached.map((a) => {
                    const markId = typeof a.mark.id === "string" ? a.mark.id : undefined;
                    return (
                      <MarkChangeChip
                        key={`${markId ?? a.mark.tag}-${a.change}`}
                        tag={a.mark.tag}
                        change={a.change}
                        onShow={markId && a.change !== "delete" ? () => onMark(markId) : undefined}
                      />
                    );
                  })}
                </p>
              )}
            </div>
          </div>
        );
      case "outcome":
        return (
          <p className="text-meta text-muted-foreground [overflow-wrap:anywhere]">
            {m.status === "cancelled"
              ? "You stopped this request. Results are unchanged."
              : `Your request didn't finish${m.text ? `: ${plainError(m.text).replace(/[.!?]$/, "")}` : ""}. Results are unchanged.`}
          </p>
        );
      case "approval":
        return (
          <ApprovalCard
            {...approvalWords(m.tool)}
            summary={m.summary}
            changes={m.outputs?.map(nameOf)}
            outOfDate={m.outOfDate?.map(nameOf)}
            answer={m.answer && { ...m.answer, time: clockOf(m.answer.at) }}
            settled={m.settled?.outcome}
            onAnswer={answers.answer && ((yes, words) => answers.answer?.(m.id, yes, words))}
            pending={answers.pending?.requestId === m.id ? answers.pending.answer : undefined}
            readOnly={answers.readOnly}
            error={answers.error?.requestId === m.id ? answers.error.text : undefined}
          />
        );
    }
  };

  const form = useRef<HTMLFormElement>(null);
  // "Tell the AI what's wrong" puts you in the box.
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
      <AgentThread
        className="flex-1 px-3 py-3"
        events={events}
        ids={main?.ids ?? []}
        working={working}
        line={line}
        live={live}
        links={agents}
        slots={slots}
        slot={slot}
        nameOf={nameOf}
        conversation
        opensAtEnd
        empty={live ? "The AI hasn't started yet." : "The AI wrote nothing."}
      />
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
          label="Message to the AI"
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
