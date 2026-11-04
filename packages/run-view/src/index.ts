/**
 * What a run looks like, shared by every web feature that shows one (features may not import each
 * other): the outputs review's model and trail, the run's events (`RunStoreProvider`), the status
 * chip and link of a `Run`, the study panel, and a visitor's keys. Unlike `@voluma/ui` this reads
 * the contracts. An app that renders it must let Tailwind input this package
 * (`@source "<path to>/packages/run-view/src";`).
 */

export { AgentThread } from "./agent-thread";
export { type AgentEntry, agentEntries, defaultAgent } from "./agent-threads";
export { ApprovalCard, type ApprovalCardProps, approvalWords } from "./approval-card";
export { Markdown } from "./chat/markdown";
export { ItemToCheck, type ItemToCheckProps } from "./item-to-check";
export { KeysForm, keysToReopen, loadKeys, RunKeyLine } from "./keys";
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
  rowsToCheck,
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
  formatDuration,
  formatUsd,
  inputHref,
  inputLabel,
  liveStatus,
  plural,
  type RunStatus,
  runCost,
  runStatus,
  runWork,
  toCheckText,
  whenText,
} from "./run-status";
export { RunStoreProvider, useEvents, useRunStore } from "./run-store";
export { placeOfStatus, sampleTree } from "./samples";
export {
  groupNames,
  groupOf,
  inputStatus,
  isLive,
  kneeOf,
  needsYouOf,
} from "./study-inputs";
export type { AgentLinks } from "./transcript-view";
export { useNow } from "./use-now";
