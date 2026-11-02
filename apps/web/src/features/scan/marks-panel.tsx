/**
 * Marks: your marks on the scan, held by the page until a message to the AI carries them. Each
 * has a short tag (P1, B1, L1, O1) drawn beside it in the views and belongs to the image it was
 * made on (`gridKeyOf`); a redo that replaces that image drops it. A row selects it (the views
 * move to it, opening its task when it is on another grid) or deletes it. The tools that make
 * them, and their keys, are `TOOLS` in the task review and `QUAD_TOOLS` in the outputs review,
 * picked on the viewer's bar. The page mounts the panel only while there is a mark. Marks are
 * the viewer's (`GridMark`); a message converts them (`messageMark`).
 */
import { MAX_MARKS, type Mark } from "@voluma/contracts/messages";
import type { Volume } from "@voluma/contracts/review";
import { IconButton, List, Row } from "@voluma/ui";
import {
  type GridMark,
  type GridViewerHandle,
  type MarkPlane,
  type MarkTool,
  markPoints,
  outlineAxis,
  probeText,
  type Zyx,
} from "@voluma/viewer/grid";
import { Angle, Crosshair, Lasso, MapPin, Pipette, Ruler, Trash2 } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";

/**
 * A mark of yours, as the viewer draws it: `volumeId` the grid's image it was made on,
 * `taskId` the task (or output) it was made in view of.
 */
export type YourMark = {
  id: string;
  tag: string;
  taskId: string;
  gridKey: string;
  volumeId: string;
  mark: GridMark;
  /** The pane it was made in; null in 3D. */
  plane: MarkPlane | null;
  /** Another person's, on a run whose marks are kept: shown, not yours to delete. */
  theirs?: boolean;
};

/**
 * Where marks are kept when the run keeps them (the outputs review): the page's marks, and the two
 * writes. `place` is a new mark or a changed one under the same id.
 */
export type MarkStore = {
  marks: readonly YourMark[];
  place(mark: YourMark): void;
  erase(id: string): void;
};

/**
 * The task and immutable image/grid identity actually mounted in the viewer, and whether a
 * picture of the views would go now (no pane loading).
 */
export type ShownGrid = { taskId: string; key: string; ready: boolean };

/**
 * An image's identity for marks: a redo keeps block ids, so coordinates belong to the bytes and
 * their frame, not the id alone. Undefined for an image the viewer can't show.
 */
export function gridKeyOf(image: Volume): string | undefined {
  return image.data?.format === "npy"
    ? JSON.stringify([image.id, image.gridId, image.data.sha256, image.shapeZyx, image.affine])
    : undefined;
}

/** A marking tool: the keys that pick it (the first shown), and the letter of the tags it makes. */
export type Tool = {
  value: MarkTool | "navigate";
  label: string;
  keys: string[];
  letter?: string;
  icon?: ReactNode;
};

/** The task review's tools, in the order shown. */
export const TOOLS: Tool[] = [
  { value: "navigate", label: "Navigate", keys: ["Escape"] },
  { value: "point", label: "Point", keys: ["p"], letter: "P" },
  { value: "box", label: "Box", keys: ["b"], letter: "B" },
  { value: "line", label: "Line", keys: ["l"], letter: "L" },
  { value: "outline", label: "Lasso", keys: ["o"], letter: "O" },
];

/** The outputs review's tools (mockup C's tool bar), icons with their names in the tooltips. */
export const QUAD_TOOLS: Tool[] = [
  { value: "navigate", label: "Navigate", keys: ["v", "Escape"], icon: <Crosshair /> },
  { value: "point", label: "Point, with a note", keys: ["p"], letter: "P", icon: <MapPin /> },
  { value: "line", label: "Ruler", keys: ["l"], letter: "R", icon: <Ruler /> },
  { value: "angle", label: "Angle", keys: ["a"], letter: "A", icon: <Angle /> },
  { value: "outline", label: "Outline", keys: ["o"], letter: "O", icon: <Lasso /> },
  { value: "probe", label: "Probe", keys: ["i"], letter: "P", icon: <Pipette /> },
];

export const FULL = `A message carries up to ${MAX_MARKS} marks. Delete one to add another.`;

/** The mark's one shape, as the viewer takes it; null for a mark with none. */
export function gridMark(mark: Mark): GridMark | null {
  if (mark.point) return { point: mark.point };
  if (mark.box) return { box: mark.box };
  if (mark.line) return { line: mark.line };
  if (mark.outline) return { outline: mark.outline };
  return null;
}

/**
 * The mark as a message sends it; null for what a message can't carry (an angle, an outline off
 * the grid's axes). Notes and probe values aren't sent: the task review makes neither.
 */
