'use client';

/**
 * "עיצוב בון" in the printer dialog (P:/specs/kitchen-ticket-designs.md §3, §4, §8, §9): the designs
 * side by side — "לפי ההגדרה הכללית", the templates, the company's named designs — this printer's own
 * options over the design, the live preview at 58 and 80 mm (this printer's paper marked) and
 * "הדפסת ניסיון בעיצוב הזה": the sample ticket, in what the dialog shows now, on this printer.
 */

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Printer } from 'lucide-react';
import {
  FITS,
  GROUP_HEADERS,
  HEADER_SIZES,
  INFO_FIELDS,
  MAX_TEXT_SIZES,
  MIN_TEXT_SIZES,
  NO_COURSE,
  ORDER_BYS,
  ORDER_SAMPLE,
  ORDER_SAMPLE_CATEGORIES,
  ORDER_SAMPLE_COURSES,
  PARAM_KEYS,
  SAMPLE_TICKET,
  isTemplate,
  resolveStyle,
  type CategoryRef,
  type CourseRef,
  type KitchenTicket,
  type TemplateKey,
  type TicketOptions,
  type TicketStyle,
} from '@/lib/kitchenTicketStyle';
import {
  testKitchenPrinter,
  type KitchenOptions,
  type KitchenPrinter,
  type KitchenPrintersPage,
  type PrinterTicketFields,
  type TicketDesign,
} from '@/lib/kitchenPrintersApi';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { keyRing } from '@/lib/deviceCommands';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { SimpleSelect } from './printer-dialog';
import { OrderListEditor } from './order-list-editor';
import { INHERIT_CHOICE, TicketDesignPicker, type DesignChoice } from './ticket-design-picker';
import { TicketPreviewPair } from './ticket-preview';

const INHERIT = '__inherit__';

/** The design's till parameters set at the shop or its company (what a printer of the shop inherits). */
export function shopTicketParams(options?: KitchenOptions | null): Record<string, unknown> {
  if (!options) return {};
  const out: Record<string, unknown> = {};
  for (const key of Object.values(PARAM_KEYS)) {
    if (options.shop[key] !== undefined) out[key] = options.shop[key];
    else if (options.fromCompany.includes(key)) out[key] = options.inherited[key];
  }
  return out;
}

/** `kitchenTicketDesign`'s value → (template, design). */
export function designOfParam(value: unknown, designs: TicketDesign[]): { template: TemplateKey; design: TicketDesign | null } {
  if (isTemplate(value)) return { template: value, design: null };
  const design = designs.find((d) => d.id === String(value ?? '').toLowerCase()) ?? null;
  return design ? { template: design.template, design } : { template: 'classic', design: null };
}

export function choiceOf(fields: PrinterTicketFields): DesignChoice {
  if (fields.ticketDesignId) return `design:${fields.ticketDesignId}`;
  if (fields.ticketDesign) return `template:${fields.ticketDesign}`;
  return INHERIT_CHOICE;
}

export function printerOptions(fields: PrinterTicketFields): TicketOptions {
  return {
    fontScale: fields.ticketFontScale ?? null,
    header: fields.ticketHeader ?? null,
    checkboxes: fields.ticketCheckboxes ?? null,
    elapsed: fields.ticketElapsed ?? null,
    fit: fields.ticketFit ?? null,
    minTextSize: fields.ticketMinTextSize ?? null,
    maxTextSize: fields.ticketMaxTextSize ?? null,
    headerSize: fields.ticketHeaderSize ?? null,
    inlineMods: fields.ticketInlineMods ?? null,
    order: fields.ticketOrder ?? null,
    orderList: fields.ticketOrderList ?? null,
    groupHeaders: fields.ticketGroupHeaders ?? null,
    noCourse: fields.ticketNoCourse ?? null,
  };
}

/** `${kind}:${id}` → name, for the order list's headings. */
export function orderNames(courses: CourseRef[], categories: CategoryRef[]): Record<string, string> {
  return Object.fromEntries([
    ...courses.map((c) => [`course:${c.id}`, c.name]),
    ...categories.map((c) => [`category:${c.id}`, c.name ?? '']),
  ]);
}

