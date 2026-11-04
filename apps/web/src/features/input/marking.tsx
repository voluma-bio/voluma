/**
 * Your marks on the input and the tools that make them. Each has a short tag (P1, R1, A1, O1)
 * drawn beside it in the views and belongs to the image it was made on (`gridKeyOf`); a redo that
 * replaces that image drops it. The tools are `TOOLS`, picked on the viewer's bar.
 * Marks are the viewer's (`GridMark`); the run's log keeps them (`useRunMarks`), or the page does on
 * an example run (`useLocalMarks`).
 */
import type { Volume } from "@voluma/contracts/review";
import {
  type GridMark,
  type MarkPlane,
  type MarkTool,
  markPoints,
  type Zyx,
} from "@voluma/viewer/grid";
import { Angle, Crosshair, Lasso, MousePointer2, Pipette, Ruler, Spline } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";

/**
 * A mark of yours, as the viewer draws it: `volumeId` the grid's image it was made on,
 * `output` the output it was made in view of.
 */
export type YourMark = {
  id: string;
  tag: string;
  output: string;
  gridKey: string;
  volumeId: string;
  mark: GridMark;
  /** The pane it was made in; null in 3D. */
  plane: MarkPlane | null;
  /** Another person's, on a run whose marks are kept: shown, not yours to delete. */
  theirs?: boolean;
};

/**
 * Where marks are kept: the run's log (`useRunMarks`) or the page (`useLocalMarks`). `place` is a
 * new mark or a changed one under the same id.
 */
export type MarkStore = {
  marks: readonly YourMark[];
  /** Every tag given out so far that a new mark must not reuse. */
  tags: readonly string[];
  place(mark: YourMark): void;
  erase(id: string): void;
  /** Your changes that wait for your next message to main; none where marks aren't sent so. */
  changes: readonly MarkChange[];
  /** Undoes a waiting change. */
  discard(id: string): void;
};

/** A change of yours to a mark that your next message carries: its id is the `markIds` entry. */
export type MarkChange = {
  id: string;
  tag: string;
  /** The output it was made on. */
  output: string;
  /** `place`: main has not seen it; `move`: moved since; `delete`: deleted since. */
  change: "place" | "move" | "delete";
};

const NO_CHANGES: readonly MarkChange[] = [];

/** Marks the page holds, lost on reload: an example run's, which keeps none in its log. */
export function useLocalMarks(): MarkStore {
  const [marks, setMarks] = useState<YourMark[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const erase = useCallback((id: string) => setMarks((had) => had.filter((m) => m.id !== id)), []);
  const place = useCallback((mark: YourMark) => {
    setTags((had) => (had.includes(mark.tag) ? had : [...had, mark.tag]));
    setMarks((had) =>
      had.some((m) => m.id === mark.id)
        ? had.map((m) => (m.id === mark.id ? mark : m))
        : [...had, mark],
    );
  }, []);
  return { marks, tags, place, erase, changes: NO_CHANGES, discard: erase };
}

/**
 * The output and immutable image/grid identity actually mounted in the viewer, and whether a
 * picture of the views would go now (no pane loading).
 */
export type ShownGrid = { output: string; key: string; ready: boolean };

/**
 * An image's identity for marks: a redo keeps block ids, so coordinates belong to the bytes and
 * their frame, not the id alone. Undefined for an image the viewer can't show.
 */
export function gridKeyOf(image: Volume): string | undefined {
  return image.data?.format === "npy"
    ? JSON.stringify([image.id, image.gridId, image.data.sha256, image.shapeZyx, image.affine])
    : undefined;
}

/** A marking tool and the letter of the tags it makes (not a command key). */
type Tool = {
  value: MarkTool | "navigate";
  /** Its name: the icon's tooltip on the bar. */
  label: string;
  letter?: string;
  icon: ReactNode;
};

/** The marking tools, every one an icon on the viewer's bar. */
export const TOOLS: Tool[] = [
  { value: "navigate", label: "Navigate", icon: <MousePointer2 /> },
  { value: "point", label: "Point", letter: "P", icon: <Crosshair /> },
  { value: "line", label: "Ruler", letter: "R", icon: <Ruler /> },
  { value: "angle", label: "Angle", letter: "A", icon: <Angle /> },
  { value: "outline", label: "Outline", letter: "O", icon: <Lasso /> },
  { value: "path", label: "Freehand line", letter: "L", icon: <Spline /> },
  { value: "probe", label: "Probe the image value", letter: "P", icon: <Pipette /> },
];

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
          : "path" in mark
            ? "path"
            : "outline";

/** A new mark's tag: its tool's letter and the next number for that letter. */
function nextTag(tags: readonly string[], mark: GridMark): string {
  const letter = TOOLS.find((t) => t.value === kindOf(mark))?.letter ?? "M";
  const used = tags
    .filter((tag) => tag.startsWith(letter))
    .map((tag) => Number(tag.slice(letter.length)));
  return `${letter}${Math.max(0, ...used) + 1}`;
}

/** Where to move the views for a mark: its voxel, or the middle of what it covers. */
function middleOf(mark: GridMark): Zyx {
  const points = markPoints(mark);
  const mid = (k: number) => Math.round(points.reduce((s, p) => s + p[k]!, 0) / points.length);
  return [mid(0), mid(1), mid(2)];
}

/**
 * Your marks and the tool that makes them. Escape within the focused viewer puts the tool away,
 * after the pane cancels its drawing and before the shell leaves Full view.
 */
export function useMarking(store: MarkStore) {
  const [tool, setTool] = useState<MarkTool | null>(null);
  const { marks } = store;
  const [selected, setSelected] = useState<string>();
  const [jump, setJump] = useState<{ at: Zyx; gridKey: string; output: string }>();
  const [shown, setShown] = useState<ShownGrid>();
  const latest = useRef({ tool, store });
  latest.current = { tool, store };
  // Tags given out since the store's marks last changed: two adds before a render get two tags.
  const issued = useRef({ of: marks, tags: [] as string[] });
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
      if (
        event.key !== "Escape" ||
        !target.closest("[data-marking-viewer]") ||
        !latest.current.tool
      )
        return;
      event.preventDefault();
      setTool(null);
      target
        .closest("[data-marking-viewer]")
        ?.querySelector<HTMLElement>('[aria-label="Marking tool"] button')
        ?.focus();
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
    jumpTo: setJump,
    jumped: useCallback(() => setJump(undefined), []),
    /** Adds a mark. */
    add: useCallback(
      (
        mark: GridMark,
        volumeId: string,
        gridKey: string,
        output: string,
        plane: MarkPlane | null = null,
      ): void => {
        const { store: kept } = latest.current;
        const id = crypto.randomUUID();
        if (issued.current.of !== kept.marks) issued.current = { of: kept.marks, tags: [] };
        const tag = nextTag([...kept.tags, ...issued.current.tags], mark);
        issued.current.tags.push(tag);
        kept.place({
          id,
          tag,
          output,
          gridKey,
          volumeId,
          mark,
          plane,
        });
      },
      [],
    ),
    /** Selects a mark and aims the views at it, or clears the selection; returns the mark. */
    select: useCallback(
      (id?: string) => {
        setSelected(id);
        const mark = marks.find((m) => m.id === id);
        if (mark) setJump({ at: middleOf(mark.mark), gridKey: mark.gridKey, output: mark.output });
        else setJump(undefined);
        return mark;
      },
      [marks],
    ),
    remove: useCallback((id: string) => latest.current.store.erase(id), []),
  };
}
