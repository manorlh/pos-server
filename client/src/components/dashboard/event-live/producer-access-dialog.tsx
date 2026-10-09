'use client';

/**
 * "עמדת מפיק" — the owner's tab on an event: invite the event's producer by e-mail (a read-only
 * account that sees this event only — its sales, its production's vouchers, and the settlement
 * when opened here), see who is invited and revoke, link the voucher batches of the production
 * and their production prices, and open the settlement. pos-server `/report-events/{id}/producers`.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Copy, Loader2, Ticket, UserMinus } from 'lucide-react';
import { eventErrorMessage } from '@/lib/eventsApi';
import { settingsBody, validEmail, validPrice, type ProducerOwnerView, type ProducerSettings } from '@/lib/producer';
import { fetchEventProducers, inviteProducer, revokeProducer, saveProducerSettings } from '@/lib/producerApi';
import { formatShortDateTime } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';

function SettingsForm({ eventId, view }: { eventId: string; view: ProducerOwnerView }) {
  const t = useTranslations('producer.owner');
  const qc = useQueryClient();
  const [draft, setDraft] = useState<ProducerSettings>(() => ({
    settlementEnabled: view.settings.settlementEnabled,
    batchIds: [...view.settings.batchIds],
    productionPrices: { ...view.settings.productionPrices },
  }));
  const save = useMutation({
    mutationFn: () => saveProducerSettings(eventId, settingsBody(draft)),
    onSuccess: (data) => {
      qc.setQueryData(['event-producers', eventId], (old: ProducerOwnerView | undefined) => ({ ...(old ?? data), ...data }));
      toast.success(t('saved'));
    },
    onError: (err) => toast.error(eventErrorMessage(err, t('saveFailed'))),
  });
  const pricesOk = Object.values(draft.productionPrices).every((p) => validPrice(p));
  return (
    <section className="space-y-3 rounded-2xl border p-4">
      <div className="flex items-center justify-between gap-3">
        <span>
          <span className="block font-semibold">{t('settlement')}</span>
          <span className="block text-xs text-muted-foreground">{t('settlementHint')}</span>
        </span>
        <Switch
          checked={draft.settlementEnabled}
          onCheckedChange={(v) => setDraft((d) => ({ ...d, settlementEnabled: v }))}
          aria-label={t('settlement')}
        />
      </div>
      <div className="space-y-1">
        <p className="font-semibold">{t('batches')}</p>
        <p className="text-xs text-muted-foreground">{t('batchesHint')}</p>
        {view.canSeeBatches === false ? <p className="text-sm text-muted-foreground">{t('batchesNoAccess')}</p> : null}
        {view.canSeeBatches !== false && view.batches.length === 0 ? <p className="text-sm text-muted-foreground">{t('noBatches')}</p> : null}
        <ul className="max-h-64 space-y-1 overflow-y-auto">
          {view.batches.map((b) => {
            const linked = b.auto || draft.batchIds.includes(b.id);
            return (
              <li key={b.id} className="flex flex-wrap items-center gap-2 rounded-xl border p-2 text-sm">
                <label className="flex min-w-0 flex-1 items-center gap-2">
                  <input
                    type="checkbox"
                    className="size-4 accent-[#007AFF]"
                    checked={linked}
                    disabled={b.auto || view.canEditBatches === false}
                    onChange={() =>
                      setDraft((d) => ({
                        ...d,
                        batchIds: d.batchIds.includes(b.id) ? d.batchIds.filter((x) => x !== b.id) : [...d.batchIds, b.id],
                      }))
                    }
                  />
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{b.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {[b.eventName, b.customerName, b.auto ? t('auto') : b.suggested ? t('suggested') : null].filter(Boolean).join(' · ')}
                    </span>
                  </span>
                </label>
                {linked ? (
                  <span className="flex items-center gap-1 text-xs">
                    {t('price')}
                    <Input
                      inputMode="decimal"
                      disabled={view.canEditBatches === false}
                      className="h-8 w-24"
                      value={String(draft.productionPrices[b.id] ?? (b.productionPrice ?? ''))}
                      aria-invalid={!validPrice(draft.productionPrices[b.id])}
                      onChange={(e) => setDraft((d) => ({ ...d, productionPrices: { ...d.productionPrices, [b.id]: e.target.value } }))}
                    />
                    ₪
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      </div>
      <div className="flex justify-end">
        <Button onClick={() => save.mutate()} disabled={save.isPending || !pricesOk}>
          {save.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
          {t('save')}
        </Button>
      </div>
    </section>
  );
}

export function ProducerAccessDialog({ eventId, open, onOpenChange }: { eventId: string; open: boolean; onOpenChange: (v: boolean) => void }) {
  const t = useTranslations('producer.owner');
  const qc = useQueryClient();
  const view = useQuery({ queryKey: ['event-producers', eventId], queryFn: () => fetchEventProducers(eventId), enabled: open });
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [sendInvite, setSendInvite] = useState(true);
  const [invitedLink, setLink] = useState<string | null>(null);
  const link = invitedLink ?? view.data?.inviteUrl ?? null;
  const invite = useMutation({
    mutationFn: () => inviteProducer(eventId, { email: email.trim(), name: name.trim() || null, sendInvite }),
    onSuccess: (data) => {
      qc.setQueryData(['event-producers', eventId], data);
      setLink(data.inviteUrl);
      setEmail('');
      setName('');
      toast.success(data.invitation === 'sent' ? t('invitedMail') : t('invited'));
    },
    onError: (err) => toast.error(eventErrorMessage(err, t('inviteFailed'))),
  });
  const revoke = useMutation({
    mutationFn: (grantId: string) => revokeProducer(eventId, grantId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['event-producers', eventId] }),
    onError: (err) => toast.error(eventErrorMessage(err, t('revokeFailed'))),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Ticket className="size-5" aria-hidden />
            {t('title')}
          </DialogTitle>
          <DialogDescription>{t('hint')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <form
            className="space-y-2 rounded-2xl border p-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (validEmail(email)) invite.mutate();
            }}
          >
            <p className="font-semibold">{t('invite')}</p>
            <div className="grid gap-2 sm:grid-cols-2">
              <Input type="email" placeholder={t('email')} value={email} onChange={(e) => setEmail(e.target.value)} aria-label={t('email')} />
              <Input placeholder={t('name')} value={name} onChange={(e) => setName(e.target.value)} aria-label={t('name')} />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="size-4 accent-[#007AFF]" checked={sendInvite} onChange={(e) => setSendInvite(e.target.checked)} />
              {t('sendInvite')}
            </label>
            <div className="flex justify-end">
              <Button type="submit" disabled={invite.isPending || !validEmail(email)}>
                {invite.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
                {t('inviteButton')}
              </Button>
            </div>
            {link ? (
              <div className="flex items-center gap-2 rounded-xl bg-muted/50 p-2 text-xs">
                <span className="min-w-0 flex-1 truncate" dir="ltr">{link}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    void navigator.clipboard?.writeText(link).then(() => toast.success(t('copied')));
                  }}
                >
                  <Copy className="size-4" aria-hidden />
                  {t('copy')}
                </Button>
              </div>
            ) : null}
            <p className="text-xs text-muted-foreground">{t('linkHint')}</p>
          </form>

          <section className="space-y-2">
            <p className="font-semibold">{t('invitedList')}</p>
            {view.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
            {(view.data?.grants ?? []).length === 0 && !view.isPending ? <p className="text-sm text-muted-foreground">{t('nobody')}</p> : null}
            <ul className="divide-y text-sm">
              {(view.data?.grants ?? []).map((g) => (
                <li key={g.id} className="flex items-center gap-2 py-2">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{g.name ? `${g.name} · ${g.email}` : g.email}</span>
                    <span className="block text-xs text-muted-foreground">
                      {!g.active ? t('revoked', { at: g.revokedAt ? formatShortDateTime(g.revokedAt) : '' }) : g.signedIn ? t('active') : t('pending')}
                    </span>
                  </span>
                  {g.active ? (
                    <Button variant="ghost" size="sm" disabled={revoke.isPending} onClick={() => revoke.mutate(g.id)}>
                      <UserMinus className="size-4 text-destructive" aria-hidden />
                      {t('revoke')}
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>

          {view.data ? <SettingsForm key={view.dataUpdatedAt} eventId={eventId} view={view.data} /> : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
