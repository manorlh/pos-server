'use client';

/**
 * A menu ("תפריט"): its name, whose it is (a company, or the whole organization — super
 * admin / distributor only), where it sells (קופות / קיוסק / both), whether it is on, its
 * colour, when ("מתי") and what ("קטגוריות ומוצרים"). Server: `POST /catalog-menus`,
 * `PUT /catalog-menus/{id}` (the arrays in the order shown).
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
import { ItemsEditor, draftCategoriesOf, itemsInput, priceOk, type DraftCategory } from './items-editor';
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
  categories: DraftCategory[];
}

function draftOf(m: CatalogMenu | null, company: string): Draft {
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
    categories: draftCategoriesOf(m),
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
      <DialogContent className="max-h-[92dvh] max-w-2xl overflow-y-auto bg-[#F2F2F7] dark:bg-black">
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
  const [d, setD] = useState<Draft>(() =>
    draftOf(menu, scope.companyId ?? (admin ? '' : (user?.companyId ?? scope.companies[0]?.id ?? ''))),
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
  const badPrice = d.categories.flatMap((c) => c.products).find((p) => !priceOk(p.price));
  const problem = !d.name.trim()
    ? t('problemName')
    : scheduleProblems(schedule).length
      ? t('problemSchedule')
      : badPrice
        ? t('problemPrice', { name: badPrice.name })
        : d.color && !COLOR.test(d.color)
          ? t('problemColor')
          : null;
  const empty = d.categories.every((c) => c.products.length === 0 && (!c.allProducts || c.categoryId === null));

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
    ...itemsInput(d.categories),
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

      <IosSectionHeader>{t('schedule')}</IosSectionHeader>
      <ScheduleEditor value={d.schedule} onChange={(v) => set('schedule', v)} disabled={readOnly} />

      <IosSectionHeader>{t('items')}</IosSectionHeader>
      <ItemsEditor value={d.categories} onChange={(v) => set('categories', v)} disabled={readOnly} />
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