/** What a printer with these fields prints in, on a till of this shop with no levels below the shop. */
export function printerStyle(page: KitchenPrintersPage, fields: PrinterTicketFields, names: Record<string, string>): TicketStyle {
  const params = shopTicketParams(page.ticketOptions);
  const designs = page.ticketDesigns ?? [];
  let template: TemplateKey;
  let design: TicketDesign | null = null;
  if (fields.ticketDesignId) {
    design = designs.find((d) => d.id === fields.ticketDesignId) ?? null;
    template = design?.template ?? 'classic';
  } else if (fields.ticketDesign) template = fields.ticketDesign;
  else ({ template, design } = designOfParam(params[PARAM_KEYS.design], designs));
  return resolveStyle(template, {
    params,
    overrides: design?.overrides,
    designId: design?.id,
    designName: design?.name,
    printer: printerOptions(fields),
    names,
  });
}

export function TicketDesignSection({
  page,
  printer,
  value,
  onChange,
  paperWidth,
  printerName,
  courses,
  categories,
}: {
  page: KitchenPrintersPage;
  printer: KitchenPrinter | null;
  value: PrinterTicketFields;
  onChange: (next: PrinterTicketFields) => void;
  paperWidth: 58 | 80;
  printerName: string;
  courses: CourseRef[];
  categories: CategoryRef[];
}) {
  const t = useTranslations('kitchenPrinters.ticketDesign');
  const tc = useTranslations('common');
  const [sample, setSample] = useState<'table' | 'order'>('table');
  const designs = page.ticketDesigns ?? [];
  const names = useMemo(() => orderNames(courses, categories), [courses, categories]);
  const style = useMemo(() => printerStyle(page, value, names), [page, value, names]);
  const inheritStyle = useMemo(
    () => printerStyle(page, { ...value, ticketDesign: null, ticketDesignId: null }, names),
    [page, value, names],
  );
  const set = (patch: PrinterTicketFields) => onChange({ ...value, ...patch });

  const choose = (choice: DesignChoice) => {
    if (choice === INHERIT_CHOICE) set({ ticketDesign: null, ticketDesignId: null });
    else if (choice.startsWith('template:')) set({ ticketDesign: choice.slice(9) as TemplateKey, ticketDesignId: null });
    else set({ ticketDesign: null, ticketDesignId: choice.slice(7) });
  };

  const [testKeys] = useState(() => keyRing());
  const test = useMutation({
    mutationFn: () => {
      const id = printer!.id;
      return testKitchenPrinter(id, testKeys.keyFor({ printerId: id, design: JSON.stringify(value) }), {
        ticketDesign: value.ticketDesign ?? null,
        ticketDesignId: value.ticketDesignId ?? null,
        ticketFontScale: value.ticketFontScale ?? null,
        ticketHeader: value.ticketHeader ?? null,
        ticketCheckboxes: value.ticketCheckboxes ?? null,
        ticketElapsed: value.ticketElapsed ?? null,
        ticketFit: value.ticketFit ?? null,
        ticketMinTextSize: value.ticketMinTextSize ?? null,
        ticketMaxTextSize: value.ticketMaxTextSize ?? null,
        ticketHeaderSize: value.ticketHeaderSize ?? null,
        ticketInlineMods: value.ticketInlineMods ?? null,
        ticketOrder: value.ticketOrder ?? null,
        ticketOrderList: value.ticketOrderList ?? null,
        ticketGroupHeaders: value.ticketGroupHeaders ?? null,
        ticketNoCourse: value.ticketNoCourse ?? null,
      });
    },
    onSuccess: (jobs) => {
      testKeys.forget({ printerId: printer!.id, design: JSON.stringify(value) });
      if (jobs.length === 0) toast.error(t('test.noTill'));
      else toast.success(t('test.sent', { count: jobs.length }));
    },
    onError: (err: unknown) => {
      const e = err as { response?: { data?: { detail?: unknown } } };
      toast.error(e?.response?.data?.detail === 'printer_has_no_till' ? t('test.noTill') : axiosErrorToToastMessage(err, tc('error')));
    },
  });

  /** One of this printer's own options: "לפי העיצוב" (null) or a value. */
  const option = <K extends keyof PrinterTicketFields>(key: K, label: string, values: readonly string[], group: string) => {
    const own = value[key];
    const bool = group === 'bool';
    return (
      <div key={String(key)} className="space-y-1">
        <Label className="text-xs">{label}</Label>
        <SimpleSelect
          value={own === null || own === undefined ? INHERIT : String(own)}
          onChange={(v) =>
            set({ [key]: v === INHERIT ? null : bool ? v === 'true' : group === 'number' ? Number(v) : v } as PrinterTicketFields)
          }
          options={[
            { value: INHERIT, label: t('byDesign') },
            ...values.map((v) => ({
              value: v,
              label: bool ? (v === 'true' ? t('values.on') : t('values.off')) : group === 'number' ? `${v}%` : t(`values.${group}.${v}`),
            })),
          ]}
          ariaLabel={label}
        />
      </div>
    );
  };
  const f = (k: string) => t(`fields.${k}`);
  const header = value.ticketHeader ?? null;
  const ticket: KitchenTicket = sample === 'table' ? SAMPLE_TICKET : ORDER_SAMPLE;

  return (
    <section className="space-y-3 rounded-lg border p-3">
      <div>
        <h3 className="text-sm font-semibold">{t('title')}</h3>
        <p className="text-xs text-muted-foreground">{t('printerHint')}</p>
      </div>
      <TicketDesignPicker value={choiceOf(value)} onChange={choose} designs={designs} withInherit inheritStyle={inheritStyle} />

      <details className="rounded-md border p-2">
        <summary className="cursor-pointer text-sm font-medium">{t('options')}</summary>
        <p className="mt-1 text-xs text-muted-foreground">{t('optionsHint')}</p>
        <div className="mt-2 grid gap-2 sm:grid-cols-3">
          {option('ticketFontScale', f('fontScale'), ['80', '90', '100', '110', '120', '130', '140', '150'], 'number')}
          {option('ticketFit', f('fit'), FITS, 'fit')}
          {option('ticketMaxTextSize', f('maxSize'), MAX_TEXT_SIZES, 'size')}
          {option('ticketMinTextSize', f('minSize'), MIN_TEXT_SIZES, 'size')}
          {option('ticketHeaderSize', f('headerSize'), HEADER_SIZES, 'size')}
          {option('ticketInlineMods', f('inlineMods'), ['true', 'false'], 'bool')}
          {option('ticketCheckboxes', f('checkboxes'), ['true', 'false'], 'bool')}
          {option('ticketElapsed', f('elapsed'), ['true', 'false'], 'bool')}
          {option('ticketOrder', f('order'), ORDER_BYS, 'order')}
          {option('ticketGroupHeaders', f('groupHeaders'), GROUP_HEADERS, 'groupHeaders')}
          {option('ticketNoCourse', f('noCourse'), NO_COURSE, 'noCourse')}
        </div>
        <div className="mt-2 space-y-1">
          <div className="flex items-center justify-between gap-2">
            <Label className="text-xs">{f('header')}</Label>
            <label className="flex items-center gap-1.5 text-xs">
              <input
                type="checkbox"
                className="h-4 w-4 accent-primary"
                checked={header === null}
                onChange={(e) => set({ ticketHeader: e.target.checked ? null : [...INFO_FIELDS] })}
              />
              {t('byDesign')}
            </label>
          </div>
          {header !== null ? (
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {INFO_FIELDS.map((field) => (
                <label key={field} className="flex items-center gap-1.5 text-sm">
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-primary"
                    checked={field === 'table' || header.includes(field)}
                    disabled={field === 'table'}
                    onChange={(e) =>
                      set({
                        ticketHeader: INFO_FIELDS.filter((x) => (x === field ? e.target.checked : x === 'table' || header.includes(x))),
                      })
                    }
                  />
                  {t(`values.info.${field}`)}
                </label>
              ))}
            </div>
          ) : null}
        </div>
        {value.ticketOrder === 'custom' ? (
          <div className="mt-2 space-y-1">
            <Label className="text-xs">{f('orderList')}</Label>
            <OrderListEditor
              value={value.ticketOrderList ?? []}
              onChange={(next) => set({ ticketOrderList: next.map((e) => ({ kind: e.kind, id: e.id })) })}
              courses={courses}
              categories={categories}
            />
          </div>
        ) : null}
      </details>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <SimpleSelect
          value={sample}
          onChange={(v) => setSample(v === 'order' ? 'order' : 'table')}
          options={[
            { value: 'table', label: t('preview.sampleTable') },
            { value: 'order', label: t('preview.sampleOrder') },
          ]}
          ariaLabel={t('preview.sample')}
        />
        {printer ? (
          <Button type="button" size="sm" variant="outline" disabled={test.isPending || !printer.isActive} onClick={() => test.mutate()}>
            <Printer className="h-3.5 w-3.5" /> {t('test.button')}
          </Button>
        ) : (
          <span className="text-xs text-muted-foreground">{t('test.saveFirst')}</span>
        )}
      </div>
      <TicketPreviewPair
        ticket={ticket}
        style={style}
        printerName={printerName || t('preview.printer')}
        courses={sample === 'order' ? [...ORDER_SAMPLE_COURSES, ...courses] : courses}
        categories={sample === 'order' ? [...ORDER_SAMPLE_CATEGORIES, ...categories] : categories}
        current={paperWidth}
      />
    </section>
  );
}
