/**
 * The insights' actions, for the cockpit and the pages (docs/SPEC_INSIGHTS.md §10):
 * self-contained sheets (`{ scope, context?, onDone }`) and the attention-feed hook. On the home
 * page they live in the cockpit (components/dashboard/cockpit: the quick actions and the
 * "דורש תשומת לב" feed); the insights page uses its own sections.
 */
export { QuickMessageSheet, type QuickMessageSheetProps } from './quick-message-sheet';
/** The promotion sheet: "מבצע מהיר | Happy hour" (Happy hour is its second mode, not a sheet of its own). */
export { QuickPromoSheet, type PromoMode, type QuickPromoSheetProps } from './quick-promo-sheet';
export { useAnomalyItems, useAnomalyFeed, type AttentionItem } from './use-anomaly-items';
export { useActionSheets, type SheetKind } from './action-host';
export type { ActionContext, ActionScope, ActionSheetProps, AttentionAction } from '@/lib/insightsActions';
