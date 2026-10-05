'use client';

/**
 * The two one-tap controls on a product, wherever it is edited (the product form, the
 * routing page's product rows):
 *
 * * "ללא בון" — no kitchen ticket for the item in any shop or printer. Switching it off
 *   sends the item back to its category.
 * * "אפס להגדרת המחלקה" — every product-level setting in every shop removed; the item
 *   follows its category again. Asks first when the item has settings in more than one shop.
 *
 * Both act at once (no separate save) and show what the item does now beside them.
 */

import { useTranslations } from 'next-intl';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  resetProductKitchen,
  setProductNoTicket,
  type ProductEffective,
  type ProductKitchenState,
  type ProductRoute,
} from '@/lib/kitchenPrintersApi';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';

type T = ReturnType<typeof useTranslations>;

/** "מודפס ב: מטבח חם, בר (לפי מחלקה)", "ללא בון (הגדרת פריט)"… — where the item prints in a shop now. */
export function effectiveText(t: T, effective: ProductEffective): string {
  const printers = effective.printerNames.join(', ');
  switch (effective.source) {
    case 'no_ticket':
      return t('status.noTicket');
    case 'product_none':
      return t('status.noneHere');
    case 'product':
      return printers ? t('status.product', { printers }) : t('status.productNoPrinter');
    default:
      return printers ? t('status.category', { printers }) : t('status.categoryNone');
  }
}

/** The same, from a product-wide state with no shop chosen. */
export function productWideText(t: T, state: Pick<ProductKitchenState, 'noTicket' | 'overrideShops'>): string {
  if (state.noTicket) return t('status.noTicket');
  if (state.overrideShops.length > 0) {
    return t('status.overrides', {
      count: state.overrideShops.length,
      shops: state.overrideShops.map((s) => s.shopName ?? '?').join(', '),
    });
  }
  return t('status.byCategory');
}

/** A routing-page row: its setting in this shop, or "ללא בון" on the product. */
export function routeRowText(t: T, row: ProductRoute, printerName: (id: string) => string): string {
  if (row.mode === 'no_ticket') return t('status.noTicket');
  if (row.mode === 'none') return t('status.noneHere');
  const printers = row.printerIds.map(printerName).join(', ');
  return printers ? t('status.product', { printers }) : t('status.productNoPrinter');
}

export function ProductKitchenControls({
  productId,
  shopId,
  noTicket,
  overrideShopCount,
  canEdit,
  status,
  onChanged,
  compact = false,
}: {
  productId: string;
  /** The shop whose part the answer should carry (the form's), if any. */
  shopId?: string | null;
  noTicket: boolean;
  overrideShopCount: number;
  canEdit: boolean;
  /** What the item does now, in words. */
  status: string;
  onChanged: (state: ProductKitchenState) => void;
  compact?: boolean;
}) {
  const t = useTranslations('kitchenPrinters.productWide');
  const tc = useTranslations('common');

  const toggle = useMutation({
    mutationFn: (on: boolean) => setProductNoTicket(productId, on, shopId),
    onSuccess: (state) => {
      onChanged(state);
      toast.success(state.noTicket ? t('noTicketOn') : t('noTicketOff'));
    },
    onError: (err: unknown) => {
      const e = err as { response?: { status?: number } };
      toast.error(e?.response?.status === 403 ? t('notAllowed') : axiosErrorToToastMessage(err, tc('error')));
    },
  });

  const reset = useMutation({
    mutationFn: () => resetProductKitchen(productId, shopId),
    onSuccess: (state) => {
      onChanged(state);
      toast.success(t('resetDone'));
    },
    onError: (err: unknown) => {
      const e = err as { response?: { status?: number } };
      toast.error(e?.response?.status === 403 ? t('notAllowed') : axiosErrorToToastMessage(err, tc('error')));
    },
  });

  const busy = toggle.isPending || reset.isPending;
  const hasSettings = noTicket || overrideShopCount > 0;

  const askReset = () => {
    if (overrideShopCount > 1 && !window.confirm(t('resetConfirm', { count: overrideShopCount }))) return;
    reset.mutate();
  };

  return (
    <div className={compact ? 'space-y-1.5' : 'space-y-2'}>
      <div className="text-sm font-medium" dir="auto">
        {status}
      </div>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <label className="flex items-center gap-2 text-sm">
          <Switch
            checked={noTicket}
            disabled={!canEdit || busy}
            onCheckedChange={(on) => toggle.mutate(on)}
            aria-label={t('noTicket')}
          />
          <span>
            <span className="font-medium">{t('noTicket')}</span>
            {!compact && <span className="block text-xs text-muted-foreground">{t('noTicketHint')}</span>}
          </span>
        </label>
        <Button size="sm" variant="outline" disabled={!canEdit || busy || !hasSettings} onClick={askReset}>
          {t('reset')}
        </Button>
      </div>
      {!canEdit && <p className="text-xs text-muted-foreground">{t('readOnly')}</p>}
    </div>
  );
}
