'use client';

/**
 * "מסך איסוף ציבורי": a page for a TV browser, no login — numbers in preparation and
 * ready only (no names, phones or notes). Reached by an opaque token; replacing the
 * token breaks the old link (pos-server SPEC_KDS.md §8).
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Copy, ExternalLink, RefreshCw, TriangleAlert, Tv } from 'lucide-react';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { pickupScreenUrl, rotatePickupToken, type KdsShopOverview } from '@/lib/kdsApi';
import { cn } from '@/lib/utils';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export function PickupSection({ shopId, overview }: { shopId: string; overview: KdsShopOverview }) {
  const t = useTranslations('kds.page.pickup');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const [copied, setCopied] = useState(false);
  const token = overview.pickupToken;
  const url = token ? pickupScreenUrl(token) : null;

  const rotate = useMutation({
    mutationFn: () => rotatePickupToken(shopId),
    onSuccess: (pickupToken) => {
      toast.success(t('created'));
      qc.setQueryData<KdsShopOverview>(['kds-shop', shopId], (prev) => (prev ? { ...prev, pickupToken } : prev));
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, tc('error'))),
  });

  const copy = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      toast.success(t('copied'));
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error(t('copyFailed'));
    }
  };

  return (
    <section className="space-y-3 rounded-lg border bg-card p-4">
      <div className="flex items-center gap-2">
        <Tv className="h-5 w-5 text-muted-foreground" aria-hidden />
        <h2 className="text-lg font-semibold">{t('title')}</h2>
      </div>
      <p className="text-sm text-muted-foreground">{t('hint')}</p>

      {url ? (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-2">
            <Input
              readOnly
              value={url}
              dir="ltr"
              className="h-10 min-w-0 flex-1 font-mono text-xs"
              aria-label={t('title')}
              onFocus={(e) => e.currentTarget.select()}
            />
            <Button variant="outline" className="h-10" onClick={() => void copy()}>
              <Copy className="h-4 w-4" /> {copied ? t('copiedShort') : t('copy')}
            </Button>
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className={cn(buttonVariants({ variant: 'outline' }), 'h-10')}
            >
              <ExternalLink className="h-4 w-4" /> {t('open')}
            </a>
          </div>
          {overview.canEdit ? (
            <div className="flex flex-wrap items-center gap-3">
              <Button
                variant="outline"
                className="h-10"
                disabled={rotate.isPending}
                onClick={() => {
                  if (window.confirm(t('rotateConfirm'))) rotate.mutate();
                }}
              >
                <RefreshCw className="h-4 w-4" /> {t('rotate')}
              </Button>
              <span className="flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-300">
                <TriangleAlert className="h-3.5 w-3.5" aria-hidden />
                {t('rotateWarning')}
              </span>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm text-muted-foreground">{t('none')}</span>
          {overview.canEdit ? (
            <Button className="h-10" disabled={rotate.isPending} onClick={() => rotate.mutate()}>
              {t('create')}
            </Button>
          ) : null}
        </div>
      )}
    </section>
  );
}