export function messageMark({ mark, volumeId }: YourMark): Mark | null {
  if ("point" in mark) return { volumeId, point: [...mark.point] };
  if ("box" in mark) return { volumeId, box: { min: [...mark.box.min], max: [...mark.box.max] } };
  if ("line" in mark)
    return {
      volumeId,
      line: { aZyx: [...mark.line.aZyx], bZyx: [...mark.line.bZyx], lengthMm: mark.line.lengthMm },
    };
  if ("angle" in mark) return null;
  const axis = outlineAxis(mark.outline.zyx);
  const { zyx, areaMm2 } = mark.outline;
  return axis === null
    ? null
    : { volumeId, outline: { axis, zyx: zyx.map((p) => [...p]), areaMm2 } };
}

const kindOf = (mark: GridMark): MarkTool =>
  "point" in mark
    ? mark.probe
      ? "probe"
      : "point"
    : "box" in mark
      ? "box"
      : "line" in mark
        ? "line"
        : "angle" in mark
          ? "angle"
          : "outline";

/** The slice panes by the array axis they hold. */
const PLANE = ["axial", "sagittal", "coronal"] as const;

/**
 * A mark's kind with its measure, in words, as `tools` name it: "Line 0.556 mm", "Lasso on axial
 * 241 0.112 mm²", "Probe ≈ −172 HU".
 */
export function describe(
  mark: GridMark,
  tools: readonly Tool[] = TOOLS,
): { title: string; measure?: string } {
  const word = tools.find((t) => t.value === kindOf(mark))?.label.split(",")[0] ?? "Mark";
  const n = (v: number) => String(Number(v.toPrecision(3)));
  if ("line" in mark) return { title: word, measure: `${n(mark.line.lengthMm)} mm` };
  if ("angle" in mark) return { title: word, measure: `${n(mark.angle.degrees)}°` };
  if ("outline" in mark) {
    const { zyx, areaMm2 } = mark.outline;
    const axis = outlineAxis(zyx);
    return {
      title: axis === null ? word : `${word} on ${PLANE[axis]} ${Math.round(zyx[0]![axis]) + 1}`,
      measure: `${n(areaMm2)} mm²`,
    };
  }
  if ("point" in mark && mark.probe) return { title: word, measure: probeText(mark.probe) };
  if ("point" in mark && mark.note) return { title: word, measure: mark.note };
  return { title: word };
}

/** A new mark's tag: its tool's letter and the next number for that letter. */
export function nextTag(
  marks: readonly YourMark[],
  mark: GridMark,
  tools: readonly Tool[],
): string {
  const letter = tools.find((t) => t.value === kindOf(mark))?.letter ?? "M";
  const used = marks
    .filter((m) => m.tag.startsWith(letter))
    .map((m) => Number(m.tag.slice(letter.length)));
  return `${letter}${Math.max(0, ...used) + 1}`;
}

/** Where to move the views for a mark: its voxel, or the middle of what it covers. */
export function middleOf(mark: GridMark): Zyx {
  const points = markPoints(mark);
  const mid = (k: number) => Math.round(points.reduce((s, p) => s + p[k]!, 0) / points.length);
  return [mid(0), mid(1), mid(2)];
}

export function MarksPanel({
  marks,
  shown,
  taskTitle,
  selected,
  onSelect,
  onDelete,
}: {
  marks: readonly YourMark[];
  /** Marks on another grid say where they are. */
  shown: ShownGrid | undefined;
  taskTitle: (taskId: string) => string;
  selected: string | undefined;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div className="grid gap-2 p-3">
      <List label="Your marks" columns="auto 28px" boxed>
        {marks.map((m) => {
          const { title, measure } = describe(m.mark);
          const elsewhere = m.gridKey !== shown?.key;
          return (
            <Row
              key={m.id}
              selected={m.id === selected}
              onSelect={() => onSelect(m.id)}
              title={
                <span className="flex min-w-0 items-baseline gap-2">
                  <span className="font-mono text-xs font-medium text-mark-mine-text">{m.tag}</span>
                  <span className="min-w-0 truncate">{title}</span>
                </span>
              }
              subtitle={
                elsewhere &&
                (m.taskId === shown?.taskId ? "On another grid" : `On ${taskTitle(m.taskId)}`)
              }
              cells={[
                <span key="measure" className="font-mono text-xs text-muted-foreground">
                  {measure}
                </span>,
                m.theirs ? null : (
                  <IconButton
                    key="delete"
                    size="sm"
                    label={`Delete ${m.tag}`}
                    onClick={() => onDelete(m.id)}
                  >
                    <Trash2 />
                  </IconButton>
                ),
              ]}
            />
          );
        })}
      </List>
      {marks.length >= MAX_MARKS && <p className="px-1 text-xs text-muted-foreground">{FULL}</p>}
    </div>
  );
}

