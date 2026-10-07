'use client';

/**
 * "מבנה הקיוסק" (config `layout`, docs/SPEC_KIOSK_LAYOUTS.md) beside "סגנון ממשק": the template
 * picker with a thumbnail per template, the accessibility mode, every key one by one under
 * "מתקדם", and the category icons (catalog.categoryIconIds). Picking a template moves every value
 * that followed the old one; a value chosen explicitly (here or above) stays — as the style does.
 */

import { useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Check, ChevronDown, Sparkles } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { resolveThemeColors, type ResolvedThemeColors } from '@/lib/kioskConfig';
import {
  LAYOUT_TEMPLATES,
  LAYOUT_VOCABULARY,
  layoutValueReady,
  type KioskLayout,
  type LayoutTemplate,
} from '@/lib/kioskLayout';
import { KIOSK_ICONS, categoryIconOf, suggestCategoryIcon, type KioskIconStyle } from '@/lib/kioskIcons';
import { KioskIconSvg } from '@/kiosk-shared/layouts/icons';
import { useKioskEditor, useKioskField } from './editor-context';
import { FieldShell, OverrideMark, SectionCard, Segmented, SwitchField } from './fields';

/* ------------------------------------------------------------ thumbnails */

/** A schematic of a template in the draft's colours (right to left, as the kiosk). */
function LayoutThumb({ template, c }: { template: LayoutTemplate; c: ResolvedThemeColors }) {
  const muted = `${c.text}26`;
  const soft = `${c.primary}33`;
  const tile = (key: string | number, extra?: ReactNode, round = false) => (
    <div key={key} className="flex flex-col items-center justify-center gap-0.5 rounded-[3px] p-0.5" style={{ background: c.surface }}>
      <span className={cn('block h-2.5 w-2.5', round ? 'rounded-full' : 'rounded-[2px]')} style={{ background: soft }} />
      {extra}
    </div>
  );
  const header = <div className="h-1.5 w-full rounded-full" style={{ background: muted }} />;
  const bar = (dark = false) => (
    <div className="flex h-3 w-full items-center justify-between rounded-[3px] px-1" style={{ background: dark ? '#14161A' : c.button }}>
      <span className="block h-1 w-5 rounded-full" style={{ background: dark ? '#FFFFFF66' : `${c.buttonText}88` }} />
      {dark ? <span className="block h-1.5 w-3 rounded-full" style={{ background: c.button }} /> : null}
    </div>
  );
  let body: ReactNode;
  switch (template) {
    case 'guided':
      body = (
        <>
          {header}
          <div className="flex items-center justify-center gap-0.5">
            {[0, 1, 2, 3].map((i) => (
              <span key={i} className="flex items-center gap-0.5">
                <span className="block h-1.5 w-1.5 rounded-full" style={{ background: i < 2 ? c.primary : muted }} />
                {i < 3 ? <span className="block h-px w-2" style={{ background: muted }} /> : null}
              </span>
            ))}
          </div>
          <div className="grid flex-1 grid-cols-2 gap-1">{[0, 1, 2, 3].map((i) => tile(i))}</div>
          {bar()}
        </>
      );
      break;
    case 'tabs':
      body = (
        <>
          {header}
          <div className="flex gap-0.5">
            {[0, 1, 2].map((i) => (
              <span key={i} className="block h-2 flex-1 rounded-full" style={{ background: i === 0 ? c.primary : c.surface }} />
            ))}
          </div>
          <div className="h-1 w-6 rounded-full" style={{ background: muted }} />
          <div className="grid flex-1 grid-cols-3 gap-0.5">{[0, 1, 2, 3, 4, 5].map((i) => tile(i))}</div>
          {bar()}
        </>
      );
      break;
    case 'landing':
      body = (
        <>
          {header}
          <div className="mx-auto h-1 w-8 rounded-full" style={{ background: `${c.text}55` }} />
          <div className="grid flex-1 grid-cols-3 gap-0.5">{[0, 1, 2, 3, 4, 5].map((i) => tile(i, null, true))}</div>
        </>
      );
      break;
    case 'fastfood':
      body = (
        <>
          {header}
          <div className="flex min-h-0 flex-1 gap-1">
            <div className="flex w-5 shrink-0 flex-col gap-0.5">
              {[0, 1, 2, 3].map((i) => (
                <span key={i} className="block flex-1 rounded-[3px]" style={{ background: i === 0 ? soft : `linear-gradient(135deg, ${c.accent}40, ${c.primary}30)`, outline: i === 0 ? `1px solid ${c.primary}` : undefined }} />
              ))}
            </div>
            <div className="grid flex-1 grid-cols-2 gap-0.5">{[0, 1, 2, 3].map((i) => tile(i, null, true))}</div>
          </div>
          {bar(true)}
        </>
      );
      break;
    case 'cafe':
      body = (
        <>
          {header}
          {[0, 1, 2].map((r) => (
            <div key={r} className="space-y-0.5">
              <div className="h-1 w-5 rounded-full" style={{ background: muted }} />
              <div className="flex gap-0.5">{[0, 1, 2].map((i) => <span key={i} className="block h-3.5 flex-1 rounded-[3px]" style={{ background: c.surface }} />)}</div>
            </div>
          ))}
        </>
      );
      break;
    case 'combo':
      body = (
        <>
          {header}
          <div className="flex flex-1 items-center justify-center gap-1">
            {[0, 1, 2].map((i) => (
              <span key={i} className="block h-5 w-5 rounded-full border border-dashed" style={{ borderColor: i === 0 ? c.primary : muted, background: i === 0 ? soft : undefined }} />
            ))}
          </div>
          <div className="h-4 w-full rounded-[3px]" style={{ background: c.surface }} />
          {bar()}
        </>
      );
      break;
    case 'list':
      body = (
        <>
          <div className="h-2 w-full rounded-full" style={{ background: c.surface }} />
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="flex items-center gap-1 rounded-[3px] p-0.5" style={{ background: c.surface }}>
              <span className="block h-2 w-2 rounded-[2px]" style={{ background: soft }} />
              <span className="block h-1 flex-1 rounded-full" style={{ background: muted }} />
            </div>
          ))}
        </>
      );
      break;
    case 'magazine':
      body = (
        <>
          {header}
          {[0, 1].map((i) => (
            <div key={i} className="flex flex-1 flex-col overflow-hidden rounded-[3px]" style={{ background: c.surface }}>
              <span className="block flex-1" style={{ background: `linear-gradient(135deg, ${c.primary}40, ${c.accent}40)` }} />
              <span className="m-0.5 block h-1 w-6 rounded-full" style={{ background: muted }} />
            </div>
          ))}
        </>
      );
      break;
    case 'wall':
      body = (
        <div className="grid flex-1 grid-cols-4 gap-0.5">
          {Array.from({ length: 16 }, (_, i) => (
            <span key={i} className="block rounded-[3px]" style={{ background: i % 5 === 0 ? c.button : c.surface }} />
          ))}
        </div>
      );
      break;
    default:
      // standard: today's — the categories at the side, the dishes, the bar.
      body = (
        <>
          {header}
          <div className="flex min-h-0 flex-1 gap-1">
            <div className="flex w-3.5 shrink-0 flex-col items-center gap-1 rounded-[3px] py-1" style={{ background: c.surface }}>
              {[0, 1, 2].map((i) => (
                <span key={i} className="block h-2 w-2 rounded-[2px]" style={{ background: i === 0 ? c.primary : muted }} />
              ))}
            </div>
            <div className="grid flex-1 grid-cols-2 gap-0.5">{[0, 1, 2, 3].map((i) => tile(i))}</div>
          </div>
          {bar()}
        </>
      );
  }
  return (
    <div dir="rtl" className="mx-auto flex h-28 w-16 flex-col gap-1 overflow-hidden rounded-lg p-1 shadow-inner" style={{ background: c.background }}>
      {body}
    </div>
  );
}

