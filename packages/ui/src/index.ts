/**
 * Shared React components taken from the mockups' generic parts, styled only
 * through design-token utilities. An app that renders them must let Tailwind
 * scan this package: `@source "<path to>/packages/ui/src";` in its CSS entry.
 */
export { Button, type ButtonProps, buttonClass } from "./button";
export { Card, type CardProps } from "./card";
export {
  ChatComposer,
  type ChatComposerProps,
  ChatMessage,
  type ChatMessageProps,
  ChatThread,
} from "./chat-thread";
export { cx } from "./cx";
export { Lightbox, type LightboxProps } from "./lightbox";
export { SplitPanel, type SplitPanelProps } from "./split-panel";
export { StatusBadge, type StatusBadgeProps, type StatusTone } from "./status-badge";
export {
  type StripGroup,
  StripPlot,
  type StripPlotProps,
  type StripPoint,
} from "./strip-plot";
export { Table, type TableColumn, type TableProps } from "./table";
export { type TabItem, Tabs, type TabsProps, tabId } from "./tabs";
