/**
 * Button in four looks: primary (ink fill, one per view), secondary (raised, outlined), ghost
 * (bare until hovered; `aria-pressed` shows it on) and link (underlined text that sits in a
 * sentence). `asChild` gives the look to its one child instead, e.g. a router `Link` or a Radix
 * trigger. `IconButton` is the square, icon-only form, named by its tooltip.
 */
import { Slot } from "radix-ui";
import { type ButtonHTMLAttributes, type ReactNode, useId } from "react";
import { cx } from "./cx";
import { Tooltip } from "./tooltip";

type Look = {
  variant?: "primary" | "secondary" | "ghost" | "link";
  /** `md` is 30 px, `sm` 24 px for dense rows and panel heads. */
  size?: "md" | "sm";
};

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> &
  Look & {
    /** Why the button is disabled, shown beside it while it is. */
    reason?: ReactNode;
    /** Render the one child (a link, a trigger) with this look instead of a `<button>`. */
    asChild?: boolean;
  };

// Hover only while enabled (`not-disabled`, so a link given the look still gets it).
const variants = {
  primary:
    "bg-primary text-primary-foreground not-disabled:hover:bg-primary-strong disabled:bg-secondary disabled:text-fg-subtle",
  secondary:
    "border border-border bg-secondary text-foreground not-disabled:hover:border-line-strong not-disabled:hover:bg-accent not-disabled:active:bg-border disabled:bg-transparent disabled:text-fg-subtle",
  ghost:
    "text-muted-foreground not-disabled:hover:bg-secondary not-disabled:hover:text-foreground aria-pressed:bg-secondary aria-pressed:text-foreground aria-pressed:shadow-[inset_0_0_0_1px_var(--line-strong)] disabled:text-fg-subtle",
};

const sizes = {
  md: "h-7.5 gap-1.5 text-base",
  sm: "h-6 gap-1 text-sm",
};

const focus = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

// A link takes the size of the sentence it sits in.
const linkLook = cx(
  "inline-flex cursor-pointer items-center gap-1 rounded-sm font-medium text-primary-text underline decoration-primary-text/40 underline-offset-2 not-disabled:hover:decoration-current",
  "disabled:cursor-default disabled:text-fg-subtle disabled:no-underline [&_svg]:size-3.5 [&_svg]:shrink-0",
  focus,
);

function buttonClass({
  variant = "secondary",
  size = "md",
  square = false,
  className,
}: Look & { square?: boolean; className?: string }) {
  if (variant === "link") return cx(linkLook, className);
  return cx(
    "inline-flex shrink-0 cursor-pointer items-center justify-center rounded-md font-medium whitespace-nowrap transition-colors duration-100 ease-out",
    "disabled:cursor-default [&_svg]:size-3.5 [&_svg]:shrink-0",
    focus,
    variants[variant],
    sizes[size],
    // Ghost buttons sit closer to their neighbours; icon-only ones are square.
    square
      ? size === "sm"
        ? "w-6"
        : "w-7.5"
      : variant === "ghost" || size === "sm"
        ? "px-2"
        : "px-3",
    className,
  );
}

export function Button({
  variant,
  size,
  reason,
  asChild = false,
  type = "button",
  className,
  ...props
}: ButtonProps) {
  const reasonId = useId();
  const look = buttonClass({ variant, size, className });
  const button = asChild ? (
    <Slot.Root className={look} {...props} />
  ) : (
    <button
      type={type}
      aria-describedby={props.disabled && reason ? reasonId : undefined}
      className={look}
      {...props}
    />
  );
  if (!props.disabled || !reason) return button;
  return (
    <span className="inline-flex items-center gap-2">
      {button}
      <span id={reasonId} className="text-sm text-muted-foreground">
        {reason}
      </span>
    </span>
  );
}

export type IconButtonProps = Omit<
  ButtonProps,
  "children" | "reason" | "asChild" | "aria-label"
> & {
  /** The icon, e.g. a lucide icon. */
  children: ReactNode;
  /** What the button does: its accessible name and its tooltip. */
  label: string;
  /** The key that does the same, shown in the tooltip. */
  shortcut?: string;
};

export function IconButton({
  label,
  shortcut,
  variant = "ghost",
  size,
  type = "button",
  className,
  ...props
}: IconButtonProps) {
  return (
    <Tooltip label={label} shortcut={shortcut}>
      <button
        type={type}
        aria-label={label}
        className={buttonClass({ variant, size, square: true, className })}
        {...props}
      />
    </Tooltip>
  );
}
