/**
 * One agent's thread as rows, derived with no React from the run's durable events: what it was
 * told, its prose, the calls that change results (`VISIBLE`) as rows of their own, and its other
 * reasoning and tool calls folded into process blocks labelled by its newest `activity` line and
 * a digest. The stream delivers durable events only, so a row appears when its event lands; a
 * call with no result yet is `running`.
 *
 * A thread is one or several thread ids: main is `main` plus every `main.N` after a review, in
 * log order. A screen can put its own rows into the thread by log position (`slots`): each closes
 * the fold before it and renders as the screen says. A call main held for the researcher's yes
 * (`approval.requested`) gets no row: the screen's approval slot is that row.
 */

import { agentLog } from "@voluma/contracts/agents";
import type { RunEvent } from "@voluma/contracts/events";
import { versionPath } from "@voluma/contracts/r2";
import { plural } from "./run-status";

// ---------------------------------------------------------------------------------------------
// Tool calls

/** Calls that change results: never folded, a row of their own in every thread. */
const VISIBLE = new Set(["start_worker", "report_output", "change_outputs"]);

/**
 * What one tool call did in a few words, and the agent it names, if it names one. `nameOf` gives
 * an output's catalog name.
 */
export function toolTitle(
  name: string,
  input: unknown,
  nameOf: (id: string) => string = (id) => id,
): { title: string; target?: string } {
  const r = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const s = (k: string) => (typeof r[k] === "string" ? (r[k] as string) : undefined);
  const list = (k: string) =>
    Array.isArray(r[k])
      ? (r[k] as unknown[]).filter((p): p is string => typeof p === "string")
      : [];
  switch (name) {
    case "bash": {
      const lines = (s("command") ?? "")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#"));
      const first = lines[0] ?? "";
      // A heredoc's or `-c "`'s first line says only which interpreter: add its first statement.
      if (/(<<-?\s*['"]?\w+['"]?|\s-c\s+["'])\s*$/.test(first)) {
        const body = lines.slice(1).find((l) => !/^(import|from)\s/.test(l));
        if (body) return { title: `${first} ${body}` };
      }
      return { title: first };
    }
    case "bash_manage":
      return {
        title:
          {
            list: "Listed background commands",
            output: "Read a background command's output",
            wait: "Waited for a background command",
            kill: "Stopped a background command",
            detach: "Let a background command run on",
          }[s("action") ?? ""] ?? "Managed background commands",
      };
    case "read": {
      const files = list("paths").map((p) => p.split("/").pop());
      return { title: `Read ${files.join(", ") || "files"}` };
    }
    case "start_worker":
      return { title: "Started worker", target: s("name") };
    case "close_worker":
      return { title: r.now === true ? "Stopped worker" : "Closed worker", target: s("name") };
    case "message":
      return { title: "Messaged", target: s("to") };
    case "close":
      return { title: "Closed" };
    case "report_output":
      return { title: `Reported ${nameOf(s("id") ?? "") || "an output"}` };
    case "keep_output":
      return { title: `Kept ${list("ids").join(", ") || "outputs"} as they are` };
    case "change_outputs":
      return { title: "Changed the final outputs" };
    case "activity":
      return { title: s("text") ?? "Activity" };
    case "segment_sam":
      return { title: "Segmented with SAM" };
    case "segment_plate":
      return { title: "Proposed the growth plate with the plate model" };
    default: {
      const json = JSON.stringify(input);
      const text = json && json !== "{}" ? `${name} ${json}` : name;
      return { title: text.length > 120 ? `${text.slice(0, 120)}…` : text };
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Rows

export type ToolStep = {
  kind: "tool";
  id: string;
  name: string;
  title: string;
  /** The agent the call names (`start_worker`, `message`, `close_worker`). */
  target?: string;
  input: unknown;
  /** `stopped`: its thread ended, or the run ended, before it returned. */
  status: "running" | "done" | "error" | "stopped";
  output?: string;
  truncated?: boolean;
};

export type Step =
  | ToolStep
  | { kind: "reasoning"; id: string; text: string }
  /** A mechanical step: the sandbox. */
  | { kind: "note"; id: string; text: string; failed?: boolean };

export type Row =
  /**
   * The agent's words: its prose, and on main its `message` calls to the researcher too, one
   * voice. `head`: in the Conversation, the first words of a turn (the thread's, and each after
   * your message), which carry "The AI" and the time.
   */
  | { kind: "prose"; id: string; text: string; at: string; head?: boolean }
  /** Folded steps under `label`: the newest `activity` text in them, then their digest. */
  | { kind: "process"; id: string; steps: Step[]; label: string }
  /** A call that changes results (`VISIBLE`), shown open. */
  | { kind: "step"; id: string; step: ToolStep }
  /** What the thread was told: its system prompt, its brief, a message from someone. */
  | { kind: "brief"; id: string; label: string; text: string }
  | { kind: "failure"; id: string; text: string }
  /**
   * A screen's own row at its place in the log (`Slot`); the screen renders it by id. On a
   * person's slot, `got` is what main was handed with their words.
   */
  | { kind: "slot"; id: string; person?: boolean; got?: string };

/**
 * A row a screen puts into the thread: before the first event whose `seq` is past its own.
 * `person`: the researcher's message (its id is the `person.message` event's), which takes what
 * main got with it.
 */
export type Slot = { id: string; seq: number; person?: boolean };

/**
 * "Ran 12 commands, read 2 files, 1 failed": counts across a fold. `activity` calls are left out
 * (their text is the fold's label), and so are sandbox notes, which stay rows inside the fold.
 */
export function digest(steps: Step[]): string {
  let commands = 0;
  let reads = 0;
  let other = 0;
  const named: string[] = [];
  let failed = 0;
  let thought = false;
  for (const s of steps) {
    if (s.kind === "reasoning") thought = true;
    else if (s.kind === "tool" && s.name !== "activity") {
      if (s.name === "bash") commands++;
      else if (s.name === "read") reads++;
      else {
        const name = s.target ? `${s.title} ${s.target}` : s.title;
        // Unknown tools are too long or too vague to name.
        if (name.length <= 40) named.push(name);
        else other++;
      }
      if (s.status === "error") failed++;
    }
  }
  const parts = [
    commands > 0 && `ran ${plural(commands, "command")}`,
    reads > 0 && `read ${plural(reads, "file")}`,
    // A few other calls are named ("started worker intake"); more are counted.
    ...(named.length <= 2 ? named.map((n) => n[0]?.toLowerCase() + n.slice(1)) : []),
    (other > 0 || named.length > 2) &&
      plural(
        other + (named.length > 2 ? named.length : 0),
        commands + reads + named.length > 0 ? "other step" : "step",
      ),
    failed > 0 && `${failed} failed`,
  ].filter((p): p is string => Boolean(p));
  const text = parts.join(", ");
  if (!text) return thought ? "Thought" : "";
  return text[0]?.toUpperCase() + text.slice(1);
}

/** The newest `activity` text among `steps`: the agent's own status line. */
function activityOf(steps: readonly Step[]): string | undefined {
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i];
    if (s?.kind === "tool" && s.name === "activity") {
      const text = (s.input as { text?: unknown } | undefined)?.text;
      if (typeof text === "string" && text.trim()) return text.trim();
    }
  }
  return undefined;
}

/** A fold's label: "Checking the scan header · ran 1 command", or the digest alone. */
function foldLabel(steps: Step[]): string {
  const said = activityOf(steps);
  const count = digest(steps);
  // A fold of sandbox notes alone says the last of them ("Sandbox ready").
  const note = [...steps].reverse().find((s) => s.kind === "note");
  if (!said) return count || (note?.kind === "note" ? note.text : "Working");
  return count ? `${said} · ${count[0]?.toLowerCase()}${count.slice(1)}` : said;
}

/** Collects steps into the open process block, and closes it when something visible arrives. */
function rowBuilder() {
  const rows: Row[] = [];
  let open: Step[] | null = null;
  return {
    step(s: Step) {
      if (!open) {
        open = [];
        rows.push({ kind: "process", id: `process:${s.id}`, steps: open, label: "" });
      }
      open.push(s);
    },
    row(r: Row) {
      open = null;
      rows.push(r);
    },
    done(): Row[] {
      for (const r of rows) if (r.kind === "process") r.label = foldLabel(r.steps);
      return rows;
    },
  };
}

/** How a screen wants the thread: output names, and whether it is main's Conversation. */
export type ThreadOptions = {
  slots?: readonly Slot[];
  /** An output's catalog name. */
  nameOf?: (id: string) => string;
  /** Main's thread as the Conversation: each turn's first words head their row (`head`). */
  conversation?: boolean;
};

/**
 * The rows of the threads in `ids` (log order): one worker or check, or main's every thread, with
 * the screen's `slots` at their places. On a run that has ended (`live` false) a call still
 * running shows as stopped.
 */
export function threadRows(
  events: readonly RunEvent[],
  ids: readonly string[],
  live: boolean,
  { slots = [], nameOf, conversation = false }: ThreadOptions = {},
) {
  const shown = new Set(ids);
  const names = agentLog(events).records;
  const b = rowBuilder();
  const pending = [...slots].sort((x, y) => x.seq - y.seq);
  let next = 0;
  // Every slot's row up front, so a delivery can attach to your message by its id (`covers`).
  const slotRows = new Map(
    pending.map((s): [string, Extract<Row, { kind: "slot" }>] => [
      s.id,
      { kind: "slot", id: s.id, person: s.person },
    ]),
  );
  // The next words open a turn: the thread's first, and the first after each of your messages.
  let turn = conversation;
  const placeSlots = (upTo: number) => {
    for (let s = pending[next]; s && s.seq <= upTo; s = pending[++next]) {
      if (s.person) turn = conversation;
      const row = slotRows.get(s.id);
      if (row) b.row(row);
    }
  };
  const say = (id: string, text: string, at: string) => {
    b.row({ kind: "prose", id, text, at, head: turn || undefined });
    turn = false;
  };
  const tools = new Map<string, ToolStep>();
  // A report's version folder (`versionPath`) to its call, to name the version once published.
  const reports = new Map<string, ToolStep>();
  const briefed = new Set<string>();
  // Calls held for the researcher (main's, in review): their approval slot is their row.
  const held = new Set(
    events.flatMap((e) => (e.type === "approval.requested" ? [e.payload.toolCallId] : [])),
  );
  // Main's deliveries say which log events they cover: a person.message in that range is the researcher.
  const position = new Map(events.map((e, i) => [e.id, i]));
  let lastCovered = -1;
  let systemSeen = false;
  const stopRunning = () => {
    for (const step of tools.values()) if (step.status === "running") step.status = "stopped";
  };
  for (const e of events) {
    placeSlots(e.seq);
    // Whichever thread records it, a published version names the report that made it.
    if (e.type === "output.published") {
      const step = reports.get(e.payload.path);
      if (step) step.title = `${step.title}, version ${e.payload.version}`;
    }
    if (!shown.has(e.threadId)) continue;
    const isMain = names.get(e.threadId)?.place === "main";
    switch (e.type) {
      case "message": {
        const p = e.payload;
        if (p.role === "assistant") {
          if (p.reasoning)
            b.step({ kind: "reasoning", id: `${e.id}:reasoning`, text: p.reasoning });
          if (p.compaction) {
            // A summary that failed has no text; its message only carries the spend.
            if (p.text)
              b.row({
                kind: "brief",
                id: e.id,
                label: "The AI summarized its work so far",
                text: p.text,
              });
          } else if (p.text) say(e.id, p.text, e.createdAt);
        } else if (p.role === "system") {
          b.row({
            kind: "brief",
            id: e.id,
            label: systemSeen ? "The AI's tools changed" : "The AI's instructions",
            text: p.text,
          });
          systemSeen = true;
        } else {
          const { sender } = p;
          let label: string;
          if (sender.kind === "runtime" && sender.notice) label = "Context notice";
          else if (isMain) {
            // The researcher's words reach main inside a runtime delivery that covers them: the
            // last of your messages in the range it covers (one delivery can carry several).
            let yours: string | undefined;
            if (sender.kind === "runtime" && sender.covers) {
              const to = position.get(sender.covers);
              if (to !== undefined) {
                for (let i = lastCovered + 1; i <= to; i++) {
                  const c = events[i];
                  if (c?.type === "person.message") yours = c.id;
                }
                lastCovered = Math.max(lastCovered, to);
              }
            }
            // What main was handed goes into your message's own row; only with no such row does
            // it get a row of its own.
            if (yours) {
              const mine = slotRows.get(yours);
              if (mine?.person) {
                mine.got = p.text;
                briefed.add(e.threadId);
                break;
              }
              label = "What the AI got with your message";
            } else if (sender.kind === "thread")
              label = `Message from ${names.get(sender.threadId)?.name ?? "another agent"}`;
            else label = "News from the run";
          } else if (!briefed.has(e.threadId)) label = "Brief";
          else if (sender.kind === "thread")
            label = `Message from ${names.get(sender.threadId)?.name ?? "another agent"}`;
          else label = sender.kind === "runtime" ? "News from the run" : "Message";
          briefed.add(e.threadId);
          b.row({ kind: "brief", id: e.id, label, text: p.text });
        }
        break;
      }
      case "tool.call": {
        const step: ToolStep = {
          kind: "tool",
          id: e.payload.toolCallId,
          name: e.payload.name,
          ...toolTitle(e.payload.name, e.payload.input, nameOf),
          input: e.payload.input,
          status: "running",
        };
        tools.set(step.id, step);
        const input = e.payload.input as { to?: unknown; text?: unknown } | undefined;
        if (
          e.payload.name === "message" &&
          input?.to === "researcher" &&
          typeof input.text === "string"
        )
          say(step.id, input.text, e.createdAt);
        else if (held.has(step.id)) {
          // The approval slot says what it would do; the call runs, if you say yes, as a job.
        } else if (VISIBLE.has(step.name)) b.row({ kind: "step", id: step.id, step });
        else b.step(step);
        const id = (input as { id?: unknown } | undefined)?.id;
        if (step.name === "report_output" && typeof id === "string")
          reports.set(versionPath(id, step.id), step);
        break;
      }
      case "tool.result": {
        const step = tools.get(e.payload.toolCallId);
        if (!step) break;
        step.status = e.payload.isError ? "error" : "done";
        step.output = e.payload.output;
        step.truncated = e.payload.truncated;
        break;
      }
      case "sandbox":
        b.step({
          kind: "note",
          id: e.id,
          text: `Sandbox ${e.payload.state}${e.payload.detail ? `: ${e.payload.detail}` : ""}`,
          failed: e.payload.state === "failed",
        });
        break;
      case "thread.ended":
        stopRunning();
        if (e.payload.status === "failed")
          b.row({ kind: "failure", id: e.id, text: e.payload.error ?? "The thread failed." });
        break;
    }
  }
  placeSlots(Number.POSITIVE_INFINITY);
  if (!live) stopRunning();
  return b.done();
}

/** The title of the call a working thread has no result for yet: its live line. */
export function runningTitle(rows: readonly Row[]): string | undefined {
  const last = rows.at(-1);
  const step = last?.kind === "process" ? last.steps.at(-1) : last?.kind === "step" && last.step;
  return step && step.kind === "tool" && step.status === "running"
    ? `${step.title}${step.target ? ` ${step.target}` : ""}`
    : undefined;
}

/**
 * What the agent last said it is doing (`activity`) in its current turn: the scan stops at your
 * newest message and at anything else main was handed, which start a new turn.
 */
export function latestActivity(rows: readonly Row[]): string | undefined {
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if ((r?.kind === "slot" && r.person) || r?.kind === "brief") return undefined;
    const said = r?.kind === "process" ? activityOf(r.steps) : undefined;
    if (said) return said;
  }
  return undefined;
}
