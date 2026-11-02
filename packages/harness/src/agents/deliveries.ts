/**
 * Every string the agent loop tells an agent: main's delivery (notices, the agent list, what is
 * out of date or pending), a worker's wrap-up request, the cut-off and liveness lines, and the
 * refusals and results of the coordination tools. The task loop's are `messages.ts`.
 */
import type { AgentLog, AgentRecord, AgentState, Notice } from "@voluma/contracts/agents";
import type { RunEvent } from "@voluma/contracts/events";
import type { PersonMessage } from "@voluma/contracts/messages";
import { OUTPUTS_MOUNT, outputsFold } from "@voluma/contracts/output-fold";
import { callKey } from "@voluma/contracts/thread-records";

/** Characters of a worker-to-worker message shown to main as a receipt. */
const RECEIPT_CHARS = 300;
/** Characters of main's last message to an agent (or its brief), shown as what it is on. */
const ON_CHARS = 80;

/** Characters of the researcher's open view shown to main. */
const VIEW_CHARS = 600;

const clip = (text: string, n: number) => (text.length > n ? `${text.slice(0, n)}…` : text);
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

/** What a worker is told when it is asked to wrap up (and what `close` answers itself). */
export const wrapUpText = (name: string) =>
  `Wrap up. Write /work/${name}/NOTES.md so that someone starting from it can carry on without you: what you did, where the files are, what you found, what is left and what you would try next. Then repeat the note as your last message and end your turn. Messages to you are refused from now on.`;

/** A cut-off agent that was winding up. */
export const wrapUpResumeText = (name: string) =>
  `You were asked to wrap up: finish /work/${name}/NOTES.md, repeat the note as your last message and end your turn.`;

/** The idle ping (Jimmy's wording); `minutes` comes from config so the text is right on every provider. */
export const pingText = (minutes: number) =>
  `This session has been idle for ${minutes} minutes. If you are finished, call close().`;

/** What an agent is told when it has worked a while without an `activity` line. */
export const activityReminder = (minutes: number) =>
  `You have sent no activity line for ${minutes} min. Send one now with activity: one plain sentence on what you are doing, then carry on.`;

export const STUCK_SUMMARY =
  "The run stopped before every output was made: main stopped moving, so code ended it.";
/** The summary of the root's end while the researcher is reviewing and nothing is in flight. */
export const WAITING_SUMMARY = "Waiting for the researcher.";
export const STUCK_REASON = "the run stopped before this was made";

export const noticeLine = (n: Notice, events: readonly RunEvent[]): string => {
  switch (n.kind) {
    case "output": {
      const o = outputsFold(events).byId.get(n.outputId);
      const v = o?.versions.find((x) => x.version === n.version);
      const folder = v ? `${OUTPUTS_MOUNT}/${v.path}/` : "";
      const what = v?.value
        ? `${v.value.number} ${v.value.unit}`
        : (v?.files.map((f) => `${folder}${f.name}`).join(", ") ?? "");
      const expect = Array.isArray(o?.entry?.expect) ? (o.entry.expect as string[]) : [];
      const toCheck = v?.toCheck.map((t) => t.title) ?? [];
      return [
        `- ${n.agent} reported ${n.outputId} version ${n.version}: ${what}`,
        ...(expect.length ? [`  expected: ${expect.map(oneLine).join(" | ")}`] : []),
        ...(toCheck.length ? [`  to check: ${toCheck.join(" | ")}`] : []),
        ...(v && v.madeFrom.length
          ? [
              `  made from: ${v.madeFrom.map((m) => `${m.id} v${m.version} (${m.role})`).join(", ")}`,
            ]
          : []),
      ].join("\n");
    }
    case "message":
      return `- ${n.agent} to you: ${n.text}`;
    case "failed":
      return `- ${n.agent} failed: ${n.error}. Message it to try again, or close_worker it.`;
    case "closed":
      return `- ${n.agent} closed.${n.note ? ` Its note: ${n.note}` : ""}`;
    case "stopped":
      return `- ${n.agent} was stopped: ${n.reason}. Start a new worker if its work is not done.`;
    case "silent":
      return `- ${n.agent} ended its turn without a report, a message to you or a close.${n.reply ? ` Its last words: ${n.reply}` : ""}`;
    case "person":
      return personLines(n.message, events);
    case "approval":
      return approvalLine(n, events);
  }
};

