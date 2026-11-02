/**
 * Every string the agent loop tells an agent: main's delivery (notices, the agent list, what is
 * out of date or pending), a worker's wrap-up request, the cut-off and liveness lines, and the
 * refusals and results of the coordination tools. The task loop's are `messages.ts`.
 */
import type { AgentLog, AgentRecord, AgentState, Notice } from "@voluma/contracts/agents";
import type { RunEvent } from "@voluma/contracts/events";
import { OUTPUTS_MOUNT, outputsFold } from "@voluma/contracts/output-fold";
import { callKey } from "@voluma/contracts/thread-records";

/** Characters of a worker-to-worker message shown to main as a receipt. */
const RECEIPT_CHARS = 300;
/** Characters of main's last message to an agent (or its brief), shown as what it is on. */
const ON_CHARS = 80;

const clip = (text: string, n: number) => (text.length > n ? `${text.slice(0, n)}…` : text);
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

/** What a worker is told when it is asked to wrap up (and what `close` answers itself). */
export const wrapUpText = (name: string) =>
  `Wrap up. Write /work/${name}/NOTES.md so that someone starting from it can carry on without you: what you did, where the files are, what you found, what is left and what you would try next. Then repeat the note as your last message and end your turn. Messages to you are refused from now on.`;

/** A cut-off agent that was winding up. */
export const wrapUpResumeText = (name: string) =>
  `You were asked to wrap up: finish /work/${name}/NOTES.md, repeat the note as your last message and end your turn.`;

export const STUCK_SUMMARY =
  "The run stopped before every output was made: main stopped moving, so code ended it.";
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
  }
};

/** The brief and skills of a worker, read back from the `start_worker` call that started it. */
export function briefOf(d: AgentLog, r: AgentRecord): { brief: string; skills: string[] } {
  const call =
    r.parentThreadId && r.spawnedBy
      ? d.calls.get(callKey(r.parentThreadId, r.spawnedBy))
      : undefined;
  const input = call?.name === "start_worker" ? (call.input as Record<string, unknown>) : {};
  return {
    brief: typeof input.brief === "string" ? input.brief : "",
    skills: Array.isArray(input.skills) ? (input.skills as string[]) : [],
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
}

export const deliveryText = (p: DeliveryParts): string =>
  [
    p.notices.join("\n"),
    p.receipts.length > 0 ? `Messages between workers:\n${p.receipts.join("\n")}` : "",
    `Agents:\n${p.agents}`,
    p.outOfDate.length > 0
      ? `Out of date, not yet decided (keep_output if it still holds, or have it redone): ${p.outOfDate.join(", ")}`
      : "",
    p.pending.length > 0
      ? `Final outputs still waiting for a first version: ${p.pending.join(", ")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
