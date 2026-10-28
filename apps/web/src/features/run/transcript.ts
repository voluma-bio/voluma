/**
 * The live run page's transcripts, derived with no React from the run's durable events plus
 * the live frames still in flight (`@voluma/contracts/stream`). Pure over `RunEvent[]` in
 * `seq` order and a `Live` value.
 *
 * Shape follows Meridian Flow's assistant turn: the model's prose stays visible; reasoning and
 * each run of tool calls between two pieces of prose fold into one process block whose
 * summary is a digest; milestones (checkpoints, reported outputs) and failures break the fold.
 *
 * The main thread is the run's orchestration: its wakes are its own voice, workers and
 * checkers appear as agent cards where they started, and the supervisor's code (task
 * statuses set by a rule, judgments applied, revisions) folds like tool calls.
 *
 * Live frames are folded per key and dropped when their durable event lands: a reply's text
 * and reasoning by `messageId` (the id of the durable `message`, or of the `wake` for the main
 * thread), a tool call's arguments by `toolCallId` (until its `tool.call`), its output by
 * `toolCallId` (until its `tool.result`).
 */
import type { ModelUsage, RunEvent } from "@voluma/contracts/events";
import type { LiveFrame } from "@voluma/contracts/stream";
import { taskTitle } from "./workflows";

type Ev<T extends RunEvent["type"]> = Extract<RunEvent, { type: T }>;

// ---------------------------------------------------------------------------------------------
// Live frames

export type LiveReply = { threadId: string; text: string; reasoning: string };
export type LiveCall = { threadId: string; messageId: string; args: string };
export type Live = {
  replies: ReadonlyMap<string, LiveReply>;
  calls: ReadonlyMap<string, LiveCall>;
  outputs: ReadonlyMap<string, string>;
};
export const noLive: Live = { replies: new Map(), calls: new Map(), outputs: new Map() };

/** Appends a frame where its `offset` fits what is held; a frame that doesn't fit is dropped. */
export function applyFrame(live: Live, f: LiveFrame): Live {
  switch (f.type) {
    case "text.delta":
    case "reasoning.delta": {
      const held = live.replies.get(f.messageId) ?? {
        threadId: f.threadId,
        text: "",
        reasoning: "",
      };
      const field = f.type === "text.delta" ? "text" : "reasoning";
      if (held[field].length !== f.offset) return live;
      const replies = new Map(live.replies);
      replies.set(f.messageId, { ...held, [field]: held[field] + f.text });
      return { ...live, replies };
    }
    case "tool.arguments.delta": {
      const held = live.calls.get(f.toolCallId) ?? {
        threadId: f.threadId,
        messageId: f.messageId,
        args: "",
      };
      if (held.args.length !== f.offset) return live;
      const calls = new Map(live.calls);
      calls.set(f.toolCallId, { ...held, args: held.args + f.text });
      return { ...live, calls };
    }
    case "tool.output": {
      const outputs = new Map(live.outputs);
      outputs.set(f.toolCallId, (live.outputs.get(f.toolCallId) ?? "") + f.text);
      return { ...live, outputs };
    }
  }
}

/** Drops what a durable event completes; returns `live` itself when nothing changed. */
export function settle(live: Live, e: RunEvent): Live {
  const drop = <V>(map: ReadonlyMap<string, V>, keep: (k: string, v: V) => boolean) => {
    let next: Map<string, V> | undefined;
    for (const [k, v] of map)
      if (!keep(k, v)) {
        next ??= new Map(map);
        next.delete(k);
      }
    return next;
  };
  let replies: Map<string, LiveReply> | undefined;
  let calls: Map<string, LiveCall> | undefined;
  let outputs: Map<string, string> | undefined;
  if (e.type === "message" || e.type === "wake") replies = drop(live.replies, (k) => k !== e.id);
  if (e.type === "tool.call") calls = drop(live.calls, (k) => k !== e.payload.toolCallId);
  if (e.type === "tool.result") outputs = drop(live.outputs, (k) => k !== e.payload.toolCallId);
  if (e.type === "thread.ended") {
    // A reply cut off mid-stream never gets its durable events.
    replies = drop(live.replies, (_, v) => v.threadId !== e.threadId);
    calls = drop(live.calls, (_, v) => v.threadId !== e.threadId);
  }
  if (!replies && !calls && !outputs) return live;
  return {
    replies: replies ?? live.replies,
    calls: calls ?? live.calls,
    outputs: outputs ?? live.outputs,
  };
}

