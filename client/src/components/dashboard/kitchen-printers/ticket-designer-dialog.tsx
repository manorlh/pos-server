'use client';

/**
 * "מודול עיצוב בון" — one named design of the company (P:/specs/kitchen-ticket-designs.md §6ג, §8,
 * §9): its name, the template it is based on, every element it changes, and the live preview at 58
 * and 80 mm with the estimated length and the share of solid black; "הדפסת ניסיון" of what is on the
 * screen now (saved or not) on a printer of the shop.
 */

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Printer, RotateCcw } from 'lucide-react';
import {
  ORDER_SAMPLE,
  ORDER_SAMPLE_CATEGORIES,
  ORDER_SAMPLE_COURSES,
  SAMPLE_TICKET,
  resolveStyle,
  templateStyle,
  type CategoryRef,
  type CourseRef,
  type Overrides,
  type TemplateKey,
} from '@/lib/kitchenTicketStyle';
import {
  createTicketDesign,
  testKitchenPrinter,
  updateTicketDesign,
  type KitchenPrintersPage,
  type TicketDesign,
} from '@/lib/kitchenPrintersApi';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { keyRing } from '@/lib/deviceCommands';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { SimpleSelect } from './printer-dialog';
import { TicketDesignPicker, type DesignChoice } from './ticket-design-picker';
import { TicketPreviewPair } from './ticket-preview';
import { TicketStyleControls } from './ticket-style-controls';
import { orderNames, shopTicketParams } from './ticket-design-section';

const NONE = '__none__';

