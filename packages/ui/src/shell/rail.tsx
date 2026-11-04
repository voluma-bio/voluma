/** The single global navigation: a labelled vertical rail, with account controls at its foot. */
import type { ComponentProps, ReactNode } from "react";
import { cx } from "../cx";

export type RailProps = {
  children: ReactNode;
  /** The non-interactive brand mark at the top of the sidebar. */
  brand: ReactNode;
  /** Settings and Account controls at the foot. */
  end?: ReactNode;
};

export function Rail({ children, brand, end }: RailProps) {
  return (
    <nav
      aria-label="Global navigation"
      className="relative z-20 flex w-20 shrink-0 flex-col items-center gap-1 border-r border-border bg-muted py-2"
    >
      <div className="mb-1 grid min-h-14 w-full shrink-0 place-items-center">{brand}</div>
      {children}
      <span className="flex-1" />
      {end}
    </nav>
  );
}

export type RailLinkRenderProps = {
  className: string;
  children: ReactNode;
  "aria-label": string;
  "aria-current"?: "page";
};

export type RailLinkProps = {
  label: string;
  icon: ReactNode;
  active?: boolean;
  /** A URL, or your router's native link rendered with the props given. */
  to: string | ((props: RailLinkRenderProps) => ReactNode);
};

const itemClassName =
  "relative flex min-h-14 w-18 shrink-0 cursor-pointer flex-col items-center justify-center gap-1 rounded-md px-1 py-2 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-5";
const idleClassName = "text-muted-foreground hover:bg-accent hover:text-foreground";

export function RailLink({ label, icon, active = false, to }: RailLinkProps) {
  const props: RailLinkRenderProps = {
    className: cx(
      itemClassName,
      active
        ? "bg-secondary text-foreground before:absolute before:top-1.5 before:bottom-1.5 before:-left-1 before:w-0.5 before:rounded-r-sm before:bg-foreground"
        : idleClassName,
    ),
    children: (
      <>
        <span aria-hidden>{icon}</span>
        <span>{label}</span>
      </>
    ),
    "aria-label": label,
    "aria-current": active ? "page" : undefined,
  };
  return typeof to === "string" ? <a href={to} {...props} /> : to(props);
}

export type RailButtonProps = Omit<ComponentProps<"button">, "children"> & {
  label: string;
  icon: ReactNode;
};

/** A named action in the rail, sharing the links' size, label and focus treatment. */
export function RailButton({ label, icon, className, ...props }: RailButtonProps) {
  return (
    <button
      type="button"
      className={cx(
        itemClassName,
        idleClassName,
        "aria-expanded:bg-secondary aria-expanded:text-foreground",
        className,
      )}
      {...props}
    >
      <span aria-hidden>{icon}</span>
      <span>{label}</span>
    </button>
  );
}
