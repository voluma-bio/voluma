/**
 * What a run looks like, shared by every web feature that shows one (features may not import each
 * other): the run's model and transcript folds, the agent threads and their transcript, the task
 * graph, the status chip and link of a `Run`, and a visitor's keys. Unlike `@voluma/ui` this reads
 * the contracts. An app that renders it must let Tailwind input this package
 * (`@source "<path to>/packages/run-view/src";`).
 */
export { AgentThread } from "./agent-thread";
export { THREAD_STATUS } from "./agents";
export { ApprovalCard, type ApprovalCardProps, approvalWords } from "./approval-card";
export { DisclosureProvider } from "./chat/disclosure-store";
export { Markdown } from "./chat/markdown";
export { ThreadNavigationProvider } from "./chat/thread-navigation";
export { TaskInfo } from "./info";
export { ItemToCheck, type ItemToCheckProps } from "./item-to-check";
export { KeysForm, loadKeys, RunKeyLine } from "./keys";
export {
  inViewOf,
  itemsOfVersion,
  type OutputItem,
  type OutputRow,
  type OutputsReview,
  openItemsOf,
  outputBlocks,
  outputName,
  outputsReview,
  reviewAssetsOf,
  shownOf,
  undrawn,
} from "./outputs-model";
export {
  type ChainLink,
  type GraphNode,
  madeFromIt,
  ROLE_WORD,
  type RunGraph,
  resolveLink,
  runGraph,
  type TrailRow,
  trailOf,
  versionWords,
  type Worker,
  workersOf,
} from "./outputs-trail";
export { plainError, stoppedText } from "./run-error";
export {
  type AgentNode,
  agentLabel,
  agentTree,
  CARD_TITLE,
  cardId,
  haltOf,
  type NeedItem,
  runModels,
  runView,
  runWork,
  type TaskState,
  type TaskView,
  type Thread,
  workedSeconds,
} from "./run-model";
export {
  formatDuration,
  formatUsd,
  inputHref,
  inputLabel,
  itemHref,
  liveStatus,
  plural,
  type RunStatus,
  runCost,
  runStatus,
  toCheckText,
  whenText,
} from "./run-status";
export {
  RunStoreProvider,
  useClosed,
  useEvents,
  useRunStore,
  useThreads,
} from "./run-store";
export { placeOfStatus, sampleTree } from "./samples";
export {
  groupNames,
  groupOf,
  inputStatus,
  isLive,
  kneeOf,
  needsYouOf,
  StudyPanel,
} from "./study-panel";
export {
  type GraphTask,
  type InputGraphTask,
  shownStatus,
  TASK_STATUS,
  TaskGraph,
  type TaskGraphProps,
  taskStateWord,
} from "./task-graph";
export { applyFrame, type Live, noLive, type Settled, settle } from "./transcript";
export { useNow } from "./use-now";
