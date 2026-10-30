/**
 * Tabs, each with an optional count (Overview | To check 3 | Scans 5/8). Radix underneath: arrow
 * keys, Home and End move between tabs, and each panel is named by its tab.
 *
 *   <Tabs value={tab} onValueChange={setTab}>
 *     <TabList label="Study" tabs={[...]} />
 *     <TabPanel value={tab}>...</TabPanel>
 *   </Tabs>
 *
 * `Tabs` holds the state and may wrap a whole page, so the tab list and the panel can sit in
 * different parts of it. Render a `TabPanel` for the selected tab only, or one per tab.
 */
import { Tabs as T } from "radix-ui";
import type { ReactNode } from "react";
import { cx } from "./cx";

export type TabItem<Id extends string> = {
  id: Id;
  label: string;
  /** Shown after the label in mono, e.g. `5/8`. */
  count?: string | number;
  /** Draws the count as an amber To-check count. */
  alert?: boolean;
  /** Spoken in place of `count`, and its tooltip, e.g. "5 of 8 done". */
  countLabel?: string;
};

export type TabsProps<Id extends string> = {
  value: Id;
  onValueChange: (id: Id) => void;
  children: ReactNode;
  className?: string;
};

export function Tabs<Id extends string>({
  value,
  onValueChange,
  children,
  className,
}: TabsProps<Id>) {
  return (
    <T.Root value={value} onValueChange={(v) => onValueChange(v as Id)} className={className}>
      {children}
    </T.Root>
  );
}

export type TabListProps<Id extends string> = {
  tabs: TabItem<Id>[];
  /** Accessible name for the tab row. */
  label: string;
  className?: string;
};

/** The row of tabs. It never scrolls: on a narrow screen give it a line of its own. */
export function TabList<Id extends string>({ tabs, label, className }: TabListProps<Id>) {
  return (
    <T.List aria-label={label} className={cx("flex items-stretch gap-0.5", className)}>
      {tabs.map((tab) => (
        <T.Trigger
          key={tab.id}
          value={tab.id}
          className={cx(
            "relative flex min-h-9 cursor-pointer items-center gap-1.5 px-2.5 text-base whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground",
            "after:absolute after:inset-x-1.5 after:-bottom-px after:h-0.5 after:rounded-full after:content-['']",
            "data-[state=active]:text-foreground data-[state=active]:after:bg-foreground",
            "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
          )}
        >
          {tab.label}
          {tab.count !== undefined && (
            <span
              title={tab.countLabel}
              aria-hidden={tab.countLabel !== undefined}
              className={cx(
                // The Count look; swap in Count once it lands.
                "inline-flex h-[18px] min-w-5 items-center justify-center rounded-full px-1.5 font-mono text-xs font-medium tabular-nums",
                tab.alert ? "bg-check-tint text-check" : "bg-secondary text-muted-foreground",
              )}
            >
              {tab.count}
            </span>
          )}
          {tab.countLabel && <span className="sr-only">{tab.countLabel}</span>}
        </T.Trigger>
      ))}
    </T.List>
  );
}

export type TabPanelProps = {
  value: string;
  children: ReactNode;
  className?: string;
};

export function TabPanel({ value, children, className }: TabPanelProps) {
  return (
    <T.Content value={value} className={cx("focus-visible:outline-none", className)}>
      {children}
    </T.Content>
  );
}
