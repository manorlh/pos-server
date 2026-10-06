'use client';

import { useTranslations } from 'next-intl';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { KIOSK_LIMITS, kioskScheduleIssues, toggleInList, type HoursRange } from '@/lib/kioskConfig';
import { useKioskField } from './editor-context';
import { FieldErrors, FieldShell, NumberField, SectionCard, SwitchField, TextField, TimeField } from './fields';

const DAYS = [0, 1, 2, 3, 4, 5, 6];

function HoursRanges() {
  const t = useTranslations('kiosks.timers');
  const tf = useTranslations('kiosks.fields');
  const enabled = useKioskField<boolean>('hours.enabled');
  const f = useKioskField<HoursRange[]>('hours.ranges');
  const list = Array.isArray(f.value) ? f.value : [];
  if (!enabled.value) return null;
  const patch = (i: number, x: Partial<HoursRange>) => f.set(list.map((r, j) => (j === i ? { ...r, ...x } : r)));
  return (
    <FieldShell path="hours.ranges" label={tf('hours.ranges')} hint={t('hoursHint')}>
      <div className="space-y-2">
        {list.map((r, i) => (
          <div key={i} className="space-y-2 rounded-xl border bg-card p-3">
            <div className="flex flex-wrap items-center gap-1.5">
              {DAYS.map((d) => {
                const on = r.days.includes(d);
                return (
                  <button
                    key={d}
                    type="button"
                    aria-pressed={on}
                    disabled={f.disabled}
                    onClick={() => patch(i, { days: toggleInList(r.days, d).sort((a, b) => a - b) })}
                    className={cn(
                      'h-8 w-8 rounded-full border text-sm transition-colors duration-150 disabled:opacity-50',
                      on ? 'border-primary bg-primary text-primary-foreground' : 'hover:bg-muted',
                    )}
                  >
                    {t(`day.${d}`)}
                  </button>
                );
              })}
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                className="ms-auto text-destructive"
                aria-label={t('removeRange')}
                disabled={f.disabled || list.length <= 1}
                onClick={() => f.set(list.filter((_, j) => j !== i))}
              >
                <Trash2 />
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <label className="flex items-center gap-2">
                {t('open')}
                <Input type="time" dir="ltr" className="w-28" value={r.open} disabled={f.disabled} onChange={(e) => patch(i, { open: e.target.value })} />
              </label>
              {r.close !== null ? (
                <label className="flex items-center gap-2">
                  {t('close')}
                  <Input type="time" dir="ltr" className="w-28" value={r.close} disabled={f.disabled} onChange={(e) => patch(i, { close: e.target.value })} />
                </label>
              ) : null}
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground" title={t('noCloseHint')}>
                <input
                  type="checkbox"
                  checked={r.close === null}
                  disabled={f.disabled}
                  onChange={(e) => patch(i, { close: e.target.checked ? null : '23:00' })}
                />
                {t('noClose')}
              </label>
              {r.close && r.open && r.close < r.open ? <span className="text-xs text-muted-foreground">{t('pastMidnight')}</span> : null}
            </div>
            <FieldErrors path={`hours.ranges.${i}`} />
          </div>
        ))}
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={f.disabled || list.length >= KIOSK_LIMITS.hoursRangesMax}
          onClick={() => f.set([...list, { days: [5], open: '08:00', close: '14:00' }])}
        >
          <Plus /> {t('addRange')}
        </Button>
      </div>
    </FieldShell>
  );
}

/** "סגירה ← Z ← פתיחה": a warning when the automatic Z would run while the kiosk is open. */
function ScheduleWarning() {
  const ts = useTranslations('kiosks.schedule');
  const enabled = useKioskField<boolean>('hours.enabled');
  const ranges = useKioskField<HoursRange[]>('hours.ranges');
  const autoClose = useKioskField<string>('operations.autoCloseAt');
  const issues = kioskScheduleIssues(
    { enabled: !!enabled.value, ranges: Array.isArray(ranges.value) ? ranges.value : [] },
    typeof autoClose.value === 'string' ? autoClose.value : null,
  );
  return (
    <>
      {issues.map((i) => (
        <p key={i.code} className="text-xs text-red-700 dark:text-red-400">
          {ts(`issue.${i.code}`, { time: i.time })}
        </p>
      ))}
    </>
  );
}

export function TimersSection() {
  const t = useTranslations('kiosks.timers');
  const tf = useTranslations('kiosks.fields');
  const tb = useTranslations('kiosks.builtin');
  const L = KIOSK_LIMITS;
  return (
    <div className="space-y-4">
      <SectionCard
        title={t('title')}
        paths={['timers.inactivitySec', 'timers.warningSec', 'timers.successSec', 'timers.attractSlideSec']}
      >
        <NumberField
          path="timers.inactivitySec"
          label={tf('timers.inactivitySec')}
          hint={t('inactivityHint')}
          min={L.inactivitySec.min}
          max={L.inactivitySec.max}
          suffix={t('seconds')}
          slider
        />
        <NumberField
          path="timers.warningSec"
          label={tf('timers.warningSec')}
          hint={t('warningHint')}
          min={L.warningSec.min}
          max={L.warningSec.max}
          suffix={t('seconds')}
          slider
        />
        <NumberField
          path="timers.successSec"
          label={tf('timers.successSec')}
          hint={t('successHint')}
          min={L.successSec.min}
          max={L.successSec.max}
          suffix={t('seconds')}
          slider
        />
        <NumberField
          path="timers.attractSlideSec"
          label={tf('timers.attractSlideSec')}
          hint={t('slideHint')}
          min={L.attractSlideSec.min}
          max={L.attractSlideSec.max}
          suffix={t('seconds')}
          slider
        />
      </SectionCard>

      <SectionCard title={t('hoursTitle')} paths={['hours.enabled', 'hours.ranges']}>
        <SwitchField path="hours.enabled" label={tf('hours.enabled')} hint={t('hoursEnabledHint')} />
        <HoursRanges />
      </SectionCard>

      <SectionCard
        title={t('opsTitle')}
        paths={['operations.autoCloseAt', 'operations.closeWithShopZ', 'operations.pausedTitle', 'operations.pausedBody']}
      >
        <TimeField path="operations.autoCloseAt" label={tf('operations.autoCloseAt')} hint={t('autoCloseHint')} clearable />
        {/* "סגירה יחד עם ה-Z הסניפי": the shop's Z closes the kiosk and makes its own Z. */}
        <SwitchField path="operations.closeWithShopZ" label={tf('operations.closeWithShopZ')} hint={t('closeWithShopZHint')} />
        <ScheduleWarning />
        <TextField
          path="operations.pausedTitle"
          label={tf('operations.pausedTitle')}
          hint={t('pausedHint')}
          max={L.pausedTitleMax}
          placeholder={tb('pausedTitle')}
        />
        <TextField
          path="operations.pausedBody"
          label={tf('operations.pausedBody')}
          max={L.pausedBodyMax}
          placeholder={tb('pausedBody')}
          multiline
        />
      </SectionCard>
    </div>
  );
}
