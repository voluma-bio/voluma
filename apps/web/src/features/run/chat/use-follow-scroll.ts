/**
 * Follow or free scroll for a live transcript. Ported verbatim in behaviour from Meridian Flow's
 * `useChatFollowScroll` (apps/app/src/features/chat).
 *
 * `follow` pins to the bottom on every content change, before paint. Deliberate upward intent
 * (wheel up, ArrowUp/PageUp/Home, a downward touch drag) switches to `free` at once; scrolling back
 * within 32 px of the bottom silently re-locks `follow`. The pin's own scroll writes open a short
 * guard window so they don't read as the reader's, except a guarded scroll that moved up and sits
 * far above the bottom, which can only be a scrollbar drag mid-stream.
 */
import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

export type FollowMode = "follow" | "free";

/** Distance from the bottom that still counts as the live edge (px). */
const BOTTOM_THRESHOLD_PX = 32;
/** Self-scroll guard window. */
const AUTOSCROLL_GUARD_MS = 180;

export function useFollowScroll({
  scrollRef,
  contentHeight,
}: {
  scrollRef: RefObject<HTMLElement | null>;
  contentHeight: number;
}): { mode: FollowMode; enterFollow: () => void } {
  const [mode, setMode] = useState<FollowMode>("follow");
  // The only writer is `commitMode`, so callbacks can read the freshest mode before React commits.
  const modeRef = useRef<FollowMode>("follow");
  const programmaticGuardRef = useRef(false);
  const guardTimeoutRef = useRef<number | null>(null);
  const lastScrollTopRef = useRef(0);
  const touchStartYRef = useRef<number | null>(null);
  const contentHeightRef = useRef(contentHeight);
  const viewportHeightRef = useRef(0);
  contentHeightRef.current = contentHeight;

  const maxScrollTop = useCallback(() => {
    const el = scrollRef.current;
    if (viewportHeightRef.current === 0 && el) viewportHeightRef.current = el.clientHeight;
    return Math.max(contentHeightRef.current - viewportHeightRef.current, 0);
  }, [scrollRef]);

  const commitMode = useCallback((next: FollowMode) => {
    modeRef.current = next;
    setMode((current) => (current === next ? current : next));
  }, []);

  const beginProgrammaticScroll = useCallback(() => {
    programmaticGuardRef.current = true;
    if (guardTimeoutRef.current !== null) clearTimeout(guardTimeoutRef.current);
    guardTimeoutRef.current = window.setTimeout(() => {
      programmaticGuardRef.current = false;
      guardTimeoutRef.current = null;
    }, AUTOSCROLL_GUARD_MS);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => {
      viewportHeightRef.current = el.clientHeight;
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [scrollRef]);

  const enterFollow = useCallback(() => {
    commitMode("follow");
    const el = scrollRef.current;
    if (!el) return;
    beginProgrammaticScroll();
    el.scrollTop = maxScrollTop();
    lastScrollTopRef.current = el.scrollTop;
  }, [beginProgrammaticScroll, commitMode, maxScrollTop, scrollRef]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) commitMode("free");
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "ArrowUp" || event.key === "PageUp" || event.key === "Home")
        commitMode("free");
    };
    const onTouchStart = (event: TouchEvent) => {
      touchStartYRef.current = event.touches[0]?.clientY ?? null;
    };
    const onTouchMove = (event: TouchEvent) => {
      const startY = touchStartYRef.current;
      const currentY = event.touches[0]?.clientY;
      if (startY == null || currentY == null) return;
      // Finger moving down = content moving up = reading history.
      if (currentY > startY + 2) commitMode("free");
    };
    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("keydown", onKeyDown);
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: true });
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("keydown", onKeyDown);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
    };
  }, [commitMode, scrollRef]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let reconcileTimer: number | null = null;
    const onScroll = () => {
      // One deferred reconcile per burst, reading the freshest geometry when it fires.
      if (reconcileTimer !== null) return;
      reconcileTimer = window.setTimeout(() => {
        reconcileTimer = null;
        const currentTop = el.scrollTop;
        const prevTop = lastScrollTopRef.current;
        const max = maxScrollTop();
        lastScrollTopRef.current = currentTop;
        if (programmaticGuardRef.current) {
          const farAboveBottom = max - currentTop > 2 * BOTTOM_THRESHOLD_PX;
          if (farAboveBottom && currentTop < prevTop - 1) commitMode("free");
          return;
        }
        if (max - currentTop <= BOTTOM_THRESHOLD_PX) {
          commitMode("follow");
          return;
        }
        if (currentTop < prevTop - 1) commitMode("free");
      }, 1);
    };
    lastScrollTopRef.current = el.scrollTop;
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (reconcileTimer !== null) clearTimeout(reconcileTimer);
    };
  }, [commitMode, maxScrollTop, scrollRef]);

  useLayoutEffect(() => {
    if (mode !== "follow") return;
    const el = scrollRef.current;
    if (!el) return;
    const top = maxScrollTop();
    // Guard only a real write: an idle pin must not swallow the reader's next scroll.
    if (el.scrollTop !== top) {
      beginProgrammaticScroll();
      el.scrollTop = top;
    }
    lastScrollTopRef.current = el.scrollTop;
  }, [contentHeight, mode, beginProgrammaticScroll, maxScrollTop, scrollRef]);

  useEffect(
    () => () => {
      if (guardTimeoutRef.current !== null) clearTimeout(guardTimeoutRef.current);
    },
    [],
  );

  return { mode, enterFollow };
}
