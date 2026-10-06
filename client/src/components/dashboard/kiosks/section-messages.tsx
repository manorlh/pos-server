'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown, ChevronLeft, Plus, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import {
  KIOSK_LIMITS,
  MESSAGE_KINDS,
  MESSAGE_SCREENS,
  MESSAGE_STYLES,
  moveItem,
  nextMessageId,
  type KioskMessage,
  type MessageKind,
  type MessageScreen,
  type MessageStyle,
} from '@/lib/kioskConfig';
import { useKioskEditor, useKioskField } from './editor-context';
import { ChipToggles, FieldErrors, FieldShell, MediaInput, MoveButtons, OptionSelect, SectionCard, Segmented } from './fields';

const NO_PRODUCT = '__none__';

/** ISO → the value of a datetime-local input, in the browser's zone. */
function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInput(v: string): string | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** The dot colour of a message style, as the kiosk tints it. */
export const STYLE_TONE: Record<MessageStyle, string> = {
  info: 'bg-sky-500',
  promo: 'bg-fuchsia-500',
  warning: 'bg-amber-500',
  success: 'bg-emerald-500',
};

const DEFAULT_SCREENS: Record<MessageKind, MessageScreen[]> = {
  banner: ['attract', 'catalog'],
  notice: ['catalog'],
  closed: ['paused'],
};

function MessageEditor({
  message,
  index,
  onChange,
}: {
  message: KioskMessage;
  index: number;
  onChange: (next: KioskMessage) => void;
}) {
  const t = useTranslations('kiosks.messages');
  const ed = useKioskEditor();
  const disabled = !ed.canEdit;
  const products = ed.catalog?.products ?? [];
  const p = `messages.${index}`;
  const patch = (x: Partial<KioskMessage>) => onChange({ ...message, ...x });

  return (
    <div className="space-y-4 border-t p-3 animate-in fade-in slide-in-from-top-1 duration-200">
      <div className="space-y-1.5">
        <span className="text-sm font-medium">{t('fieldKind')}</span>
        <Segmented<MessageKind>
          value={message.kind}
          disabled={disabled}
          ariaLabel={t('fieldKind')}
          options={MESSAGE_KINDS.map((k) => ({ value: k, label: t(`kind.${k}`) }))}
          onChange={(kind) => patch({ kind, productId: kind === 'banner' ? message.productId : null })}
        />
        <p className="text-xs text-muted-foreground">{t(`kindHint.${message.kind}`)}</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1">
          <span className="text-sm font-medium">{t('fieldTitle')}</span>
          <Input value={message.title} disabled={disabled} maxLength={KIOSK_LIMITS.messageTitleMax + 20} onChange={(e) => patch({ title: e.target.value })} />
          <FieldErrors path={`${p}.title`} />
        </label>
        <div className="space-y-1">
          <span className="text-sm font-medium">{t('fieldStyle')}</span>
          <Segmented<MessageStyle>
            value={message.style}
            disabled={disabled}
            ariaLabel={t('fieldStyle')}
            options={MESSAGE_STYLES.map((s) => ({
              value: s,
              label: (
                <span className="inline-flex items-center gap-1.5">
                  <span className={cn('h-2 w-2 rounded-full', STYLE_TONE[s])} />
                  {t(`style.${s}`)}
                </span>
              ),
            }))}
            onChange={(style) => patch({ style })}
          />
        </div>
      </div>
      <label className="block space-y-1">
        <span className="text-sm font-medium">{t('fieldBody')}</span>
        <textarea
          className="min-h-16 w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
          value={message.body}
          disabled={disabled}
          onChange={(e) => patch({ body: e.target.value })}
        />
        <div className="flex justify-between">
          <FieldErrors path={`${p}.body`} />
          <span className="text-[11px] text-muted-foreground tabular-nums">
            {message.body.length}/{KIOSK_LIMITS.messageBodyMax}
          </span>
        </div>
      </label>
      <div className="space-y-1.5">
        <span className="text-sm font-medium">{t('fieldScreens')}</span>
        <ChipToggles<MessageScreen>
          value={message.screens}
          disabled={disabled}
          options={MESSAGE_SCREENS.map((s) => ({ value: s, label: t(`screen.${s}`) }))}
          onChange={(screens) => patch({ screens })}
        />
        <FieldErrors path={`${p}.screens`} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <span className="text-sm font-medium">{t('fieldImage')}</span>
          <MediaInput value={message.image} disabled={disabled} thumbClassName="h-16 w-28" onChange={(image) => patch({ image })} />
        </div>
        {message.kind === 'banner' ? (
          <div className="space-y-1">
            <span className="text-sm font-medium">{t('fieldProduct')}</span>
            <OptionSelect
              value={message.productId ?? NO_PRODUCT}
              disabled={disabled}
              ariaLabel={t('fieldProduct')}
              options={[
                { value: NO_PRODUCT, label: t('noProduct') },
                ...(message.productId && !products.some((x) => x.id === message.productId)
                  ? [{ value: message.productId, label: t('unknownProduct') }]
                  : []),
                ...products.map((x) => ({ value: x.id, label: x.name })),
              ]}
              onChange={(v) => patch({ productId: v === NO_PRODUCT ? null : v })}
            />
            <p className="text-xs text-muted-foreground">{t('productHint')}</p>
          </div>
        ) : null}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1">
          <span className="text-sm font-medium">{t('fieldStarts')}</span>
          <Input
            type="datetime-local"
            dir="ltr"
            disabled={disabled}
            value={toLocalInput(message.startsAt)}
            onChange={(e) => patch({ startsAt: fromLocalInput(e.target.value) })}
          />
          <FieldErrors path={`${p}.startsAt`} />
        </label>
        <label className="space-y-1">
          <span className="text-sm font-medium">{t('fieldEnds')}</span>
          <Input
            type="datetime-local"
            dir="ltr"
            disabled={disabled}
            value={toLocalInput(message.endsAt)}
            onChange={(e) => patch({ endsAt: fromLocalInput(e.target.value) })}
          />
          <FieldErrors path={`${p}.endsAt`} />
        </label>
      </div>
      <p className="text-xs text-muted-foreground">{t('datesHint')}</p>
    </div>
  );
}

