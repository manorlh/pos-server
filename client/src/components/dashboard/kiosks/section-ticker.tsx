'use client';

/**
 * "כיתוב רץ" in the kiosk settings ("הודעות"): the switch, the texts (order, on / off, days, hours,
 * dates), the screens, where it sits, its speed, colours and size, and pause on touch — with the
 * strip itself as a live sample. The kiosk preview beside shows it in place.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown, ChevronLeft, Plus, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DateTimePicker, TimeInput } from '@/components/ui/date-picker';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import {
  KIOSK_LIMITS,
  TICKER_SCREENS,
  moveItem,
  nextTickerItemId,
  resolveThemeColors,
  tickerColors,
  tickerItemLive,
  toggleInList,
  type KioskTickerItem,
  type TickerPosition,
  type TickerScreen,
  type TickerSize,
  type TickerSpeed,
} from '@/lib/kioskConfig';
import { useKioskEditor, useKioskField } from './editor-context';
import { ChipToggles, ColorField, FieldErrors, FieldShell, MoveButtons, SectionCard, SegmentField, SwitchField } from './fields';
import { KioskTickerStrip } from './preview-ticker';

const DAYS = [0, 1, 2, 3, 4, 5, 6];

/** ISO → a datetime-local input's value, in the browser's zone. */
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

function TickerItemSchedule({ item, index, onChange, disabled }: { item: KioskTickerItem; index: number; onChange: (next: KioskTickerItem) => void; disabled: boolean }) {
  const t = useTranslations('kiosks.ticker');
  const tt = useTranslations('kiosks.timers');
  const p = `ticker.items.${index}`;
  const patch = (x: Partial<KioskTickerItem>) => onChange({ ...item, ...x });
  return (
    <div className="space-y-3 border-t p-3 animate-in fade-in slide-in-from-top-1 duration-200">
      <div className="space-y-1.5">
        <span className="text-sm font-medium">{t('days')}</span>
        <div className="flex flex-wrap items-center gap-1.5">
          {DAYS.map((d) => {
            const on = item.days.includes(d);
            return (
              <button
                key={d}
                type="button"
                aria-pressed={on}
                disabled={disabled}
                onClick={() => patch({ days: toggleInList(item.days, d).sort((a, b) => a - b) })}
                className={cn(
                  'h-8 w-8 rounded-full border text-sm transition-colors duration-150 disabled:opacity-50',
                  on ? 'border-primary bg-primary text-primary-foreground' : 'hover:bg-muted',
                )}
              >
                {tt(`day.${d}`)}
              </button>
            );
          })}
        </div>
        <FieldErrors path={`${p}.days`} />
      </div>
      <div className="flex flex-wrap items-end gap-3 text-sm">
        <label className="space-y-1">
          <span className="block font-medium">{t('from')}</span>
          <TimeInput dir="ltr" className="w-28" value={item.from ?? ''} disabled={disabled} onChange={(e) => patch({ from: e.target.value || null })} />
        </label>
        <label className="space-y-1">
          <span className="block font-medium">{t('to')}</span>
          <TimeInput dir="ltr" className="w-28" value={item.to ?? ''} disabled={disabled} onChange={(e) => patch({ to: e.target.value || null })} />
        </label>
        {item.from || item.to ? (
          <Button type="button" size="xs" variant="ghost" disabled={disabled} onClick={() => patch({ from: null, to: null })}>
            {t('allDay')}
          </Button>
        ) : (
          <span className="pb-2 text-xs text-muted-foreground">{t('allDay')}</span>
        )}
        {item.from && item.to && item.to < item.from ? <span className="pb-2 text-xs text-muted-foreground">{t('pastMidnight')}</span> : null}
      </div>
      <FieldErrors path={`${p}.from`} />
      <FieldErrors path={`${p}.to`} />
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1">
          <span className="text-sm font-medium">{t('startsAt')}</span>
          <DateTimePicker dir="ltr" disabled={disabled} value={toLocalInput(item.startsAt)} onChange={(e) => patch({ startsAt: fromLocalInput(e.target.value) })} />
          <FieldErrors path={`${p}.startsAt`} />
        </label>
        <label className="space-y-1">
          <span className="text-sm font-medium">{t('endsAt')}</span>
          <DateTimePicker dir="ltr" disabled={disabled} value={toLocalInput(item.endsAt)} onChange={(e) => patch({ endsAt: fromLocalInput(e.target.value) })} />
          <FieldErrors path={`${p}.endsAt`} />
        </label>
      </div>
      <p className="text-xs text-muted-foreground">{t('scheduleHint')}</p>
    </div>
  );
}

