'use client';

/**
 * "סניף לא פעיל" (P:/specs/shop-code-and-inactive.md §3, lib/shopActive.ts).
 *
 * * `ShopActiveSwitch` — the "סניף פעיל" switch of the shop's edit form: shown to everyone,
 *   enabled for the super admin only. Flipping it asks for confirmation and a reason ("להפוך
 *   את הסניף ללא פעיל? כל הקופות, הקיוסקים והמסכים בסניף יינעלו") and saves at once
 *   (`PUT /shops/{id}` with `isActive` and `activeReason`) — never with the form's details.
 *   Under it, the latest change from the log: who, when, why.
 * * `ShopInactiveBadge` — "לא פעיל" wherever the shop is listed, and in its header.
 * * `ShopInactiveStripe` — across the top of the shop's page: its devices are locked, its
 *   reports stay visible.
 *
 * All three render the shop's own state; the devices lock and unlock on the server's signal.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Lock } from 'lucide-react';
import { api } from '@/lib/api';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { formatDateTime } from '@/lib/format';
import {
  lastShopActiveChange,
  SHOP_ACTIVE_REASON_MAX,
  shopActiveConfirmKind,
  shopActivePayload,
  shopActiveReasonError,
  type ShopActiveStatus,
} from '@/lib/shopActive';
import type { Shop } from '@/lib/types';
import { useIsSuperAdmin } from '@/components/dashboard/license-fields';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

export function ShopActiveSwitch({
  shop,
  onChanged,
}: {
  shop: Pick<Shop, 'id' | 'isActive'>;
  onChanged?: (saved: Shop) => void;
}) {
  const t = useTranslations('shopActive');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const isSuperAdmin = useIsSuperAdmin();
  const [active, setActive] = useState(shop.isActive !== false);
  // The state being confirmed (the switch's new position), or null while no confirmation is open.
  const [pending, setPending] = useState<boolean | null>(null);
  const [reason, setReason] = useState('');
  const [reasonTouched, setReasonTouched] = useState(false);

  const status = useQuery<ShopActiveStatus>({
    queryKey: ['shop-active', shop.id],
    queryFn: () => api.get<ShopActiveStatus>(`/shops/${shop.id}/active-log`).then((r) => r.data),
  });
  const last = lastShopActiveChange(status.data);

  const save = useMutation({
    mutationFn: async (next: boolean) =>
      (await api.put<Shop>(`/shops/${shop.id}`, shopActivePayload(next, reason))).data,
    onSuccess: (saved) => {
      setActive(saved.isActive !== false);
      setPending(null);
      setReason('');
      setReasonTouched(false);
      qc.invalidateQueries({ queryKey: ['shops'] });
      qc.invalidateQueries({ queryKey: ['shop-active', shop.id] });
      toast.success(saved.isActive === false ? t('turnedOff') : t('turnedOn'));
      onChanged?.(saved);
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, tc('error'))),
  });

  const reasonError = shopActiveReasonError(reason);
  const kind = pending === null ? null : shopActiveConfirmKind(pending);

  return (
    <div className="space-y-1.5 rounded-md border p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <Label htmlFor="shop-active" className={cn(isSuperAdmin && 'cursor-pointer')}>
            {t('label')}
          </Label>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {isSuperAdmin ? t('hint') : t('superAdminOnly')}
          </p>
        </div>
        <Switch
          id="shop-active"
          checked={active}
          disabled={!isSuperAdmin || save.isPending}
          onCheckedChange={(next) => {
            setReason('');
            setReasonTouched(false);
            setPending(next);
          }}
        />
      </div>
      {last ? (
        <p className="text-xs text-muted-foreground">
          {last.active
            ? t('lastOn', {
                name: last.userName ?? '—',
                at: last.at ? formatDateTime(last.at) : '—',
                reason: last.reason ?? '—',
              })
            : t('lastOff', {
                name: last.userName ?? '—',
                at: last.at ? formatDateTime(last.at) : '—',
                reason: last.reason ?? '—',
              })}
        </p>
      ) : null}

      <Dialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open && !save.isPending) setPending(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="leading-snug">
              {kind === 'on' ? t('confirmOnTitle') : t('confirmOffTitle')}
            </DialogTitle>
            <DialogDescription>{kind === 'on' ? t('confirmOnDesc') : t('confirmOffDesc')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-1">
            <Label htmlFor="shop-active-reason">
              {t('reason')} <span className="text-destructive">*</span>
            </Label>
            <textarea
              id="shop-active-reason"
              className="border-input bg-background min-h-20 w-full rounded-md border px-3 py-2 text-sm font-normal"
              value={reason}
              maxLength={SHOP_ACTIVE_REASON_MAX}
              placeholder={t('reasonPlaceholder')}
              aria-invalid={reasonError !== null && reasonTouched}
              onChange={(e) => {
                setReasonTouched(true);
                setReason(e.target.value);
              }}
            />
            {reasonError && reasonTouched ? (
              <p className="text-destructive text-xs font-normal">{t('reasonRequired')}</p>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPending(null)} disabled={save.isPending}>
              {tc('cancel')}
            </Button>
            <Button
              variant={kind === 'off' ? 'destructive' : 'default'}
              disabled={save.isPending || reasonError !== null}
              onClick={() => {
                setReasonTouched(true);
                if (pending !== null && reasonError === null) save.mutate(pending);
              }}
            >
              {kind === 'on' ? t('confirmOn') : t('confirmOff')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function ShopInactiveBadge({
  shop,
  className,
}: {
  shop: { isActive?: boolean } | null | undefined;
  className?: string;
}) {
  const t = useTranslations('shopActive');
  if (!shop || shop.isActive !== false) return null;
  return (
    <span
      title={t('badgeHint')}
      className={cn(
        'inline-flex h-5 w-fit shrink-0 items-center gap-1 rounded-full bg-destructive px-2 text-xs font-medium whitespace-nowrap text-white',
        className,
      )}
    >
      <Lock className="h-3 w-3" aria-hidden />
      {t('badge')}
    </span>
  );
}

export function ShopInactiveStripe({
  shop,
  className,
}: {
  shop: { isActive?: boolean } | null | undefined;
  className?: string;
}) {
  const t = useTranslations('shopActive');
  if (!shop || shop.isActive !== false) return null;
  return (
    <div
      role="status"
      className={cn(
        'flex w-full items-center gap-2 rounded-md bg-destructive px-4 py-2 text-sm font-medium text-white shadow-sm',
        className,
      )}
    >
      <Lock className="h-4 w-4 shrink-0" aria-hidden />
      <span>{t('stripe')}</span>
    </div>
  );
}