/** Where a message stands against its dates right now. */
function windowState(m: KioskMessage, nowMs: number): 'scheduled' | 'expired' | null {
  if (m.startsAt && Date.parse(m.startsAt) > nowMs) return 'scheduled';
  if (m.endsAt && Date.parse(m.endsAt) <= nowMs) return 'expired';
  return null;
}

export function MessagesSection({ nowMs }: { nowMs: number }) {
  const t = useTranslations('kiosks.messages');
  const tf = useTranslations('kiosks.fields');
  const ed = useKioskEditor();
  const f = useKioskField<KioskMessage[]>('messages');
  const list = Array.isArray(f.value) ? f.value : [];
  const [open, setOpen] = useState<string | null>(null);
  const full = list.length >= KIOSK_LIMITS.messagesMax;

  const add = () => {
    const id = nextMessageId(list);
    const kind: MessageKind = 'banner';
    f.set([
      ...list,
      {
        id,
        kind,
        enabled: true,
        title: '',
        body: '',
        image: null,
        screens: DEFAULT_SCREENS[kind],
        style: 'promo',
        productId: null,
        startsAt: null,
        endsAt: null,
      },
    ]);
    setOpen(id);
    ed.showScreen('attract');
  };

  return (
    <SectionCard
      title={t('title')}
      description={t('hint')}
      paths={['messages']}
      action={
        <Button type="button" size="sm" disabled={f.disabled || full} onClick={add}>
          <Plus /> {t('add')}
        </Button>
      }
    >
      <FieldShell path="messages" label={tf('messages')}>
        {list.length === 0 ? (
          <p className="rounded-xl border border-dashed p-4 text-center text-sm text-muted-foreground">{t('empty')}</p>
        ) : (
          <ol className="space-y-2">
            {list.map((m, i) => {
              const expanded = open === m.id;
              const state = windowState(m, nowMs);
              return (
                <li key={m.id} className={cn('rounded-2xl border bg-card transition-all duration-200', !m.enabled && 'opacity-70')}>
                  <div className="flex items-center gap-2 p-2">
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      aria-expanded={expanded}
                      aria-label={t('edit')}
                      onClick={() => {
                        setOpen(expanded ? null : m.id);
                        const first = m.screens[0];
                        if (!expanded && first) ed.showScreen(first === 'paused' ? 'paused' : first);
                      }}
                    >
                      {expanded ? <ChevronDown /> : <ChevronLeft />}
                    </Button>
                    <span className={cn('h-2.5 w-2.5 shrink-0 rounded-full', STYLE_TONE[m.style])} aria-hidden />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="truncate font-medium">{m.title || t('untitled')}</span>
                        <Badge variant="outline">{t(`kind.${m.kind}`)}</Badge>
                        {state ? <Badge variant="secondary">{t(state)}</Badge> : null}
                      </div>
                      <span className="text-xs text-muted-foreground">
                        {m.screens.map((s) => t(`screen.${s}`)).join(' · ')}
                      </span>
                    </div>
                    <Switch
                      checked={m.enabled}
                      disabled={f.disabled}
                      aria-label={t('enabled')}
                      onCheckedChange={(v) => f.set(list.map((x, j) => (j === i ? { ...x, enabled: !!v } : x)))}
                    />
                    <MoveButtons index={i} count={list.length} disabled={f.disabled} onMove={(d) => f.set(moveItem(list, i, d))} />
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      className="text-destructive"
                      aria-label={t('remove')}
                      disabled={f.disabled}
                      onClick={() => {
                        if (window.confirm(t('removeConfirm', { title: m.title || t('untitled') }))) {
                          f.set(list.filter((_, j) => j !== i));
                        }
                      }}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                  <FieldErrors path={`messages.${i}.id`} />
                  {expanded ? (
                    <MessageEditor message={m} index={i} onChange={(next) => f.set(list.map((x, j) => (j === i ? next : x)))} />
                  ) : null}
                </li>
              );
            })}
          </ol>
        )}
      </FieldShell>
    </SectionCard>
  );
}
