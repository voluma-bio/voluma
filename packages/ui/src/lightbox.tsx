/**
 * Full-window view of one piece of evidence (a QC image, a slice capture)
 * with a caption. Built on the native <dialog>, which supplies the focus
 * trap, Escape to close and the top layer. Clicking outside the figure closes it.
 */
import { type ReactNode, useEffect, useRef } from "react";
import { cx } from "./cx";

export type LightboxProps = {
  open: boolean;
  onClose: () => void;
  /** The media to show, e.g. an <img> with alt text. */
  children: ReactNode;
  caption?: ReactNode;
  className?: string;
};

export function Lightbox({ open, onClose, children, caption, className }: LightboxProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape already closes a modal <dialog>; the click is the pointer-only backdrop dismissal.
    <dialog
      ref={dialogRef}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      className={cx(
        "m-0 h-dvh max-h-none w-dvw max-w-none bg-scrim p-6 text-foreground backdrop:bg-transparent",
        "open:grid open:place-items-center",
        className,
      )}
    >
      <figure className="m-0 grid max-w-[min(1400px,100%)] gap-2.5">
        <div className="overflow-hidden rounded-lg [&_img]:max-h-[calc(100dvh-120px)] [&_img]:max-w-full [&_img]:object-contain">
          {children}
        </div>
        <figcaption className="flex items-center justify-between gap-3 text-ui text-muted-foreground">
          <span>{caption}</span>
          <button
            type="button"
            onClick={onClose}
            className="cursor-pointer rounded-md px-2 py-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            Close
          </button>
        </figcaption>
      </figure>
    </dialog>
  );
}
