'use client';

/**
 * "WhatsApp Business API" (optional, off by default): the official WhatsApp Cloud API — an
 * approved template message with the PDF as its document, statuses back by webhook. What is
 * missing is said in words; the company's settings (token and app secret write-only) in a dialog.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Copy, Loader2, Send, Settings } from 'lucide-react';
import {
  fetchWhatsAppConfig,
  saveWhatsAppConfig,
  sendByApi,
  type DistributionOverview,
  type WhatsAppConfig,
  type WhatsAppConfigBody,
} from '@/lib/voucherDistributionApi';
import type { PrepaidVoucherBatch } from '@/lib/prepaidVouchersApi';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useDistributionError, useRefreshDistribution } from './shared';

const MASK = '••••••••';

function ConfigForm({ c, companyId, onSaved }: { c: WhatsAppConfig; companyId: string; onSaved: () => void }) {
  const t = useTranslations('voucherDistribution.api');
  const errorText = useDistributionError();
  // Initialised from what is stored; the dialog remounts this form (its `key`) after every save.
  const [form, setForm] = useState<WhatsAppConfigBody>(() => ({
    enabled: c.enabled, phoneNumberId: c.phoneNumberId ?? '', businessAccountId: c.businessAccountId ?? '',
    templateName: c.templateName ?? '', templateLanguage: c.templateLanguage, apiVersion: c.apiVersion ?? '',
    accessToken: c.accessTokenSet ? MASK : '', appSecret: c.appSecretSet ? MASK : '',
  }));
  const [params, setParams] = useState(c.bodyParams.join(', '));

  const save = useMutation({
    mutationFn: (extra: Partial<WhatsAppConfigBody>) =>
      saveWhatsAppConfig(companyId, {
        ...form,
        ...extra,
        bodyParams: params.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean),
      }),
    onSuccess: () => {
      toast.success(t('saved'));
      onSaved();
    },
    onError: (err) => toast.error(errorText(err)),
  });

  const field = (key: keyof WhatsAppConfigBody, label: string, opts: { secret?: boolean; hint?: string } = {}) => (
    <div className="space-y-1">
      <Label htmlFor={`wa-${key}`}>{label}</Label>
      <Input id={`wa-${key}`} dir="ltr" type={opts.secret ? 'password' : 'text'} autoComplete="off"
        value={(form[key] as string | undefined) ?? ''} onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))} />
      {opts.hint ? <p className="text-xs text-muted-foreground">{opts.hint}</p> : null}
    </div>
  );
  const copy = (v: string | null) => v && void navigator.clipboard.writeText(v).then(() => toast.success(t('copied')));

  return (
    <>
      <div className="space-y-3 text-sm">
        <p className="text-muted-foreground">{t('requirements')}</p>
        {!c.serverEnabled ? <p className="rounded-md bg-amber-100 p-2 text-amber-900 dark:bg-amber-950/40 dark:text-amber-300">{t('serverOff')}</p> : null}
        <div className="grid gap-3 sm:grid-cols-2">
          {field('phoneNumberId', t('phoneNumberId'))}
          {field('businessAccountId', t('businessAccountId'))}
          {field('templateName', t('templateName'), { hint: t('templateHint') })}
          {field('templateLanguage', t('templateLanguage'))}
          {field('accessToken', t('accessToken'), { secret: true, hint: c.accessTokenSet ? t('secretSet') : t('secretNotSet') })}
          {field('appSecret', t('appSecret'), { secret: true, hint: c.appSecretSet ? t('secretSet') : t('appSecretHint') })}
          {field('apiVersion', t('apiVersion'), { hint: t('apiVersionHint', { v: c.defaultApiVersion }) })}
          <div className="space-y-1">
            <Label htmlFor="wa-params">{t('bodyParams')}</Label>
            <Input id="wa-params" dir="ltr" value={params} onChange={(e) => setParams(e.target.value)} />
            <p className="text-xs text-muted-foreground">{t('bodyParamsHint', { keys: c.bodyParamKeys.join(', ') })}</p>
          </div>
        </div>
        <div className="space-y-1 rounded-md border p-2">
          <p className="font-medium">{t('webhook')}</p>
          <p className="text-xs text-muted-foreground">{t('webhookHint')}</p>
          <div className="flex items-center gap-2 text-xs">
            <code className="flex-1 truncate" dir="ltr">{c.webhookUrl ?? t('webhookAfterSave')}</code>
            {c.webhookUrl ? <Button size="sm" variant="ghost" onClick={() => copy(c.webhookUrl)} aria-label={t('copy')}><Copy aria-hidden /></Button> : null}
          </div>
          <div className="flex items-center gap-2 text-xs">
            <span>{t('verifyToken')}</span>
            <code className="flex-1 truncate" dir="ltr">{c.verifyToken ?? '—'}</code>
            {c.verifyToken ? <Button size="sm" variant="ghost" onClick={() => copy(c.verifyToken)} aria-label={t('copy')}><Copy aria-hidden /></Button> : null}
          </div>
        </div>
        <label className="flex items-center gap-2">
          <Switch checked={!!form.enabled} onCheckedChange={(v) => setForm((f) => ({ ...f, enabled: !!v }))} aria-label={t('enabled')} />
          {t('enabled')}
        </label>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={() => save.mutate({ regenerateVerifyToken: true })} disabled={save.isPending}>
          {t('newVerifyToken')}
        </Button>
        <Button onClick={() => save.mutate({})} disabled={save.isPending}>
          {save.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
          {t('save')}
        </Button>
      </DialogFooter>
    </>
  );
}

function ConfigDialog({ companyId, open, onOpenChange }: { companyId: string; open: boolean; onOpenChange: (v: boolean) => void }) {
  const t = useTranslations('voucherDistribution.api');
  const cfg = useQuery({ queryKey: ['whatsapp-config', companyId], queryFn: () => fetchWhatsAppConfig(companyId), enabled: open });
  const c = cfg.data;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92dvh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('settingsTitle')}</DialogTitle>
        </DialogHeader>
        {c ? (
          <ConfigForm key={`${c.updatedAt ?? 'new'}|${c.verifyToken ?? ''}`} c={c} companyId={companyId} onSaved={() => void cfg.refetch()} />
        ) : (
          <Loader2 className="mx-auto animate-spin" aria-hidden />
        )}
      </DialogContent>
    </Dialog>
  );
}

export function ApiPanel({ batch, overview }: { batch: PrepaidVoucherBatch; overview: DistributionOverview }) {
  const t = useTranslations('voucherDistribution.api');
  const errorText = useDistributionError();
  const refresh = useRefreshDistribution(batch.id);
  const [open, setOpen] = useState(false);
  const cap = overview.api;

  const send = useMutation({
    mutationFn: () => sendByApi(batch.id),
    onSuccess: (out) => {
      toast.success(t('sentResult', { queued: out.queued, accepted: out.accepted, retry: out.retry, failed: out.failed }));
      refresh();
    },
    onError: (err) => toast.error(errorText(err)),
  });

  const status = !cap.serverEnabled ? t('statusServerOff') : !cap.configured ? t('statusNotConfigured') : !cap.enabled ? t('statusDisabled') : t('statusReady');
  const pending = (overview.counts.pending ?? 0) + (overview.counts.failed ?? 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
        <p className="text-sm text-muted-foreground">{t('intro')}</p>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm">
          <span className="font-medium">{t('status')}: </span>
          {status}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => setOpen(true)}>
            <Settings aria-hidden /> {t('settings')}
          </Button>
          <Button disabled={!cap.ready || pending === 0 || send.isPending} onClick={() => {
            if (window.confirm(t('confirmSend', { n: pending }))) send.mutate();
          }}>
            {send.isPending ? <Loader2 className="animate-spin" aria-hidden /> : <Send aria-hidden />}
            {t('sendPending', { n: pending })}
          </Button>
        </div>
        <ConfigDialog companyId={batch.companyId} open={open} onOpenChange={setOpen} />
      </CardContent>
    </Card>
  );
}
