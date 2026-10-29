/**
 * A row of tabs, each with an optional count, as in the study page's header
 * (Overview | To check 3 | Scans 5/8). It renders the tablist only: the page
 * renders the selected panel with `role="tabpanel"` and the id it passes as
 * `controls`. Arrow keys, Home and End move between tabs.
 */
import { type KeyboardEvent, useRef } from "react";
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
  tabs: TabItem<Id>[];
  value: Id;
  onChange: (id: Id) => void;
  /** Accessible name for the tab row. */
  label: string;
  /** Id of the panel the page renders for the selected tab. */
  controls?: string;
  className?: string;
};

export function Tabs<Id extends string>({
  tabs,
  value,
  onChange,
  label,
  controls,
  className,
}: TabsProps<Id>) {
  const refs = useRef(new Map<Id, HTMLButtonElement>());

  const onKeyDown = (event: KeyboardEvent) => {
    const index = tabs.findIndex((tab) => tab.id === value);
    const next = {
      ArrowRight: index + 1,
      ArrowLeft: index - 1,
      Home: 0,
      End: tabs.length - 1,
    }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    const tab = tabs[(next + tabs.length) % tabs.length];
    if (!tab) return;
    onChange(tab.id);
    refs.current.get(tab.id)?.focus();
  };

  return (
    <div
      role="tablist"
      aria-label={label}
      onKeyDown={onKeyDown}
      className={cx("flex min-w-0 items-stretch gap-1 overflow-x-auto", className)}
    >
      {tabs.map((tab) => {
        const selected = tab.id === value;
        return (
          <button
            key={tab.id}
            ref={(node) => {
              if (node) refs.current.set(tab.id, node);
              else refs.current.delete(tab.id);
            }}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={selected ? controls : undefined}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(tab.id)}
            className={cx(
              "relative -mb-px flex min-h-11 cursor-pointer items-center gap-2 border-b-2 px-3 text-sm font-medium whitespace-nowrap transition-colors",
              "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
              selected
                ? "border-foreground text-foreground"
                : "border-transparent text-fg-subtle hover:text-foreground",
            )}
          >
            {tab.label}
            {tab.count !== undefined && (
              <span
                title={tab.countLabel}
                aria-hidden={tab.countLabel !== undefined}
                className={cx(
                  "font-mono text-meta tabular-nums",
                  tab.alert
                    ? "rounded-full border border-check-line bg-check-tint px-2 text-check"
                    : "text-fg-subtle",
                )}
              >
                {tab.count}
              </span>
            )}
            {tab.countLabel && <span className="sr-only">{tab.countLabel}</span>}
          </button>
        );
      })}
    </div>
  );
}
