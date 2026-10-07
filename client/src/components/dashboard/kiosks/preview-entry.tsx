'use client';

/**
 * Typing on the kiosk — the dashboard's live preview and the Windows kiosk (shared through
 * `@/kiosk-shared`, the Android kiosk's KioskKeyboard.kt / KioskEntryWindow.kt): everything a
 * customer types is typed in a window in the middle of the screen, on the kiosk's own keyboard —
 * never the system's: there is no <input> at all (nothing may raise the Windows touch keyboard),
 * the value is drawn with its own caret. A window walks through its steps (the name, then the
 * phone and the table on a digits pad), "המשך" / "דלג" on each, ✕ to close.
 *
 * Every word the customer reads is a kiosk text (`m.txt`, editable in the dashboard). Shared: only
 * React, lucide-react, `lib/kioskConfig` and `lib/kioskKeys` (the model, kiosk_keyboard_layout.json).
 */

import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { ArrowBigUp, ArrowLeft, ChevronRight, Delete, HandCoins, Hash, MessageSquareText, Pencil, Phone, UserRound, X } from 'lucide-react';
import { contrastText, type KioskConfig } from '@/lib/kioskConfig';
import {
  BOTTOM_ROW,
  DIGIT_ROWS,
  KEY,
  KEY_LIMITS,
  firstStrongRtl,
  keyLabel,
  keyRows,
  langFor,
  langTextKey,
  pageOf,
  pageTextKey,
  press,
  SPACE_TEXT_KEY,
  startKeyboard,
  type KioskKey,
  type KioskKeyCap,
  type KioskKeyPage,
  type KioskKeyboardState,
} from '@/lib/kioskKeys';
import type { PreviewModel } from './preview-screens';

const DANGER = '#DC2626';

/** The caret's blink (opacity only; `.k-reduce` keeps it lit). */
export const ENTRY_CSS = `
@keyframes kCaretBlink { 0%, 52% { opacity: 1; } 56%, 96% { opacity: 0; } 100% { opacity: 1; } }
.k-caret { display: inline-block; width: 2px; height: 1.1em; margin-inline: 2px; vertical-align: -0.18em; border-radius: 1px; animation: kCaretBlink 1s linear infinite; }
`;

/** A key's height in CSS px: ≥ 56 on a portrait kiosk (540 across), smaller in the preview's frame. */
export function keyHeight(m: Pick<PreviewModel, 'screen'>): number {
  return Math.max(30, Math.min(60, Math.round(Math.min(m.screen.w * 0.105, m.screen.h * 0.075))));
}

/** A key "pops" when pressed (none with reduce motion). */
function pop(el: HTMLElement, m: PreviewModel, scale = 1.12) {
  if (m.cfg.general.reduceMotion || typeof el.animate !== 'function') return;
  el.animate([{ transform: 'scale(1)' }, { transform: `scale(${scale})` }, { transform: 'scale(1)' }], { duration: 190, easing: 'cubic-bezier(.3,1.5,.5,1)' });
}

/** Acts on the press, then — held — again after 450 ms and every 70 ms until let go (the backspace). */
function useHold(action: () => void) {
  const latest = useRef(action);
  const timer = useRef<number | null>(null);
  useEffect(() => {
    latest.current = action;
  });
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );
  const stop = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };
  const begin = (e: ReactPointerEvent<HTMLElement>) => {
    e.preventDefault();
    stop();
    latest.current();
    const tick = (delay: number) => {
      timer.current = window.setTimeout(() => {
        latest.current();
        tick(70);
      }, delay);
    };
    tick(450);
  };
  return { begin, stop };
}

