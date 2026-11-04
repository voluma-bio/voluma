/**
 * The Segmentation tab of the input review's left side: what each colour in the views is, by its
 * anatomical name, with its volume where the run measured one, and how it is drawn. Above the
 * list, settings for every structure at once (opacity, Fill or Outline on the slices, colour by
 * structure); on each row, its own opacity and show or hide. The list is what the shown grid
 * draws (`LegendEntry`, from `reviewGrid`), so it changes with the output in view; the settings
 * are the page's (`LabelDisplay`) and hold across outputs.
 */
import type { OutputRow } from "@voluma/run-view";
import { cx, EmptyState, IconButton, SegmentedControl } from "@voluma/ui";
import type { LabelDisplay, LegendEntry } from "@voluma/viewer/grid";
import { Eye, EyeOff } from "lucide-react";
import { useId } from "react";

/** Each structure's volume, from a value measured on it alone in mm³, by structure id. */
export function structureVolumes(rows: Iterable<OutputRow>): Map<string, string> {
  const volumes = new Map<string, string>();
  for (const r of rows)
    if (r.on.length === 1 && r.value?.unit === "mm³")
      volumes.set(r.on[0]!, `${r.value.text} ${r.value.unit}`);
  return volumes;
}

export function SegmentationPanel({
  legend,
  display,
  onDisplay,
  volumes,
  inView,
}: {
  /** What the shown grid draws; undefined while no picture is shown. */
  legend: readonly LegendEntry[] | undefined;
  display: LabelDisplay;
  onDisplay: (update: (display: LabelDisplay) => LabelDisplay) => void;
  volumes: ReadonlyMap<string, string>;
  /** The output in view, whose own region is highlighted. */
  inView: string | undefined;
}) {
  const allId = useId();
  if (!legend)
    return (
      <div className="p-4">
        <EmptyState title="No picture shown">
          The structures drawn in the views are listed here once an output with a picture is open.
        </EmptyState>
      </div>
    );
  if (legend.length === 0)
    return (
      <div className="p-4">
        <EmptyState title="No segmentation here">
          {inView ? `${inView} is shown on the scan alone.` : undefined}
        </EmptyState>
      </div>
    );
  const set = (patch: (d: LabelDisplay) => Partial<LabelDisplay>) =>
    onDisplay((d) => ({ ...d, ...patch(d) }));
  const hidden = new Set(display.hidden);
  return (
    <div className="grid gap-4 px-3 py-3">
      <section aria-label="Every structure" className="grid gap-3">
        <div className="flex items-center gap-3">
          <label htmlFor={allId} className="w-16 shrink-0 text-sm">
            Opacity
          </label>
          <Slider
            id={allId}
            label="Opacity of every structure"
            value={display.opacity}
            onChange={(opacity) => set(() => ({ opacity }))}
          />
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <SegmentedControl
            label="On the slices"
            options={[
              { value: "fill", label: "Fill" },
              { value: "outline", label: "Outline" },
            ]}
            value={display.style}
            onValueChange={(style) => set(() => ({ style }))}
          />
          <label className="flex items-center gap-1.5 text-sm">
            <input
              type="checkbox"
              checked={display.colours}
              onChange={(e) => set(() => ({ colours: e.target.checked }))}
            />
            Colour each structure
          </label>
        </div>
      </section>
      <ul className="m-0 grid list-none gap-1 p-0">
        {legend.map((e) => {
          const off = hidden.has(e.id);
          const volume = volumes.get(e.id);
          const note =
            e.as === "output"
              ? `Highlighted while ${inView ?? "this output"} is open`
              : e.as === "check"
                ? "Highlighted: the place to check"
                : e.only3d
                  ? "In 3D only"
                  : undefined;
          return (
            <li key={e.id} className="flex items-center gap-2 py-1">
              <span
                aria-hidden
                className={cx("size-3 shrink-0 rounded-[3px]", off && "opacity-30")}
                style={{ backgroundColor: e.color }}
              />
              <div className={cx("min-w-0 flex-1", off && "text-muted-foreground")}>
                <p className="text-sm [overflow-wrap:anywhere]">{e.name}</p>
                {(volume || note) && (
                  <p className="flex flex-wrap items-center gap-x-2 text-muted-foreground text-xs">
                    {volume && <span className="font-mono tabular-nums">{volume}</span>}
                    {note && <span>{note}</span>}
                    {e.usual && (
                      <span className="flex items-center gap-1">
                        usual colour
                        <span
                          aria-hidden
                          className="size-2.5 rounded-[2px]"
                          style={{ backgroundColor: e.usual }}
                        />
                      </span>
                    )}
                  </p>
                )}
              </div>
              <Slider
                label={`Opacity of ${e.name}`}
                className="w-16 flex-none"
                disabled={off}
                value={display.structures[e.id] ?? 1}
                onChange={(o) => set((d) => ({ structures: { ...d.structures, [e.id]: o } }))}
              />
              <IconButton
                size="sm"
                label={off ? `Show ${e.name}` : `Hide ${e.name}`}
                aria-pressed={off}
                onClick={() =>
                  set((d) => ({
                    hidden: off ? d.hidden.filter((h) => h !== e.id) : [...d.hidden, e.id],
                  }))
                }
              >
                {off ? <EyeOff /> : <Eye />}
              </IconButton>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Slider({
  id,
  label,
  value,
  onChange,
  disabled,
  className,
}: {
  id?: string;
  label: string;
  value: number;
  onChange: (value: number) => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <input
      id={id}
      type="range"
      aria-label={label}
      min={0}
      max={100}
      step={5}
      value={Math.round(value * 100)}
      disabled={disabled}
      onChange={(e) => onChange(Number(e.target.value) / 100)}
      className={cx(
        "h-4 min-w-0 flex-1 cursor-pointer accent-primary disabled:opacity-40",
        className,
      )}
    />
  );
}
