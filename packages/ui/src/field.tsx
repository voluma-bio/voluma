/**
 * Text input and text area with a label and an error. The label sits above; `hideLabel` keeps it
 * for screen readers only, for a box whose purpose the screen already shows (the AI composer).
 * An error shows under the box and marks it invalid.
 */
import {
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
  useId,
} from "react";
import { cx } from "./cx";

type FieldOwnProps = {
  label: string;
  hideLabel?: boolean;
  /** What is wrong and how to fix it, e.g. "Give the study a name". */
  error?: ReactNode;
};

const boxClass = cx(
  "w-full rounded-md bg-card px-2.5 text-base text-foreground inset-ring inset-ring-line-strong placeholder:text-fg-subtle",
  "focus:outline-2 focus:-outline-offset-1 focus:outline-ring",
  "disabled:cursor-not-allowed disabled:opacity-50",
  "aria-invalid:inset-ring-destructive",
);

export type TextFieldProps = FieldOwnProps & InputHTMLAttributes<HTMLInputElement>;

export function TextField({ label, hideLabel, error, className, id, ...props }: TextFieldProps) {
  const own = useId();
  return (
    <Frame id={id ?? own} label={label} hideLabel={hideLabel} error={error} className={className}>
      {(a11y) => <input type="text" {...props} {...a11y} className={cx(boxClass, "h-8")} />}
    </Frame>
  );
}

export type TextAreaFieldProps = FieldOwnProps & TextareaHTMLAttributes<HTMLTextAreaElement>;

export function TextAreaField({
  label,
  hideLabel,
  error,
  className,
  id,
  ...props
}: TextAreaFieldProps) {
  const own = useId();
  return (
    <Frame id={id ?? own} label={label} hideLabel={hideLabel} error={error} className={className}>
      {(a11y) => (
        <textarea {...props} {...a11y} className={cx(boxClass, "min-h-18 resize-y py-2")} />
      )}
    </Frame>
  );
}

function Frame({
  id,
  label,
  hideLabel,
  error,
  className,
  children,
}: FieldOwnProps & {
  id: string;
  className?: string;
  children: (a11y: {
    id: string;
    "aria-invalid": true | undefined;
    "aria-describedby": string | undefined;
  }) => ReactNode;
}) {
  const errorId = `${id}-error`;
  return (
    <div className={cx("grid gap-1", className)}>
      <label htmlFor={id} className={cx("text-sm font-medium", hideLabel && "sr-only")}>
        {label}
      </label>
      {children({
        id,
        "aria-invalid": error ? true : undefined,
        "aria-describedby": error ? errorId : undefined,
      })}
      {error && (
        <p id={errorId} className="m-0 text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