function KeyButton({ m, cap, page, h, gap, onKey }: { m: PreviewModel; cap: KioskKeyCap; page: KioskKeyPage; h: number; gap: number; onKey: (k: KioskKey) => void }) {
  const k = cap.key;
  const hold = useHold(() => onKey(k));
  const dark = m.cfg.theme.mode === 'dark';
  const special = k.kind !== 'type' && k.kind !== 'space';
  const shiftOn = k.kind === 'shift' && page.shift;
  const style: CSSProperties = {
    flex: `0 0 calc((100% - ${9 * gap}px) * ${cap.width / 10} + ${(cap.width - 1) * gap}px)`,
    height: h,
    borderRadius: Math.min(12, Math.max(6, Math.round(m.radius * 0.6))),
    background: shiftOn ? m.c.primary : special ? (dark ? '#FFFFFF24' : `${m.c.primary}17`) : dark ? '#FFFFFF14' : m.c.surface,
    color: shiftOn ? contrastText(m.c.primary) : m.c.text,
    border: `1px solid ${m.c.border}`,
    boxShadow: dark ? 'none' : '0 1px 0 rgba(17,24,39,0.10)',
    fontSize: Math.round(h * 0.42),
  };
  const icon = { width: Math.round(h * 0.42), height: Math.round(h * 0.42) };
  const content =
    k.kind === 'type' ? (
      keyLabel(k, page)
    ) : k.kind === 'space' ? (
      <span style={{ fontSize: Math.round(h * 0.3), color: m.c.mutedText }}>{m.txt(SPACE_TEXT_KEY)}</span>
    ) : k.kind === 'lang' ? (
      <span className="font-bold" style={{ fontSize: Math.round(h * 0.32), color: m.c.primary }}>
        {m.txt(langTextKey(page))}
      </span>
    ) : k.kind === 'page' ? (
      <span className="font-bold" style={{ fontSize: Math.round(h * 0.32) }}>
        {m.txt(pageTextKey(page))}
      </span>
    ) : k.kind === 'shift' ? (
      <ArrowBigUp style={icon} fill={shiftOn ? 'currentColor' : 'none'} />
    ) : (
      <Delete style={icon} />
    );
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-label={k.kind === 'backspace' ? 'backspace' : k.kind === 'shift' ? 'shift' : undefined}
      className="flex min-w-0 select-none items-center justify-center font-semibold active:brightness-95"
      style={style}
      onPointerDown={(e) => {
        pop(e.currentTarget, m, k.kind === 'space' ? 1.04 : 1.12);
        if (k.kind === 'backspace') {
          hold.begin(e);
          return;
        }
        e.preventDefault();
        onKey(k);
      }}
      onPointerUp={hold.stop}
      onPointerLeave={hold.stop}
      onPointerCancel={hold.stop}
    >
      {content}
    </button>
  );
}

/**
 * The full keyboard: the three character rows always left to right (the Israeli keyboard's ק is at
 * the top left in Hebrew too), the bottom row in the screen's direction (in Hebrew the other
 * language at the right, the backspace at the left). A key acts on the press.
 */
export function KioskKeyboard({ m, kb, onKey }: { m: PreviewModel; kb: KioskKeyboardState; onKey: (k: KioskKey) => void }) {
  const page = pageOf(kb);
  const h = keyHeight(m);
  const gap = Math.max(4, Math.round(h * 0.11));
  const dark = m.cfg.theme.mode === 'dark';
  return (
    <div
      className="flex w-full select-none flex-col"
      style={{ gap, padding: gap, background: dark ? '#00000033' : `${m.c.primary}0D`, borderRadius: Math.min(Math.max(m.radius, 10), 18) }}
    >
      {keyRows(page).map((row, i) => (
        <div key={`${page.lang}-${page.numbers}-${i}`} dir="ltr" className="flex justify-center" style={{ gap }}>
          {row.map((cap, j) => (
            <KeyButton key={j} m={m} cap={cap} page={page} h={h} gap={gap} onKey={onKey} />
          ))}
        </div>
      ))}
      <div className="flex" style={{ gap }}>
        {BOTTOM_ROW.map((cap) => (
          <KeyButton key={cap.key.kind} m={m} cap={cap} page={page} h={h} gap={gap} onKey={onKey} />
        ))}
      </div>
    </div>
  );
}

