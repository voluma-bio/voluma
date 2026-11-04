/**
 * One agent's thread as rows, derived with no React from the run's durable events: what it was
 * told, its prose, and its reasoning and tool calls folded into process blocks whose label is a
 * digest. The stream delivers durable events only, so a row appears when its event lands; a call
 * with no result yet is `running`.
 *
 * A thread is one or several thread ids: main is `main` plus every `main.N` after a review, in
 * log order, with a divider where each later one starts.
 */

import { agentLog } from "@voluma/contracts/agents";
import type { RunEvent } from "@voluma/contracts/events";
import { plural } from "./run-status";

// ---------------------------------------------------------------------------------------------
// Tool calls

/** What one tool call did in a few words, and the agent it names, if it names one. */
export function toolTitle(name: string, input: unknown): { title: string; target?: string } {
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
      return { title: `Reported ${s("id") ?? "an output"}` };
    case "keep_output":
      return { title: `Kept ${list("ids").join(", ") || "outputs"} as they are` };
    case "change_outputs":
      return { title: "Changed the final outputs" };
    case "activity":
      return { title: s("text") ?? "Activity" };
    case "segment_sam":
      return { title: "Segmented with SAM" };
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
  | { kind: "prose"; id: string; text: string }
  | { kind: "process"; id: string; steps: Step[]; digest: string }
  /** What the thread was told: its system prompt, its brief, a message from someone. */
  | { kind: "brief"; id: string; label: string; text: string }
  | { kind: "failure"; id: string; text: string }
  /** Where a later `main.N` thread of the merged main starts. */
  | { kind: "divider"; id: string; text: string };

/** "Ran 12 commands, read 2 files, 1 failed": counts across a fold. */
export function digest(steps: Step[]): string {
  let commands = 0;
  let reads = 0;
  let other = 0;
  const named: string[] = [];
  let failed = 0;
  let thought = false;
  for (const s of steps) {
    if (s.kind === "reasoning") thought = true;
    else if (s.kind === "note") {
      // A note is short runtime text ("Sandbox stopped"): name it like a call.
      if (s.text.length <= 40) named.push(s.text);
      else other++;
      if (s.failed) failed++;
    } else {
      if (s.name === "bash") commands++;
      else if (s.name === "read") reads++;
      else {
        const name = s.target ? `${s.title} ${s.target}` : s.title;
        // Activity text and unknown tools are too long or too vague to name.
        if (s.name !== "activity" && name.length <= 40) named.push(name);
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
  if (!text) return thought ? "Thinking" : "Working";
  return text[0]?.toUpperCase() + text.slice(1);
}

/** Collects steps into the open process block, and closes it when something visible arrives. */
function rowBuilder() {
  const rows: Row[] = [];
  let open: Step[] | null = null;
  return {
    step(s: Step) {
      if (!open) {
        open = [];
        rows.push({ kind: "process", id: `process:${s.id}`, steps: open, digest: "" });
      }
      open.push(s);
    },
    row(r: Row) {
      open = null;
      rows.push(r);
    },
    done(): Row[] {
      for (const r of rows) if (r.kind === "process") r.digest = digest(r.steps);
      return rows;
    },
  };
}

/**
 * The rows of the threads in `ids` (log order): one worker or check, or main's every thread. On
 * a run that has ended (`live` false) a call still running shows as stopped.
 */
export function threadRows(events: readonly RunEvent[], ids: readonly string[], live: boolean) {
  const shown = new Set(ids);
  const names = agentLog(events).records;
  const b = rowBuilder();
  const tools = new Map<string, ToolStep>();
  const started = new Set<string>();
  const briefed = new Set<string>();
  // Main's deliveries say which log events they cover: a person.message in that range is the researcher.
  const position = new Map(events.map((e, i) => [e.id, i]));
  let lastCovered = -1;
  let systemSeen = false;
  const stopRunning = () => {
    for (const step of tools.values()) if (step.status === "running") step.status = "stopped";
  };
  for (const e of events) {
    if (!shown.has(e.threadId)) continue;
    const isMain = names.get(e.threadId)?.place === "main";
    switch (e.type) {
      case "thread.started":
        if (started.size > 0 && !started.has(e.threadId))
          b.row({ kind: "divider", id: e.id, text: names.get(e.threadId)?.name ?? e.threadId });
        started.add(e.threadId);
        break;
      case "message": {
        const p = e.payload;
        if (p.role === "assistant") {
          if (p.reasoning)
            b.step({ kind: "reasoning", id: `${e.id}:reasoning`, text: p.reasoning });
          if (p.compaction) {
            // A summary that failed has no text; its message only carries the spend.
            if (p.text)
              b.row({ kind: "brief", id: e.id, label: "History summarized", text: p.text });
          } else if (p.text) b.row({ kind: "prose", id: e.id, text: p.text });
        } else if (p.role === "system") {
          b.row({
            kind: "brief",
            id: e.id,
            label: systemSeen ? "Tools changed" : "System prompt",
            text: p.text,
          });
          systemSeen = true;
        } else {
          const { sender } = p;
          let label: string;
          if (sender.kind === "runtime" && sender.notice) label = "Context notice";
          else if (isMain) {
            // The researcher's words reach main inside a runtime delivery that covers them.
            let fromYou = sender.kind === "person";
            if (sender.kind === "runtime" && sender.covers) {
              const to = position.get(sender.covers);
              if (to !== undefined) {
                for (let i = lastCovered + 1; i <= to && !fromYou; i++)
                  fromYou = events[i]?.type === "person.message";
                lastCovered = Math.max(lastCovered, to);
              }
            }
            if (fromYou) label = "Message from you";
            else if (sender.kind === "thread")
              label = `Message from ${names.get(sender.threadId)?.name ?? "another agent"}`;
            else label = "Update from Voluma";
          } else if (!briefed.has(e.threadId)) label = "Brief";
          else if (sender.kind === "thread")
            label = `Message from ${names.get(sender.threadId)?.name ?? "another agent"}`;
          else label = sender.kind === "runtime" ? "Update from Voluma" : "Message";
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
          ...toolTitle(e.payload.name, e.payload.input),
          input: e.payload.input,
          status: "running",
        };
        tools.set(step.id, step);
        b.step(step);
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
  if (!live) stopRunning();
  return b.done();
}

/** The title of the call a working thread has no result for yet: its live line. */
export function runningTitle(rows: readonly Row[]): string | undefined {
  const last = rows.at(-1);
  if (last?.kind !== "process") return undefined;
  const step = last.steps.at(-1);
  return step?.kind === "tool" && step.status === "running"
    ? `${step.title}${step.target ? ` ${step.target}` : ""}`
    : undefined;
}