/* ------------------------------------------------------------ the picker */

export function LayoutTemplatePicker() {
  const t = useTranslations('kiosks.layouts');
  const ed = useKioskEditor();
  const f = useKioskField<LayoutTemplate>('layout.template');
  const c = resolveThemeColors(ed.draft.theme);
  return (
    <FieldShell path="layout.template" label={t('templateLabel')} hint={t('templateHint')}>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5">
        {LAYOUT_TEMPLATES.map((template) => {
          const active = f.value === template;
          const ready = layoutValueReady('template', template);
          return (
            <button
              key={template}
              type="button"
              disabled={f.disabled || (!ready && !active)}
              aria-pressed={active}
              title={ready ? undefined : t('soonHint')}
              onClick={() => ed.setLayoutTemplate(template)}
              className={cn(
                'relative flex flex-col gap-1.5 rounded-2xl border p-2 text-start transition-all duration-200 disabled:cursor-not-allowed',
                active ? 'border-primary bg-primary/5 shadow-sm ring-1 ring-primary' : 'hover:bg-muted/50',
                !ready && 'opacity-55',
              )}
            >
              <LayoutThumb template={template} c={c} />
              <span className="flex items-center justify-between gap-1 text-sm font-semibold">
                {t(`templates.${template}.name`)}
                {active ? <Check className="h-4 w-4 text-primary" /> : null}
              </span>
              <span className="text-[11px] leading-snug text-muted-foreground">{t(`templates.${template}.desc`)}</span>
              {!ready ? (
                <Badge variant="outline" className="absolute end-2 top-2 bg-background text-[10px]">
                  {t('soon')}
                </Badge>
              ) : null}
            </button>
          );
        })}
      </div>
    </FieldShell>
  );
}