function DigitKey({ m, d, h, onKey }: { m: PreviewModel; d: string; h: number; onKey: (k: KioskKey) => void }) {
  const back = d === 'BACKSPACE';
  const hold = useHold(() => onKey(KEY.backspace));
  const dark = m.cfg.theme.mode === 'dark';
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-label={back ? 'backspace' : d}
      className="flex select-none items-center justify-center font-bold active:brightness-95"
      style={{
        height: h,
        borderRadius: Math.min(14, Math.max(8, Math.round(m.radius * 0.7))),
        background: back ? (dark ? '#FFFFFF24' : `${m.c.primary}17`) : dark ? '#FFFFFF14' : m.c.surface,
        color: m.c.text,
        border: `1px solid ${m.c.border}`,
        boxShadow: dark ? 'none' : '0 1px 0 rgba(17,24,39,0.10)',
        fontSize: Math.round(h * 0.46),
      }}
      onPointerDown={(e) => {
        pop(e.currentTarget, m, 1.08);
        if (back) {
          hold.begin(e);
          return;
        }
        e.preventDefault();
        onKey(KEY.type(d));
      }}
      onPointerUp={hold.stop}
      onPointerLeave={hold.stop}
      onPointerCancel={hold.stop}
    >
      {back ? <Delete style={{ width: Math.round(h * 0.42), height: Math.round(h * 0.42) }} /> : d}
    </button>
  );
}

/** The digits pad (the phone, the table, a tip amount): 1-9, 0 and the backspace, left to right. */
export function DigitsPad({ m, onKey }: { m: PreviewModel; onKey: (k: KioskKey) => void }) {
  const h = Math.round(keyHeight(m) * 1.05);
  const gap = Math.max(6, Math.round(h * 0.14));
  return (
    <div dir="ltr" className="mx-auto grid w-full select-none grid-cols-3" style={{ gap, maxWidth: h * 6 }}>
      {DIGIT_ROWS.flat().map((d, i) => (d === '' ? <span key={i} /> : <DigitKey key={i} m={m} d={d} h={h} onKey={onKey} />))}
    </div>
  );
}

/* --------------------------------------------------------------- the window */

const STEP_ICONS = { person: UserRound, phone: Phone, table: Hash, note: MessageSquareText, tip: HandCoins } as const;

/** One question in the window. */
export interface EntryStep {
  key: string;
  icon?: keyof typeof STEP_ICONS;
  title: string;
  subtitle?: string | null;
  /** Above the field, at its start (the counter n / max at its end for text). */
  label?: string | null;
  /** Shown, lighter, while nothing is typed. */
  hint: string;
  initial: string;
  max: number;
  /** The digits pad (else the keyboard). */
  digits?: boolean;
  /** After the value (a tip amount's "₪"). */
  suffix?: string;
  /** "דלג" under the main button. */
  optional?: boolean;
  /** A name: each English word starts upper case. */
  capitalizeWords?: boolean;
  /** The main button (default: texts.entryContinue). */
  confirmLabel?: string;
  /** The skip button (default: texts.entrySkip). */
  skipLabel?: string;
  /** Shown under the field from the start (the page found it missing). */
  initialError?: string | null;
  /** The words under the field when the value cannot go on, else null. */
  check?: (value: string) => string | null;
  commit: (value: string) => void;
}

function EntryLogo({ m, size }: { m: PreviewModel; size: number }) {
  if (m.logoUrl) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={m.logoUrl} alt="" draggable={false} className="object-contain" style={{ height: size, maxWidth: size * 4, borderRadius: Math.min(m.radius, 10) }} />;
  }
  return (
    <span className="truncate font-extrabold tracking-wide" style={{ color: m.c.primary, fontSize: Math.round(size * 0.6), maxWidth: size * 6 }}>
      {m.brandName}
    </span>
  );
}

