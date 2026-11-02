/**
 * Marks: your marks on the scan, held by the page until a message to the AI carries them. Each
 * has a short tag (P1, B1, L1, O1) drawn beside it in the views and belongs to the image it was
 * made on (`gridKeyOf`); a redo that replaces that image drops it. A row selects it (the views
 * move to it, opening its task when it is on another grid) or deletes it. The tools that make
 * them, and their keys, are `TOOLS`, picked above the views. The page mounts the panel only
 * while there is a mark.
 */
import { MAX_MARKS, type Mark } from "@voluma/contracts/messages";
import type { Volume } from "@voluma/contracts/review";
import { IconButton, List, Row } from "@voluma/ui";
import type { GridMark, GridViewerHandle, MarkTool, Zyx } from "@voluma/viewer/grid";
import { Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

/** A mark of yours: `mark` is what the message sends; `taskId` the task it was made in view of. */
export type YourMark = { id: string; tag: string; taskId: string; gridKey: string; mark: Mark };

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

/** The marking tools in the order shown, each with the key that picks it. */
export const TOOLS: { value: MarkTool | "navigate"; label: string; shortcut: string }[] = [
  { value: "navigate", label: "Navigate", shortcut: "Escape" },
  { value: "point", label: "Point", shortcut: "p" },
  { value: "box", label: "Box", shortcut: "b" },
  { value: "line", label: "Line", shortcut: "l" },
  { value: "outline", label: "Lasso", shortcut: "o" },
];

export const FULL = `A message carries up to ${MAX_MARKS} marks. Delete one to add another.`;

const LETTER: Record<MarkTool, string> = { point: "P", box: "B", line: "L", outline: "O" };

const wordOf = (tool: MarkTool) => TOOLS.find((t) => t.value === tool)!.label;

/** The mark's one shape, as the viewer takes it; null for a mark with none. */
export function gridMark(mark: Mark): GridMark | null {
  if (mark.point) return { point: mark.point };
  if (mark.box) return { box: mark.box };
  if (mark.line) return { line: mark.line };
  if (mark.outline) return { outline: mark.outline };
  return null;
}

export const kindOf = (mark: GridMark): MarkTool =>
  "point" in mark ? "point" : "box" in mark ? "box" : "line" in mark ? "line" : "outline";

/** The slice panes by the array axis they hold. */
const PLANE = ["axial", "sagittal", "coronal"] as const;

/** A mark's kind with its measure, in words: "Line 0.556 mm", "Lasso on axial 241 0.112 mm²". */
export function describe(mark: Mark): { title: string; measure?: string } {
  const shape = gridMark(mark);
  if (!shape) return { title: "Mark" };
  const word = wordOf(kindOf(shape));
  const n = (v: number) => String(Number(v.toPrecision(3)));
  if ("line" in shape) return { title: word, measure: `${n(shape.line.lengthMm)} mm` };
  if ("outline" in shape) {
    const { axis, zyx, areaMm2 } = shape.outline;
    return {
      title: `${word} on ${PLANE[axis]} ${Math.round(zyx[0]![axis]) + 1}`,
      measure: `${n(areaMm2)} mm²`,
    };
  }
  return { title: word };
}

/** A new mark's tag: the kind's letter and the next number for that kind. */
export function nextTag(marks: readonly YourMark[], mark: GridMark): string {
  const letter = LETTER[kindOf(mark)];
  const used = marks
    .filter((m) => m.tag.startsWith(letter))
    .map((m) => Number(m.tag.slice(letter.length)));
  return `${letter}${Math.max(0, ...used) + 1}`;
}

/** Where to move the views for a mark: its voxel, or the middle of what it covers. */
export function middleOf(mark: GridMark): Zyx {
  const points: readonly (readonly number[])[] =
    "point" in mark
      ? [mark.point]
      : "box" in mark
        ? [mark.box.min, mark.box.max]
        : "line" in mark
          ? [mark.line.aZyx, mark.line.bZyx]
          : mark.outline.zyx;
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
                <IconButton
                  key="delete"
                  size="sm"
                  label={`Delete ${m.tag}`}
                  onClick={() => onDelete(m.id)}
                >
                  <Trash2 />
                </IconButton>,
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
 * Your marks and the tool that makes them. A tool's key (`TOOLS`) picks it and Esc puts it away,
 * as the shell's panel keys do: never while typing, never with a modifier. Listening on the
 * document puts this after a pane's own Esc (dropping a mark being drawn) and before the shell's
 * (leaving Full view), so one Esc does one thing.
 */
export function useMarking() {
  const [tool, setTool] = useState<MarkTool | null>(null);
  const [marks, setMarks] = useState<YourMark[]>([]);
  const [selected, setSelected] = useState<string>();
  const [jump, setJump] = useState<{ at: Zyx; gridKey: string; taskId: string }>();
  const [shown, setShown] = useState<ShownGrid>();
  const viewer = useRef<GridViewerHandle>(null);
  const full = marks.length >= MAX_MARKS;
  const latest = useRef({ tool, full });
  latest.current = { tool, full };
  // At the cap the tools are held off (`viewer.tsx` says why).
  useEffect(() => {
    if (full) setTool(null);
  }, [full]);
  useEffect(() => {
    const keys = new Map(
      TOOLS.map((t) => [t.shortcut.toLowerCase(), t.value === "navigate" ? null : t.value]),
    );
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.isComposing) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement;
      if (
        target.isContentEditable ||
        target.closest("input, textarea, select, dialog, [role='dialog'], [role='menu']")
      )
        return;
      const next = keys.get(event.key.toLowerCase());
      if (next === undefined) return;
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
    marks,
    selected,
    jump,
    shown,
    setShown,
    viewer,
    jumped: useCallback(() => setJump(undefined), []),
    add: useCallback((mark: GridMark, volumeId: string, gridKey: string, taskId: string) => {
      setMarks((had) =>
        had.length >= MAX_MARKS
          ? had
          : [
              ...had,
              {
                id: crypto.randomUUID(),
                tag: nextTag(had, mark),
                taskId,
                gridKey,
                mark: { volumeId, ...mark },
              },
            ],
      );
    }, []),
    /** Selects a mark and aims the views at it; returns it. */
    select: useCallback(
      (id: string) => {
        setSelected(id);
        const mark = marks.find((m) => m.id === id);
        const shape = mark && gridMark(mark.mark);
        if (mark && shape)
          setJump({ at: middleOf(shape), gridKey: mark.gridKey, taskId: mark.taskId });
        return mark;
      },
      [marks],
    ),
    remove: useCallback((id: string) => setMarks((had) => had.filter((m) => m.id !== id)), []),
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
