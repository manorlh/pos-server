'use client';

/**
 * The editor's LIVE preview: the public `CardView` itself, fed by the same resolver the public
 * page uses (lib/businessCards.ts, pinned to the server's by a golden fixture), on the unsaved
 * draft — in phone / tablet / desktop frames, in each of the card's languages, at a chosen date.
 *
 * Two modes, never mixed: "עריכה" (a click selects the section for editing) and "סימולציה"
 * (a click shows what the visitor's action would do — nothing is dialled, sent or stored).
 */
import { Monitor, RotateCcw, Smartphone, Tablet, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';

import { CARD_FONT_VARIABLES } from '@/components/business-cards/card-fonts';
import { CardView, EnquiryForm, type CardTarget } from '@/menu-shared/cards';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import type { CardDoc, CardLang, PublicAction, PublicCardModel } from '@/lib/businessCards';
import { previewVcard } from '@/lib/businessCardsApi';

import { Segmented } from './bc-ui';
import { NS } from './field-editors';

export type Device = 'phone' | 'tablet' | 'desktop';

const SIZES: Record<Device, { w: number; h: number; bezel: number; radius: number }> = {
  phone: { w: 390, h: 800, bezel: 12, radius: 40 },
  tablet: { w: 820, h: 1080, bezel: 16, radius: 28 },
  desktop: { w: 1280, h: 800, bezel: 10, radius: 12 },
};

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setW((prev) => (prev === el.clientWidth ? prev : el.clientWidth));
    const ro = new ResizeObserver(read);
    ro.observe(el);
    read();
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

function Frame({ device, maxHeight, children, overlay }: { device: Device; maxHeight: number; children: ReactNode; overlay?: ReactNode }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const s = SIZES[device];
  const scale = width > 0 ? Math.max(0.15, Math.min(1, (width - 2 * s.bezel) / s.w, (maxHeight - 2 * s.bezel) / s.h)) : 0;
  return (
    <div ref={ref} className="w-full">
      {width > 0 ? (
        <div
          className="mx-auto shadow-2xl ring-1 ring-black/10"
          style={{ width: s.w * scale + 2 * s.bezel, height: s.h * scale + 2 * s.bezel, padding: s.bezel, borderRadius: s.radius, background: '#171a20' }}
        >
          <div className="relative overflow-hidden bg-white" style={{ width: s.w * scale, height: s.h * scale, borderRadius: Math.max(4, s.radius - s.bezel) }}>
            <div className="absolute top-0 origin-top-left" style={{ width: s.w, height: s.h, transform: `scale(${scale})`, left: 0 }}>
              {children}
              {overlay}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function CardPreview({
  cardId,
  doc,
  model,
  languages,
  lang,
  onLang,
  editMode,
  onEditMode,
  selected,
  onSelect,
  today,
  onToday,
}: {
  cardId: string;
  doc: CardDoc;
  model: PublicCardModel;
  languages: CardLang[];
  lang: CardLang;
  onLang: (l: CardLang) => void;
  editMode: boolean;
  onEditMode: (v: boolean) => void;
  selected: CardTarget | null;
  onSelect: (t: CardTarget) => void;
  today: string;
  onToday: (d: string) => void;
}) {
  const t = useTranslations(`${NS}.preview`);
  const [device, setDevice] = useState<Device>('phone');
  const [reduced, setReduced] = useState(false);
  const [replay, setReplay] = useState(0);
  const [sim, setSim] = useState<{ text: string; href?: string } | null>(null);
  const [vcf, setVcf] = useState<string | null>(null);
  const [vcfOpen, setVcfOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const maxHeight = typeof window !== 'undefined' ? Math.max(420, window.innerHeight - 200) : 720;

  const simulate = (a: PublicAction, e: MouseEvent<HTMLElement>) => {
    e.preventDefault();
    if (a.type === 'save_contact') {
      setVcf(null);
      setVcfOpen(true);
      void previewVcard(cardId, doc, lang)
        .then(setVcf)
        .catch(() => setVcf('—'));
      return;
    }
    if (a.type === 'share') {
      setSim({ text: t('simShare') });
      return;
    }
    if (a.type === 'enquiry') {
      scrollRef.current?.querySelector('#enquiry')?.scrollIntoView({ block: 'start', behavior: reduced ? 'auto' : 'smooth' });
      return;
    }
    setSim({ text: t('simWouldOpen'), href: a.href ?? undefined });
  };

  const motionKey = `${doc.design.motion.mode}-${doc.design.motion.durationMs}-${replay}-${reduced}`;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <Segmented
          label={t('device')}
          value={device}
          onChange={setDevice}
          options={[
            { value: 'phone', label: <Smartphone aria-label={t('phone')} className="size-4" />, title: t('phone') },
            { value: 'tablet', label: <Tablet aria-label={t('tablet')} className="size-4" />, title: t('tablet') },
            { value: 'desktop', label: <Monitor aria-label={t('desktop')} className="size-4" />, title: t('desktop') },
          ]}
        />
        {languages.length > 1 ? (
          <Segmented
            label={t('language')}
            value={lang}
            onChange={onLang}
            options={languages.map((l) => ({ value: l, label: l === 'he' ? 'עברית' : 'English' }))}
          />
        ) : null}
        <Segmented
          label={t('mode')}
          value={editMode ? 'edit' : 'simulate'}
          onChange={(v) => onEditMode(v === 'edit')}
          options={[
            { value: 'edit', label: t('edit') },
            { value: 'simulate', label: t('simulate') },
          ]}
        />
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
        <label className="flex items-center gap-2">
          <Switch size="sm" checked={reduced} onCheckedChange={(v) => setReduced(!!v)} />
          {t('reducedMotion')}
        </label>
        <label className="flex items-center gap-2">
          {t('date')}
          <input type="date" dir="ltr" value={today} onChange={(e) => e.target.value && onToday(e.target.value)} className="h-7 rounded-md border bg-transparent px-1.5" />
        </label>
        <Button type="button" size="xs" variant="ghost" onClick={() => setReplay((n) => n + 1)}>
          <RotateCcw aria-hidden />
          {t('replay')}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{editMode ? t('editHint') : t('simulateHint')}</p>
      <Frame
        device={device}
        maxHeight={maxHeight}
        overlay={
          sim ? (
            <div className="absolute inset-x-3 bottom-3 z-30 rounded-xl bg-neutral-900/95 p-3 text-sm text-white shadow-xl" dir="rtl" lang="he" role="status">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-semibold">{t('simTitle')}</p>
                  <p>{sim.text}</p>
                  {sim.href ? (
                    <p dir="ltr" className="mt-1 truncate text-start font-mono text-xs text-sky-200">
                      {sim.href}
                    </p>
                  ) : null}
                  <p className="mt-1 text-xs text-white/80">{t('simNothing')}</p>
                </div>
                <button type="button" onClick={() => setSim(null)} aria-label={t('close')} className="rounded p-1 hover:bg-white/10">
                  <X aria-hidden className="size-4" />
                </button>
              </div>
            </div>
          ) : null
        }
      >
        <div ref={scrollRef} className={`${CARD_FONT_VARIABLES} size-full overflow-x-hidden overflow-y-auto overscroll-contain`}>
          <CardView
            key={motionKey}
            model={model}
            mode="preview"
            editMode={editMode}
            selected={selected}
            onSelect={onSelect}
            onAction={simulate}
            onLangChange={onLang}
            forceReducedMotion={reduced}
            renderEnquiry={(enquiry) => <EnquiryForm enquiry={enquiry} lang={model.lang} onSubmit={async () => ({ kind: 'simulated' })} />}
          />
        </div>
      </Frame>
      <Dialog open={vcfOpen} onOpenChange={setVcfOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('simTitle')}</DialogTitle>
            <DialogDescription>{t('simVcf')}</DialogDescription>
          </DialogHeader>
          <pre dir="ltr" className="max-h-80 overflow-auto rounded-lg bg-muted p-3 text-start font-mono text-xs whitespace-pre-wrap">
            {vcf ?? t('loadingVcf')}
          </pre>
          <p className="text-xs text-muted-foreground">{t('simNothing')}</p>
        </DialogContent>
      </Dialog>
    </div>
  );
}
