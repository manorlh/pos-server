'use client';

/**
 * "מודול עיצוב בון" (P:/specs/kitchen-ticket-designs.md §6ג, §8, §9): every element of a named design,
 * each "לפי התבנית" (the template's own, nothing stored) or a value of its own — the head, each band,
 * the item lines and their fitting, choices and notes, lines and spacing, the order of the lines, the
 * foot and the paper. Mandatory information has no "hidden": only its style changes.
 */

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import type { CategoryRef, CourseRef, Look, OrderEntry, Overrides } from '@/lib/kitchenTicketStyle';
import {
  ALLERGY_STYLES,
  BAND_KEYS,
  BAND_STYLES,
  FEED_LINES,
  FITS,
  FONT_SCALE,
  FOOTER_FIELDS,
  GROUPINGS,
  GROUP_HEADERS,
  HEADER_FILLS,
  HEADER_SIZES,
  HELD_COURSE_STYLES,
  IMPORTANT_NOTE_STYLES,
  INFO_FIELDS,
  ITEM_DIVIDERS,
  LINE_LAYOUTS,
  MAX_LINES_MAX,
  MAX_TEXT_SIZES,
  MIN_TEXT_SIZES,
  MOD_LAYOUTS,
  MOD_MARKS,
  NO_COURSE,
  ORDER_BYS,
  QTY_STYLES,
  SEPARATORS,
  SPACINGS,
  WEIGHTS,
} from '@/lib/kitchenTicketStyle';
import { Label } from '@/components/ui/label';
import { SimpleSelect } from './printer-dialog';
import { OrderListEditor } from './order-list-editor';

const INHERIT = '__template__';

type Path = string[];

export function getPath(obj: unknown, path: Path): unknown {
  return path.reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj);
}

/** `overrides` with `path` set (or removed when `value` is undefined); empty groups dropped. */
export function setPath(overrides: Overrides, path: Path, value: unknown): Overrides {
  const out = JSON.parse(JSON.stringify(overrides ?? {})) as Record<string, unknown>;
  let node = out;
  for (const key of path.slice(0, -1)) {
    if (!node[key] || typeof node[key] !== 'object') node[key] = {};
    node = node[key] as Record<string, unknown>;
  }
  const last = path[path.length - 1];
  if (value === undefined) delete node[last];
  else node[last] = value;
  if (path.length > 1) {
    const parent = path[0];
    if (out[parent] && typeof out[parent] === 'object' && Object.keys(out[parent] as object).length === 0) delete out[parent];
  }
  return out as Overrides;
}

interface EnumControl {
  path: Path;
  label: string;
  values: readonly (string | number | boolean)[];
  /** The message group of the values' labels (values.<group>.<value>). */
  group: string;
}

