/** Keeps a scroll container pinned to its bottom while new content arrives, unless the reader scrolled up. */
import { useEffect, useRef } from "react";

export function useStickToBottom<T extends HTMLElement>(changes: unknown, resetKey: unknown) {
  const ref = useRef<T>(null);
  const pinned = useRef(true);
  useEffect(() => {
    pinned.current = true;
  }, [resetKey]);
  useEffect(() => {
    const el = ref.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [changes, resetKey]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    };
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, []);
  return ref;
}