/* ------------------------------------------------------------ one key */

const AUTO = '__auto__';

/** A layout key as a segmented choice; null (as today) shows as "כמו היום"; values not drawn yet as "בקרוב". */
function LayoutChoice<K extends keyof KioskLayout>({ name, nullable = false, hint }: { name: K; nullable?: boolean; hint?: ReactNode }) {
  const t = useTranslations('kiosks.layouts');
  const path = `layout.${name}`;
  const f = useKioskField<KioskLayout[K]>(path);
  const values = LAYOUT_VOCABULARY[name as keyof typeof LAYOUT_VOCABULARY] as readonly unknown[];
  const options = [
    ...(nullable ? [{ value: AUTO, label: t('auto') }] : []),
    ...values.map((v) => {
      const ready = layoutValueReady(name, v);
      return {
        value: String(v),
        label: (
          <span className="inline-flex items-center gap-1">
            {t(`values.${String(name)}.${String(v)}`)}
            {ready ? null : <Sparkles className="h-3 w-3 opacity-60" aria-label={t('soon')} />}
          </span>
        ),
        disabled: !ready && String(f.value) !== String(v),
        title: ready ? undefined : t('soonHint'),
      };
    }),
  ];
  const current = f.value === null || f.value === undefined ? AUTO : String(f.value);
  return (
    <FieldShell path={path} label={t(`keys.${String(name)}`)} hint={hint}>
      <Segmented<string>
        value={current}
        options={options}
        disabled={f.disabled}
        ariaLabel={t(`keys.${String(name)}`)}
        onChange={(v) => {
          if (v === AUTO) return f.set(null as KioskLayout[K]);
          const typed = values.find((x) => String(x) === v);
          f.set(typed as KioskLayout[K]);
        }}
      />
    </FieldShell>
  );
}

/* ------------------------------------------------------------ the card */

export function LayoutSection() {
  const t = useTranslations('kiosks.layouts');
  const ed = useKioskEditor();
  const [open, setOpen] = useState(false);
  const layout = ed.draft.layout;
  return (
    <div className="space-y-4">
      <SectionCard title={t('title')} description={t('hint')} paths={['layout']}>
        <LayoutTemplatePicker />
        <div className="space-y-3 rounded-2xl border bg-muted/30 p-3">
          <div className="text-sm font-semibold">{t('reachTitle')}</div>
          <LayoutChoice name="reach" hint={t('reachHint')} />
          <SwitchField path="layout.reachToggle" label={t('keys.reachToggle')} hint={t('reachToggleHint')} />
        </div>
        <div className="rounded-2xl border">
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-start text-sm font-semibold"
          >
            <span>
              {t('advanced')}
              <span className="ms-2 text-xs font-normal text-muted-foreground">{t('advancedHint')}</span>
            </span>
            <ChevronDown className={cn('h-4 w-4 shrink-0 transition-transform duration-200', open && 'rotate-180')} />
          </button>
          {open ? (
            <div className="space-y-4 border-t p-3 animate-in fade-in duration-200">
              <LayoutChoice name="catalog" nullable hint={t('catalogHint')} />
              <LayoutChoice name="categoryIcons" nullable />
              {layout?.catalog === 'rail' ? <LayoutChoice name="railSize" /> : null}
              {layout?.catalog === 'landing' ? (
                <>
                  <LayoutChoice name="landingColumns" />
                  <SwitchField path="layout.landingShowCounts" label={t('keys.landingShowCounts')} />
                </>
              ) : null}
              <LayoutChoice name="card" nullable />
              <LayoutChoice name="flow" hint={t('flowHint')} />
              <LayoutChoice name="itemView" />
              <LayoutChoice name="quickAdd" hint={t('quickAddHint')} />
              <LayoutChoice name="mealUpsell" hint={t('mealUpsellHint')} />
              <LayoutChoice name="mealView" />
              <LayoutChoice name="basket" nullable />
              <LayoutChoice name="hero" />
              <LayoutChoice name="service" />
              <LayoutChoice name="name" />
            </div>
          ) : null}
        </div>
      </SectionCard>
      <CategoryIconsCard />
    </div>
  );
}