/**
 * A kiosk window's head (the owner's design; the service card, the tip card, the entry window):
 * the business — its logo, else its name in the brand colour — at the start (right in Hebrew),
 * the small caption at the end, then ✕. `start`: before the business (the real kiosk's back).
 */
export function EntryHeader({
  m,
  caption,
  onClose,
  compact,
  start,
}: {
  m: PreviewModel;
  caption: string;
  onClose?: () => void;
  compact?: boolean;
  start?: ReactNode;
}) {
  return (
    <div className="flex shrink-0 items-center gap-3 border-b px-4 py-3" style={{ borderColor: m.c.border }}>
      {start}
      <EntryLogo m={m} size={compact ? 24 : 30} />
      <span className="min-w-0 flex-1 truncate text-end kt-13 font-semibold" style={{ color: m.c.mutedText }}>
        {caption}
      </span>
      {onClose ? (
        <button
          type="button"
          aria-label={m.t('close')}
          onClick={onClose}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-transform duration-150 active:scale-95"
          style={{ background: `${m.c.text}0F`, color: m.c.text }}
        >
          <X className="h-5 w-5" />
        </button>
      ) : null}
    </div>
  );
}

function EntryStepBody({ m, step, compact, onNext }: { m: PreviewModel; step: EntryStep; compact: boolean; onNext: (value: string) => void }) {
  const [kb, setKb] = useState(() => startKeyboard(step.initial, langFor(step.initial, true), step.max, !!step.digits, !!step.capitalizeWords));
  const [error, setError] = useState<string | null>(step.initialError ?? null);
  const onKey = (k: KioskKey) => {
    setKb((s) => press(s, k));
    setError(null);
  };
  const go = () => {
    const value = kb.text.trim();
    const problem = step.check ? step.check(value) : null;
    if (problem) {
      setError(problem);
      return;
    }
    step.commit(value);
    onNext(value);
  };
  const h = keyHeight(m);
  const text = kb.text;
  const rtl = !step.digits && (firstStrongRtl(text) ?? kb.lang === 'he');
  const Icon = STEP_ICONS[step.icon ?? 'person'];
  const caret = <span className="k-caret" style={{ background: m.c.primary }} />;
  const btn = Math.max(44, Math.round(h * 0.95));
  return (
    <div className="flex flex-col gap-3 px-4 pb-4 pt-3">
      {!compact ? (
        <span className="mx-auto flex items-center justify-center" style={{ width: 52, height: 52, borderRadius: 16, background: `${m.c.primary}1F`, color: m.c.primary }}>
          <Icon className="h-6 w-6" />
        </span>
      ) : null}
      <div className="space-y-1 text-center">
        <h2 className="text-2xl font-extrabold leading-tight">{step.title}</h2>
        {step.subtitle ? (
          <p className="kt-13 leading-snug" style={{ color: m.c.mutedText }}>
            {step.subtitle}
          </p>
        ) : null}
      </div>
      <div>
        {step.label || !step.digits ? (
          <div className="mb-1.5 flex items-center justify-between gap-2 kt-13">
            <span className="font-semibold">{step.label ?? ''}</span>
            {!step.digits ? (
              <span dir="ltr" className="tabular-nums" style={{ color: m.c.mutedText }}>
                {text.length} / {step.max}
              </span>
            ) : null}
          </div>
        ) : null}
        <div
          className="flex items-center px-4"
          style={{ minHeight: Math.round(h * 1.15), border: `2px solid ${error ? DANGER : m.c.primary}`, borderRadius: Math.min(Math.max(m.radius, 8), 16), background: m.c.background }}
        >
          <div
            dir={rtl ? 'rtl' : 'ltr'}
            className={`w-full break-words font-semibold ${step.digits ? 'tabular-nums tracking-wider' : ''}`}
            style={{ fontSize: Math.round(h * 0.5), textAlign: step.digits ? 'center' : 'start', lineHeight: 1.25 }}
          >
            {text ? (
              <>
                {text}
                {caret}
                {step.suffix ? <span style={{ color: m.c.mutedText }}> {step.suffix}</span> : null}
              </>
            ) : (
              <>
                {caret}
                <span style={{ color: m.c.mutedText, fontWeight: 400 }}>{step.hint}</span>
              </>
            )}
          </div>
        </div>
        {error ? (
          <p className="mt-1.5 kt-13 font-medium" style={{ color: DANGER }}>
            {error}
          </p>
        ) : null}
      </div>
      {step.digits ? <DigitsPad m={m} onKey={onKey} /> : <KioskKeyboard m={m} kb={kb} onKey={onKey} />}
      <div className="space-y-2">
        <button
          type="button"
          onClick={go}
          className="flex w-full items-center justify-center gap-2 px-4 kt-15 font-bold transition-transform duration-150 active:scale-[0.98]"
          style={{ minHeight: btn, background: m.c.button, color: m.c.buttonText, borderRadius: m.btnRadius }}
        >
          <span>{step.confirmLabel ?? m.txt('entryContinue')}</span>
          <ArrowLeft className="h-5 w-5" />
        </button>
        {step.optional ? (
          <button
            type="button"
            onClick={() => {
              step.commit('');
              onNext('');
            }}
            className="flex w-full items-center justify-center px-4 kt-15 font-semibold transition-transform duration-150 active:scale-[0.98]"
            style={{ minHeight: btn, border: `1.5px solid ${m.c.border}`, color: m.c.text, borderRadius: m.btnRadius }}
          >
            {step.skipLabel ?? m.txt('entrySkip')}
          </button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The window in the middle of the screen (dimmed around, modal): its steps one after the other;
 * after the last one `onFinish` with what each step gave, by its key (the owner closes it), ✕
 * `onClose`. It enters with a pop.
 */
export function EntryWindow({
  m,
  caption,
  steps,
  start = 0,
  onFinish,
  onClose,
}: {
  m: PreviewModel;
  caption: string;
  steps: EntryStep[];
  start?: number;
  onFinish: (given: Record<string, string>) => void;
  onClose: () => void;
}) {
  const [given, setGiven] = useState<Record<string, string>>({});
  const [index, setIndex] = useState(() => Math.min(Math.max(0, start), Math.max(0, steps.length - 1)));
  const card = useRef<HTMLDivElement>(null);
  const reduce = m.cfg.general.reduceMotion;
  useEffect(() => {
    const el = card.current;
    if (!el || reduce || typeof el.animate !== 'function') return;
    el.animate(
      [
        { transform: 'scale(0.9)', opacity: 0 },
        { transform: 'scale(1.02)', opacity: 1, offset: 0.7 },
        { transform: 'scale(1)', opacity: 1 },
      ],
      { duration: 280, easing: 'cubic-bezier(.2,.9,.3,1.2)' },
    );
  }, [reduce]);
  const step = steps[index];
  if (!step) return null;
  const compact = m.screen.h < 720;
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center p-3" style={{ background: 'rgba(0,0,0,0.5)' }}>
      <style>{ENTRY_CSS}</style>
      <div
        ref={card}
        role="dialog"
        aria-modal
        className="relative flex max-h-full w-full flex-col overflow-y-auto [scrollbar-width:none]"
        style={{ maxWidth: 720, background: m.c.surface, color: m.c.text, borderRadius: Math.max(18, m.radius), boxShadow: '0 24px 64px rgba(0,0,0,0.35)' }}
      >
        <EntryHeader m={m} caption={caption} onClose={onClose} compact={compact} />
        {steps.length > 1 ? (
          <div className="flex justify-center gap-1.5 pt-3" aria-hidden>
            {steps.map((s, i) => (
              <span key={s.key} className="h-1.5 rounded-full transition-all duration-200" style={{ width: i === index ? 22 : 6, background: i <= index ? m.c.primary : `${m.c.text}26` }} />
            ))}
          </div>
        ) : null}
        <EntryStepBody
          key={`${index}-${step.key}`}
          m={m}
          step={step}
          compact={compact}
          onNext={(value) => {
            const all = { ...given, [step.key]: value };
            if (index >= steps.length - 1) return onFinish(all);
            setGiven(all);
            setIndex(index + 1);
          }}
        />
      </div>
    </div>
  );
}

/* ---------------------------------------------------- the customer's details */

export type DetailsField = 'name' | 'phone' | 'table';
export type DetailsValues = Record<DetailsField, string>;
export type AskMode = 'optional' | 'required';

/** The till's KioskCustomer.tableAsk: only eat-in; the table's own setting, else "שאל מספר שולחן" = required. */
function tableAsk(cfg: KioskConfig, service: 'take_away' | 'eat_in' | null): AskMode | null {
  if (service !== 'eat_in') return null;
  const own = (cfg.payment as { tableNumber?: string }).tableNumber;
  if (own === 'optional' || own === 'required') return own;
  return cfg.general.askTableNumber ? 'required' : null;
}

/** The details this order asks, in order (name → phone → table), each optional or required. */
export function detailsFields(cfg: KioskConfig, service: 'take_away' | 'eat_in' | null): Array<{ field: DetailsField; mode: AskMode }> {
  const out: Array<{ field: DetailsField; mode: AskMode }> = [];
  const shown = (v: string): v is AskMode => v === 'optional' || v === 'required';
  if (shown(cfg.payment.customerName)) out.push({ field: 'name', mode: cfg.payment.customerName });
  if (shown(cfg.payment.customerPhone)) out.push({ field: 'phone', mode: cfg.payment.customerPhone });
  const table = tableAsk(cfg, service);
  if (table) out.push({ field: 'table', mode: table });
  return out;
}

/** An Israeli phone: 0 and 8–9 more digits (the kiosk's phoneValid). */
export function phoneLooksValid(raw: string): boolean {
  return /^0\d{8,9}$/.test(raw.replace(/[\s-]/g, ''));
}

/** What keeps a detail from going on (texts.fieldRequired / phoneInvalid), else null. */
export function detailsProblem(m: PreviewModel, field: DetailsField, mode: AskMode, value: string, phoneOk: (v: string) => boolean = phoneLooksValid): string | null {
  const v = value.trim();
  if (!v) return mode === 'required' ? m.txt('fieldRequired') : null;
  if (field === 'phone' && !phoneOk(v)) return m.txt('phoneInvalid');
  return null;
}

/** The window's steps for the details asked (the owner's design: "איך לקרוא לכם?", then the phone, the table). */
export function detailsEntrySteps(
  m: PreviewModel,
  fields: Array<{ field: DetailsField; mode: AskMode }>,
  values: DetailsValues,
  set: (field: DetailsField, value: string) => void,
  opts: { errors?: Partial<Record<DetailsField, string | null>>; phoneOk?: (v: string) => boolean } = {},
): EntryStep[] {
  return fields.map(({ field, mode }): EntryStep => {
    const common = {
      key: field,
      initial: values[field],
      optional: mode === 'optional',
      initialError: opts.errors?.[field] ?? null,
      check: (v: string) => detailsProblem(m, field, mode, v, opts.phoneOk),
      commit: (v: string) => set(field, v),
    };
    if (field === 'name') {
      return {
        ...common,
        icon: 'person',
        title: m.txt('nameTitle'),
        subtitle: m.txt('nameSubtitle'),
        label: m.txt('nameLabel'),
        hint: m.txt('nameHint'),
        max: KEY_LIMITS.name,
        capitalizeWords: true,
        confirmLabel: m.txt('nameConfirm'),
        skipLabel: m.txt('nameSkip'),
      };
    }
    if (field === 'phone') {
      return { ...common, icon: 'phone', title: m.txt('phoneTitle'), subtitle: m.txt('customerExplain'), hint: m.txt('phoneHint'), max: KEY_LIMITS.phone, digits: true };
    }
    return { ...common, icon: 'table', title: m.txt('tableTitle'), hint: '', max: KEY_LIMITS.table, digits: true };
  });
}

export interface DetailsRow {
  key: DetailsField;
  label: string;
  value: string;
  hint: string;
  error: string | null;
  required: boolean;
  ltr: boolean;
}

/** The rows of the details page (what was given; a tap opens that question again). */
export function detailsRows(m: PreviewModel, fields: Array<{ field: DetailsField; mode: AskMode }>, values: DetailsValues, errors: Partial<Record<DetailsField, string | null>> = {}): DetailsRow[] {
  return fields.map(({ field, mode }) => ({
    key: field,
    label: field === 'name' ? m.txt('nameLabel') : field === 'phone' ? m.txt('phoneTitle') : m.txt('tableTitle'),
    value: values[field],
    hint: field === 'name' ? m.txt('nameHint') : field === 'phone' ? m.txt('phoneHint') : '—',
    error: errors[field] ?? null,
    required: mode === 'required',
    ltr: field !== 'name',
  }));
}

/**
 * The details page behind the window: what was given, a tap on a line opens that question again,
 * the main button goes on (to payment, or to the next step).
 */
export function DetailsPage({
  m,
  rows,
  onRow,
  button,
  onButton,
  onBack,
}: {
  m: PreviewModel;
  rows: DetailsRow[];
  onRow: (key: DetailsField) => void;
  button: string;
  onButton: () => void;
  onBack?: (() => void) | null;
}) {
  const radius = Math.min(Math.max(m.radius, 8), 18);
  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 px-4 pt-4">
        {onBack ? (
          <button
            type="button"
            aria-label={m.t('back')}
            onClick={onBack}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-transform duration-150 active:scale-95"
            style={{ background: `${m.c.button}1A`, color: m.c.button }}
          >
            <ChevronRight className="h-5 w-5" />
          </button>
        ) : null}
        <h2 className="flex-1 text-xl font-extrabold">{m.txt('customerTitle')}</h2>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4 [scrollbar-width:none]">
        <div className="mx-auto w-full max-w-[720px] space-y-4">
          <p className="kt-13 leading-snug" style={{ color: m.c.mutedText }}>
            {m.txt('customerExplain')}
          </p>
          {rows.map((r) => (
            <button key={r.key} type="button" onClick={() => onRow(r.key)} className="block w-full text-start transition-transform duration-150 active:scale-[0.99]">
              <div className="mb-1.5 kt-15 font-bold">
                {r.label}
                {r.required ? <span style={{ color: DANGER }}> *</span> : null}
              </div>
              <div
                className="flex items-center gap-3 px-4"
                style={{ minHeight: 60, background: m.c.surface, borderRadius: radius, border: `${r.error ? 2 : 1.5}px solid ${r.error ? DANGER : m.c.border}` }}
              >
                <span
                  dir={r.ltr && r.value ? 'ltr' : undefined}
                  className="min-w-0 flex-1 truncate text-lg"
                  style={{ color: r.value ? m.c.text : m.c.mutedText, fontWeight: r.value ? 600 : 400, textAlign: 'start' }}
                >
                  {r.value || r.hint}
                </span>
                <Pencil className="h-5 w-5 shrink-0" style={{ color: m.c.primary }} />
              </div>
              {r.error ? (
                <div className="mt-1 kt-13 font-medium" style={{ color: DANGER }}>
                  {r.error}
                </div>
              ) : null}
            </button>
          ))}
        </div>
      </div>
      <div className="shrink-0 p-3">
        <button
          type="button"
          onClick={onButton}
          className="mx-auto flex w-full max-w-[720px] items-center justify-center gap-2 px-4 py-3 kt-15 font-bold transition-transform duration-150 active:scale-[0.98]"
          style={{ background: m.c.button, color: m.c.buttonText, borderRadius: m.btnRadius }}
        >
          <span>{button}</span>
          <ArrowLeft className="h-5 w-5" />
        </button>
      </div>
    </div>
  );
}

/**
 * The details step (the kiosk's checkout step and the preview's "פרטים" screen): the page, with the
 * window opening by itself on arrival and walking through the questions; its last "המשך" goes on
 * as the page's button would. Going on with something missing opens that question again, its
 * problem shown.
 */
export function DetailsStep({
  m,
  fields,
  values,
  onSet,
  onDone,
  onBack,
  button,
  autoOpen = true,
  phoneOk,
}: {
  m: PreviewModel;
  fields: Array<{ field: DetailsField; mode: AskMode }>;
  values: DetailsValues;
  onSet: (field: DetailsField, value: string) => void;
  onDone: () => void;
  onBack?: (() => void) | null;
  /** The page's main button. */
  button: string;
  autoOpen?: boolean;
  phoneOk?: (v: string) => boolean;
}) {
  const [open, setOpen] = useState<{ at: number; one: boolean } | null>(() => (autoOpen && fields.length > 0 ? { at: 0, one: false } : null));
  const [errors, setErrors] = useState<Partial<Record<DetailsField, string | null>>>({});
  const set = (field: DetailsField, value: string) => {
    setErrors((e) => ({ ...e, [field]: null }));
    onSet(field, value);
  };
  const steps = detailsEntrySteps(m, fields, values, set, { errors, phoneOk });
  /** `given`: what the window's steps were just given (the state has not caught up in the same tap). */
  const goOn = (given: Partial<Record<string, string>> = {}) => {
    const now = { ...values, ...given } as DetailsValues;
    const found = fields.map(({ field, mode }) => ({ field, problem: detailsProblem(m, field, mode, now[field], phoneOk) })).filter((x) => x.problem);
    if (found.length === 0) {
      setOpen(null);
      onDone();
      return;
    }
    setErrors(Object.fromEntries(found.map((x) => [x.field, x.problem])));
    setOpen({ at: fields.findIndex((f) => f.field === found[0].field), one: true });
  };
  const win = open && steps[open.at] ? open : null;
  return (
    <div className="relative h-full">
      <DetailsPage
        m={m}
        rows={detailsRows(m, fields, values, errors)}
        onRow={(key) => setOpen({ at: fields.findIndex((f) => f.field === key), one: true })}
        button={button}
        onButton={() => goOn()}
        onBack={onBack}
      />
      {win ? (
        <EntryWindow
          key={`${win.at}-${win.one}`}
          m={m}
          caption={m.txt('detailsCaption')}
          steps={win.one ? [steps[win.at]] : steps}
          start={win.one ? 0 : win.at}
          onFinish={win.one ? () => setOpen(null) : goOn}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </div>
  );
}

/** The preview's "פרטים" screen (a sample name question when nothing is asked, so its words show). */
export function DetailsPreview({ m, onDone, onBack }: { m: PreviewModel; onDone: () => void; onBack: () => void }) {
  const asked = detailsFields(m.cfg, m.service);
  const fields = asked.length > 0 ? asked : [{ field: 'name' as const, mode: 'optional' as const }];
  const [values, setValues] = useState<DetailsValues>({ name: '', phone: '', table: '' });
  return (
    <DetailsStep
      m={m}
      fields={fields}
      values={values}
      onSet={(field, value) => setValues((v) => ({ ...v, [field]: value }))}
      onDone={onDone}
      onBack={onBack}
      button={m.txt('entryContinue')}
    />
  );
}
