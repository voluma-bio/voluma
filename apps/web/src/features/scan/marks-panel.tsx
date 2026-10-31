/**
 * Marks: your marks on the scan, held by the page until a message to the AI carries them. Each
 * has a short tag (P1, B1, L1, O1) drawn beside it in the views and belongs to the image it was
 * made on (`gridKeyOf`); a redo that replaces that image drops it. A row selects it (the views
 * move to it, opening its task when it is on another grid) or deletes it. The tools that make
 * them, and their keys, are `TOOLS`, picked above the views.
 */
import { MAX_MARKS, type Mark } from "@voluma/contracts/messages";
import type { Volume } from "@voluma/contracts/review";
import { EmptyState, IconButton, List, Row } from "@voluma/ui";
import type { GridMark, MarkTool, Zyx } from "@voluma/viewer/grid";
import { Trash2 } from "lucide-react";

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
  if (marks.length === 0)
    return (
      <div className="p-4">
        <EmptyState title="No marks of yours yet" />
      </div>
    );
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
