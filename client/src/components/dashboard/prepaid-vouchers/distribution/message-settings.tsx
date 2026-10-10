'use client';

/**
 * "ההודעה": the batch's message to a person and to a group send — editable, with placeholders
 * and a live preview (the server's own rule, `renderMessage`) — the PDF's layout and when the
 * personal links stop working.
 */

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { PLACEHOLDERS, renderMessage } from '@/lib/voucherDistribution';
import { updateDistribution, type DistributionOverview } from '@/lib/voucherDistributionApi';
import type { PrepaidVoucherBatch } from '@/lib/prepaidVouchersApi';
import { formatDate, isoDate } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useDistributionError, useRefreshDistribution } from './shared';

/** `yyyy-mm-dd` of an ISO date, local; '' when none. */
function dayValue(iso: string | null): string {
  if (!iso || !isoDate(iso)) return '';
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function TemplateField({
  id, label, value, onChange, sample,
}: { id: string; label: string; value: string; onChange: (v: string) => void; sample: Parameters<typeof renderMessage>[1] }) {
  const t = useTranslations('voucherDistribution.message');
  const ref = useRef<HTMLTextAreaElement>(null);
  const insert = (token: string) => {
    const el = ref.current;
    if (!el) {
      onChange(value + token);
      return;
    }
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? value.length;
    onChange(value.slice(0, start) + token + value.slice(end));
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  };
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <textarea id={id} ref={ref} dir="auto" rows={5} value={value} onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-md border bg-background px-2 py-1.5 text-sm" />
      <div className="flex flex-wrap gap-1">
        {PLACEHOLDERS.map((p) => (
          <button key={p.token} type="button" onClick={() => insert(p.token)}
            className="rounded-full border px-2 py-0.5 text-xs hover:bg-muted" title={t(`placeholder.${p.key}`)}>
            {p.token} <span className="text-muted-foreground">{t(`placeholder.${p.key}`)}</span>
          </button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">{t('preview')}</p>
      <pre className="whitespace-pre-wrap rounded-md border bg-muted/40 p-2 font-sans text-sm" dir="auto">{renderMessage(value, sample)}</pre>
    </div>
  );
}

export function MessageSettings({ batch, overview }: { batch: PrepaidVoucherBatch; overview: DistributionOverview }) {
  const t = useTranslations('voucherDistribution.message');
  const tl = useTranslations('voucherDistribution.layout');
  const errorText = useDistributionError();
  const refresh = useRefreshDistribution(batch.id);

  // Initialised from what is stored; the parent remounts this card (its `key`) when that changes.
  const [message, setMessage] = useState(overview.messageTemplate ?? overview.defaultMessageTemplate);
  const [groupMessage, setGroupMessage] = useState(overview.groupMessageTemplate ?? overview.defaultGroupMessageTemplate);
  const [layout, setLayout] = useState(overview.layout);
  const [expiry, setExpiry] = useState(dayValue(overview.linkExpiresAt));

  const event = batch.eventName || batch.name;
  const sample = {
    name: t('sampleName'), event, count: 2, serials: '0001-0002', group: 3,
    link: `${overview.linkBase}/api/v1/public/vouchers/…`,
    validUntil: batch.validUntil ? formatDate(batch.validUntil) : '',
  };

  const save = useMutation({
    mutationFn: () => {
      const [y, m, d] = expiry.split('-').map(Number);
      const linkExpiresAt = expiry && y && m && d ? new Date(y, m - 1, d, 23, 59, 59).toISOString() : null;
      return updateDistribution(batch.id, {
        // The default text is stored as "no text of its own", so a better default reaches it later.
        messageTemplate: message.trim() === overview.defaultMessageTemplate.trim() ? null : message,
        groupMessageTemplate: groupMessage.trim() === overview.defaultGroupMessageTemplate.trim() ? null : groupMessage,
        layout,
        linkExpiresAt,
      });
    },
    onSuccess: () => {
      toast.success(t('saved'));
      refresh();
    },
    onError: (err) => toast.error(errorText(err)),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
        <p className="text-sm text-muted-foreground">{t('intro')}</p>
      </CardHeader>
      <CardContent className="space-y-4">
        <TemplateField id="vd-msg" label={t('person')} value={message} onChange={setMessage} sample={sample} />
        {overview.grouped ? (
          <TemplateField id="vd-gmsg" label={t('group')} value={groupMessage} onChange={setGroupMessage} sample={{ ...sample, name: '' }} />
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="vd-layout">{tl('label')}</Label>
            <select id="vd-layout" value={layout} onChange={(e) => setLayout(e.target.value)}
              className="h-8 w-full rounded-md border bg-background px-2 text-sm">
              {overview.layouts.map((l) => <option key={l} value={l}>{tl.has(l) ? tl(l) : l}</option>)}
            </select>
            <p className="text-xs text-muted-foreground">{tl('hint')}</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="vd-expiry">{t('expiry')}</Label>
            {/* A past date would kill every link at once (the server refuses it too). */}
            <Input id="vd-expiry" type="date" value={expiry} min={dayValue(new Date().toISOString())}
              onChange={(e) => setExpiry(e.target.value)} />
            <p className="text-xs text-muted-foreground">
              {t('expiryHint', { date: formatDate(overview.defaultLinkExpiresAt) })}
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
            {t('save')}
          </Button>
          <Button variant="ghost" onClick={() => { setMessage(overview.defaultMessageTemplate); setGroupMessage(overview.defaultGroupMessageTemplate); }}>
            {t('reset')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