/**
 * The value of a string field in JSON that may be cut off mid-string: `{"command":"ls -l` gives
 * `ls -l`. Enough to title a tool call, or show a wake's note, while the model still writes it.
 */
export function partialJsonString(json: string, key: string): string | undefined {
  const at = json.search(new RegExp(`"${key}"\\s*:\\s*"`));
  if (at < 0) return undefined;
  let i = json.indexOf('"', json.indexOf(":", at)) + 1;
  let out = "";
  const escapes: Record<string, string> = {
    n: "\n",
    t: "\t",
    r: "",
    '"': '"',
    "\\": "\\",
    "/": "/",
  };
  while (i < json.length) {
    const c = json[i];
    if (c === '"') break;
    if (c === "\\") {
      const next = json[i + 1];
      if (next === undefined) break;
      if (next === "u") {
        const hex = json.slice(i + 2, i + 6);
        if (hex.length < 4) break;
        out += String.fromCharCode(Number.parseInt(hex, 16));
        i += 6;
        continue;
      }
      out += escapes[next] ?? next;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Tool calls

/** What one tool call did, in a few words: the command for bash, the gist for the others. */
export function toolTitle(name: string, input: unknown): string {
  const r = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const s = (k: string) => (typeof r[k] === "string" ? (r[k] as string) : undefined);
  switch (name) {
    case "bash": {
      const lines = (s("command") ?? "")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#"));
      const first = lines[0] ?? "";
      // A heredoc's first line says only which interpreter: add its first real statement.
      if (/<<-?\s*['"]?\w+['"]?\s*$/.test(first)) {
        const body = lines.slice(1).find((l) => !/^(import|from)\s/.test(l));
        if (body) return `${first} ${body}`;
      }
      return first;
    }
    case "view_image": {
      const paths = Array.isArray(r.paths) ? r.paths.filter((p) => typeof p === "string") : [];
      return `Viewed ${paths.map((p) => p.split("/").pop()).join(", ") || "an image"}`;
    }
    case "checklist":
      return `Marked ${taskTitle(s("taskId") ?? "the task")} ${s("status") ?? ""}`.trim();
    case "checkpoint":
      return "Recorded a checkpoint";
    case "report_output":
      return `Reported ${s("outputId") ?? "an output"}`;
    case "thread_message":
      return `Messaged ${s("threadId") ?? "another thread"}`;
    case "segment_sam":
      return "Segmented with SAM";
    default: {
      const json = JSON.stringify(input);
      return json && json !== "{}" ? `${name} ${json}` : name;
    }
  }
}

/** A tool call's title from arguments still being written: the bash command once it shows. */
const partialTitle = (args: string) => {
  const command = partialJsonString(args, "command");
  return command?.trim() ? toolTitle("bash", { command }) : "Writing a tool call…";
};

// ---------------------------------------------------------------------------------------------
// Rows

export type ToolStep = {
  kind: "tool";
  id: string;
  /** Absent while the call's arguments are still streaming (frames carry no tool name). */
  name?: string;
  title: string;
  input: unknown;
  status: "running" | "done" | "error";
  output?: string;
  truncated?: boolean;
};

export type Step =
  | ToolStep
  | { kind: "reasoning"; id: string; text: string }
  /** A mechanical step: the sandbox, an attempt opening, the supervisor's code. */
  | { kind: "note"; id: string; text: string; failed?: boolean };

export type Row =
  | { kind: "prose"; id: string; text: string; streaming: boolean; usage?: ModelUsage }
  | { kind: "process"; id: string; steps: Step[]; digest: string }
  /** What the thread was told: its system prompt, its brief, a message from another thread. */
  | { kind: "brief"; id: string; label: string; text: string }
  | { kind: "checkpoint"; id: string; event: Ev<"checkpoint"> }
  | { kind: "output"; id: string; event: Ev<"output"> }
  | { kind: "failure"; id: string; text: string }
  /** The main thread's turn; `partial` is its note while the reply streams. */
  | { kind: "wake"; id: string; event?: Ev<"wake">; partial?: string }
  | { kind: "agent"; id: string; threadId: string };

/** "Ran 12 commands, viewed 2 images, 1 failed": counts across a fold, Flow's digest. */
export function digest(steps: Step[]): string {
  let commands = 0;
  let images = 0;
  let other = 0;
  let failed = 0;
  let thought = false;
  for (const s of steps) {
    if (s.kind === "reasoning") thought = true;
    else if (s.kind === "note") {
      other++;
      if (s.failed) failed++;
    } else {
      if (s.name === "bash" || s.name === undefined) commands++;
      else if (s.name === "view_image") images++;
      else other++;
      if (s.status === "error") failed++;
    }
  }
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const parts = [
    commands > 0 && `ran ${plural(commands, "command", "commands")}`,
    images > 0 && `viewed ${plural(images, "image", "images")}`,
    other > 0 && plural(other, "step", "steps"),
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

const MAIN_KINDS = new Set(["supervisor"]);

/** Tools whose result is its own visible row (a checkpoint or output event); the call adds nothing. */
const SHOWN_AS_ROWS = new Set(["checkpoint", "report_output"]);

/**
 * One worker, checker or chat thread's transcript: what it was told, its prose, its folded
 * process, its milestones, then whatever of its reply is still streaming.
 */
export function threadRows(events: RunEvent[], threadId: string, live: Live = noLive): Row[] {
  const b = rowBuilder();
  const tools = new Map<string, ToolStep>();
  for (const e of events) {
    if (e.threadId !== threadId) continue;
    switch (e.type) {
      case "message": {
        const p = e.payload;
        if (p.role === "assistant") {
          if (p.reasoning)
            b.step({ kind: "reasoning", id: `${e.id}:reasoning`, text: p.reasoning });
          if (p.text)
            b.row({ kind: "prose", id: e.id, text: p.text, streaming: false, usage: p.usage });
        } else if (p.role === "system") {
          b.row({ kind: "brief", id: e.id, label: "System prompt", text: p.text });
        } else {
          const label =
            p.sender.kind === "thread"
              ? "Message from another thread"
              : p.sender.kind === "person"
                ? "Message from a person"
                : "Brief";
          b.row({ kind: "brief", id: e.id, label, text: p.text });
        }
        break;
      }
      case "tool.call": {
        const step: ToolStep = {
          kind: "tool",
          id: e.payload.toolCallId,
          name: e.payload.name,
          title: toolTitle(e.payload.name, e.payload.input),
          input: e.payload.input,
          status: "running",
          output: live.outputs.get(e.payload.toolCallId),
        };
        tools.set(step.id, step);
        if (!SHOWN_AS_ROWS.has(e.payload.name)) b.step(step);
        break;
      }
      case "tool.result": {
        const step = tools.get(e.payload.toolCallId);
        if (!step) break;
        step.status = e.payload.isError ? "error" : "done";
        step.output = e.payload.output;
        step.truncated = e.payload.truncated;
        // A failed checkpoint or report has no row of its own: show the failed call.
        if (e.payload.isError && step.name && SHOWN_AS_ROWS.has(step.name)) b.step(step);
        break;
      }
      case "checkpoint":
        b.row({ kind: "checkpoint", id: e.id, event: e });
        break;
      case "output":
        b.row({ kind: "output", id: e.id, event: e });
        break;
      case "sandbox":
        b.step({
          kind: "note",
          id: e.id,
          text: `Sandbox ${e.payload.state}${e.payload.detail ? `: ${e.payload.detail}` : ""}`,
          failed: e.payload.state === "failed",
        });
        break;
      case "attempt.opened":
        b.step({
          kind: "note",
          id: e.id,
          text: `Opened an attempt on ${taskTitle(e.payload.taskId)}`,
        });
        break;
      case "task":
        b.step({
          kind: "note",
          id: e.id,
          text: `${taskTitle(e.payload.taskId)} is ${e.payload.status}: ${e.payload.reason}`,
        });
        break;
      case "thread.ended":
        if (e.payload.status === "failed")
          b.row({ kind: "failure", id: e.id, text: e.payload.error ?? "The thread failed." });
        break;
    }
  }
  for (const [id, reply] of live.replies) {
    if (reply.threadId !== threadId) continue;
    if (reply.reasoning)
      b.step({ kind: "reasoning", id: `${id}:reasoning`, text: reply.reasoning });
    if (reply.text) b.row({ kind: "prose", id, text: reply.text, streaming: true });
  }
  for (const [id, call] of live.calls) {
    if (call.threadId !== threadId || tools.has(id)) continue;
    b.step({
      kind: "tool",
      id,
      title: partialTitle(call.args),
      input: call.args,
      status: "running",
    });
  }
  return b.done();
}

/**
 * The main thread's transcript, which is the run's orchestration: wakes, an agent card where
 * each worker and checker started, and the supervisor's own steps folded between them.
 */
export function mainRows(events: RunEvent[], live: Live = noLive): Row[] {
  const b = rowBuilder();
  const supervisor = events.find(
    (e) => e.type === "thread.started" && MAIN_KINDS.has(e.payload.kind),
  )?.threadId;
  const seen = new Set<string>();
  for (const e of events) {
    switch (e.type) {
      case "wake":
        b.row({ kind: "wake", id: e.id, event: e });
        break;
      case "thread.started":
        if ((e.payload.kind === "worker" || e.payload.kind === "check") && !seen.has(e.threadId)) {
          seen.add(e.threadId);
          b.row({ kind: "agent", id: `agent:${e.threadId}`, threadId: e.threadId });
        }
        break;
      case "revision.started":
        if (e.payload.reason !== "run")
          b.step({
            kind: "note",
            id: e.id,
            text:
              e.payload.reason === "fix"
                ? `The checker fixed ${taskTitle(e.payload.taskId)}: a new revision of its results`
                : `${taskTitle(e.payload.taskId)} was corrected: a new revision of its results`,
          });
        break;
      case "task":
        if (e.payload.by.kind !== "agent")
          b.step({
            kind: "note",
            id: e.id,
            text: `${taskTitle(e.payload.taskId)} is ${e.payload.status}: ${e.payload.reason}`,
          });
        break;
      case "judgment":
        b.step({
          kind: "note",
          id: e.id,
          text: `Applied "${e.payload.applied.action}"${
            e.payload.applied.fallback === "redo-cap"
              ? " (the redo limit was reached)"
              : e.payload.applied.fallback === "error"
                ? " (the judgment failed, so it accepted)"
                : ""
          }`,
          failed: e.payload.applied.fallback === "error",
        });
        break;
      case "sandbox":
        if (e.payload.state === "failed")
          b.row({
            kind: "failure",
            id: e.id,
            text: `Sandbox ${e.payload.name} failed${e.payload.detail ? `: ${e.payload.detail}` : "."}`,
          });
        break;
      case "thread.ended":
        if (e.threadId === supervisor && e.payload.status === "failed")
          b.row({ kind: "failure", id: e.id, text: e.payload.error ?? "The run failed." });
        break;
    }
  }
  for (const [id, reply] of live.replies) {
    if (reply.threadId !== supervisor) continue;
    b.row({ kind: "wake", id, partial: partialJsonString(reply.text, "note") ?? "" });
  }
  return b.done();
}