const WITHDRAWN = "The run was closed";

/** What became of a held call, for main: the researcher's answer, or what happened when it ran. */
function approvalLine(
  n: Extract<Notice, { kind: "approval" }>,
  events: readonly RunEvent[],
): string {
  const request = events.find(
    (e) => e.type === "approval.requested" && e.payload.toolCallId === n.toolCallId,
  );
  const call =
    request?.type === "approval.requested"
      ? `${request.payload.tool} (${request.payload.summary})`
      : n.toolCallId;
  switch (n.outcome) {
    case "done":
      return `- The researcher approved ${call}, and it ran: ${n.text}`;
    case "refused":
      return `- The researcher approved ${call}, but it was refused when it ran: ${n.text}`;
    case "withdrawn":
      return `- ${call} was withdrawn: ${n.text || WITHDRAWN}.`;
    case "declined": {
      const left = events
        .filter((e) => e.type === "output.published" && e.id.startsWith(`${request?.id}:left:`))
        .map((e) => (e.type === "output.published" ? e.payload.outputId : ""));
      return [
        `- The researcher declined ${call}.${n.text ? ` Their words: ${n.text}` : ""}`,
        ...(left.length > 0
          ? [
              `  ${left.join(", ")} ${left.length === 1 ? "is" : "are"} left to the researcher with a To check item, so ${left.length === 1 ? "it needs" : "they need"} no decision from you.`,
            ]
          : []),
      ].join("\n");
    }
  }
}

const mm = (v: readonly number[]) => `(${v.map((x) => Number(x.toFixed(2))).join(", ")})`;

const SHAPES: Record<string, string> = {
  point: "a point",
  line: "a line",
  box: "a box",
  angle: "an angle",
  outline: "an outline",
};