/* ------------------------------------------------------------ category icons */

function CategoryIconRow({ id, name, style }: { id: string; name: string; style: KioskIconStyle }) {
  const t = useTranslations('kiosks.layouts');
  const ed = useKioskEditor();
  const path = `catalog.categoryIconIds.${id}`;
  const f = useKioskField<string | null | undefined>(path);
  const [open, setOpen] = useState(false);
  const c = resolveThemeColors(ed.draft.theme);
  const iconId = categoryIconOf(id, name, ed.draft.catalog.categoryIconIds);
  const suggested = suggestCategoryIcon(name);
  const explicit = typeof f.value === 'string' && f.value !== '';
  return (
    <li className="space-y-2 px-3 py-2">
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl" style={{ background: `${c.primary}14` }}>
          <KioskIconSvg id={iconId} style={style} size={24} color={c.primary} knock={c.surface} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{name}</div>
          <div className="text-[11px] text-muted-foreground">
            {explicit ? KIOSK_ICONS.find((i) => i.id === iconId)?.label.he : suggested ? t('iconsSuggested') : t('iconsFallback')}
          </div>
        </div>
        <OverrideMark path={path} />
        <Button type="button" size="xs" variant="outline" disabled={f.disabled} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {t('iconsChange')}
        </Button>
      </div>
      {open ? (
        <div className="grid grid-cols-6 gap-1 rounded-xl border bg-muted/30 p-2 sm:grid-cols-9 animate-in fade-in duration-200">
          {KIOSK_ICONS.map((icon) => {
            const on = icon.id === iconId;
            return (
              <button
                key={icon.id}
                type="button"
                title={icon.label.he}
                aria-label={icon.label.he}
                aria-pressed={on}
                onClick={() => {
                  f.set(icon.id);
                  setOpen(false);
                }}
                className={cn(
                  'flex aspect-square items-center justify-center rounded-lg transition-colors',
                  on ? 'bg-primary/15 ring-1 ring-primary' : 'hover:bg-background',
                )}
              >
                <KioskIconSvg id={icon.id} style={style} size={22} color={c.primary} knock={c.surface} />
              </button>
            );
          })}
        </div>
      ) : null}
    </li>
  );
}

function CategoryIconsCard() {
  const t = useTranslations('kiosks.layouts');
  const ed = useKioskEditor();
  const mode = ed.draft.layout?.categoryIcons ?? null;
  const style: KioskIconStyle = mode === 'filled' || mode === 'duotone' ? mode : 'line';
  const categories = ed.catalog?.categories ?? [];
  return (
    <SectionCard title={t('iconsTitle')} description={t('iconsHint')} paths={['catalog.categoryIconIds']}>
      {mode === null || mode === 'none' ? <p className="rounded-xl bg-muted/50 p-2 text-xs text-muted-foreground">{t('iconsOff')}</p> : null}
      {categories.length === 0 ? (
        <p className="rounded-xl border border-dashed p-4 text-center text-sm text-muted-foreground">{ed.catalogLoading ? t('iconsLoading') : t('iconsNoCatalog')}</p>
      ) : (
        <ul className="divide-y rounded-xl border">
          {categories.map((cat) => (
            <CategoryIconRow key={cat.id} id={cat.id} name={cat.name} style={style} />
          ))}
        </ul>
      )}
    </SectionCard>
  );
}
