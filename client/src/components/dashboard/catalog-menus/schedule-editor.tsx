'use client';

/**
 * "מתי" — a menu's schedule: always, or weekdays and time ranges (a range whose end is at
 * or before its start runs on past midnight and belongs to the day it started;
 * "00:00–00:00" is the whole day), and an optional date range. The rules are
 * lib/menuSchedule.ts, the server's own.
 */

import { useTranslations } from 'next-intl';
import { Plus, X } from 'lucide-react';
import {
  MAX_RANGES,
  WEEKDAYS,
  crossesMidnight,
  isValidTime,
  isWholeDayRange,
  normalizeDays,
  scheduleProblems,
  scheduleSummary,
  type MenuSchedule,
} from '@/lib/menuSchedule';
import { Input } from '@/components/ui/input';
import { IosCard, IosChip, IosFootnote, IosRow, IosSwitch, IosTag } from '@/components/dashboard/menu/ios';
import { cn } from '@/lib/utils';

export interface ScheduleDraft extends MenuSchedule {
  validFrom: string;
  validTo: string;
}

export function ScheduleEditor({
  value,
  onChange,
  disabled,
}: {
  value: ScheduleDraft;
  onChange: (next: ScheduleDraft) => void;
  disabled?: boolean;
}) {
  const t = useTranslations('catalogMenus.schedule');
  const tw = useTranslations('catalogMenus.weekdays');
  const set = (patch: Partial<ScheduleDraft>) => onChange({ ...value, ...patch });
  // "תמיד" hides the days and hours: only the dates can be wrong then.
  const problems = scheduleProblems({
    ...value,
    ranges: value.always ? [] : value.ranges,
    validFrom: value.validFrom || null,
    validTo: value.validTo || null,
  });

  const toggleDay = (day: number) => {
    const current = value.days ?? WEEKDAYS;
    const next = current.includes(day) ? current.filter((d) => d !== day) : [...current, day];
    set({ days: normalizeDays(next) });
  };

  const setRange = (i: number, patch: Partial<{ start: string; end: string }>) =>
    set({ ranges: value.ranges.map((r, j) => (j === i ? { ...r, ...patch } : r)) });

  return (
    <>
      <IosCard>
        <IosRow>
          <div className="flex-1">
            <div className="text-[15px]">{t('always')}</div>
            <div className="text-[12px] text-[#6D6D72]">{t('alwaysHint')}</div>
          </div>
          <IosSwitch checked={value.always} onChange={(v) => set({ always: v })} label={t('always')} disabled={disabled} />
        </IosRow>
        {!value.always ? (
          <>
            <IosRow>
              <div className="w-full space-y-2 py-1">
                <div className="text-[13px] text-[#6D6D72]">{t('days')}</div>
                <div className="flex flex-wrap gap-1.5">
                  <IosChip on={value.days === null} disabled={disabled} onClick={() => set({ days: null })}>
                    {t('everyDay')}
                  </IosChip>
                  {WEEKDAYS.map((day) => (
                    <IosChip
                      key={day}
                      on={value.days === null || value.days.includes(day)}
                      disabled={disabled}
                      onClick={() => toggleDay(day)}
                    >
                      {tw(String(day))}
                    </IosChip>
                  ))}
                </div>
              </div>
            </IosRow>
            <IosRow>
              <div className="w-full space-y-2 py-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[13px] text-[#6D6D72]">{t('hours')}</span>
                  {!disabled && value.ranges.length < MAX_RANGES ? (
                    <button
                      type="button"
                      onClick={() =>
                        set({
                          ranges: [
                            ...value.ranges,
                            value.ranges.length ? { start: '17:00', end: '23:00' } : { start: '07:00', end: '11:30' },
                          ],
                        })
                      }
                      className="inline-flex items-center gap-1 text-[14px] font-medium text-[#007AFF] active:opacity-60"
                    >
                      <Plus className="h-4 w-4" aria-hidden />
                      {t('addRange')}
                    </button>
                  ) : null}
                </div>
                {value.ranges.length === 0 ? (
                  <p className="text-[13px] text-[#3C3C43] dark:text-white/70">{t('wholeDayHint')}</p>
                ) : (
                  <ul className="space-y-1.5">
                    {value.ranges.map((r, i) => {
                      const bad = !isValidTime(r.start) || !isValidTime(r.end);
                      return (
                        <li key={i} className="flex flex-wrap items-center gap-2">
                          <Input
                            type="time"
                            value={r.start}
                            disabled={disabled}
                            onChange={(e) => setRange(i, { start: e.target.value })}
                            className={cn('h-8 w-28', bad && !isValidTime(r.start) && 'border-[#FF3B30]')}
                            aria-label={t('from')}
                          />
                          <span className="text-[#8E8E93]">–</span>
                          <Input
                            type="time"
                            value={r.end}
                            disabled={disabled}
                            onChange={(e) => setRange(i, { end: e.target.value })}
                            className={cn('h-8 w-28', bad && !isValidTime(r.end) && 'border-[#FF3B30]')}
                            aria-label={t('to')}
                          />
                          {isWholeDayRange(r) ? <IosTag tone="green">{t('wholeDay')}</IosTag> : null}
                          {crossesMidnight(r) ? <IosTag tone="blue">{t('overnight')}</IosTag> : null}
                          {!disabled ? (
                            <button
                              type="button"
                              aria-label={t('removeRange')}
                              title={t('removeRange')}
                              onClick={() => set({ ranges: value.ranges.filter((_, j) => j !== i) })}
                              className="ms-auto rounded-full p-1 text-[#8E8E93] hover:bg-black/5"
                            >
                              <X className="h-4 w-4" aria-hidden />
                            </button>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </IosRow>
          </>
        ) : null}
        <IosRow>
          <div className="w-full space-y-2 py-1">
            <div className="text-[13px] text-[#6D6D72]">{t('dates')}</div>
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-1.5 text-[13px]">
                <span>{t('validFrom')}</span>
                <Input
                  type="date"
                  value={value.validFrom}
                  disabled={disabled}
                  onChange={(e) => set({ validFrom: e.target.value })}
                  className="h-8 w-40"
                />
              </label>
              <label className="flex items-center gap-1.5 text-[13px]">
                <span>{t('validTo')}</span>
                <Input
                  type="date"
                  value={value.validTo}
                  disabled={disabled}
                  onChange={(e) => set({ validTo: e.target.value })}
                  className="h-8 w-40"
                />
              </label>
              {!disabled && (value.validFrom || value.validTo) ? (
                <button
                  type="button"
                  onClick={() => set({ validFrom: '', validTo: '' })}
                  className="text-[13px] font-medium text-[#007AFF] active:opacity-60"
                >
                  {t('clearDates')}
                </button>
              ) : null}
            </div>
          </div>
        </IosRow>
        <IosRow>
          <span className="text-[13px] text-[#6D6D72]">{t('summary')}</span>
          <span className="min-w-0 flex-1 text-[14px] font-medium">
            {scheduleSummary({ ...value, validFrom: value.validFrom || null, validTo: value.validTo || null })}
          </span>
        </IosRow>
      </IosCard>
      {problems.length ? (
        <p className="px-4 pt-1.5 text-[12px] text-[#FF3B30]">{problems.map((p) => t(`problems.${p}`)).join(' · ')}</p>
      ) : null}
      {!value.always ? <IosFootnote>{t('rangesHint')}</IosFootnote> : null}
    </>
  );
}