function TickerTexts({ nowMs }: { nowMs: number }) {
  const t = useTranslations('kiosks.ticker');
  const ed = useKioskEditor();
  const f = useKioskField<KioskTickerItem[]>('ticker.items');
  const list = Array.isArray(f.value) ? f.value : [];
  const [open, setOpen] = useState<string | null>(null);
  const full = list.length >= KIOSK_LIMITS.tickerItemsMax;
  const now = new Date(nowMs);
  const setAt = (i: number, next: KioskTickerItem) => f.set(list.map((x, j) => (j === i ? next : x)));

  const add = () => {
    const id = nextTickerItemId(list);
    f.set([...list, { id, text: '', enabled: true, from: null, to: null, days: [...DAYS], startsAt: null, endsAt: null }]);
    ed.showScreen('catalog');
  };

  return (
    <FieldShell path="ticker.items" label={t('texts')} hint={t('textsHint')}>
      <div className="space-y-2">
        {list.length === 0 ? <p className="rounded-xl border border-dashed p-4 text-center text-sm text-muted-foreground">{t('empty')}</p> : null}
        <ol className="space-y-2">
          {list.map((item, i) => {
            const expanded = open === item.id;
            const resting = item.enabled && item.text.trim() !== '' && !tickerItemLive(item, now);
            const scheduled = !!(item.from || item.to || item.startsAt || item.endsAt || item.days.length < 7);
            return (
              <li key={item.id} className={cn('rounded-2xl border bg-card transition-all duration-200', !item.enabled && 'opacity-70')}>
                <div className="flex items-center gap-2 p-2">
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    aria-expanded={expanded}
                    aria-label={t('schedule')}
                    title={t('schedule')}
                    onClick={() => setOpen(expanded ? null : item.id)}
                  >
                    {expanded ? <ChevronDown /> : <ChevronLeft />}
                  </Button>
                  <Input
                    value={item.text}
                    disabled={f.disabled}
                    dir="auto"
                    maxLength={KIOSK_LIMITS.tickerTextMax + 20}
                    placeholder={t('textPlaceholder')}
                    aria-label={t('texts')}
                    className="min-w-0 flex-1"
                    onChange={(e) => setAt(i, { ...item, text: e.target.value })}
                  />
                  {scheduled ? <Badge variant="outline">{t('schedule')}</Badge> : null}
                  {resting ? <Badge variant="secondary">{t('notNow')}</Badge> : null}
                  <Switch
                    checked={item.enabled}
                    disabled={f.disabled}
                    aria-label={t('itemEnabled')}
                    onCheckedChange={(v) => setAt(i, { ...item, enabled: !!v })}
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
                      if (item.text.trim() === '' || window.confirm(t('removeConfirm', { text: item.text.trim() }))) {
                        f.set(list.filter((_, j) => j !== i));
                      }
                    }}
                  >
                    <Trash2 />
                  </Button>
                </div>
                <div className="px-3 pb-1">
                  <FieldErrors path={`ticker.items.${i}.text`} />
                  <FieldErrors path={`ticker.items.${i}.id`} />
                </div>
                {expanded ? <TickerItemSchedule item={item} index={i} disabled={f.disabled} onChange={(next) => setAt(i, next)} /> : null}
              </li>
            );
          })}
        </ol>
        <Button type="button" size="sm" variant="outline" disabled={f.disabled || full} onClick={add}>
          <Plus /> {t('add')}
        </Button>
      </div>
    </FieldShell>
  );
}

