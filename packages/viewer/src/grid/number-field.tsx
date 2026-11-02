/** A number field for the viewer's window: typed freely, applied on Enter or blur. */
import { useState } from "react";

/**
 * A number typed freely (a lone "-", "0.") and applied on Enter or blur, so a half-typed value
 * never redraws every pane or snaps back.
 */
export function NumberField({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: number;
  onCommit(value: number): void;
}) {
  const shown = Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(6)));
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    const n = Number(draft);
    if (draft !== null && draft.trim() !== "" && Number.isFinite(n) && n !== value) onCommit(n);
    setDraft(null);
  };
  return (
    <label className="flex items-center gap-1">
      {label}
      <input
        className="h-7 w-20 rounded-md border border-border bg-card px-1 font-mono text-foreground"
        type="text"
        inputMode="decimal"
        value={draft ?? shown}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") setDraft(null);
        }}
      />
    </label>
  );
}