export function TicketDesignerDialog({
  page,
  companyId,
  design,
  courses,
  categories,
  onClose,
  onSaved,
}: {
  page: KitchenPrintersPage;
  companyId: string;
  /** null: a new design. */
  design: TicketDesign | null;
  courses: CourseRef[];
  categories: CategoryRef[];
  onClose: () => void;
  onSaved: (design: TicketDesign) => void;
}) {
  const t = useTranslations('kitchenPrinters.ticketDesign');
  const tc = useTranslations('common');
  const [name, setName] = useState(design?.name ?? '');
  const [template, setTemplate] = useState<TemplateKey>(design?.template ?? 'classic');
  const [overrides, setOverrides] = useState<Overrides>(design?.overrides ?? {});
  const [sample, setSample] = useState<'table' | 'order'>('table');
  const kitchen = page.printers.filter((p) => (p.purpose ?? 'kitchen') === 'kitchen' && p.isActive);
  const [testPrinter, setTestPrinter] = useState<string>(kitchen[0]?.id ?? NONE);
  const [error, setError] = useState<string | null>(null);

  const names = useMemo(() => orderNames(courses, categories), [courses, categories]);
  const params = useMemo(() => shopTicketParams(page.ticketOptions), [page.ticketOptions]);
  const style = useMemo(
    () => resolveStyle(template, { params, overrides, designId: design?.id, designName: name.trim() || null, names }),
    [template, params, overrides, design?.id, name, names],
  );
  const base = useMemo(() => templateStyle(template), [template]);
  const previewCourses = sample === 'order' ? [...ORDER_SAMPLE_COURSES, ...courses] : courses;
  const previewCategories = sample === 'order' ? [...ORDER_SAMPLE_CATEGORIES, ...categories] : categories;

  const save = useMutation({
    mutationFn: () => {
      const body = { name: name.trim(), template, overrides };
      return design ? updateTicketDesign(design.id, body) : createTicketDesign({ ...body, companyId });
    },
    onSuccess: (saved) => {
      toast.success(t('designer.saved'));
      onSaved(saved);
    },
    onError: (err: unknown) => {
      const e = err as { response?: { data?: { detail?: unknown } } };
      setError(e?.response?.data?.detail === 'design_name_taken' ? t('designer.nameTaken') : axiosErrorToToastMessage(err, tc('error')));
    },
  });

  const [testKeys] = useState(() => keyRing());
  const test = useMutation({
    mutationFn: () => {
      const request = { ticketDesignId: design?.id ?? null, template, overrides };
      return testKitchenPrinter(testPrinter, testKeys.keyFor({ printerId: testPrinter, ...request }), {
        ...(design ? { ticketDesignId: design.id } : {}),
        template,
        overrides,
      });
    },
    onSuccess: (jobs) => {
      testKeys.forget();
      if (jobs.length === 0) toast.error(t('test.noTill'));
      else toast.success(t('test.sent', { count: jobs.length }));
    },
    onError: (err: unknown) => {
      const e = err as { response?: { data?: { detail?: unknown } } };
      toast.error(e?.response?.data?.detail === 'printer_has_no_till' ? t('test.noTill') : axiosErrorToToastMessage(err, tc('error')));
    },
  });

  const submit = () => {
    setError(null);
    if (!name.trim()) return setError(t('designer.nameRequired'));
    save.mutate();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-6xl">
        <DialogHeader>
          <DialogTitle>{design ? t('designer.titleEdit') : t('designer.titleNew')}</DialogTitle>
          <DialogDescription>{t('designer.hint')}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,30rem)]">
          <div className="min-w-0 space-y-3">
            <div className="space-y-1">
              <Label htmlFor="ktd-name">{t('designer.name')}</Label>
              <Input
                id="ktd-name"
                value={name}
                maxLength={60}
                placeholder={t('designer.namePlaceholder')}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <div className="flex items-center justify-between gap-2">
                <Label>{t('designer.template')}</Label>
                {Object.keys(overrides).length > 0 ? (
                  <Button type="button" size="sm" variant="ghost" onClick={() => setOverrides({})}>
                    <RotateCcw className="h-3.5 w-3.5" /> {t('designer.reset')}
                  </Button>
                ) : null}
              </div>
              <TicketDesignPicker
                value={`template:${template}` as DesignChoice}
                onChange={(choice) => choice.startsWith('template:') && setTemplate(choice.slice(9) as TemplateKey)}
              />
            </div>
            <TicketStyleControls
              base={base}
              overrides={overrides}
              onChange={setOverrides}
              courses={courses}
              categories={categories}
            />
          </div>

          <div className="min-w-0 space-y-3 lg:sticky lg:top-0 lg:self-start">
            <div className="flex flex-wrap items-center gap-2">
              <SimpleSelect
                value={sample}
                onChange={(v) => setSample(v === 'order' ? 'order' : 'table')}
                options={[
                  { value: 'table', label: t('preview.sampleTable') },
                  { value: 'order', label: t('preview.sampleOrder') },
                ]}
                ariaLabel={t('preview.sample')}
              />
            </div>
            <TicketPreviewPair
              ticket={sample === 'table' ? SAMPLE_TICKET : ORDER_SAMPLE}
              style={style}
              printerName={t('preview.printer')}
              courses={previewCourses}
              categories={previewCategories}
            />
            <div className="space-y-1 rounded-md border p-2">
              <Label className="text-xs">{t('test.choosePrinter')}</Label>
              <div className="flex flex-wrap items-center gap-2">
                <div className="min-w-40 flex-1">
                  <SimpleSelect
                    value={testPrinter}
                    onChange={setTestPrinter}
                    options={
                      kitchen.length
                        ? kitchen.map((p) => ({ value: p.id, label: p.name }))
                        : [{ value: NONE, label: t('test.noPrinter') }]
                    }
                    disabled={kitchen.length === 0}
                    ariaLabel={t('test.choosePrinter')}
                  />
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={testPrinter === NONE || test.isPending}
                  onClick={() => test.mutate()}
                >
                  <Printer className="h-3.5 w-3.5" /> {t('test.button')}
                </Button>
              </div>
            </div>
          </div>
        </div>

        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={save.isPending}>
            {tc('cancel')}
          </Button>
          <Button onClick={submit} disabled={save.isPending}>
            {save.isPending ? tc('saving') : tc('save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
