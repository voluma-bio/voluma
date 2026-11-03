/**
 * A few modes of one view (Status / Values, Comfortable / Compact, the marking tools). Radix
 * toggle group underneath: one option is always on, and arrow keys move between options. An
 * option with a shortcut or a reason shows it in a tooltip, as `IconButton` does; an option with
 * an icon shows only the icon, and its label in the tooltip.
 */
import { ToggleGroup } from "radix-ui";
import type { ReactNode } from "react";
import { cx } from "./cx";
import { Tooltip } from "./tooltip";

export type SegmentedControlOption<V extends string> = {
  value: V;
  label: string;
  /** The key that picks the option. */
  shortcut?: string;
  /** Why the option can't be picked now; it stays visible, and this is its tooltip. */
  reason?: string;
  /** A lucide icon shown instead of the label, which becomes its name and tooltip. */
  icon?: ReactNode;
};

export type SegmentedControlProps<V extends string> = {
  options: SegmentedControlOption<V>[];
  value: V;
  onValueChange: (value: V) => void;
  /** Accessible name, e.g. "Density". */
  label: string;
  className?: string;
};

export function SegmentedControl<V extends string>({
  options,
  value,
  onValueChange,
  label,
  className,
}: SegmentedControlProps<V>) {
  return (
    <ToggleGroup.Root
      type="single"
      value={value}
      // Clicking the option that is on would turn every option off; keep it on.
      onValueChange={(v) => {
        const picked = options.find((o) => o.value === v);
        if (picked && !picked.reason) onValueChange(picked.value);
      }}
      aria-label={label}
      className={cx(
        "inline-flex rounded-md bg-muted p-0.5 inset-ring inset-ring-border",
        className,
      )}
    >
      {options.map((option) => {
        const item = (
          <ToggleGroup.Item
            key={option.value}
            value={option.value}
            aria-keyshortcuts={option.reason ? undefined : option.shortcut}
            aria-label={option.icon ? option.label : undefined}
            // Not `disabled`: a disabled button gets no hover, so its reason could never show.
            aria-disabled={option.reason ? true : undefined}
            className={cx(
              "h-[22px] cursor-pointer rounded-sm text-sm whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground",
              option.icon ? "flex w-7 items-center justify-center [&_svg]:size-3.5" : "px-2.5",
              // aria-checked, not data-state: a tooltip trigger sets its own data-state on the item.
              "aria-checked:bg-card aria-checked:font-medium aria-checked:text-foreground aria-checked:inset-ring aria-checked:inset-ring-foreground/40",
              "aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-disabled:hover:text-muted-foreground",
              "focus-visible:outline-2 focus-visible:outline-ring",
            )}
          >
            {option.icon ?? option.label}
          </ToggleGroup.Item>
        );
        if (!option.shortcut && !option.reason && !option.icon) return item;
        return (
          <Tooltip
            key={option.value}
            label={
              option.reason
                ? option.icon
                  ? `${option.label}: ${option.reason}`
                  : option.reason
                : option.label
            }
            shortcut={option.reason ? undefined : option.shortcut}
          >
            {item}
          </Tooltip>
        );
      })}
    </ToggleGroup.Root>
  );
}