/** The message the researcher sent, with each mark they attached in the plain terms of the notice (`design-r3.md`). Positions are world mm, never voxels. */
function personLines(m: PersonMessage, events: readonly RunEvent[]): string {
  const fold = outputsFold(events);
  const marks = (m.attached ?? []).map((a) => {
    const shape = SHAPES[Object.keys(a.mark.mark).find((k) => k in SHAPES) ?? ""] ?? "a mark";
    const view = a.mark.plane ? `the ${a.mark.plane.view.toUpperCase()} plane` : "3D";
    const where = `${shape} in ${view}`;
    const head = `- ${a.change}: "${a.mark.tag}" on ${a.mark.output} v${a.version}, ${where}`;
    const line = (a.mark.mark as { line?: { lengthMm?: number } }).line;
    const length =
      line?.lengthMm === undefined ? "" : `, length ${Number(line.lengthMm.toFixed(2))} mm`;
    const ends = a.mark.world.map(mm).join("–");
    if (a.change === "move" && a.was)
      return `${head}, from ${a.was.world.map(mm).join("–")} to ${ends} mm${length}`;
    if (a.change === "place") {
      // A ruler end dragged is a first `mark.placed` of an output the AI drew: the original is in its files.
      const drawn = fold.byId.get(a.mark.output)?.latest?.detail?.points !== undefined;
      return `${head} at ${ends} mm${length}${drawn ? `; the AI's version is in ${a.mark.output} v${a.version}'s files (\`/run/outputs.yaml\` gives the path)` : ""}`;
    }
    return `${head} at ${ends} mm${length}`;
  });
  const checkTitle = m.toCheck
    ? fold.byId.get(m.toCheck.output)?.versions.find((v) => v.version === m.toCheck?.version)
        ?.toCheck[m.toCheck.item]?.title
    : undefined;
  const about = [
    ...(m.output ? [`They were looking at ${m.output}.`] : []),
    ...(m.toCheck
      ? [
          `They are correcting To check item ${m.toCheck.item} of ${m.toCheck.output} v${m.toCheck.version}${checkTitle ? `: ${checkTitle}` : ""}.`,
        ]
      : []),
    ...(m.view ? [`Their view: ${JSON.stringify(m.view).slice(0, VIEW_CHARS)}`] : []),
  ];
  return [
    `The researcher wrote${m.text ? `:\n${m.text}` : " (marks only):"}`,
    ...about,
    ...(marks.length > 0
      ? [
          "Marks they attached (their annotations, not outputs; nothing changed until you change it):",
          ...marks,
        ]
      : []),
    ...(m.snapshotKey
      ? [`Screenshot: ${m.snapshotKey.replace(/^runs\/[^/]+\/scratch\//, "/work/")}`]
      : []),
  ].join("\n");
}

/** The brief, skills and `outputs` limit of a worker, read back from the `start_worker` call that started it. */
export function briefOf(
  d: AgentLog,
  r: AgentRecord,
): { brief: string; skills: string[]; outputs?: string[] } {
  const call =
    r.parentThreadId && r.spawnedBy
      ? d.calls.get(callKey(r.parentThreadId, r.spawnedBy))
      : undefined;
  const input = call?.name === "start_worker" ? (call.input as Record<string, unknown>) : {};
  return {
    brief: typeof input.brief === "string" ? input.brief : "",
    skills: Array.isArray(input.skills) ? (input.skills as string[]) : [],
    ...(Array.isArray(input.outputs) && { outputs: input.outputs as string[] }),
  };
}

/** Agents as main reads them: name, state, what it is on, idle time, last report. */
export function agentList(
  d: AgentLog,
  stateOf: (r: AgentRecord) => AgentState,
  now: number,
): string {
  const rows = [...d.records.values()]
    .filter((r) => r.place === "worker")
    .map((r) => {
      const state = stateOf(r);
      const brief = [...d.messages.values()].filter((m) => m.from === "main" && m.to === r.name);
      const on = brief.at(-1)?.text ?? briefOf(d, r).brief;
      const idle =
        state === "idle" && r.end
          ? `, idle ${Math.max(0, Math.round((now - Date.parse(r.endedTime)) / 60_000))} min`
          : "";
      const last = r.lastReport
        ? `, last report ${r.lastReport.outputId} v${r.lastReport.version}`
        : "";
      const tie = `${r.blind ? `, blind to ${r.blind}` : ""}${r.from ? `, started from ${r.from}` : ""}`;
      return `- ${r.name}: ${state}${tie}${idle}${on ? `, on: ${clip(oneLine(on), ON_CHARS)}` : ""}${last}`;
    });
  return rows.length > 0 ? rows.join("\n") : "(no workers started)";
}

/** Worker-to-worker messages since the delivery before: main sees that they happened. */
export function receipts(d: AgentLog, since: number): string[] {
  return [...d.messages.values()]
    .filter((m) => m.at > since && m.to !== "main" && m.to !== "researcher" && m.from !== "main")
    .map((m) => `- ${m.from} to ${m.to}: ${clip(oneLine(m.text), RECEIPT_CHARS)}`);
}

interface DeliveryParts {
  notices: string[];
  receipts: string[];
  agents: string;
  outOfDate: string[];
  pending: string[];
  /** The researcher is reviewing: an out-of-date output may also be left to them. */
  reviewing: boolean;
  /** Skill texts due with this delivery (`researcher`, `corrections`). */
  skills: string[];
}

export const deliveryText = (p: DeliveryParts): string =>
  [
    p.notices.join("\n"),
    p.receipts.length > 0 ? `Messages between workers:\n${p.receipts.join("\n")}` : "",
    `Agents:\n${p.agents}`,
    p.outOfDate.length > 0
      ? `Out of date, not yet decided (keep_output if it still holds, or have it redone${p.reviewing ? ", or leave it to the researcher with keep_output's toCheck" : ""}): ${p.outOfDate.join(", ")}`
      : "",
    p.pending.length > 0
      ? `Final outputs still waiting for a first version: ${p.pending.join(", ")}`
      : "",
    ...p.skills,
  ]
    .filter(Boolean)
    .join("\n\n");
