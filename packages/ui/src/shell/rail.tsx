/**
 * The rail: the app's places in a 44 px column at the far left of every screen, under the header
 * line (Studies and Workflows at the top, Settings at the foot). Places are icons only: each is
 * named by its tooltip and its accessible name. The place you are in is pressed, with a bar at the
 * rail's edge. A primary `RailButton` (a guest's Sign in) shows its label under the icon.
 */
import type { ComponentProps, ReactElement, ReactNode } from "react";
import { cx } from "../cx";
import { Tooltip } from "../tooltip";

export type RailProps = {
  /** The mark at the top, linking home. */
  home: ReactNode;
  /** The places (`RailLink`). */
  children: ReactNode;
  /** At the foot: a guest's Sign in, then Settings (`RailButton`s). */
  end?: ReactNode;
};

export function Rail({ home, children, end }: RailProps) {
  return (
    <nav
      data-shell-edge
      aria-label="App"
      className="relative z-20 flex w-11 shrink-0 flex-col items-center gap-1 border-r border-border bg-muted py-2"
    >
      <div className="mb-2.5 grid size-6 place-items-center">{home}</div>
      {children}
      <span className="flex-1" />
      {end}
    </nav>
  );
}

const itemClass = (active: boolean) =>
  cx(
    "relative grid size-8 shrink-0 cursor-pointer place-items-center rounded-md outline-none [&_svg]:size-[18px]",
    "focus-visible:ring-2 focus-visible:ring-ring",
    active
      ? "bg-secondary text-foreground before:absolute before:top-1.5 before:bottom-1.5 before:-left-1.5 before:w-0.5 before:rounded-r-sm before:bg-foreground"
      : "text-muted-foreground hover:bg-accent hover:text-foreground",
  );

/** Props to spread on your router's link: they carry the item's look and name. */
export type RailLinkRenderProps = {
  className: string;
  children: ReactNode;
  "aria-label": string;
  "aria-current"?: "page";
};

export type RailLinkProps = {
  label: string;
  icon: ReactNode;
  /** This place is the one shown. */
  active?: boolean;
  /** A URL, or your router's link rendered with the props given. */
  to: string | ((props: RailLinkRenderProps) => ReactNode);
};

/** A place on the rail. */
export function RailLink({ label, icon, active = false, to }: RailLinkProps) {
  const props: RailLinkRenderProps = {
    className: itemClass(active),
    children: icon,
    "aria-label": label,
    "aria-current": active ? "page" : undefined,
  };
  return (
    <Tooltip label={label} side="right">
      {typeof to === "string" ? <a href={to} {...props} /> : (to(props) as ReactElement)}
    </Tooltip>
  );
}

export type RailButtonProps = Omit<ComponentProps<"button">, "children" | "aria-label"> & {
  label: string;
  icon: ReactNode;
  active?: boolean;
  /** Primary: filled, with the label shown under the icon, for the one action the rail asks for. */
  variant?: "default" | "primary";
};

/** A rail item that acts in place: Settings' popover trigger, a guest's Sign in. */
export function RailButton({
  label,
  icon,
  active = false,
  variant = "default",
  className,
  ...props
}: RailButtonProps) {
  if (variant === "primary")
    return (
      <button
        type="button"
        className={cx(
          "mb-1 grid w-10 shrink-0 cursor-pointer place-items-center gap-0.5 rounded-md bg-primary px-0.5 py-1.5 text-primary-foreground outline-none hover:bg-primary-strong [&_svg]:size-4",
          "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-muted",
          className,
        )}
        {...props}
      >
        {icon}
        <span className="text-[11px] font-medium leading-none whitespace-nowrap">{label}</span>
      </button>
    );
  return (
    <Tooltip label={label} side="right">
      <button
        type="button"
        aria-label={label}
        className={cx(itemClass(active), className)}
        {...props}
      >
        {icon}
      </button>
    </Tooltip>
  );
}
