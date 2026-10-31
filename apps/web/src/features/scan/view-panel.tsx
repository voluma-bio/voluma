/**
 * View: what the views draw. The structures and surfaces of the latest result, those the task in
 * view names first, each shown or hidden and faded; the viewer redraws in place. Window and level
 * stay on the viewer's own bar, where it exposes them.
 */
import type { ReviewTask, Revision } from "@voluma/contracts/review";
import { EmptyState, IconButton } from "@voluma/ui";
import type { StructureDisplay } from "@voluma/viewer/grid";
import { Eye, EyeOff } from "lucide-react";
import type { CSSProperties } from "react";

type Item = { id: string; name: string; label?: number; note?: string };

export function ViewPanel({
  revision,
  task,
  display,
  onDisplay,
}: {
  revision: Revision | undefined;
  task: ReviewTask | undefined;
  display: StructureDisplay;
  onDisplay: (display: StructureDisplay) => void;
}) {
  const all: Item[] = [
    ...(revision?.structures ?? []).map((s) => ({
      id: s.id,
      name: s.name,
      label: s.voxels && "label" in s.voxels ? s.voxels.label : undefined,
      note: s.missing ? `Missing: ${s.missing.reason}` : undefined,
    })),
    // Surfaces draw as meshes in 3D, so they hide and fade the same way.
    ...(revision?.surfaces ?? []).map((s) => ({ id: s.id, name: s.name })),
  ];
  if (all.length === 0)
    return (
      <div className="p-4">
        <EmptyState title="Nothing to show or hide yet">
          The structures appear once a task reports them.
        </EmptyState>
      </div>
    );
  const named = new Set(
    task ? [...task.measurements, ...task.scores].flatMap((m) => [...m.on, ...m.context]) : [],
  );
  const inTask = all.filter((s) => named.has(s.id) || (task && s.id.startsWith(`${task.id}/`)));
  const rest = all.filter((s) => !inTask.includes(s));
  const set = (id: string, patch: Partial<StructureDisplay[string]>) =>
    onDisplay({
      ...display,
      [id]: { ...(display[id] ?? { visible: true, opacity: 100 }), ...patch },
    });
  return (
    <div className="grid gap-4 p-3">
      {inTask.length > 0 && (
        <Group title={task?.title ?? ""} items={inTask} display={display} set={set} />
      )}
      {rest.length > 0 && (
        <Group
          title={inTask.length > 0 ? "Other structures" : "Structures"}
          items={rest}
          display={display}
          set={set}
        />
      )}
    </div>
  );
}

function Group({
  title,
  items,
  display,
  set,
}: {
  title: string;
  items: Item[];
  display: StructureDisplay;
  set: (id: string, patch: Partial<StructureDisplay[string]>) => void;
}) {
  return (
    <section aria-label={title}>
      <h3 className="px-1 pb-1 text-xs text-muted-foreground">{title}</h3>
      <ul className="grid">
        {items.map((s) => {
          const d = display[s.id] ?? { visible: true, opacity: 100 };
          return (
            <li
              key={s.id}
              className="grid grid-cols-[10px_minmax(0,1fr)_72px_auto] items-center gap-2 rounded-sm px-1 py-0.5 hover:bg-accent"
            >
              <span
                aria-hidden
                className="size-2.5 rounded-[2px] bg-[var(--swatch)] shadow-[inset_0_0_0_1px_var(--line-strong)]"
                style={
                  {
                    "--swatch":
                      s.label !== undefined
                        ? `var(--label-${((s.label - 1) % 12) + 1})`
                        : "transparent",
                  } as CSSProperties
                }
              />
              <span className={`min-w-0 truncate text-sm ${d.visible ? "" : "text-fg-subtle"}`}>
                {s.name}
                {s.note && <span className="block truncate text-xs text-fg-subtle">{s.note}</span>}
              </span>
              <input
                type="range"
                aria-label={`${s.name} opacity`}
                min={0}
                max={100}
                value={d.opacity}
                disabled={!d.visible}
                onChange={(e) => set(s.id, { opacity: Number(e.target.value) })}
                className="w-full accent-[var(--select)] disabled:opacity-40"
              />
              <IconButton
                size="sm"
                label={d.visible ? `Hide ${s.name}` : `Show ${s.name}`}
                onClick={() => set(s.id, { visible: !d.visible })}
              >
                {d.visible ? <Eye /> : <EyeOff />}
              </IconButton>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
