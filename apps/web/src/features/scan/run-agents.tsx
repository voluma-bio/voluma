/**
 * The run's agents by name, in the panes' place: when each worked, the outputs it reported, and
 * whether it is still at work. From `workersOf` (`outputs-trail.ts`).
 */

import type { RunEvent } from "@voluma/contracts/events";
import type { OutputsFold } from "@voluma/contracts/output-fold";
import { workersOf } from "@voluma/run-view";
import { useMemo } from "react";
import { clockOf } from "./version-report";

const NOW: Record<string, string> = {
  running: "Working",
  completed: "Done",
  closed: "Done",
  failed: "Failed",
  cancelled: "Stopped",
};

export function RunAgents({
  events,
  fold,
  nameOf,
}: {
  events: readonly RunEvent[];
  fold: OutputsFold;
  nameOf: (id: string) => string;
}) {
  const workers = useMemo(() => workersOf(events, fold), [events, fold]);
  if (workers.length === 0)
    return <p className="p-6 text-sm text-muted-foreground">No agent has started yet.</p>;
  return (
    <div className="h-full overflow-auto">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-card text-left text-xs text-muted-foreground">
          <tr className="border-b border-border">
            <th className="px-4 py-2 font-medium">Agent</th>
            <th className="px-4 py-2 font-medium">Worked</th>
            <th className="px-4 py-2 font-medium">Reported</th>
            <th className="px-4 py-2 font-medium">Now</th>
          </tr>
        </thead>
        <tbody>
          {workers.map((w) => (
            <tr key={`${w.name}/${w.from}`} className="border-b border-border align-top">
              <td className="px-4 py-2 font-mono">{w.name}</td>
              <td className="px-4 py-2 font-mono whitespace-nowrap tabular-nums">
                {clockOf(w.from)}
                {w.to && `–${clockOf(w.to)}`}
              </td>
              <td className="px-4 py-2">
                {w.made.length > 0 ? (
                  w.made.map(nameOf).join(", ")
                ) : (
                  <span className="text-muted-foreground">Nothing</span>
                )}
              </td>
              <td className="px-4 py-2 text-muted-foreground">{NOW[w.status]}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