/**
 * Your marks and the tool that makes them. A tool's key (`tools`) picks it and Esc puts it away,
 * as the shell's panel keys do: never while typing, never with a modifier. Listening on the
 * document puts this after a pane's own Esc (dropping a mark being drawn) and before the shell's
 * (leaving Full view), so one Esc does one thing.
 */
export function useMarking(tools: readonly Tool[] = TOOLS, store?: MarkStore) {
  const [tool, setTool] = useState<MarkTool | null>(null);
  const [held, setMarks] = useState<YourMark[]>([]);
  const marks = store ? store.marks : held;
  const [selected, setSelected] = useState<string>();
  const [jump, setJump] = useState<{ at: Zyx; gridKey: string; taskId: string }>();
  const [shown, setShown] = useState<ShownGrid>();
  const viewer = useRef<GridViewerHandle>(null);
  // A message carries up to MAX_MARKS; marks the run keeps have no cap.
  const full = !store && marks.length >= MAX_MARKS;
  const latest = useRef({ tool, full, tools, store, marks });
  latest.current = { tool, full, tools, store, marks };
  // At the cap the tools are held off (`viewer.tsx` says why).
  useEffect(() => {
    if (full) setTool(null);
  }, [full]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.isComposing) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement;
      if (
        target.isContentEditable ||
        target.closest("input, textarea, select, dialog, [role='dialog'], [role='menu']")
      )
        return;
      const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
      const picked = latest.current.tools.find((t) => t.keys.includes(key));
      if (!picked) return;
      const next = picked.value === "navigate" ? null : picked.value;
      // Esc with no tool out is the shell's; a tool's key at the cap does nothing.
      if (next === null ? !latest.current.tool : latest.current.full) return;
      event.preventDefault();
      setTool(next);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  return {
    tool,
    setTool,
    tools,
    marks,
    full,
    selected,
    jump,
    shown,
    setShown,
    viewer,
    jumped: useCallback(() => setJump(undefined), []),
    /** Adds a mark at the cap's mercy; returns its id, or undefined when full. */
    add: useCallback(
      (
        mark: GridMark,
        volumeId: string,
        gridKey: string,
        taskId: string,
        plane: MarkPlane | null = null,
      ): string | undefined => {
        const { full: capped, store: kept, marks: had, tools: made } = latest.current;
        if (capped) return undefined;
        const id = crypto.randomUUID();
        if (kept) {
          kept.place({
            id,
            tag: nextTag(had, mark, made),
            taskId,
            gridKey,
            volumeId,
            mark,
            plane,
          });
          return id;
        }
        setMarks((had) =>
          had.length >= MAX_MARKS
            ? had
            : [
                ...had,
                {
                  id,
                  tag: nextTag(had, mark, latest.current.tools),
                  taskId,
                  gridKey,
                  volumeId,
                  mark,
                  plane,
                },
              ],
        );
        return id;
      },
      [],
    ),
    /** Gives a point its note. */
    note: useCallback((id: string, note: string) => {
      const { store: kept, marks: had } = latest.current;
      const noted = (m: YourMark): YourMark =>
        m.id === id && "point" in m.mark ? { ...m, mark: { ...m.mark, note } } : m;
      if (kept) {
        const m = had.find((x) => x.id === id);
        if (m) kept.place(noted(m));
      } else setMarks((had) => had.map(noted));
    }, []),
    /** Selects a mark and aims the views at it; returns it. */
    select: useCallback(
      (id: string) => {
        setSelected(id);
        const mark = marks.find((m) => m.id === id);
        if (mark) setJump({ at: middleOf(mark.mark), gridKey: mark.gridKey, taskId: mark.taskId });
        return mark;
      },
      [marks],
    ),
    remove: useCallback((id: string) => {
      const { store: kept } = latest.current;
      if (kept) kept.erase(id);
      else setMarks((had) => had.filter((m) => m.id !== id));
    }, []),
    /** Keeps only the marks on these grids. */
    keep: useCallback((grids: ReadonlySet<string>) => {
      setMarks((had) =>
        had.every((m) => grids.has(m.gridKey)) ? had : had.filter((m) => grids.has(m.gridKey)),
      );
    }, []),
    /** Drops the marks a message carried. */
    drop: useCallback((ids: string[]) => {
      if (ids.length) setMarks((had) => had.filter((m) => !ids.includes(m.id)));
    }, []),
    snapshot: useCallback(
      // Undefined until the lazy viewer mounts: nothing to picture yet.
      (maxBytes: number) => viewer.current?.snapshot(maxBytes) ?? Promise.resolve(undefined),
      [],
    ),
  };
}
