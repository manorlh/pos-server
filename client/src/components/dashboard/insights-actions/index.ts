/**
 * The insights' actions, for the cockpit and the pages (docs/SPEC_INSIGHTS.md §10):
 * self-contained sheets (`{ scope, context?, onDone }`), the attention-feed hook, the board's
 * block and tabs.
 */
export { QuickMessageSheet, type QuickMessageSheetProps } from './quick-message-sheet';
export { QuickPromoSheet, type QuickPromoSheetProps } from './quick-promo-sheet';
export { HappyHourSheet, type HappyHourSheetProps } from './happy-hour-sheet';
export { useAnomalyItems, useAnomalyFeed, type AttentionItem } from './use-anomaly-items';
export { useActionSheets, type SheetKind } from './action-host';
export { BoardInsightsBlock } from './board-block';
export { BoardTabs, type BoardTab } from './board-tabs';
export type { ActionContext, ActionScope, ActionSheetProps, AttentionAction } from '@/lib/insightsActions';
