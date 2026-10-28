/** Button with the mockups' three looks: primary (pine fill), quiet (outlined) and ghost. */
import type { ButtonHTMLAttributes } from "react";
import { cx } from "./cx";

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "quiet" | "ghost";
  /** `md` is the workflow screens' 36px button; `sm` is the review's denser 32px one. */
  size?: "md" | "sm";
};

const variants = {
  primary: "bg-primary text-primary-foreground hover:bg-primary-strong",
  quiet: "border border-border bg-card text-foreground hover:bg-accent",
  ghost: "text-muted-foreground hover:bg-accent hover:text-foreground",
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
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        "disabled:pointer-events-none disabled:opacity-50",
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    />
  );
}