/** The strip as the kiosk paints it, with every text that is on (whatever its hours). */
function TickerSample() {
  const t = useTranslations('kiosks.ticker');
  const ed = useKioskEditor();
  const tk = ed.draft.ticker;
  if (!tk) return null;
  const texts = (tk.items ?? []).filter((x) => x.enabled && x.text.trim() !== '').map((x) => x.text.trim());
  const { bg, fg } = tickerColors(tk, resolveThemeColors(ed.draft.theme));
  return (
    <div className="space-y-1.5">
      <span className="text-sm font-medium">{t('preview')}</span>
      <div className="overflow-hidden rounded-xl border">
        <KioskTickerStrip
          texts={texts.length > 0 ? texts : [t('previewSample')]}
          speed={tk.speed}
          size={tk.size}
          bg={bg}
          fg={fg}
          still={ed.draft.general.reduceMotion}
          pauseOnTouch={tk.pauseOnTouch}
          label={t('title')}
        />
      </div>
      <p className="text-xs text-muted-foreground">{t('reduceMotionHint')}</p>
    </div>
  );
}

export function TickerSection({ nowMs }: { nowMs: number }) {
  const t = useTranslations('kiosks.ticker');
  const ed = useKioskEditor();
  const enabled = useKioskField<boolean>('ticker.enabled');
  const screens = useKioskField<TickerScreen[]>('ticker.screens');
  const theme = resolveThemeColors(ed.draft.theme);
  if (!ed.draft.ticker) return null;
  return (
    <SectionCard title={t('title')} description={t('hint')} paths={['ticker']}>
      <SwitchField path="ticker.enabled" label={t('enabled')} hint={t('enabledHint')} />
      {enabled.value ? (
        <>
          <TickerSample />
          <TickerTexts nowMs={nowMs} />
          <FieldShell path="ticker.screens" label={t('screens')} hint={t('screensHint')}>
            <ChipToggles<TickerScreen>
              value={Array.isArray(screens.value) ? screens.value : []}
              disabled={screens.disabled}
              options={TICKER_SCREENS.map((s) => ({ value: s, label: t(`screen.${s}`) }))}
              onChange={(next) => {
                screens.set(next);
                const added = next.find((s) => !(screens.value ?? []).includes(s));
                if (added) ed.showScreen(added);
              }}
            />
          </FieldShell>
          <SegmentField<TickerPosition>
            path="ticker.position"
            label={t('position')}
            options={[
              { value: 'top', label: t('positionTop') },
              { value: 'bottom', label: t('positionBottom') },
            ]}
          />
          <SegmentField<TickerSpeed>
            path="ticker.speed"
            label={t('speed')}
            hint={t('speedHint')}
            options={[
              { value: 'slow', label: t('speedSlow') },
              { value: 'normal', label: t('speedNormal') },
              { value: 'fast', label: t('speedFast') },
            ]}
          />
          <SegmentField<TickerSize>
            path="ticker.size"
            label={t('size')}
            options={[
              { value: 's', label: t('sizeS') },
              { value: 'm', label: t('sizeM') },
              { value: 'l', label: t('sizeL') },
            ]}
          />
          <div className="grid gap-4 lg:grid-cols-2">
            <ColorField path="ticker.backgroundColor" label={t('background')} nullable nullLabel={t('fromTheme')} fallback={theme.button} />
            <ColorField path="ticker.textColor" label={t('textColor')} nullable nullLabel={t('fromTheme')} fallback={theme.buttonText} />
          </div>
          <SwitchField path="ticker.pauseOnTouch" label={t('pauseOnTouch')} hint={t('pauseOnTouchHint')} />
        </>
      ) : null}
    </SectionCard>
  );
}
