/**
 * Marks: your marks on the scan, held by the page until a message to the AI carries them. Each
 * has a short tag (P1, B1, L1, O1) drawn beside it in the views; a row selects it (the views
 * move to it) or deletes it. The tool that makes them is picked above the views (`viewer.tsx`).
 */
import { MAX_MARKS, type Mark } from "@voluma/contracts/messages";
import { EmptyState, IconButton, List, Row } from "@voluma/ui";
import type { GridMark, MarkTool, Zyx } from "@voluma/viewer/grid";
import { Trash2 } from "lucide-react";

/** A mark of yours: `mark` is what the message sends. */
export type YourMark = { id: string; tag: string; mark: Mark };

const KIND: Record<MarkTool, { word: string; letter: string }> = {
  point: { word: "Point", letter: "P" },
  box: { word: "Box", letter: "B" },
  line: { word: "Line", letter: "L" },
  outline: { word: "Lasso", letter: "O" },
};

export const kindOf = (mark: Mark | GridMark): MarkTool =>
  "point" in mark && mark.point
    ? "point"
    : "box" in mark && mark.box
      ? "box"
      : "line" in mark && mark.line
        ? "line"
        : "outline";

/** The slice panes by the array axis they hold. */
const PLANE = ["axial", "sagittal", "coronal"] as const;

/** A mark's kind with its measure, in words: "Line 0.556 mm", "Lasso on axial 241 0.112 mm²". */
export function describe(mark: Mark): { title: string; measure?: string } {
  const word = KIND[kindOf(mark)].word;
  const n = (v: number) => String(Number(v.toPrecision(3)));
  if (mark.line) return { title: word, measure: `${n(mark.line.lengthMm)} mm` };
  if (mark.outline) {
    const { axis, zyx, areaMm2 } = mark.outline;
    return {
      title: `${word} on ${PLANE[axis]} ${zyx[0]![axis] + 1}`,
      measure: `${n(areaMm2)} mm²`,
    };
  }
  return { title: word };
}

/** A new mark's tag: the kind's letter and the next number for that kind. */
export function nextTag(marks: readonly YourMark[], mark: GridMark): string {
  const letter = KIND[kindOf(mark)].letter;
  const used = marks
    .filter((m) => m.tag.startsWith(letter))
    .map((m) => Number(m.tag.slice(letter.length)));
  return `${letter}${Math.max(0, ...used) + 1}`;
}

/** Where to move the views for a mark: its voxel, or the middle of what it covers. */
export function middleOf(mark: Mark): Zyx {
  const points: readonly (readonly number[])[] = mark.point
    ? [mark.point]
    : mark.box
      ? [mark.box.min, mark.box.max]
      : mark.line
        ? [mark.line.aZyx, mark.line.bZyx]
        : (mark.outline?.zyx ?? []);
  return [0, 1, 2].map((k) =>
    Math.round(points.reduce((s, p) => s + p[k]!, 0) / points.length),
  ) as unknown as Zyx;
}

export function MarksPanel({
  marks,
  selected,
  onSelect,
  onDelete,
}: {
  marks: readonly YourMark[];
  selected: string | undefined;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  if (marks.length === 0)
    return (
      <div className="p-4">
        <EmptyState title="No marks of yours yet">
          Pick Point, Box, Line or Lasso above the views, then mark the scan. The AI sees your marks
          with your next message.
        </EmptyState>
      </div>
    );
  return (
    <div className="grid gap-2 p-3">
      <List label="Your marks" density="compact" columns="auto 28px" boxed>
        {marks.map((m) => {
          const { title, measure } = describe(m.mark);
          return (
            <Row
              key={m.id}
              selected={m.id === selected}
              onSelect={() => onSelect(m.id)}
              title={
                <span className="flex min-w-0 items-center gap-2">
                  <span className="font-mono text-xs font-medium text-mark-mine">{m.tag}</span>
                  <span className="truncate">{title}</span>
                </span>
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
      {marks.length >= MAX_MARKS && (
        <p className="px-1 text-xs text-muted-foreground">
          A message carries up to {MAX_MARKS} marks. Delete one to add another.
        </p>
      )}
    </div>
  );
}
