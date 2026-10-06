'use client';

/**
 * QR sources: each is an opaque token in a sign-up link (a receipt, a till, a kiosk, a
 * poster…), optionally tied to a shop. The server resolves the club and shop from the
 * token alone, and counts the sign-ups per source. Deactivating one makes its link
 * show "הדף אינו זמין" — print a new one rather than reusing a token.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { QRCodeSVG } from 'qrcode.react';
import { Ban, Copy, ExternalLink, Plus } from 'lucide-react';
import {
  CLUB_SOURCE_KINDS,
  createClubSource,
  deactivateClubSource,
  type ClubOverview,
  type ClubSource,
  type ClubSourceKind,
} from '@/lib/clubApi';
import { companySubtreeIds } from '@/lib/companyTree';
import { sameId } from '@/lib/entityLookup';
import { useScope } from '@/lib/scope';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ConfirmDialog, NC, SimpleSelect, formatWhen, useNcErrorText } from '@/components/dashboard/notifications/shared';

function SourceCard({ source, onDeactivate }: { source: ClubSource; onDeactivate: (s: ClubSource) => void }) {
  const t = useTranslations(`${NC}.club.sources`);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(source.url);
      toast.success(t('copied'));
    } catch {
      toast.error(t('copyFailed'));
    }
  };
  return (
    <li className={cn('flex flex-col gap-3 rounded-xl border p-3 sm:flex-row', !source.isActive && 'opacity-60')}>
      <div className="flex shrink-0 justify-center rounded-lg bg-white p-2">
        <QRCodeSVG value={source.url} size={128} level="M" aria-label={t('qrFor', { label: source.label ?? '' })} />
      </div>
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{source.label || t(`kinds.${source.sourceKind}`)}</span>
          <Badge variant="secondary">{t.has(`kinds.${source.sourceKind}`) ? t(`kinds.${source.sourceKind}`) : source.sourceKind}</Badge>
          <Badge variant={source.isActive ? 'default' : 'outline'}>{source.isActive ? t('active') : t('inactive')}</Badge>
        </div>
        <p className="text-xs text-muted-foreground">
          {source.shopName ?? t('allShops')} · {t('signups', { count: source.signups })} · {formatWhen(source.createdAt)}
        </p>
        <p dir="ltr" className="truncate rounded bg-muted/50 px-2 py-1 text-start font-mono text-xs" title={source.url}>
          {source.url}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => void copy()}>
            <Copy aria-hidden />
            {t('copy')}
          </Button>
          <a
            href={source.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-7 items-center gap-1 rounded-lg px-2.5 text-[0.8rem] text-primary hover:bg-muted pointer-coarse:h-10"
          >
            <ExternalLink className="h-3.5 w-3.5" aria-hidden />
            {t('open')}
          </a>
          {source.isActive ? (
            <Button size="sm" variant="ghost" onClick={() => onDeactivate(source)}>
              <Ban aria-hidden />
              {t('deactivate')}
            </Button>
          ) : null}
        </div>
      </div>
    </li>
  );
}

export function SourcesTab({ companyId, data }: { companyId: string; data: ClubOverview }) {
  const t = useTranslations(`${NC}.club.sources`);
  const errorText = useNcErrorText();
  const qc = useQueryClient();
  const scope = useScope();
  const [label, setLabel] = useState('');
  const [kind, setKind] = useState<ClubSourceKind>('receipt');
  const [shopId, setShopId] = useState('');
  const [toDeactivate, setToDeactivate] = useState<ClubSource | null>(null);

  const companyIds = companySubtreeIds(scope.tree, companyId);
  const shops = scope.shops.filter((s) => companyIds.some((id) => sameId(id, s.companyId)));
  const sources = data.sources ?? [];

  const create = useMutation({
    mutationFn: () => createClubSource(companyId, { label: label.trim(), sourceKind: kind, shopId: shopId || null }),
    onSuccess: () => {
      setLabel('');
      toast.success(t('created'));
      void qc.invalidateQueries({ queryKey: ['club', companyId] });
    },
    onError: (err) => toast.error(errorText(err)),
  });
  const deactivate = useMutation({
    mutationFn: (id: string) => deactivateClubSource(id),
    onSuccess: () => {
      setToDeactivate(null);
      toast.success(t('deactivated'));
      void qc.invalidateQueries({ queryKey: ['club', companyId] });
    },
    onError: (err) => toast.error(errorText(err)),
  });

  return (
    <div className="max-w-4xl space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>{t('newTitle')}</CardTitle>
        </CardHeader>
        <CardContent>
          <form
            className="grid gap-3 sm:grid-cols-[1fr_10rem_12rem_auto] sm:items-end"
            onSubmit={(e) => {
              e.preventDefault();
              if (!create.isPending) create.mutate();
            }}
          >
            <div className="space-y-1">
              <Label htmlFor="src-label" className="text-xs">
                {t('label')}
              </Label>
              <Input id="src-label" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={120} placeholder={t('labelHint')} />
            </div>
            <SimpleSelect
              id="src-kind"
              label={t('kind')}
              value={kind}
              onChange={(v) => setKind(v as ClubSourceKind)}
              options={CLUB_SOURCE_KINDS.map((k) => ({ value: k, label: t(`kinds.${k}`) }))}
            />
            <SimpleSelect
              id="src-shop"
              label={t('shop')}
              value={shopId}
              onChange={setShopId}
              anyLabel={t('allShops')}
              options={shops.map((s) => ({ value: s.id, label: s.name }))}
            />
            <Button type="submit" disabled={create.isPending}>
              <Plus aria-hidden />
              {t('create')}
            </Button>
          </form>
          <p className="mt-2 text-xs text-muted-foreground">{t('newHint')}</p>
        </CardContent>
      </Card>

      {sources.length === 0 ? (
        <p className="rounded-lg border bg-muted/30 p-6 text-center text-sm text-muted-foreground">{t('empty')}</p>
      ) : (
        <ul className="grid gap-3 lg:grid-cols-2">
          {sources.map((s) => (
            <SourceCard key={s.id} source={s} onDeactivate={setToDeactivate} />
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={!!toDeactivate}
        onOpenChange={(open) => !open && setToDeactivate(null)}
        title={t('deactivateTitle')}
        description={t('deactivateHint')}
        confirmLabel={t('deactivate')}
        onConfirm={() => toDeactivate && deactivate.mutate(toDeactivate.id)}
        pending={deactivate.isPending}
      />
    </div>
  );
}
