/**
 * Chat thread shell: the message list and the composer with suggested
 * prompts. It knows nothing about threads, proposals or the API; the review's
 * per-task chat fills it.
 */
import { type FormEvent, type KeyboardEvent, type ReactNode, useId } from "react";
import { cx } from "./cx";

export function ChatThread({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div role="log" aria-live="polite" className={cx("grid gap-3", className)}>
      {children}
    </div>
  );
}

export type ChatMessageProps = {
  from: "user" | "agent";
  /** Shown above agent messages, e.g. "Agent" or "Second agent". */
  author?: string;
  children: ReactNode;
};

export function ChatMessage({ from, author, children }: ChatMessageProps) {
  if (from === "user") {
    return (
      <div className="max-w-[88%] justify-self-end rounded-xl rounded-br-sm border border-line-strong bg-muted px-3 py-2 text-ui text-foreground">
        {children}
      </div>
    );
  }
  return (
    <div className="grid gap-1.5 text-ui text-muted-foreground">
      {author && <div className="text-xs font-semibold text-primary-text">{author}</div>}
      <div>{children}</div>
    </div>
  );
}

export type ChatComposerProps = {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  placeholder: string;
  /** Prompts suggested for what is on screen; choosing one fills the box. */
  suggestions?: string[];
  disabled?: boolean;
  className?: string;
};

export function ChatComposer({
  value,
  onChange,
  onSubmit,
  placeholder,
  suggestions = [],
  disabled = false,
  className,
}: ChatComposerProps) {
  const inputId = useId();
  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const text = value.trim();
    if (text && !disabled) onSubmit(text);
  };
  // Enter sends; Shift+Enter adds a line.
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) submit(event);
  };

  return (
    <form onSubmit={submit} className={cx("grid gap-2", className)}>
      {suggestions.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {suggestions.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              onClick={() => onChange(suggestion)}
              className="cursor-pointer rounded-full border border-line-strong px-2.5 py-1 text-left text-meta text-muted-foreground hover:border-fg-subtle hover:text-foreground"
            >
              {suggestion}
            </button>
          ))}
        </div>
      )}
      <div className="flex items-end gap-1.5 rounded-xl border border-line-strong bg-background py-1.5 pr-1.5 pl-3 focus-within:border-fg-subtle">
        <label htmlFor={inputId} className="sr-only">
          {placeholder}
        </label>
        <textarea
          id={inputId}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          rows={1}
          className="field-sizing-content max-h-30 min-w-0 flex-1 resize-none bg-transparent py-1 text-ui text-foreground outline-none placeholder:text-fg-subtle"
        />
        <button
          type="submit"
          disabled={disabled || !value.trim()}
          aria-label="Send"
          className="grid size-7.5 cursor-pointer place-items-center rounded-lg bg-primary text-primary-foreground disabled:cursor-default disabled:opacity-50"
        >
          <svg viewBox="0 0 16 16" className="size-3.5" aria-hidden="true">
            <path
              d="M8 13V3M3.5 7.5 8 3l4.5 4.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>
    </form>
  );
}
