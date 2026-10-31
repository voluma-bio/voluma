import type { Meta, StoryObj } from "@storybook/react-vite";
import type { Status } from "@voluma/ui";
import type { NeedItem, ResultRow, TaskState, Thread } from "./run-model";
import { type ScanGraphTask, type StudyGraphTask, TaskGraph } from "./task-graph";

/**
 * **What:** the workflow as a graph of real nodes, one box per task laid out by its
 * dependencies, in three sizes: `study` (each box sums the study's scans, one cell per scan),
 * `summary` (one scan's tasks, small, left to right) and `report` (one scan's tasks top down in
 * the scan review's Report panel; the selected, working or redone task lists its agents).
 * **Why:** one picture of what a scan or a study went through and where it is stuck, and the way
 * into a task. **Where:** the study dashboard and Workflow page (study), a scan row's quick
 * summary (summary), the scan review's Report panel (report).
 *
 * Sample data (stories only): the mouse OA workflow's nine tasks, as `tasks.json` plans them.
 */
const meta = {
  title: "Run view/TaskGraph",
  component: TaskGraph,
} satisfies Meta<typeof TaskGraph>;
export default meta;
type Story = StoryObj<typeof meta>;

const PLAN: [string, string, string[]][] = [
  ["intake", "Scan intake", []],
  ["orientation", "Orientation", ["intake"]],
  ["segmentation", "Segmentation", ["orientation"]],
  ["iioc", "Tibial IIOC", ["segmentation"]],
  ["subchondral-plate", "Subchondral bone plate", ["iioc"]],
  ["trabecular-roi", "IIOC trabecular bone", ["iioc", "subchondral-plate"]],
  ["metaphyseal-roi", "Proximal tibial metaphysis", ["iioc"]],
  ["cortical", "Tibial cortical thickness", ["metaphyseal-roi"]],
  ["femoral-geometry", "Distal femur", ["segmentation"]],
];

const VALUES: Record<string, [string, string]> = {
  iioc: ["55.1", "% BV/TV"],
  "subchondral-plate": ["0.145", "mm"],
  "trabecular-roi": ["31.7", "% BV/TV"],
  "metaphyseal-roi": ["10.5", "% BV/TV"],
  cortical: ["0.165", "mm"],
  "femoral-geometry": ["3.30", "mm"],
};

const at = (min: number) => new Date(Date.UTC(2026, 9, 30, 9, min)).toISOString();

function thread(
  id: string,
  kind: "worker" | "check",
  taskId: string,
  status: Thread["status"],
  minutes: [number, number?],
  extra: Partial<Thread> = {},
): Thread {
  return {
    id,
    role: kind,
    kind,
    parentId: "main",
    taskId,
    attempts: [],
    startedAt: at(minutes[0]),
    endedAt: minutes[1] === undefined ? undefined : at(minutes[1]),
    workedBefore: 0,
    status,
    toolCalls: 0,
    toolErrors: 0,
    ...extra,
  };
}

function need(taskId: string, title: string): NeedItem {
  return {
    id: `${taskId}/1`,
    taskId,
    resultRevisionId: "story-revision",
    title,
    text: "",
    accepted: false,
    acceptable: true,
  };
}

function scanTasks(
  states: Record<string, TaskState>,
  extra: Record<string, Partial<ScanGraphTask>> = {},
) {
  return PLAN.map(([id, title, dependsOn]): ScanGraphTask => {
    const state = states[id] ?? "waiting";
    const v = VALUES[id];
    const results: ResultRow[] =
      v && (state === "done" || state === "to-check")
        ? [{ id: `${id}/value`, title, value: v[0], unit: v[1] }]
        : [];
    return { id, title, dependsOn, state, needs: [], results, ...extra[id] };
  });
}

