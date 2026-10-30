/**
 * The model's prose as Markdown (GitHub flavour), and its streaming form with a caret.
 *
 * Streaming text is cut off mid-construct (`**bold`, an open code fence); `remend` closes what is
 * open before parsing, the same tail repair Meridian Flow's renderer uses, so the tree doesn't
 * flash raw markers as the text grows. Raw HTML in model output is shown as text, never rendered,
 * and images render as their alt text: the run page never fetches what a model linked.
 * The caret is ported from Flow's `StreamingText` (apps/app/src/features/chat).
 */
import { memo, useLayoutEffect, useRef, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remend from "remend";

const components: Components = {
  a: ({ node: _, ...props }) => <a {...props} target="_blank" rel="noreferrer noopener" />,
  img: ({ alt }) => <span>{alt}</span>,
};

export const Markdown = memo(function Markdown({
  text,
  streaming = false,
  className = "",
}: {
  text: string;
  streaming?: boolean;
  className?: string;
}) {
  return (
    <div className={`run-prose ${className}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} skipHtml>
        {streaming ? remend(text) : text}
      </ReactMarkdown>
    </div>
  );
});

export function StreamingText({ text, streaming }: { text: string; streaming: boolean }) {
  return (
    <div>
      <Markdown text={text} streaming={streaming} />
      {streaming && (
        <span aria-hidden className="mt-1 block">
          <span className="ml-0.5 inline-block h-[1.05em] w-2 translate-y-[2px] rounded-[1px] bg-primary motion-safe:animate-[blink_1.05s_step-end_infinite]" />
        </span>
      )}
    </div>
  );
}

/** Markdown cut to a few lines, with "Show all" when there is more; `label`, if given, names what it is. */
export function ClampedMarkdown({
  text,
  label,
  className = "",
}: {
  text: string;
  label?: string;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => setOverflows(el.scrollHeight > el.clientHeight + 1);
    check();
    const observer = new ResizeObserver(check);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return (
    <section aria-label={label} className={className}>
      {label && <p className="text-meta font-medium text-muted-foreground">{label}</p>}
      {/* Four lines of `run-prose` (14 px at 1.625). */}
      <div ref={ref} className={open ? "text-sm" : "max-h-[6.5em] overflow-hidden text-sm"}>
        <Markdown text={text} className="[color:inherit]" />
      </div>
      {(overflows || open) && (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="mt-0.5 text-meta font-medium text-primary-text hover:underline"
        >
          {open ? "Show less" : "Show all"}
        </button>
      )}
    </section>
  );
}
