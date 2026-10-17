'use client';

/**
 * A menu ("תפריט"): its name, whose it is (a company, or the whole organization — super
 * admin / distributor only), where it applies ("פעיל ב": חברה › סניף › נקודת מכירה › קופה, or
 * a device group — the "שיוך" tab's own rows), where it sells (קופות / קיוסק / both), whether it
 * is on, its colour, when ("מתי") and what ("קטגוריות ומוצרים", the shared two-pane picker).
 * Server: `POST /catalog-menus`, `PUT /catalog-menus/{id}` (the arrays in the order shown;
 * `assignments` only when the places changed).
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useAuth } from '@/lib/auth';
import { useScope } from '@/lib/scope';
import {
  createCatalogMenu,
  updateCatalogMenu,
  type CatalogMenu,
  type CatalogMenuInput,
} from '@/lib/catalogMenusApi';
import { NAME_MAX, isValidTime, normalizeDays, scheduleProblems, type MenuChannel } from '@/lib/menuSchedule';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { IosCard, IosFootnote, IosRow, IosSectionHeader, IosSegmented, IosSwitch } from '@/components/dashboard/menu/ios';
import { ScheduleEditor, type ScheduleDraft } from './schedule-editor';
import { ItemsEditor, badPriceOf, itemsDraftOf, itemsEmpty, itemsInput, type MenuItemsDraft } from './items-editor';
import { MenuTargetsField, defaultTargets, type DraftTarget } from './targets-field';
import { MENU_COLORS, useInvalidateMenus, useMenuErrorText } from './shared';

interface Draft {
  name: string;
  /** '' — the whole organization. */
  companyId: string;
  channel: MenuChannel;
  /** "גם באונליין / בתפריט הדיגיטלי" — the web channels it is offered on too. */
  webChannels: ('online' | 'menu')[];
  isActive: boolean;
  color: string | null;
  schedule: ScheduleDraft;
  items: MenuItemsDraft;
  /** "פעיל ב" — the menu's places (the "שיוך" rows). */
  targets: DraftTarget[];
  /** Sent only when changed (or a new menu): an untouched list never rewrites the "שיוך" rows. */
  targetsChanged: boolean;
}

function draftOf(m: CatalogMenu | null, company: string, scope: { shopId?: string | null; areaId?: string | null }): Draft {
  const targets: DraftTarget[] = m
    ? m.assignments.map((a) => ({ level: a.level, targetId: a.targetId, priority: a.priority, name: a.targetName }))
    : defaultTargets(scope);
  return {
    name: m?.name ?? '',
    companyId: m ? (m.companyId ?? '') : company,
    channel: m?.channel ?? 'both',
    webChannels: [...(m?.webChannels ?? [])],
    isActive: m?.isActive ?? true,
    color: m?.color ?? null,
    schedule: {
      always: m?.always ?? false,
      days: m ? m.days : [0, 1, 2, 3, 4],
      ranges: m ? m.ranges.map((r) => ({ start: r.start, end: r.end })) : [{ start: '07:00', end: '11:30' }],
      validFrom: m?.validFrom ?? '',
      validTo: m?.validTo ?? '',
    },
    items: itemsDraftOf(m),
    targets,
    targetsChanged: !m && targets.length > 0,
  };
}

const COLOR = /^#[0-9A-Fa-f]{6}$/;