const finished = scanTasks(Object.fromEntries(PLAN.map(([id]) => [id, "done" as TaskState])), {
  segmentation: {
    state: "to-check",
    needs: [need("segmentation", "Meniscus label touches the tibia")],
  },
  cortical: {
    state: "to-check",
    needs: [need("cortical", "Cortex thin at the medial edge")],
    threads: [
      thread("w", "worker", "cortical", "completed", [10, 16], { attempts: ["a1", "a2"] }),
      thread("c1", "check", "cortical", "completed", [16, 18], {
        attemptId: "a1",
        result: { text: "", verdict: "needs-review" },
      }),
      thread("c2", "check", "cortical", "completed", [22, 24], {
        attemptId: "a2",
        result: { text: "", verdict: "passed" },
      }),
    ],
  },
  iioc: {
    threads: [
      thread("wi", "worker", "iioc", "completed", [4, 9], { attempts: ["b1"] }),
      thread("ci", "check", "iioc", "completed", [9, 11], {
        attemptId: "b1",
        result: { text: "", verdict: "passed" },
      }),
    ],
  },
});

const running = scanTasks(
  {
    intake: "done",
    orientation: "done",
    segmentation: "done",
    iioc: "running",
    "femoral-geometry": "checking",
  },
  {
    iioc: { threads: [thread("wr", "worker", "iioc", "running", [4], { attempts: ["r1"] })] },
    "femoral-geometry": {
      threads: [
        thread("wf", "worker", "femoral-geometry", "completed", [4, 8], { attempts: ["f1"] }),
        thread("cf", "check", "femoral-geometry", "running", [8], { attemptId: "f1" }),
      ],
    },
  },
);

/** The scan review's Report panel, one task selected: it lists its agents. */
export const Report: Story = {
  args: {
    size: "report",
    tasks: finished,
    selected: "iioc",
    onSelect: () => {},
    onAgent: () => {},
  },
  decorators: [(Story) => <div className="w-[368px]">{Story()}</div>],
};

/** While the run goes: working tasks list their agents. */
export const ReportRunning: Story = {
  args: { size: "report", tasks: running, onSelect: () => {}, onAgent: () => {} },
  decorators: [(Story) => <div className="w-[368px]">{Story()}</div>],
};

/** A failed run: where it stopped, and what never started. */
export const ReportFailed: Story = {
  args: {
    size: "report",
    tasks: scanTasks({
      intake: "done",
      orientation: "done",
      segmentation: "failed",
      iioc: "skipped",
      "femoral-geometry": "skipped",
    }),
  },
  decorators: [(Story) => <div className="w-[368px]">{Story()}</div>],
};

/** A scan row's quick summary: small, left to right; a box opens the scan review on that task. */
export const Summary: Story = {
  args: { size: "summary", tasks: finished, onSelect: () => {} },
  decorators: [(Story) => <div className="w-[760px]">{Story()}</div>],
};

const SCANS = 20;
const spread = (counts: Partial<Record<Status, number>>): Status[] => {
  const out: Status[] = [];
  for (const [s, n] of Object.entries(counts))
    for (let i = 0; i < (n ?? 0); i++) out.push(s as Status);
  while (out.length < SCANS) out.push("waiting");
  return out;
};
const STUDY: Record<string, Partial<Record<Status, number>>> = {
  intake: { done: 17 },
  orientation: { done: 15, stopped: 1, paused: 1 },
  segmentation: { done: 9, check: 5, stopped: 1 },
  iioc: { done: 6, check: 6, running: 1, paused: 1 },
  "subchondral-plate": { done: 11, check: 1 },
  "trabecular-roi": { done: 12 },
  "metaphyseal-roi": { done: 11, running: 1 },
  cortical: { done: 7, check: 4 },
  "femoral-geometry": { done: 11, check: 1, running: 1 },
};
const study: StudyGraphTask[] = PLAN.map(([id, title, dependsOn]) => ({
  id,
  title,
  dependsOn,
  scans: spread(STUDY[id] ?? {}),
}));

/** The study dashboard: each box is one task across the study's 20 scans. */
export const Study: Story = {
  args: { size: "study", tasks: study, selected: "iioc", onSelect: () => {} },
  decorators: [(Story) => <div className="w-[720px]">{Story()}</div>],
};

/** Before any scan has a plan: every box waits. */
export const StudyNothingYet: Story = {
  args: {
    size: "study",
    tasks: PLAN.map(([id, title, dependsOn]) => ({ id, title, dependsOn, scans: spread({}) })),
  },
  decorators: [(Story) => <div className="w-[720px]">{Story()}</div>],
};
