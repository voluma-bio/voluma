/**
 * A closed-by-default fold over a process run (reasoning and tool calls), with a digest as its
 * label. Ported from Meridian Flow's `ProcessDisclosure` (apps/app/src/features/chat), restyled
 * onto voluma's tokens.
 *
 * It always mounts closed and streaming never opens or closes it, so a live thread and a settled
 * one keep the same layout; only the reader's click toggles it. Its body is built on first open.
 */
import { ChevronRight } from "lucide-react";
import { type ReactNode, useId, useState } from "react";

export function ProcessDisclosure({ label, children }: { label: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [hasOpened, setHasOpened] = useState(false);
  const panelId = useId();

  return (
    <div>
      <button
        type="button"
        onClick={() => {
          if (!open) setHasOpened(true);
          setOpen(!open);
        }}
        aria-expanded={open}
        aria-controls={panelId}
        className="flex w-full min-w-0 items-center gap-2 py-1 text-left text-ui font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronRight
          className={`size-3 shrink-0 transition-transform duration-200 ${open ? "rotate-90" : ""}`}
          aria-hidden
        />
        <span className="min-w-0 truncate">{label}</span>
      </button>
      <div
        id={panelId}
        aria-hidden={!open}
        className={`grid transition-[grid-template-rows] duration-300 ease-out motion-reduce:transition-none ${
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        }`}
      >
        <div className="min-w-0 overflow-hidden">
          <div className="mt-2">{hasOpened ? children : null}</div>
        </div>
      </div>
    </div>
  );
}
