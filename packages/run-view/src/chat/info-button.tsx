/**
 * A quiet info button whose popover lists labelled numbers in titled sections: model usage for a
 * reply, a wake or a whole thread. Ported from Meridian Flow's `TurnInfoButton`
 * (apps/app/src/features/chat) onto radix-ui's Popover.
 */
import type { ModelUsage } from "@voluma/contracts/events";
import { Info } from "lucide-react";
import { Popover } from "radix-ui";
import { Fragment } from "react";

export type InfoSection = { title: string; rows: [label: string, value: string][] };

export function InfoButton({ label, sections }: { label: string; sections: InfoSection[] }) {
  return (
    <Popover.Root>
      <Popover.Trigger
        aria-label={label}
        title={label}
        className="grid size-6 shrink-0 place-items-center rounded-md text-fg-subtle hover:bg-accent hover:text-foreground"
      >
        <Info className="size-3.5" aria-hidden />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={4}
          className="z-50 w-64 rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-md"
        >
          <dl className="grid grid-cols-[1fr_auto] gap-x-2 gap-y-1 text-meta">
            {sections.map(({ title, rows }, index) => (
              <Fragment key={title}>
                <dt
                  className={`col-span-2 font-medium text-foreground ${
                    index > 0 ? "mt-1 border-t border-border pt-1.5" : ""
                  }`}
                >
                  {title}
                </dt>
                {rows.map(([k, v]) => (
                  <Fragment key={k}>
                    <dt className="text-muted-foreground">{k}</dt>
                    <dd className="text-right font-mono tabular-nums">{v}</dd>
                  </Fragment>
                ))}
              </Fragment>
            ))}
          </dl>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

const count = (n: number) => n.toLocaleString();

/** Rows for one model call's usage: tokens, the share read from cache, whether it missed the cache, cost. */
export function usageRows(u: ModelUsage, miss = false): InfoSection["rows"] {
  const read = u.input + u.cacheRead;
  return [
    ["Input tokens", count(read)],
    ["Output tokens", count(u.output)],
    ["Cache hit", read > 0 ? `${Math.round((100 * u.cacheRead) / read)}%` : "none"],
    ...(miss ? ([["Cache", "miss"]] as [string, string][]) : []),
    ["Cache writes", count(u.cacheWrite)],
    ["Cost", `$${u.costUsd.toFixed(u.costUsd < 0.1 ? 4 : 2)}`],
  ];
}
