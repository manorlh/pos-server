/**
 * The insights' actions, for the cockpit and the pages (docs/SPEC_INSIGHTS.md §10):
 * self-contained sheets (`{ scope, context?, onDone }`), the attention-feed hook, the board's
 * block and tabs.
 */
export { QuickMessageSheet, type QuickMessageSheetProps } from './quick-message-sheet';
/** The promotion sheet: "מבצע מהיר | Happy hour" (Happy hour is its second mode, not a sheet of its own). */
export { QuickPromoSheet, type PromoMode, type QuickPromoSheetProps } from './quick-promo-sheet';
export { useAnomalyItems, useAnomalyFeed, type AttentionItem } from './use-anomaly-items';
export { useActionSheets, type SheetKind } from './action-host';
export { BoardInsightsBlock } from './board-block';
export { BoardTabs, type BoardTab } from './board-tabs';
export type { ActionContext, ActionScope, ActionSheetProps, AttentionAction } from '@/lib/insightsActions';
