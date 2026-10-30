/**
 * Stories only: a stand-in for StatusMark (built in parallel) so rows show a status. Delete it
 * and use StatusMark in the stories once that lands.
 */
import { CircleCheck, CircleDashed, Diamond, LoaderCircle, OctagonX } from "lucide-react";
import { cx } from "./cx";

const looks = {
  done: { Icon: CircleCheck, word: "Done", ink: "text-done" },
  check: { Icon: Diamond, word: "To check", ink: "text-check" },
  running: { Icon: LoaderCircle, word: "Running", ink: "text-info" },
  waiting: { Icon: CircleDashed, word: "Waiting", ink: "text-muted-foreground" },
  stopped: { Icon: OctagonX, word: "Stopped", ink: "text-destructive" },
};

export function PlaceholderStatus({ state, word }: { state: keyof typeof looks; word?: string }) {
  const { Icon, word: fallback, ink } = looks[state];
  return (
    <span className={cx("inline-flex items-center gap-1.5 text-sm", ink)}>
      <Icon aria-hidden className="size-3.5" />
      {word ?? fallback}
    </span>
  );
}