export function TicketStyleControls({
  base,
  overrides,
  onChange,
  courses,
  categories,
  disabled,
}: {
  /** The template's look: what "לפי התבנית" means. */
  base: Look;
  overrides: Overrides;
  onChange: (next: Overrides) => void;
  courses: CourseRef[];
  categories: CategoryRef[];
  disabled?: boolean;
}) {
  const t = useTranslations('kitchenPrinters.ticketDesign');
  const valueLabel = (group: string, v: string | number | boolean) =>
    group === 'number' ? String(v) : group === 'bool' ? (v ? t('values.on') : t('values.off')) : t(`values.${group}.${String(v)}`);

  const select = (c: EnumControl) => {
    const own = getPath(overrides, c.path);
    const inherited = getPath(base, c.path);
    const options = [
      {
        value: INHERIT,
        label:
          inherited === undefined
            ? t('byParameters')
            : t('byTemplate', { value: valueLabel(c.group, inherited as string) }),
      },
      ...c.values.map((v) => ({ value: String(v), label: valueLabel(c.group, v) })),
    ];
    const parse = (s: string): unknown =>
      c.group === 'bool' ? s === 'true' : c.group === 'number' ? Number(s) : s;
    return (
      <div key={c.path.join('.')} className="space-y-1">
        <Label className="text-xs">{c.label}</Label>
        <SimpleSelect
          value={own === undefined ? INHERIT : String(own)}
          onChange={(v) => onChange(setPath(overrides, c.path, v === INHERIT ? undefined : parse(v)))}
          options={options}
          disabled={disabled}
          ariaLabel={c.label}
        />
      </div>
    );
  };

  const fieldList = (path: Path, all: readonly string[], label: string) => {
    const own = getPath(overrides, path) as string[] | undefined;
    const current = own ?? (getPath(base, path) as string[]);
    const toggle = (field: string, on: boolean) => {
      const next = on ? all.filter((f) => f === field || current.includes(f)) : current.filter((f) => f !== field);
      onChange(setPath(overrides, path, next));
    };
    return (
      <div className="space-y-1">
        <div className="flex items-center justify-between gap-2">
          <Label className="text-xs">{label}</Label>
          {own !== undefined ? (
            <button
              type="button"
              className="text-xs text-primary hover:underline"
              disabled={disabled}
              onClick={() => onChange(setPath(overrides, path, undefined))}
            >
              {t('backToTemplate')}
            </button>
          ) : (
            <span className="text-xs text-muted-foreground">{t('templatesOwn')}</span>
          )}
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {all.map((field) => {
            const mandatory = field === 'table' && path[0] === 'header';
            return (
              <label key={field} className="flex items-center gap-1.5 text-sm">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-primary"
                  checked={mandatory || current.includes(field)}
                  disabled={disabled || mandatory}
                  onChange={(e) => toggle(field, e.target.checked)}
                />
                {t(`values.info.${field}`)}
              </label>
            );
          })}
        </div>
      </div>
    );
  };

  const section = (title: string, children: ReactNode, hint?: string) => (
    <fieldset className="space-y-2 rounded-lg border p-3">
      <legend className="px-1 text-sm font-semibold">{title}</legend>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      {children}
    </fieldset>
  );
  const grid = (controls: EnumControl[]) => <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{controls.map(select)}</div>;
  const f = (key: string) => t(`fields.${key}`);
  const ownOrder = (getPath(overrides, ['order', 'by']) ?? base.order.by) as string;
  const orderList = (getPath(overrides, ['order', 'list']) as OrderEntry[] | undefined) ?? base.order.list;

  return (
    <div className="space-y-3">
      {section(
        t('groups.header'),
        <>
          {grid([
            { path: ['header', 'size'], label: f('headerSize'), values: HEADER_SIZES, group: 'size' },
            { path: ['header', 'fill'], label: f('headerFill'), values: HEADER_FILLS, group: 'fill' },
            { path: ['header', 'layout'], label: f('headerLayout'), values: LINE_LAYOUTS, group: 'layout' },
            { path: ['elapsed'], label: f('elapsed'), values: [true, false], group: 'bool' },
          ])}
          {fieldList(['header', 'fields'], INFO_FIELDS, f('header'))}
        </>,
      )}
      {section(
        t('groups.bands'),
        grid(BAND_KEYS.map((k) => ({ path: ['bands', k], label: t(`bands.${k}`), values: BAND_STYLES, group: 'band' }))),
        t('mandatory'),
      )}
      {section(
        t('groups.items'),
        grid([
          { path: ['fit'], label: f('fit'), values: FITS, group: 'fit' },
          { path: ['itemName', 'maxSize'], label: f('maxSize'), values: MAX_TEXT_SIZES, group: 'size' },
          { path: ['itemName', 'minSize'], label: f('minSize'), values: MIN_TEXT_SIZES, group: 'size' },
          {
            path: ['itemName', 'maxLines'], label: f('maxLines'),
            values: Array.from({ length: MAX_LINES_MAX + 1 }, (_, i) => i), group: 'number',
          },
          { path: ['qty'], label: f('qty'), values: QTY_STYLES, group: 'qty' },
          { path: ['layout', 'qtyColumn'], label: f('qtyColumn'), values: [true, false], group: 'bool' },
          { path: ['layout', 'hangingIndent'], label: f('hangingIndent'), values: [true, false], group: 'bool' },
          { path: ['checkboxes'], label: f('checkboxes'), values: [true, false], group: 'bool' },
          {
            path: ['fontScale'], label: f('fontScale'),
            values: [80, 90, 100, 110, 120, 130, 140, 150].filter((n) => n >= FONT_SCALE.min && n <= FONT_SCALE.max), group: 'number',
          },
        ]),
      )}
      {section(
        t('groups.mods'),
        grid([
          { path: ['mods', 'layout'], label: f('modsLayout'), values: MOD_LAYOUTS, group: 'modsLayout' },
          { path: ['mods', 'marks'], label: f('modsMarks'), values: MOD_MARKS, group: 'modsMarks' },
          { path: ['note', 'frame'], label: f('noteFrame'), values: [true, false], group: 'bool' },
          { path: ['note', 'important'], label: f('important'), values: IMPORTANT_NOTE_STYLES, group: 'important' },
          { path: ['allergy'], label: f('allergy'), values: ALLERGY_STYLES, group: 'allergy' },
        ]),
      )}
      {section(
        t('groups.lines'),
        grid([
          { path: ['separators'], label: f('separators'), values: SEPARATORS, group: 'separators' },
          { path: ['separatorWeight'], label: f('separatorWeight'), values: WEIGHTS, group: 'weight' },
          { path: ['itemDivider'], label: f('itemDivider'), values: ITEM_DIVIDERS, group: 'itemDivider' },
          { path: ['spacing'], label: f('spacing'), values: SPACINGS, group: 'spacing' },
        ]),
      )}
      {section(
        t('groups.order'),
        <>
          {grid([
            { path: ['order', 'by'], label: f('order'), values: ORDER_BYS, group: 'order' },
            { path: ['order', 'groupHeaders'], label: f('groupHeaders'), values: GROUP_HEADERS, group: 'groupHeaders' },
            { path: ['order', 'noCourse'], label: f('noCourse'), values: NO_COURSE, group: 'noCourse' },
            { path: ['grouping'], label: f('grouping'), values: GROUPINGS, group: 'grouping' },
            { path: ['heldCourse'], label: f('heldCourse'), values: HELD_COURSE_STYLES, group: 'heldCourse' },
            { path: ['totals'], label: f('totals'), values: [true, false], group: 'bool' },
          ])}
          {ownOrder === 'custom' ? (
            <div className="space-y-1">
              <Label className="text-xs">{f('orderList')}</Label>
              <OrderListEditor
                value={orderList}
                onChange={(next) => onChange(setPath(overrides, ['order', 'list'], next.map((e) => ({ kind: e.kind, id: e.id }))))}
                courses={courses}
                categories={categories}
                disabled={disabled}
              />
            </div>
          ) : null}
        </>,
        t('orderHint'),
      )}
      {section(
        t('groups.footer'),
        <>
          {grid([
            { path: ['footer', 'layout'], label: f('footerLayout'), values: LINE_LAYOUTS, group: 'layout' },
            {
              path: ['feedLines'], label: f('feedLines'),
              values: Array.from({ length: FEED_LINES.max - FEED_LINES.min + 1 }, (_, i) => FEED_LINES.min + i), group: 'number',
            },
            { path: ['inkSaver'], label: f('inkSaver'), values: [true, false], group: 'bool' },
          ])}
          {fieldList(['footer', 'fields'], FOOTER_FIELDS, f('footerFields'))}
        </>,
        t('inkSaverHint'),
      )}
    </div>
  );
}
