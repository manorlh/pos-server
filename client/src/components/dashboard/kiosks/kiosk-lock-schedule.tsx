'use client';

/**
 * "נעילה למכירה" and "פתיחה אוטומטית" from the dashboard (docs/SPEC_KIOSK.md §15) — the same
 * commands a controlling till sends (`POST /kiosks/{id}/commands`, audited): lock now (until
 * reopened by hand, HH:MM today, N minutes, or the next automatic opening) and the kiosk's
 * daily automatic opening, with an optional closing time and the automatic Z after it. The
 * schedule is written to the kiosk's own settings level, so the settings editor shows it too.
 */

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { CalendarClock, Lock, Play } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { TimeInput } from '@/components/ui/date-picker';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { formatDateTime } from '@/lib/format';
import {
  KIOSK_LOCK_MODES,
  kioskScheduleIssues,
  scheduleFormAutoClose,
  scheduleFormHours,
  scheduleFormOf,
  toggleInList,
  type KioskLockMode,
  type KioskScheduleForm,
} from '@/lib/kioskConfig';
import type { KioskCommandIn, KioskSummary } from '@/lib/kioskApi';

const DAYS = [0, 1, 2, 3, 4, 5, 6];

export function KioskLockControls({
  kiosk,
  canWrite,
  busy,
  send,
}: {
  kiosk: KioskSummary;
  canWrite: boolean;
  busy: boolean;
  send: (body: KioskCommandIn) => void;
}) {
  const t = useTranslations('kiosks.lock');
  const [message, setMessage] = useState('');
  const [mode, setMode] = useState<KioskLockMode>('manual');
  const [untilTime, setUntilTime] = useState('');
  const [minutes, setMinutes] = useState(30);
  const hasSchedule = !!kiosk.schedule?.enabled;

  if (kiosk.paused) {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-xl bg-amber-50 p-3 dark:bg-amber-950/30">
        <div className="min-w-0 flex-1 text-sm">
          <div className="flex items-center gap-1.5 font-medium">
            <Lock className="h-4 w-4" /> {t('locked')}
          </div>
          <div className="text-xs text-muted-foreground">{t('lockedBy', { by: kiosk.pausedBy ?? '—', when: formatDateTime(kiosk.pausedAt) })}</div>
          <div className="text-xs text-muted-foreground">
            {kiosk.pausedUntil ? t(kiosk.pausedMode === 'next_open' ? 'untilOpening' : 'until', { when: formatDateTime(kiosk.pausedUntil) }) : t('untilManual')}
          </div>
          {kiosk.pauseMessage ? <div className="mt-1 text-xs">“{kiosk.pauseMessage}”</div> : null}
        </div>
        {canWrite ? (
          <Button size="sm" disabled={busy} onClick={() => send({ action: 'resume' })}>
            <Play /> {t('reopen')}
          </Button>
        ) : null}
      </div>
    );
  }
  if (!canWrite) return null;
  const ready = mode !== 'time' || /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(untilTime);
  return (
    <div className="space-y-2 rounded-xl border p-3">
      <div className="flex items-center gap-1.5 text-sm font-medium">
        <Lock className="h-4 w-4" /> {t('title')}
      </div>
      <p className="text-xs text-muted-foreground">{t('hint')}</p>
      <label className="block space-y-1">
        <span className="text-xs text-muted-foreground">{t('message')}</span>
        <Input value={message} maxLength={300} placeholder={t('messagePlaceholder')} onChange={(e) => setMessage(e.target.value)} />
      </label>
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={t('untilLabel')}>
        {KIOSK_LOCK_MODES.filter((m) => m !== 'next_open' || hasSchedule).map((m) => (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={mode === m}
            onClick={() => setMode(m)}
            className={cn(
              'rounded-full border px-3 py-1 text-xs transition-colors',
              mode === m ? 'border-primary bg-primary text-primary-foreground' : 'hover:bg-muted',
            )}
          >
            {t(`mode.${m}`)}
          </button>
        ))}
      </div>
      {mode === 'time' ? (
        <TimeInput dir="ltr" className="w-32" value={untilTime} onChange={(e) => setUntilTime(e.target.value)} />
      ) : null}
      {mode === 'minutes' ? (
        <div className="flex items-center gap-2 text-sm">
          <Input type="number" dir="ltr" className="w-24" min={1} max={1440} value={minutes} onChange={(e) => setMinutes(Math.max(1, Math.min(1440, Number(e.target.value) || 1)))} />
          {t('minutes')}
        </div>
      ) : null}
      <Button
        size="sm"
        variant="outline"
        disabled={busy || !ready}
        onClick={() =>
          send({
            action: 'pause',
            ...(message.trim() ? { message: message.trim() } : {}),
            untilMode: mode,
            ...(mode === 'time' ? { untilTime } : {}),
            ...(mode === 'minutes' ? { minutes } : {}),
          })
        }
      >
        <Lock /> {t('lock')}
      </Button>
    </div>
  );
}

