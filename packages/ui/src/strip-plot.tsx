/**
 * Strip plot: one measurement compared across groups of scans, for the small
 * groups a study has (n = 1-8), where a bar would hide the scans. Each scan is
 * a dot on its group's row, a tick marks the group mean, and dots that share a
 * value spread around it so none hides another. A dot is a button: hover or
 * focus names the scan and its value, and `onSelect` decides what it opens.
 * The plot is one tab stop: arrow keys move between dots (left and right in
 * value order, up and down between groups). Scans without a value yet are
 * counted beside their group, not drawn.
 */
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { cx } from "./cx";

export type StripPoint = {
  id: string;
  label: string;
  /** null while the scan has no result yet. */
  value: number | null;
  /** Far from its group: drawn amber, with its label above it. */
  far?: boolean;
  /** Why it is far, in the tooltip under "Far from its group" (the rule's numbers). */
  farReason?: string;
  /** Drawn as a ring; the page's legend says what that means. */
  hollow?: boolean;
};

export type StripGroup = { name: string; points: StripPoint[] };

export type StripPlotProps = {
  groups: StripGroup[];
  unit: string;
  /** Accessible name, usually the measurement's name. */
  label: string;
  onSelect: (point: StripPoint) => void;
  /** Decimals for values in the tooltip and spoken names: the measurement's precision. */
  digits: number;
  className?: string;
};

// Pixels. The dot radius matches the prototype; MIN_GAP lets touching dots overlap slightly.
const R = 5.5;
const HIT = 11;
const MIN_GAP = 2 * R - 2;
const SPREAD = 7;
// Dots stack at most this many SPREADs above and below the axis line, then move sideways.
const MAX_LEVEL = 3;
const ROW = 32;
const LABEL_ROOM = 16;
// Within this many pixels of an end, tooltips and far labels align to that end.
const EDGE = 70;

type Placed = StripPoint & { value: number; x: number; y: number };

