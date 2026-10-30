/**
 * Readout: measured values in a sunken well, each a label with its reading right-aligned in mono
 * (`Volume 0.500 mm³`), so a number looks the same wherever it appears. One well holds one value
 * or several.
 */
import type { ReactNode } from "react";
import { cx } from "./cx";

export type ReadoutValue = {
  label: ReactNode;
  /** The reading, already formatted to the value's precision. */
  value: ReactNode;
  unit?: string;
};

export type ReadoutProps = {
  values: ReadoutValue[];
  className?: string;
};

export function Readout({ values, className }: ReadoutProps) {
  return (
    <dl
      className={cx(
        "m-0 grid grid-cols-[minmax(0,1fr)_auto] gap-x-3.5 gap-y-0.75 rounded-md bg-muted px-2.5 py-2 text-sm",
        className,
      )}
    >
      {values.map(({ label, value, unit }, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: labels need not be unique strings; the order is the identity.
        <div key={i} className="contents">
          <dt className="truncate text-fg-subtle">{label}</dt>
          <dd className="m-0 text-right font-mono text-xs leading-4.5 tabular-nums whitespace-nowrap text-foreground">
            {value}
            {unit && <span className="text-muted-foreground"> {unit}</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}
