/**
 * The model's prose as Markdown (GitHub flavour). Raw HTML in model output is shown as text, never
 * rendered, and images render as their alt text: the page never fetches what a model linked.
 */
import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const components: Components = {
  a: ({ node: _, ...props }) => <a {...props} target="_blank" rel="noreferrer noopener" />,
  img: ({ alt }) => <span>{alt}</span>,
};

export const Markdown = memo(function Markdown({
  text,
  className = "",
}: {
  text: string;
  className?: string;
}) {
  return (
    <div className={`run-prose ${className}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} skipHtml>
        {text}
      </ReactMarkdown>
    </div>
  );
});
