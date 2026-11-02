/**
 * What `report_output` and `keep_output` share: the dependencies their factories take, who the
 * caller is, the event they write and the answer they give. Both write one `output` event per
 * version inside the run's section, so a version number is read and used with no other write in
 * between.
 */
import type { OutputCatalog } from "@voluma/contracts/output-catalog";
import { OUTPUTS_MOUNT, type OutputVersion, outputsFold } from "@voluma/contracts/output-fold";
import type { ThreadLayout } from "../../layout";
import type { Publish } from "../../ports/publish";
import type { PayloadOf, Recorder } from "../../recorder";
import { Refusal } from "./refusal";

export type OutputEvent = PayloadOf<"output">;

export interface OutputToolDeps {
  runId: string;
  recorder: Recorder;
  publish: Publish;
  /** The workflow's outputs: what may be reported without `kind`. */
  catalog: OutputCatalog;
  /** The calling thread's layout (`forAgent`), for its paths. */
  layoutOf(threadId: string): ThreadLayout;
  /** The sha256 of a file where the thread's sandbox has it mounted. */
  hashIn(threadId: string, path: string, signal: AbortSignal): Promise<string>;
  /** The run's critical section: one decision and its appends at a time. */
  section<T>(fn: () => Promise<T>): Promise<T>;
  /** Wakes the run loop after an event the loop acts on. */
  changed(): void;
  /** Rewrites `/run/final-outputs.yaml` and `/run/outputs.yaml`; awaited, so the reporter's next call sees them. */
  refreshRunFiles(): Promise<void>;
}

export interface Caller {
  /** The thread's name, as `thread.started` records it. */
  name: string;
  role: "main" | "worker";
  /** Its folder under `/work`; every main thread works in `main`. */
  folder: string;
}

export function callerOf(deps: OutputToolDeps, threadId: string): Caller {
  const started = deps.recorder
    .events()
    .find((e) => e.type === "thread.started" && e.threadId === threadId);
  if (started?.type !== "thread.started" || !started.payload.role)
    throw new Refusal(
      "This tool belongs to the agent loop, and this thread is not an agent of it.",
    );
  const { name, role } = started.payload;
  return { name, role, folder: role === "main" ? "main" : name };
}

export const eventById = (deps: OutputToolDeps, id: string) =>
  deps.recorder.events().find((e) => e.id === id);

export const foldOf = (deps: OutputToolDeps) => outputsFold(deps.recorder.events());

/** The next version number of `id`. Read inside the section. */
export const nextVersion = (deps: OutputToolDeps, id: string) =>
  (foldOf(deps).byId.get(id)?.latest?.version ?? 0) + 1;

/** What a call answers, whether it just wrote the event or finds it in the log. */
export function answerOf(p: OutputEvent) {
  const folder = `${OUTPUTS_MOUNT}/${p.path}/`;
  return {
    id: p.outputId,
    version: p.version,
    path: folder,
    ...(p.files && { files: p.files.map((f) => `${folder}${f.path}`) }),
    ...(p.kept && { kept: p.kept.reason }),
    note: "Listed in /run/outputs.yaml.",
  };
}

/**
 * The nested `output` every version carries for parsers that read it (`events.ts`): a
 * `measurement` for a value, a `file` naming the primary file for anything else.
 */
export function shellOf(
  v: Pick<OutputVersion, "path" | "files" | "value">,
  title: string,
  mediaType = "application/octet-stream",
): OutputEvent["output"] {
  if (v.value)
    return { kind: "measurement", value: v.value.number, unit: v.value.unit, confidence: null };
  const primary = v.files[0];
  if (!primary) throw new Error(`${title} has neither a value nor a file`);
  return {
    kind: "file",
    file: { root: "outputs", path: `${v.path}/${primary.path}`, sha256: primary.sha256 },
    mediaType,
  };
}

/** The catalog's name for `id`, else the id. */
export const titleOf = (deps: OutputToolDeps, id: string) =>
  deps.catalog.find((e) => e.id === id)?.name ?? id;
