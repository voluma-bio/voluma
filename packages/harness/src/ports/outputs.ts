/**
 * The Outputs port: the run's `/outputs` as a whole, which a correction may overwrite and an
 * unfinished one must put back (`outputs-backup.ts`). Copies stay inside storage: an adapter
 * moves no file bytes through the host.
 */
export interface Outputs {
  /** Copies every file of the run's outputs to the backup of `reopenId`, replacing a partial earlier copy. */
  backup(runId: string, reopenId: string, signal: AbortSignal): Promise<void>;
  /** Makes the run's outputs exactly the backup of `reopenId`: clears them, then copies it back. Safe to repeat. */
  restore(runId: string, reopenId: string, signal: AbortSignal): Promise<void>;
  /** Deletes the backup of `reopenId`. Safe to repeat. */
  discard(runId: string, reopenId: string, signal: AbortSignal): Promise<void>;
  /** Whether the outputs file `path` of `taskId` holds the bytes with this sha256. */
  holds(
    runId: string,
    taskId: string,
    path: string,
    sha256: string,
    signal: AbortSignal,
  ): Promise<boolean>;
}
