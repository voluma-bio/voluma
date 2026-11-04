/**
 * The model's prose as Markdown (GitHub flavour). Raw HTML in model output is shown as text, never
 * rendered, and images render as their alt text: the page never fetches what a model linked.
 * With `agents`, inline code that is exactly an agent's name opens that agent.
 */
import { memo, useMemo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const base: Components = {
  a: ({ node: _, ...props }) => <a {...props} target="_blank" rel="noreferrer noopener" />,
  img: ({ alt }) => <span>{alt}</span>,
};

export const Markdown = memo(function Markdown({
  text,
  className = "",
  agents,
}: {
  text: string;
  className?: string;
  /** Names that are agents, and what opening one does. Keep it stable between renders. */
  agents?: { names: ReadonlySet<string>; open: (name: string) => void };
}) {
  const components = useMemo<Components>(
    () =>
      agents
        ? {
            ...base,
            code: ({ node: _, className: cls, children, ...props }) => {
              const name = typeof children === "string" && !cls ? children : undefined;
              return name && agents.names.has(name) ? (
                <button
                  type="button"
                  onClick={() => agents.open(name)}
                  className="rounded bg-muted px-1 py-px font-mono text-[0.9em] text-primary-text underline underline-offset-2"
                >
                  {name}
                </button>
              ) : (
                <code className={cls} {...props}>
                  {children}
                </code>
              );
            },
          }
        : base,
    [agents],
  );
  return (
    <div className={`run-prose ${className}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} skipHtml>
        {text}
      </ReactMarkdown>
    </div>
  );
});
