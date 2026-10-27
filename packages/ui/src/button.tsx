/** Button with the mockups' three looks: primary (pine fill), quiet (outlined) and ghost. */
import type { ButtonHTMLAttributes } from "react";
import { cx } from "./cx";

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "quiet" | "ghost";
  /** `md` is the workflow screens' 36px button; `sm` is the review's denser 32px one. */
  size?: "md" | "sm";
};

const variants = {
  primary: "bg-accent text-accent-fg hover:bg-accent-strong",
  quiet: "border border-line bg-surface text-fg hover:bg-raised",
  ghost: "text-fg-muted hover:bg-raised hover:text-fg",
};

const sizes = {
  md: "h-9 px-4 text-sm rounded-lg",
  sm: "h-8 px-3.5 text-ui rounded-lg",
};

export function Button({
  variant = "quiet",
  size = "md",
  type = "button",
  className,
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cx(
        "inline-flex cursor-pointer items-center justify-center gap-2 font-medium whitespace-nowrap transition-colors",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
        "disabled:pointer-events-none disabled:opacity-50",
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    />
  );
}
