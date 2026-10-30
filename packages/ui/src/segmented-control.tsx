/**
 * Two or three modes of one view (Status / Values, Comfortable / Compact). Radix toggle group
 * underneath: one option is always on, and arrow keys move between options.
 */
import { ToggleGroup } from "radix-ui";
import { cx } from "./cx";

export type SegmentedControlProps<V extends string> = {
  options: { value: V; label: string }[];
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
      onValueChange={(v) => v && onValueChange(v as V)}
      aria-label={label}
      className={cx(
        "inline-flex rounded-md bg-muted p-0.5 inset-ring inset-ring-border",
        className,
      )}
    >
      {options.map((option) => (
        <ToggleGroup.Item
          key={option.value}
          value={option.value}
          className={cx(
            "h-[22px] cursor-pointer rounded-sm px-2.5 text-sm whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground",
            "data-[state=on]:bg-card data-[state=on]:text-foreground data-[state=on]:inset-ring data-[state=on]:inset-ring-line-strong",
            "focus-visible:outline-2 focus-visible:outline-ring",
          )}
        >
          {option.label}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  );
}
