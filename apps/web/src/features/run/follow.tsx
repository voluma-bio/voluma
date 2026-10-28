/** A scroll area that follows new content at its bottom until the reader scrolls up, then offers a jump back. */
import { ArrowDown } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

const NEAR_BOTTOM = 80;

export function Follow({
  changes,
  resetKey,
  className,
  children,
}: {
  /** Anything that changes when content is added. */
  changes: unknown;
  /** A new key starts pinned to the bottom again (another thread). */
  resetKey: unknown;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [away, setAway] = useState(false);

  useEffect(() => {
    pinned.current = true;
    setAway(false);
  }, [resetKey]);

  useEffect(() => {
    const el = ref.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [changes, resetKey]);

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM;
    setAway(!pinned.current);
  };

  return (
    <div className="relative flex min-h-72 flex-1 flex-col max-[1100px]:block">
      <div
        ref={ref}
        onScroll={onScroll}
        className={`min-h-0 flex-1 overflow-y-auto ${className ?? ""}`}
      >
        {children}
      </div>
      {away && (
        <button
          type="button"
          onClick={() => {
            const el = ref.current;
            if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
          }}
          className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-inverse px-3 py-1.5 text-meta font-medium text-inverse-fg shadow-md hover:opacity-90 max-[1100px]:hidden"
        >
          <ArrowDown size={14} aria-hidden="true" />
          Jump to latest
        </button>
      )}
    </div>
  );
}
