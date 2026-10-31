/**
 * What a run looks like, shared by every web feature that shows one (features may not import each
 * other): the run's model and transcript folds, the agent threads and their transcript, the task
 * graph, the status chip and link of a `Run`, and a visitor's keys. Unlike `@voluma/ui` this reads
 * the contracts. An app that renders it must let Tailwind scan this package
 * (`@source "<path to>/packages/run-view/src";`).
 */
export { AgentThread } from "./agent-thread";
export { Elapsed, THREAD_STATUS } from "./agents";
export { DisclosureProvider } from "./chat/disclosure-store";
export { Markdown } from "./chat/markdown";
export { ThreadNavigationProvider } from "./chat/thread-navigation";
export { ItemToCheck, type ItemToCheckProps } from "./item-to-check";
export { KeysForm, loadKeys, RunKeyLine } from "./keys";
export {
  type AgentNode,
  agentLabel,
  agentTree,
  haltOf,
  type NeedItem,
  plainError,
  runView,
  type TaskView,
  type Thread,
} from "./run-model";
export {
  formatDuration,
  formatUsd,
  plural,
  type RunStatus,
  runHref,
  runStatus,
  scanLabel,
  shortDate,
  studyStatus,
} from "./run-status";
export {
  RunStoreProvider,
  useClosed,
  useEvents,
  useRunStore,
  useThreads,
} from "./run-store";
export {
  type GraphTask,
  type ScanGraphTask,
  type StudyGraphTask,
  TASK_STATUS,
  TaskGraph,
  type TaskGraphProps,
  taskStateWord,
} from "./task-graph";
export { applyFrame, type Live, noLive, type Settled, settle } from "./transcript";
export { useNow } from "./use-now";
