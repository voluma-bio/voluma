/** What a page hands the check panel. */

/** One stop in the queue: a check of a run's task, or the whole task when `checkId` is absent. */
export type CheckItem = { runId: string; taskId: string; checkId?: string };

export type CheckPanelProps = {
  items: CheckItem[];
  /** The index of the item to open first. */
  start: number;
  onClose: () => void;
  /** After "Looks right" saved, so the page can refresh what it shows. */
  onAccepted?: (item: CheckItem) => void;
  /** After a message or a cancel from the chat changed a run's state (the panel has its own cache). */
  onRunChanged?: (runId: string) => void;
};