export function MenuEditorDialog({
  open,
  onOpenChange,
  menu,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  menu: CatalogMenu | null;
}) {
  const t = useTranslations('catalogMenus.editor');
  const readOnly = !!menu && !menu.canEdit;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[94dvh] w-[calc(100vw-1rem)] max-w-5xl overflow-y-auto bg-[#F2F2F7] sm:max-w-5xl dark:bg-black">
        <DialogHeader>
          <DialogTitle>{readOnly ? t('titleView') : menu ? t('titleEdit') : t('titleNew')}</DialogTitle>
        </DialogHeader>
        {open ? <MenuEditor key={menu?.id ?? 'new'} menu={menu} readOnly={readOnly} onDone={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function MenuEditor({ menu, readOnly, onDone }: { menu: CatalogMenu | null; readOnly: boolean; onDone: () => void }) {
  const t = useTranslations('catalogMenus.editor');
  const tch = useTranslations('catalogMenus.channel');
  const tc = useTranslations('common');
  const { user } = useAuth();
  const scope = useScope();
  const admin = user?.role === 'super_admin' || user?.role === 'distributor';
  // The scope bar's point of sale (`?area=`, feat/area-management) where this dashboard has it.
  const scopeAreaId = (scope as unknown as { areaId?: string | null }).areaId ?? null;
  const [d, setD] = useState<Draft>(() =>
    draftOf(menu, scope.companyId ?? (admin ? '' : (user?.companyId ?? scope.companies[0]?.id ?? '')), {
      shopId: scope.shopId,
      areaId: scopeAreaId,
    }),
  );
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));
  const invalidate = useInvalidateMenus();
  const errorText = useMenuErrorText();

  // "תמיד" ignores the days and hours but keeps them for when it is turned off — only
  // what the server takes (it refuses an empty day list and an unreadable hour either way).
  const days = normalizeDays(d.schedule.days);
  const schedule = {
    always: d.schedule.always,
    days: d.schedule.always && days !== null && days.length === 0 ? null : days,
    ranges: d.schedule.always
      ? d.schedule.ranges.filter((r) => isValidTime(r.start) && isValidTime(r.end))
      : d.schedule.ranges,
    validFrom: d.schedule.validFrom || null,
    validTo: d.schedule.validTo || null,
  };
  const badPriceId = badPriceOf(d.items);
  const badPrice = badPriceId
    ? { name: d.items.extraProducts.find((p) => p.id === badPriceId)?.name ?? t('anItem') }
    : null;
  const problem = !d.name.trim()
    ? t('problemName')
    : scheduleProblems(schedule).length
      ? t('problemSchedule')
      : badPrice
        ? t('problemPrice', { name: badPrice.name })
        : d.color && !COLOR.test(d.color)
          ? t('problemColor')
          : null;
  const empty = itemsEmpty(d.items);

  const body = (): CatalogMenuInput => ({
    name: d.name.trim().slice(0, NAME_MAX),
    companyId: d.companyId || null,
    channel: d.channel,
    webChannels: d.webChannels,
    isActive: d.isActive,
    always: schedule.always,
    days: schedule.days,
    ranges: schedule.ranges,
    validFrom: schedule.validFrom,
    validTo: schedule.validTo,
    color: d.color ? d.color.toUpperCase() : null,
    ...itemsInput(d.items),
    ...(d.targetsChanged ? { assignments: d.targets.map((x) => ({ level: x.level, targetId: x.targetId, priority: x.priority })) } : {}),
  });

  const save = useMutation({
    mutationFn: () => (menu ? updateCatalogMenu(menu.id, body()) : createCatalogMenu(body())),
    onSuccess: () => {
      toast.success(t('saved'));
      invalidate();
      onDone();
    },
    onError: (err: unknown) => toast.error(errorText(err)),
  });

  const companyOptions = [
    ...(admin || (menu && menu.companyId === null) ? [{ value: '', label: t('wholeOrg') }] : []),
    ...scope.companies.map((c) => ({ value: c.id, label: c.name })),
  ];
  if (d.companyId && !companyOptions.some((o) => o.value === d.companyId)) {
    companyOptions.push({ value: d.companyId, label: menu?.companyName ?? d.companyId });
  }

  return (
    <div className="space-y-1">
      <IosCard>
        <IosRow>
          <span className="w-24 shrink-0 text-[15px]">{t('name')}</span>
          <Input
            value={d.name}
            disabled={readOnly}
            onChange={(e) => set('name', e.target.value.slice(0, NAME_MAX))}
            placeholder={t('namePlaceholder')}
            className="border-0 bg-transparent px-0 text-[15px] shadow-none focus-visible:ring-0"
          />
        </IosRow>
        {companyOptions.length > 1 || d.companyId === '' ? (
          <IosRow>
            <span className="w-24 shrink-0 text-[15px]">{t('company')}</span>
            <select
              value={d.companyId}
              disabled={readOnly}
              onChange={(e) => set('companyId', e.target.value)}
              className="min-w-0 flex-1 bg-transparent text-[15px] text-[#007AFF] outline-none disabled:text-[#8E8E93]"
            >
              {companyOptions.map((o) => (
                <option key={o.value || 'org'} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </IosRow>
        ) : null}
        <IosRow>
          <span className="w-24 shrink-0 text-[15px]">{t('channel')}</span>
          <IosSegmented
            className="flex-1"
            value={d.channel}
            disabled={readOnly}
            onChange={(v) => set('channel', v)}
            options={[
              { id: 'pos', label: tch('pos') },
              { id: 'kiosk', label: tch('kiosk') },
              { id: 'both', label: tch('both') },
            ]}
          />
        </IosRow>
        {(['online', 'menu'] as const).map((w) => (
          <IosRow key={w}>
            <span className="flex-1 text-[15px]">{t(w === 'online' ? 'webOnline' : 'webMenu')}</span>
            <IosSwitch
              checked={d.webChannels.includes(w)}
              onChange={(v) => set('webChannels', v ? [...d.webChannels.filter((x) => x !== w), w] : d.webChannels.filter((x) => x !== w))}
              label={t(w === 'online' ? 'webOnline' : 'webMenu')}
              disabled={readOnly}
            />
          </IosRow>
        ))}
        <IosRow>
          <span className="flex-1 text-[15px]">{t('active')}</span>
          <IosSwitch checked={d.isActive} onChange={(v) => set('isActive', v)} label={t('active')} disabled={readOnly} />
        </IosRow>
        <IosRow>
          <span className="w-24 shrink-0 text-[15px]">{t('color')}</span>
          <div className="flex flex-1 flex-wrap items-center gap-1.5">
            <button
              type="button"
              disabled={readOnly}
              onClick={() => set('color', null)}
              aria-pressed={d.color === null}
              title={t('noColor')}
              className={cn(
                'h-7 rounded-full border border-dashed border-[#C7C7CC] px-2 text-[12px] text-[#6D6D72]',
                d.color === null && 'ring-2 ring-[#007AFF] ring-offset-1',
              )}
            >
              {t('noColor')}
            </button>
            {MENU_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                disabled={readOnly}
                onClick={() => set('color', c)}
                aria-pressed={d.color?.toUpperCase() === c}
                aria-label={c}
                title={c}
                className={cn(
                  'h-7 w-7 rounded-full',
                  d.color?.toUpperCase() === c && 'ring-2 ring-[#007AFF] ring-offset-1',
                )}
                style={{ backgroundColor: c }}
              />
            ))}
            <label className="inline-flex items-center gap-1 text-[12px] text-[#6D6D72]" title={t('customColor')}>
              <input
                type="color"
                disabled={readOnly}
                value={d.color && COLOR.test(d.color) ? d.color : '#8E8E93'}
                onChange={(e) => set('color', e.target.value.toUpperCase())}
                className="h-7 w-9 cursor-pointer rounded border-0 bg-transparent p-0"
                aria-label={t('customColor')}
              />
            </label>
          </div>
        </IosRow>
      </IosCard>
      {d.companyId === '' ? <IosFootnote>{t('wholeOrgHint')}</IosFootnote> : <IosFootnote>{t('companyHint')}</IosFootnote>}

      <IosSectionHeader>{t('where')}</IosSectionHeader>
      <IosCard>
        <MenuTargetsField
          companyId={d.companyId}
          value={d.targets}
          onChange={(v) => setD((x) => ({ ...x, targets: v, targetsChanged: true }))}
          disabled={readOnly}
          initialShopId={scope.shopId ?? null}
        />
      </IosCard>

      <IosSectionHeader>{t('schedule')}</IosSectionHeader>
      <ScheduleEditor value={d.schedule} onChange={(v) => set('schedule', v)} disabled={readOnly} />

      <IosSectionHeader>{t('items')}</IosSectionHeader>
      <ItemsEditor value={d.items} onChange={(v) => set('items', v)} disabled={readOnly} />
      {empty ? <p className="px-4 pt-1 text-[12px] font-medium text-[#C93400] dark:text-[#FF9F0A]">{t('emptyWarning')}</p> : null}

      {readOnly ? <p className="px-4 pt-3 text-[13px] text-[#6D6D72]">{t('readOnly')}</p> : null}
      {!readOnly && problem ? <p className="px-4 pt-3 text-[13px] text-[#FF3B30]">{problem}</p> : null}
      <DialogFooter className="pt-4">
        <Button variant="outline" onClick={onDone}>
          {readOnly ? t('close') : tc('cancel')}
        </Button>
        {!readOnly ? (
          <Button disabled={!!problem || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? tc('saving') : tc('save')}
          </Button>
        ) : null}
      </DialogFooter>
    </div>
  );
}
