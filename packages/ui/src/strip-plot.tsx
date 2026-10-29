/**
 * Strip plot: one measurement compared across groups of scans, for the small
 * groups a study has (n = 1-8), where a bar would hide the scans. Each scan is
 * a dot on its group's row, a tick marks the group mean, and dots that share a
 * value spread vertically so none hides another. A dot is a button: hover or
 * focus names the scan and its value, and `onSelect` decides what it opens.
 * Scans without a value yet are counted beside their group, not drawn.
 */
import { type KeyboardEvent, type ReactNode, useLayoutEffect, useRef, useState } from "react";
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
  /** Axis range; defaults to the values' range with a margin. */
  domain?: [number, number];
  /** Decimals for values in the tooltip; defaults to one more than the axis ticks. */
  digits?: number;
  className?: string;
};

// Pixels. The dot radius matches the prototype; MIN_GAP lets touching dots overlap slightly.
const R = 5.5;
const HIT = 11;
const MIN_GAP = 2 * R - 2;
const SPREAD = 7;
const ROW = 32;
const LABEL_ROOM = 16;

type Placed = StripPoint & { value: number; x: number; y: number };

export function StripPlot({
  groups,
  unit,
  label,
  onSelect,
  domain,
  digits,
  className,
}: StripPlotProps) {
  const axisRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [active, setActive] = useState<string | null>(null);

  useLayoutEffect(() => {
    const node = axisRef.current;
    if (!node) return;
    setWidth(node.clientWidth);
    const observer = new ResizeObserver(() => setWidth(node.clientWidth));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const values = groups.flatMap((g) => g.points.flatMap((p) => (p.value === null ? [] : p.value)));
  const [lo, hi] = domain ?? paddedRange(values);
  // About one tick per 64 px, at least three so a phone's narrow axis still reads.
  const { ticks, step } = niceTicks(lo, hi, Math.max(3, Math.min(6, Math.floor(width / 64))));
  const tickDigits = decimalsOf(step);
  const valueDigits = digits ?? tickDigits + 1;
  // Dots at the domain's ends stay inside the svg.
  const inset = HIT;
  const x = (v: number) => inset + ((v - lo) / (hi - lo)) * Math.max(0, width - 2 * inset);
  const hasAxis = values.length > 0 || domain !== undefined;

  return (
    <figure
      aria-label={`${label}, ${unit}`}
      className={cx("m-0 grid grid-cols-[fit-content(9rem)_minmax(0,1fr)] gap-x-4", className)}
    >
      {groups.map((group) => {
        const placed = width > 0 ? swarm(group.points, x) : [];
        const missing = group.points.filter((p) => p.value === null).length;
        const reach = Math.max(0, ...placed.map((p) => Math.abs(p.y)));
        const top = placed.some((p) => p.far) ? LABEL_ROOM : 0;
        const height = Math.max(ROW, 2 * reach + 2 * HIT) + top;
        const mid = top + (height - top) / 2;
        const mean =
          placed.length > 1 ? placed.reduce((s, p) => s + p.value, 0) / placed.length : null;
        return (
          <Row
            key={group.name}
            name={group.name}
            missing={missing}
            mean={mean === null ? undefined : `${mean.toFixed(valueDigits)} ${unit}`}
            height={height}
            top={top}
          >
            {/* Measured width, not 100%: a percentage svg adds 300 px to the min-content width. */}
            <svg width={width} height={height} className="block overflow-visible">
              <title>{`${group.name}, ${label}`}</title>
              {ticks.map((t) => (
                <line
                  key={t}
                  x1={x(t)}
                  x2={x(t)}
                  y1={0}
                  y2={height}
                  className="stroke-line-subtle"
                />
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
                  point={p}
                  cy={mid + p.y}
                  name={`${p.label}, ${p.value.toFixed(valueDigits)} ${unit}${p.far ? `, far from its group${p.farReason ? `: ${p.farReason}` : ""}` : ""}`}
                  onSelect={() => onSelect(p)}
                  onActive={(on) => setActive(on ? p.id : null)}
                />
              ))}
            </svg>
            {placed
              .filter((p) => p.id === active)
              .map((p) => (
                <Tooltip key={p.id} x={p.x} y={mid + p.y} width={width}>
                  <span className="font-medium">{p.label}</span>{" "}
                  <span className="font-mono tabular-nums">{p.value.toFixed(valueDigits)}</span>{" "}
                  {unit}
                  {p.far && <span className="block text-check-solid">Far from its group</span>}
                  {p.far && p.farReason && <span className="block">{p.farReason}</span>}
                </Tooltip>
              ))}
          </Row>
        );
      })}
      <div className="self-start pt-1 text-meta text-fg-subtle">{hasAxis && unit}</div>
      <div ref={axisRef} className="relative h-6">
        {hasAxis &&
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
  point,
  cy,
  name,
  onSelect,
  onActive,
}: {
  point: Placed;
  cy: number;
  name: string;
  onSelect: () => void;
  onActive: (on: boolean) => void;
}) {
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect();
    }
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: an svg mark can't be a <button>; role and keys make it one.
    <g
      role="button"
      tabIndex={0}
      aria-label={name}
      className="group cursor-pointer outline-none"
      onClick={onSelect}
      onKeyDown={onKeyDown}
      onPointerEnter={() => onActive(true)}
      onPointerLeave={() => onActive(false)}
      onFocus={() => onActive(true)}
      onBlur={() => onActive(false)}
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
          x={point.x}
          y={cy - R - 5}
          textAnchor="middle"
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
  width,
  children,
}: {
  x: number;
  y: number;
  width: number;
  children: ReactNode;
}) {
  // Near an edge the tooltip aligns to that edge instead of centring past it.
  const align =
    x < 70 ? "translate-x-0" : x > width - 70 ? "-translate-x-full" : "-translate-x-1/2";
  return (
    <div
      role="tooltip"
      className={cx(
        "pointer-events-none absolute z-10 -translate-y-full whitespace-nowrap rounded-md bg-inverse px-2 py-1 text-sm text-inverse-fg shadow-md",
        align,
      )}
      style={{ left: x, top: y - HIT - 2 }}
    >
      {children}
    </div>
  );
}

/** Places a group's valued dots, lowest first: each at its value, moved up or down until it clears the dots already placed. */
function swarm(points: StripPoint[], x: (v: number) => number): Placed[] {
  const placed: Placed[] = [];
  const valued = points.flatMap((p) => (p.value === null ? [] : { ...p, value: p.value }));
  for (const point of valued.sort((a, b) => a.value - b.value)) {
    const px = x(point.value);
    let y = 0;
    for (let step = 1; placed.some((q) => Math.hypot(q.x - px, q.y - y) < MIN_GAP); step++) {
      y = Math.ceil(step / 2) * SPREAD * (step % 2 ? -1 : 1);
    }
    placed.push({ ...point, x: px, y });
  }
  return placed;
}

/** The values' range with a 12% margin; a single value (or all equal) gets a range around it. */
function paddedRange(values: number[]): [number, number] {
  if (values.length === 0) return [0, 1];
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const pad = (hi - lo || Math.abs(hi) * 0.1 || 1) * 0.12;
  return [lo - pad, hi + pad];
}

/** Round-number ticks inside [lo, hi], about `count` of them, and their step. */
function niceTicks(lo: number, hi: number, count: number): { ticks: number[]; step: number } {
  const raw = (hi - lo) / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 5, 10].find((m) => m * magnitude >= raw) ?? 10) * magnitude;
  const ticks: number[] = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi + step * 1e-9; t += step) {
    ticks.push(Number(t.toPrecision(12)));
  }
  return { ticks, step };
}

/** Decimals that show a tick step exactly: 0.05 needs 2, 0.25 needs 2, 20 needs 0. */
function decimalsOf(step: number): number {
  for (let d = 0; d < 10; d++) if (Math.abs(Number(step.toFixed(d)) - step) < step * 1e-6) return d;
  return 10;
}