export function StripPlot({ groups, unit, label, onSelect, digits, className }: StripPlotProps) {
  const axisRef = useRef<HTMLDivElement>(null);
  const dotRefs = useRef(new Map<string, SVGGElement>());
  const [width, setWidth] = useState(0);
  // The dot that holds the plot's one tab stop, and what the tooltip follows.
  const [current, setCurrent] = useState<string | null>(null);
  // Keyboard focus only: a dot clicked with the mouse keeps focus but shows no tooltip.
  const [focused, setFocused] = useState(false);
  const [hovered, setHovered] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useLayoutEffect(() => {
    const node = axisRef.current;
    if (!node) return;
    setWidth(node.clientWidth);
    const observer = new ResizeObserver(() => setWidth(node.clientWidth));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const values = groups.flatMap((g) => g.points.flatMap((p) => (p.value === null ? [] : p.value)));
  // About one tick per 64 px, at least three so a phone's narrow axis still reads.
  const { lo, hi, step } = niceDomain(values, Math.max(3, Math.min(6, Math.floor(width / 64))));
  const ticks = Array.from({ length: Math.round((hi - lo) / step) + 1 }, (_, i) =>
    Number((lo + i * step).toPrecision(12)),
  );
  const tickDigits = decimalsOf(step);
  // Dots at the domain's ends stay inside the svg.
  const x = (v: number) => HIT + ((v - lo) / (hi - lo)) * Math.max(0, width - 2 * HIT);

  const rows = groups.map((group) => {
    const placed = width > 0 ? swarm(group.points, x, width) : [];
    const reach = Math.max(0, ...placed.map((p) => Math.abs(p.y)));
    const top = placed.some((p) => p.far) ? LABEL_ROOM : 0;
    const height = Math.max(ROW, 2 * reach + 2 * HIT) + top;
    const mean = placed.length > 1 ? placed.reduce((s, p) => s + p.value, 0) / placed.length : null;
    return { group, placed, reach, top, height, mid: top + (height - top) / 2, mean };
  });
  const all = rows.flatMap((row) => row.placed);
  const stop = all.some((p) => p.id === current) ? current : (all[0]?.id ?? null);
  const tip = dismissed ? null : (hovered ?? (focused ? stop : null));

  // A hovered tooltip hides on Escape wherever focus is. Inside the plot, onKeyDown handles it first.
  const hoverTip = !dismissed && hovered !== null;
  useEffect(() => {
    if (!hoverTip) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setDismissed(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hoverTip]);

  const move = (id: string) => {
    setCurrent(id);
    setDismissed(false);
    dotRefs.current.get(id)?.focus();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    // Stopped here so a drawer or dialog around the plot doesn't also close on this press.
    if (event.key === "Escape" && tip !== null) {
      event.stopPropagation();
      setDismissed(true);
      return;
    }
    const r = rows.findIndex((row) => row.placed.some((p) => p.id === stop));
    const row = rows[r];
    if (!row) return;
    const i = row.placed.findIndex((p) => p.id === stop);
    const here = row.placed[i];
    if (!here) return;
    let next: Placed | undefined;
    if (event.key === "ArrowRight") next = row.placed[i + 1];
    else if (event.key === "ArrowLeft") next = row.placed[i - 1];
    else if (event.key === "Home") next = row.placed[0];
    else if (event.key === "End") next = row.placed.at(-1);
    else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      // The dot nearest in value in the next group, above or below, that has any.
      const onward = event.key === "ArrowDown" ? rows.slice(r + 1) : rows.slice(0, r).reverse();
      const target = onward.find((q) => q.placed.length > 0);
      next = target?.placed.reduce((a, b) =>
        Math.abs(b.value - here.value) < Math.abs(a.value - here.value) ? b : a,
      );
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect(here);
      return;
    } else return;
    event.preventDefault();
    if (next) move(next.id);
  };

  return (
    <figure
      aria-label={`${label}, ${unit}`}
      className={cx("m-0 grid grid-cols-[fit-content(9rem)_minmax(0,1fr)] gap-x-4", className)}
      onKeyDown={onKeyDown}
    >
      {rows.map(({ group, placed, reach, top, height, mid, mean }, index) => (
        <Row
          // Names need not be unique; the order is the identity.
          // biome-ignore lint/suspicious/noArrayIndexKey: groups have no id and keep their order.
          key={index}
          name={group.name}
          missing={group.points.filter((p) => p.value === null).length}
          mean={mean === null ? undefined : `${mean.toFixed(digits)} ${unit}`}
          height={height}
          top={top}
        >
          {/* Measured width, not 100%: a percentage svg adds 300 px to the min-content width. */}
          <svg width={width} height={height} className="block overflow-visible">
            <title>{`${group.name}, ${label}`}</title>
            {ticks.map((t) => (
              <line key={t} x1={x(t)} x2={x(t)} y1={0} y2={height} className="stroke-line-subtle" />
            ))}
            {mean !== null && (
              <line
                x1={x(mean)}
                x2={x(mean)}
                y1={mid - (reach + 10)}
                y2={mid + reach + 10}
                strokeWidth={2}
                className="stroke-muted-foreground"
              />
            )}
            {placed.map((p) => (
              <Dot
                key={p.id}
                ref={(node) => {
                  if (node) dotRefs.current.set(p.id, node);
                  else dotRefs.current.delete(p.id);
                }}
                point={p}
                cy={mid + p.y}
                anchor={edge(p.x, width)}
                tabStop={p.id === stop}
                name={`${p.label}, ${p.value.toFixed(digits)} ${unit}${p.far ? `, far from its group${p.farReason ? `: ${p.farReason}` : ""}` : ""}`}
                onSelect={() => onSelect(p)}
                onHover={(on) => {
                  setHovered(on ? p.id : null);
                  setDismissed(false);
                }}
                onFocus={(on) => {
                  setFocused(on);
                  if (on) {
                    setCurrent(p.id);
                    setDismissed(false);
                  }
                }}
              />
            ))}
          </svg>
          {placed
            .filter((p) => p.id === tip)
            .map((p) => (
              <Tooltip key={p.id} x={p.x} y={mid + p.y} anchor={edge(p.x, width)}>
                <span className="font-medium">{p.label}</span>{" "}
                <span className="font-mono tabular-nums">{p.value.toFixed(digits)}</span> {unit}
                {p.far && <span className="block text-check-solid">Far from its group</span>}
                {p.far && p.farReason && <span className="block">{p.farReason}</span>}
              </Tooltip>
            ))}
        </Row>
      ))}
      <div className="self-start pt-1 text-meta text-fg-subtle">{values.length > 0 && unit}</div>
      <div ref={axisRef} className="relative h-6">
        {values.length > 0 &&
          width > 0 &&
          ticks.map((t) => (
            <span
              key={t}
              className="absolute top-1 -translate-x-1/2 font-mono text-meta tabular-nums text-fg-subtle"
              style={{ left: x(t) }}
            >
              {t.toFixed(tickDigits)}
            </span>
          ))}
      </div>
    </figure>
  );
}

type Anchor = "start" | "middle" | "end";

const SHIFT: Record<Anchor, string> = {
  start: "translate-x-0",
  middle: "-translate-x-1/2",
  end: "-translate-x-full",
};

/** Near an end of the axis, text aligns to that end instead of centring past it. */
const edge = (x: number, width: number): Anchor =>
  x < EDGE ? "start" : x > width - EDGE ? "end" : "middle";

function Row({
  name,
  missing,
  mean,
  height,
  top,
  children,
}: {
  name: string;
  missing: number;
  mean?: string;
  height: number;
  top: number;
  children: ReactNode;
}) {
  return (
    <>
      <div
        className="flex flex-wrap items-center gap-x-2 text-sm leading-tight"
        style={{ minHeight: height, paddingTop: top }}
      >
        <span className="font-medium text-muted-foreground">{name}</span>
        {missing > 0 && (
          <span className="text-meta whitespace-nowrap text-fg-subtle">
            <span className="tabular-nums">{missing}</span> to come
          </span>
        )}
        {mean && <span className="sr-only">mean {mean}</span>}
      </div>
      {/* Centred like the label beside it, so a label that wraps keeps its dots level with it. */}
      <div className="flex items-center">
        <div className="relative w-full">{children}</div>
      </div>
    </>
  );
}

function Dot({
  ref,
  point,
  cy,
  anchor,
  tabStop,
  name,
  onSelect,
  onHover,
  onFocus,
}: {
  ref: (node: SVGGElement | null) => void;
  point: Placed;
  cy: number;
  anchor: Anchor;
  tabStop: boolean;
  name: string;
  onSelect: () => void;
  onHover: (on: boolean) => void;
  onFocus: (on: boolean) => void;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: an svg mark can't be a <button>; role and keys make it one.
    <g
      ref={ref}
      role="button"
      tabIndex={tabStop ? 0 : -1}
      aria-label={name}
      className="group cursor-pointer outline-none"
      onClick={onSelect}
      onPointerEnter={() => onHover(true)}
      onPointerLeave={() => onHover(false)}
      onFocus={(event) => onFocus(event.currentTarget.matches(":focus-visible"))}
      onBlur={() => onFocus(false)}
    >
      <circle cx={point.x} cy={cy} r={HIT} className="fill-transparent" />
      <circle
        cx={point.x}
        cy={cy}
        r={R + 3.5}
        strokeWidth={2}
        className="fill-none stroke-transparent group-focus-visible:stroke-ring"
      />
      <circle
        cx={point.x}
        cy={cy}
        r={R}
        strokeWidth={point.hollow ? 2 : 1.5}
        className={cx(
          "origin-center transition-transform [transform-box:fill-box] group-hover:scale-125 motion-reduce:transition-none",
          point.hollow
            ? point.far
              ? "fill-card stroke-check-solid"
              : "fill-card stroke-foreground"
            : point.far
              ? "fill-check-solid stroke-card"
              : "fill-foreground stroke-card",
        )}
      />
      {point.far && (
        <text
          x={point.x + { start: -R, middle: 0, end: R }[anchor]}
          y={cy - R - 5}
          textAnchor={anchor}
          className="fill-check text-meta font-semibold"
        >
          {point.label}
        </text>
      )}
    </g>
  );
}

function Tooltip({
  x,
  y,
  anchor,
  children,
}: {
  x: number;
  y: number;
  anchor: Anchor;
  children: ReactNode;
}) {
  return (
    <div
      role="tooltip"
      className={cx(
        "pointer-events-none absolute z-10 -translate-y-full whitespace-nowrap rounded-md bg-inverse px-2 py-1 text-sm text-inverse-fg shadow-md",
        SHIFT[anchor],
      )}
      style={{ left: x, top: y - HIT - 2 }}
    >
      {children}
    </div>
  );
}

/**
 * Places a group's valued dots, lowest first: each at its value, moved up or
 * down until it clears the dots already placed. Past MAX_LEVEL it moves a
 * dot's width sideways instead, so many equal values (integer grades) make a
 * short, wide cluster rather than a tall column, never past the axis ends.
 */
function swarm(points: StripPoint[], x: (v: number) => number, width: number): Placed[] {
  const placed: Placed[] = [];
  const valued = points.flatMap((p) => (p.value === null ? [] : { ...p, value: p.value }));
  const offsets = (n: number) =>
    Array.from({ length: 2 * n + 1 }, (_, i) => Math.ceil(i / 2) * (i % 2 ? -1 : 1));
  const levels = offsets(MAX_LEVEL).map((l) => l * SPREAD);
  for (const point of valued.sort((a, b) => a.value - b.value)) {
    const px = x(point.value);
    const free = (dx: number, y: number) =>
      !placed.some((q) => Math.hypot(q.x - (px + dx), q.y - y) < MIN_GAP);
    // x() maps the domain to [HIT, width - HIT]; a dot spilled past it would read as off the scale.
    const inside = (dx: number) => px + dx > HIT - 0.5 && px + dx < width - HIT + 0.5;
    let spot: { dx: number; y: number } | undefined;
    // Past `width` every spot is outside, so a full axis overlaps dots rather than looping forever.
    for (let ring = 0; !spot && ring * MIN_GAP <= width; ring++) {
      for (const dx of offsets(ring)
        .slice(-2)
        .map((c) => c * MIN_GAP)
        .filter(inside)) {
        const y = levels.find((l) => free(dx, l));
        if (y !== undefined) {
          spot = { dx, y };
          break;
        }
      }
    }
    placed.push({ ...point, x: px + (spot?.dx ?? 0), y: spot?.y ?? 0 });
  }
  return placed;
}

/**
 * The axis: the values' range widened outward to whole multiples of a round
 * step (1, 2 or 5 × a power of ten), as d3's `nice()` does, so both ends carry
 * a tick. The step is the smallest that leaves at most `count + 1` intervals.
 * A single value gets a range around it.
 */
function niceDomain(values: number[], count: number): { lo: number; hi: number; step: number } {
  let lo = values.length ? Math.min(...values) : 0;
  let hi = values.length ? Math.max(...values) : 1;
  if (lo === hi) {
    const pad = Math.abs(lo) * 0.1 || 1;
    lo -= pad;
    hi += pad;
  }
  // A step below 10^e gives more than 2 × count intervals, so the ladder starts there.
  for (let e = Math.floor(Math.log10((hi - lo) / count)); ; e++) {
    for (const m of [1, 2, 5]) {
      const step = m * 10 ** e;
      const a = Math.floor(lo / step + 1e-9) * step;
      const b = Math.ceil(hi / step - 1e-9) * step;
      if (Math.round((b - a) / step) <= count + 1) return { lo: a, hi: b, step };
    }
  }
}

/** Decimals that show a tick step exactly: 0.05 needs 2, 0.25 needs 2, 20 needs 0. */
function decimalsOf(step: number): number {
  for (let d = 0; d < 10; d++) if (Math.abs(Number(step.toFixed(d)) - step) < step * 1e-6) return d;
  return 10;
}
