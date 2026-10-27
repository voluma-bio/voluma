/**
 * Pure functions over a workflow package (a Mars schema v1 package with a
 * workflow.md): read and validate one, build the task dependency graph, and
 * find which tasks go stale when one changes. No I/O; callers pass the
 * package's files in, whether fetched from GitHub or bundled.
 */
export {};
