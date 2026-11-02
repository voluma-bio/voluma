/**
 * Thumbnail: a small square picture of a sample. With no `src`, or while the picture is missing
 * (the server answers 204 until a run has one) or fails to load, a plain tile stands in, so a
 * list of samples keeps its rhythm. Decorative: the sample's name sits beside it. `mark` is a
 * small status mark on the corner.
 */
import { Image } from "lucide-react";
import { type ReactNode, useState } from "react";
import { cx } from "./cx";

export type ThumbnailProps = {
  src?: string;
  /** Side in px. */
  size?: number;
  mark?: ReactNode;
  className?: string;
};

export function Thumbnail({ src, size = 40, mark, className }: ThumbnailProps) {
  const [loaded, setLoaded] = useState<string>();
  const [failed, setFailed] = useState<string>();
  const shown = src !== undefined && failed !== src;
  return (
    <span
      aria-hidden
      style={{ width: size, height: size }}
      className={cx(
        "relative inline-grid shrink-0 place-items-center rounded-md bg-muted shadow-[inset_0_0_0_1px_var(--border)]",
        className,
      )}
    >
      {!shown && <Image className="size-1/2 text-fg-subtle opacity-60" strokeWidth={1.5} />}
      {shown && (
        <img
          src={src}
          alt=""
          loading="lazy"
          onLoad={() => setLoaded(src)}
          onError={() => setFailed(src)}
          className={cx(
            "absolute inset-0 size-full rounded-[inherit] object-cover motion-safe:transition-opacity",
            loaded === src ? "opacity-100" : "opacity-0",
          )}
        />
      )}
      {mark && (
        <span className="absolute -right-1 -bottom-1 grid place-items-center rounded-full bg-card p-px">
          {mark}
        </span>
      )}
    </span>
  );
}