export function KioskScheduleControls({
  kiosk,
  canWrite,
  busy,
  send,
}: {
  kiosk: KioskSummary;
  canWrite: boolean;
  busy: boolean;
  send: (body: KioskCommandIn) => void;
}) {
  const t = useTranslations('kiosks.schedule');
  const td = useTranslations('kiosks.timers');
  const [form, setForm] = useState<KioskScheduleForm>(() => scheduleFormOf(kiosk.schedule));
  const [withClose, setWithClose] = useState(!!kiosk.schedule?.close);
  const key = JSON.stringify(kiosk.schedule ?? null);
  useEffect(() => {
    setForm(scheduleFormOf(kiosk.schedule));
    setWithClose(!!kiosk.schedule?.close);
    // Reset when the cloud's schedule changes (another till or the editor saved it).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const effective: KioskScheduleForm = { ...form, close: withClose ? form.close || '23:00' : null };
  const autoZ = scheduleFormAutoClose(effective, kiosk.schedule?.autoCloseAt ?? null);
  const issues = kioskScheduleIssues(scheduleFormHours(effective), autoZ);
  const many = (kiosk.schedule?.ranges ?? 0) > 1;
  return (
    <div className="space-y-3 rounded-xl border p-3">
      <div className="flex items-center gap-1.5 text-sm font-medium">
        <CalendarClock className="h-4 w-4" /> {t('title')}
      </div>
      <p className="text-xs text-muted-foreground">{t('hint')}</p>
      {many ? <p className="text-xs text-amber-700 dark:text-amber-400">{t('manyRanges')}</p> : null}
      <label className="flex items-center gap-2 text-sm">
        <Switch checked={form.enabled} disabled={!canWrite} onCheckedChange={(v) => setForm({ ...form, enabled: v })} />
        {t('enabled')}
      </label>
      {form.enabled ? (
        <>
          <div className="flex flex-wrap items-center gap-1.5">
            {DAYS.map((d) => {
              const on = form.days.includes(d);
              return (
                <button
                  key={d}
                  type="button"
                  aria-pressed={on}
                  disabled={!canWrite}
                  onClick={() => setForm({ ...form, days: toggleInList(form.days, d).sort((a, b) => a - b) })}
                  className={cn('h-8 w-8 rounded-full border text-sm', on ? 'border-primary bg-primary text-primary-foreground' : 'hover:bg-muted')}
                >
                  {td(`day.${d}`)}
                </button>
              );
            })}
          </div>
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <label className="flex items-center gap-2">
              {t('open')}
              <TimeInput dir="ltr" className="w-28" value={form.open} disabled={!canWrite} onChange={(e) => setForm({ ...form, open: e.target.value })} />
            </label>
            <label className="flex items-center gap-2">
              <Switch checked={withClose} disabled={!canWrite} onCheckedChange={setWithClose} />
              {t('withClose')}
            </label>
            {withClose ? (
              <TimeInput dir="ltr" className="w-28" value={effective.close ?? ''} disabled={!canWrite} onChange={(e) => setForm({ ...form, close: e.target.value })} />
            ) : null}
          </div>
          <label className="flex flex-wrap items-center gap-2 text-sm">
            {t('autoZ')}
            <TimeInput
              dir="ltr"
              className="w-28"
              value={form.autoCloseAt ?? autoZ ?? ''}
              disabled={!canWrite}
              onChange={(e) => setForm({ ...form, autoCloseAt: e.target.value })}
            />
            <span className="text-xs text-muted-foreground">{t('autoZHint')}</span>
          </label>
          {!withClose ? <p className="text-xs text-muted-foreground">{t('noCloseHint')}</p> : null}
        </>
      ) : null}
      {issues.map((i) => (
        <p key={i.code} className="text-xs text-red-700 dark:text-red-400">
          {t(`issue.${i.code}`, { time: i.time })}
        </p>
      ))}
      {canWrite ? (
        <Button
          size="sm"
          disabled={busy || issues.length > 0 || (form.enabled && !/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(form.open))}
          onClick={() => send({ action: 'schedule', schedule: { ...effective, autoCloseAt: form.autoCloseAt ?? null } })}
        >
          {t('save')}
        </Button>
      ) : null}
    </div>
  );
}
