/** What both event reads (the browser's stream and the runner's read) share: the cursor and the page size. */
import { HTTPException } from "hono/http-exception";

/** Events per page, for the stream and the runner's read (`@voluma/contracts/events`). */
export const EVENTS_PAGE = 1000;

/** The `after` cursor: absent means 0 (from the start), else a `seq`. */
export function afterParam(raw: string | undefined): number {
  if (raw === undefined) return 0;
  if (!/^\d{1,9}$/.test(raw)) throw new HTTPException(400, { message: "bad cursor" });
  return Number(raw);
}
