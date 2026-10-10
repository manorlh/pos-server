'use client';

/**
 * The digital business card as a visitor sees it — ONE component for the public page
 * (`/c/<slug>`, components/business-cards/public-card.tsx) and the editor's live preview
 * (components/dashboard/business-cards/card-preview.tsx). It renders a `PublicCardModel`
 * (lib/businessCards.ts `resolveCard`, the server's twin) and nothing else: no fetching, no
 * routing, no dashboard words — and, like `kiosk-shared`, no Next.js, no next-intl, no
 * react-query (`menu-shared/` is the public digital surfaces' shared code, plan §18.3). The card
 * typefaces' CSS variables come from the wrapper (components/business-cards/card-fonts.ts).
 *
 * Modes:
 * - `public`: real links (tel:, wa.me, mailto:, maps, the VCF, files); `onAction` only measures.
 * - `preview`: every action is a button that calls `onAction` — the editor simulates it (no call,
 *   no message, no submission). With `editMode`, a click selects the section for editing instead
 *   (component editing is separate from customer simulation).
 *
 * Responsive by container (Tailwind `@container`), so the editor's phone / tablet / desktop
 * frames lay out exactly like the real screens. RTL Hebrew / LTR English from the model; texts
 * shown in a fallback language carry their own `lang`. Motion honours prefers-reduced-motion.
 */
import { CalendarDays, Clock, FileText, Headset, MapPin, Megaphone, Sparkles } from 'lucide-react';
import type { CSSProperties, MouseEvent, ReactNode } from 'react';

import {
  cardWords,
  type CardFont,
  type CardLang,
  type HoursRow,
  type PublicAction,
  type PublicCardModel,
  type PublicEnquiry,
  type PublicSection,
  type PublicText,
} from '@/lib/businessCards';

import { ACTION_ICONS, PLATFORM_ICONS } from './card-icons';

/** The card's typefaces; the variables are defined by the wrapper's next/font classes. */
export const CARD_FONT_FAMILY: Record<CardFont, string> = {
  heebo: 'var(--font-heebo), system-ui, sans-serif',
  rubik: 'var(--font-bc-rubik), system-ui, sans-serif',
  assistant: 'var(--font-bc-assistant), system-ui, sans-serif',
  frank: 'var(--font-bc-frank), "David", Georgia, serif',
  system: 'system-ui, -apple-system, "Segoe UI", Arial, sans-serif',
};

/** What the editor can select in the preview. */
export type CardTarget = { kind: 'identity' } | { kind: 'actions' } | { kind: 'legal' } | { kind: 'section'; section: PublicSection['kind'] };

export interface CardViewProps {
  model: PublicCardModel;
  mode: 'public' | 'preview';
  /** Public: measurement + share. Preview: the simulation. */
  onAction?: (action: PublicAction, event: MouseEvent<HTMLElement>) => void;
  /** The VCF link (public mode). */
  vcardHref?: string;
  /** The enquiry form (public: the real one; preview: the simulated one). */
  renderEnquiry?: (enquiry: PublicEnquiry) => ReactNode;
  /** Language switch: a link per language (public) or a callback (preview). */
  langHref?: (lang: CardLang) => string;
  onLangChange?: (lang: CardLang) => void;
  /** Preview only: component editing instead of simulation. */
  editMode?: boolean;
  selected?: CardTarget | null;
  onSelect?: (target: CardTarget) => void;
  /** Preview only: behave as if the visitor asked for reduced motion. */
  forceReducedMotion?: boolean;
  /** Fill the viewport (public page) rather than the frame. */
  fullPage?: boolean;
}

const RADIUS = { none: '0px', sm: '6px', md: '12px', lg: '18px', xl: '26px' } as const;
const GAP = { compact: '10px', normal: '14px', airy: '20px' } as const;
const PAD = { compact: '14px', normal: '18px', airy: '24px' } as const;
const SCALE = { sm: 0.94, md: 1, lg: 1.1 } as const;
const COVER_H = { none: 0, sm: 120, md: 180, lg: 240 } as const;
const AVATAR = { sm: 64, md: 88, lg: 116 } as const;

function L({ t, as: Tag = 'span', className }: { t: PublicText | null | undefined; as?: 'span' | 'p' | 'h1' | 'h2' | 'h3' | 'div'; className?: string }) {
  if (!t) return null;
  return (
    <Tag lang={t.lang} className={className}>
      {t.text}
    </Tag>
  );
}

function sameTarget(a: CardTarget | null | undefined, b: CardTarget): boolean {
  if (!a || a.kind !== b.kind) return false;
  return a.kind !== 'section' || (b.kind === 'section' && a.section === b.section);
}

/** "2026-10-20T19:30" → a wall-clock date in the card's language (deterministic: UTC maths). */
export function formatLocalDateTime(value: string | null, lang: CardLang, withTime = true): string {
  if (!value) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/.exec(value);
  if (!m) return value;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0));
  const date = new Intl.DateTimeFormat(lang === 'he' ? 'he-IL' : 'en-GB', {
    timeZone: 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(d);
  return withTime && m[4] ? `${date} · ${m[4]}:${m[5]}` : date;
}

function formatBytes(bytes: number | null): string {
  if (!bytes) return '';
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Consecutive days as one range: [0,1,2,3,4] → "א׳–ה׳". */
export function daysLabel(days: number[], lang: CardLang): string {
  const names = cardWords(lang).days;
  const parts: string[] = [];
  let i = 0;
  while (i < days.length) {
    let j = i;
    while (j + 1 < days.length && days[j + 1] === days[j] + 1) j++;
    parts.push(j - i >= 2 ? `${names[days[i]]}–${names[days[j]]}` : days.slice(i, j + 1).map((d) => names[d]).join(', '));
    i = j + 1;
  }
  return parts.join(', ');
}

export function CardView(props: CardViewProps) {
  const { model, editMode = false, selected, onSelect, forceReducedMotion, fullPage } = props;
  const d = model.design;
  const p = d.palette;
  const w = cardWords(model.lang);
  const wide = model.template !== 'links' && model.template !== 'minimal';

  const vars = {
    '--bc-primary': p.primary,
    '--bc-on-primary': d.onPrimary,
    '--bc-accent': p.accent,
    '--bc-on-accent': d.onAccent,
    '--bc-bg': p.background,
    '--bc-surface': p.surface,
    '--bc-text': p.text,
    '--bc-muted': p.muted,
    '--bc-radius': RADIUS[d.radius],
    '--bc-gap': GAP[d.spacing],
    '--bc-pad': PAD[d.spacing],
    '--bc-motion-ms': `${d.motion.durationMs}ms`,
    fontFamily: CARD_FONT_FAMILY[d.font],
    fontSize: `${16 * SCALE[d.textScale]}px`,
    color: p.text,
    background:
      d.background === 'gradient'
        ? `linear-gradient(170deg, color-mix(in srgb, ${p.primary} 14%, ${p.background}) 0%, ${p.background} 55%)`
        : p.background,
  } as CSSProperties;

  const pick = { editMode, selected, onSelect };
  const header = <Header {...props} words={w} />;
  const actionsSection = model.sections.find((s) => s.kind === 'actions');
  const sections = model.sections.filter((s) => s.kind !== 'actions');
  // Desktop: identity and buttons beside the content (except the single-column templates).
  const blocks = sections.map((s, i) => (
    <Pick key={s.kind} {...pick} target={{ kind: 'section', section: s.kind }} label={String(w[sectionWord(s.kind)])} index={i + 2}>
      <Section section={s} {...props} words={w} />
    </Pick>
  ));

  return (
    <div
      className={`@container ${fullPage ? 'min-h-dvh' : 'min-h-full'} w-full`}
      lang={model.lang}
      dir={model.dir}
      style={vars}
      data-bc-motion={d.motion.mode}
      data-bc-reduced-motion={forceReducedMotion ? 'true' : undefined}
      data-template={model.template}
    >
      <div
        className={`mx-auto w-full ${wide ? 'max-w-[560px] @3xl:max-w-[1040px]' : 'max-w-[560px]'} px-0 pb-8 @md:px-[var(--bc-pad)] @md:pt-[var(--bc-pad)]`}
      >
        <div className={wide ? '@3xl:grid @3xl:grid-cols-[minmax(0,380px)_minmax(0,1fr)] @3xl:items-start @3xl:gap-[calc(var(--bc-gap)*2)]' : ''}>
          <div className={wide ? '@3xl:sticky @3xl:top-[var(--bc-pad)]' : ''}>
            <div
              className="overflow-hidden @md:rounded-[var(--bc-radius)] @md:shadow-[0_10px_40px_-18px_rgba(0,0,0,0.35)]"
              style={{ background: p.surface }}
            >
              <Pick {...pick} target={{ kind: 'identity' }} label={model.header.title?.text ?? w.about} index={0}>
                {header}
              </Pick>
              {actionsSection ? (
                <div className="px-[var(--bc-pad)] pb-[var(--bc-pad)]">
                  <Pick {...pick} target={{ kind: 'actions' }} label={w.enquiry} index={1}>
                    <Actions {...props} words={w} intro={(actionsSection as Extract<PublicSection, { kind: 'actions' }>).intro} />
                  </Pick>
                </div>
              ) : null}
            </div>
          </div>
          <div className="mt-[var(--bc-gap)] flex flex-col gap-[var(--bc-gap)] px-[var(--bc-pad)] @md:px-0 @3xl:mt-0">
            {blocks}
            <Pick {...pick} target={{ kind: 'legal' }} label={w.accessibility} index={sections.length + 2}>
              <Footer {...props} words={w} />
            </Pick>
          </div>
        </div>
      </div>
    </div>
  );
}

/** A block the editor can pick in edit mode: an overlay button over inert content. */
function Pick({
  target,
  label,
  children,
  index,
  editMode,
  selected,
  onSelect,
}: {
  target: CardTarget;
  label: string;
  children: ReactNode;
  index: number;
  editMode: boolean;
  selected?: CardTarget | null;
  onSelect?: (target: CardTarget) => void;
}) {
  const on = sameTarget(selected, target);
  return (
    <div className="bc-anim relative" style={{ '--bc-i': index } as CSSProperties}>
      {children}
      {editMode && onSelect ? (
        <button
          type="button"
          onClick={() => onSelect(target)}
          aria-label={label}
          aria-pressed={on}
          className={`absolute inset-[-4px] z-10 cursor-pointer rounded-[calc(var(--bc-radius)+4px)] outline-2 transition ${
            on ? 'bg-sky-500/5 outline outline-sky-500' : 'outline-transparent hover:outline hover:outline-sky-400/70'
          }`}
        />
      ) : null}
    </div>
  );
}

function sectionWord(kind: PublicSection['kind']): keyof ReturnType<typeof cardWords> {
  switch (kind) {
    case 'actions':
      return 'enquiry';
    case 'announcement':
      return 'announcement';
    case 'about':
      return 'about';
    case 'event':
      return 'event';
    case 'offer':
      return 'offer';
    case 'services':
      return 'services';
    case 'hours':
      return 'hours';
    case 'location':
      return 'location';
    case 'social':
      return 'social';
    case 'files':
      return 'files';
    case 'support':
      return 'support';
    case 'enquiry':
      return 'enquiry';
  }
}

type Inner = CardViewProps & { words: ReturnType<typeof cardWords> };

function Header({ model, words }: Inner) {
  const d = model.design;
  const { title, role, orgLine, avatar, cover } = model.header;
  const coverH = COVER_H[d.cover.height];
  const size = AVATAR[d.avatar.size];
  const shape = d.avatar.shape === 'circle' ? '9999px' : d.avatar.shape === 'rounded' ? 'calc(var(--bc-radius) + 4px)' : '4px';
  const showBand = coverH > 0;
  const overlap = d.avatar.position === 'overlap' && showBand;
  const start = d.avatar.position === 'start';
  const event = model.template === 'event' ? model.sections.find((s) => s.kind === 'event') : undefined;
  const initials = (title?.text ?? '?').trim().slice(0, 1);

  const avatarEl = (
    <div
      className="relative shrink-0 overflow-hidden border-4 bg-[var(--bc-surface)] shadow-sm"
      style={{ width: size, height: size, borderRadius: shape, borderColor: 'var(--bc-surface)' }}
    >
      {avatar ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={avatar.url} alt={avatar.alt?.text ?? title?.text ?? ''} className="size-full object-cover" />
      ) : (
        <div
          aria-hidden
          className="flex size-full items-center justify-center text-[1.9em] font-bold"
          style={{ background: 'var(--bc-primary)', color: 'var(--bc-on-primary)' }}
        >
          {initials}
        </div>
      )}
    </div>
  );

  return (
    <header className="relative">
      {showBand ? (
        <div className="relative w-full overflow-hidden" style={{ height: coverH }}>
          {cover ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={cover.url}
              alt={cover.alt?.text ?? ''}
              className="size-full"
              style={{ objectFit: d.cover.fit, objectPosition: `${d.cover.focusX}% ${d.cover.focusY}%`, background: 'var(--bc-primary)' }}
            />
          ) : (
            <div aria-hidden className="size-full" style={{ background: 'linear-gradient(135deg, var(--bc-primary), var(--bc-accent))' }} />
          )}
          {d.cover.overlay > 0 ? (
            <div aria-hidden className="absolute inset-0" style={{ background: `linear-gradient(180deg, transparent 20%, rgba(0,0,0,${d.cover.overlay / 100}))` }} />
          ) : null}
          {event && event.kind === 'event' && event.startsAt ? (
            <div
              className="absolute bottom-3 start-3 rounded-[var(--bc-radius)] px-3 py-2 text-sm font-semibold shadow"
              style={{ background: 'var(--bc-surface)', color: 'var(--bc-text)' }}
            >
              <CalendarDays aria-hidden className="me-1.5 inline size-4 align-[-3px]" />
              {formatLocalDateTime(event.startsAt, model.lang)}
            </div>
          ) : null}
        </div>
      ) : null}
      <div
        className={`px-[var(--bc-pad)] ${overlap ? '' : 'pt-[var(--bc-pad)]'} ${start ? 'flex items-center gap-4 text-start' : 'flex flex-col items-center text-center'}`}
      >
        {d.avatar.position !== 'start' || avatar || title ? (
          <div className={overlap ? '-mt-[calc(var(--bc-avatar)/2)]' : ''} style={{ '--bc-avatar': `${size}px` } as CSSProperties}>
            {avatarEl}
          </div>
        ) : null}
        <div className={`min-w-0 ${start ? '' : 'mt-3'} pb-[var(--bc-pad)]`}>
          {title ? (
            <h1 lang={title.lang} className="text-[1.6em] font-bold leading-tight break-words">
              {title.text}
            </h1>
          ) : null}
          <L t={role} as="p" className="mt-1 text-[1.02em] font-medium" />
          <L t={orgLine} as="p" className="mt-0.5 text-[0.92em] text-[color:var(--bc-muted)]" />
          {model.template === 'location' && model.contact.address ? (
            <p className="mt-2 flex items-center gap-1 text-[0.92em] text-[color:var(--bc-muted)]">
              <MapPin aria-hidden className="size-4 shrink-0" />
              <L t={model.contact.address} />
            </p>
          ) : null}
          {model.template === 'portrait' ? <ContactList model={model} words={words} /> : null}
        </div>
      </div>
    </header>
  );
}

/** The portrait template's visible contact details (public fields only, from the model). */
function ContactList({ model, words }: { model: PublicCardModel; words: ReturnType<typeof cardWords> }) {
  const c = model.contact;
  const rows: { label: string; value: string; dir?: 'ltr' }[] = [];
  if (c.phone) rows.push({ label: words.phone, value: c.phone.display, dir: 'ltr' });
  if (c.email) rows.push({ label: words.email, value: c.email, dir: 'ltr' });
  if (!rows.length) return null;
  return (
    <dl className="mt-3 grid gap-1 text-[0.9em]">
      {rows.map((r) => (
        <div key={r.label} className="flex justify-center gap-2">
          <dt className="text-[color:var(--bc-muted)]">{r.label}</dt>
          <dd dir={r.dir} className="font-medium">
            {r.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function actionHref(a: PublicAction, props: CardViewProps): string | undefined {
  if (a.type === 'save_contact') return props.vcardHref;
  if (a.type === 'enquiry') return '#enquiry';
  return a.href ?? undefined;
}

function Actions(props: Inner & { intro: PublicText | null }) {
  const { model, mode, onAction, intro } = props;
  const d = model.design;
  const cols = model.actions.length === 1 ? 1 : d.buttons.columns;
  const gridCols = cols === 3 ? 'grid-cols-2 @md:grid-cols-3' : cols === 2 ? 'grid-cols-2' : 'grid-cols-1';
  const iconOnly = d.buttons.content === 'icon';
  return (
    <section aria-label={intro?.text ?? props.words.enquiry}>
      {intro ? <L t={intro} as="h2" className="mb-2 text-center text-[1.05em] font-semibold" /> : null}
      <ul className={`grid ${iconOnly ? 'grid-cols-4 @md:grid-cols-6' : gridCols} gap-2`}>
        {model.actions.map((a) => {
          const Icon = a.type === 'link' && a.platform ? PLATFORM_ICONS[a.platform] : ACTION_ICONS[a.type];
          const primary = a.style === 'primary';
          const style = buttonStyle(d.buttons.style, primary);
          const content = (
            <>
              {d.buttons.content !== 'text' ? <Icon aria-hidden className="size-[1.15em] shrink-0" /> : null}
              <span lang={a.label.lang} className={iconOnly ? 'sr-only' : 'min-w-0 truncate'}>
                {a.label.text}
              </span>
            </>
          );
          const cls = `flex min-h-11 w-full items-center justify-center gap-2 px-3 py-2.5 text-[0.95em] font-semibold transition hover:brightness-95 focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--bc-accent)] ${
            d.buttons.style === 'pill' ? 'rounded-full' : 'rounded-[var(--bc-radius)]'
          }`;
          const span = a.style === 'primary' && cols > 1 && model.actions.filter((x) => x.style === 'primary').length === 1 ? 'col-span-full' : '';
          const href = actionHref(a, props);
          const live = mode === 'public' && href && a.type !== 'share';
          return (
            <li key={a.id} className={span}>
              {live ? (
                <a
                  href={href}
                  className={cls}
                  style={style}
                  target={a.external ? '_blank' : undefined}
                  rel={a.external ? 'noopener noreferrer' : undefined}
                  onClick={(e) => onAction?.(a, e)}
                  title={iconOnly ? a.label.text : undefined}
                >
                  {content}
                </a>
              ) : (
                <button type="button" className={cls} style={style} onClick={(e) => onAction?.(a, e)} title={iconOnly ? a.label.text : undefined}>
                  {content}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function buttonStyle(kind: string, primary: boolean): CSSProperties {
  if (primary || kind === 'filled' || kind === 'pill') {
    return { background: 'var(--bc-primary)', color: 'var(--bc-on-primary)' };
  }
  if (kind === 'outline') {
    return { background: 'transparent', color: 'var(--bc-text)', border: '1.5px solid var(--bc-primary)' };
  }
  return { background: 'color-mix(in srgb, var(--bc-primary) 12%, var(--bc-surface))', color: 'var(--bc-text)' };
}

function Box({ children, accent, id, labelledBy }: { children: ReactNode; accent?: boolean; id?: string; labelledBy?: string }) {
  return (
    <section
      id={id}
      aria-labelledby={labelledBy}
      className="rounded-[var(--bc-radius)] p-[var(--bc-pad)]"
      style={{
        background: 'var(--bc-surface)',
        border: accent ? '2px solid var(--bc-accent)' : '1px solid color-mix(in srgb, var(--bc-text) 10%, transparent)',
      }}
    >
      {children}
    </section>
  );
}

function H2({ id, icon: Icon, children }: { id: string; icon?: typeof Clock; children: ReactNode }) {
  return (
    <h2 id={id} className="mb-2 flex items-center gap-2 text-[1.08em] font-bold">
      {Icon ? <Icon aria-hidden className="size-[1.1em]" /> : null}
      {children}
    </h2>
  );
}

function Section(props: Inner & { section: PublicSection }) {
  const { section: s, model, words: w, mode, onAction } = props;
  const lang = model.lang;
  const hid = `bc-${s.kind}`;
  switch (s.kind) {
    case 'announcement':
      return (
        <Box accent labelledBy={hid}>
          <H2 id={hid} icon={Megaphone}>
            {s.title ? <L t={s.title} /> : w.announcement}
          </H2>
          <L t={s.body} as="p" className="whitespace-pre-line" />
          {s.until ? (
            <p className="mt-1 text-[0.85em] text-[color:var(--bc-muted)]">
              {w.until} {formatLocalDateTime(s.until, lang, false)}
            </p>
          ) : null}
        </Box>
      );
    case 'about':
      return (
        <Box labelledBy={hid}>
          <H2 id={hid}>{w.about}</H2>
          <L t={s.text} as="p" className="whitespace-pre-line leading-relaxed" />
        </Box>
      );
    case 'event':
      return (
        <Box accent labelledBy={hid}>
          <H2 id={hid} icon={CalendarDays}>
            {s.title ? <L t={s.title} /> : w.event}
          </H2>
          <dl className="grid gap-1 text-[0.95em]">
            {s.startsAt ? (
              <div className="flex gap-2">
                <dt className="text-[color:var(--bc-muted)]">{w.starts}</dt>
                <dd className="font-semibold">{formatLocalDateTime(s.startsAt, lang)}</dd>
              </div>
            ) : null}
            {s.endsAt ? (
              <div className="flex gap-2">
                <dt className="text-[color:var(--bc-muted)]">{w.ends}</dt>
                <dd>{formatLocalDateTime(s.endsAt, lang)}</dd>
              </div>
            ) : null}
            {s.venue ? (
              <div className="flex gap-2">
                <dt className="text-[color:var(--bc-muted)]">{w.venue}</dt>
                <dd>
                  <L t={s.venue} />
                </dd>
              </div>
            ) : null}
          </dl>
        </Box>
      );
    case 'offer':
      return (
        <Box accent labelledBy={hid}>
          <H2 id={hid} icon={Sparkles}>
            {s.title ? <L t={s.title} /> : w.offer}
          </H2>
          <L t={s.body} as="p" className="whitespace-pre-line" />
          {s.validUntil ? (
            <p className="mt-1 text-[0.85em] text-[color:var(--bc-muted)]">
              {w.validUntil} {formatLocalDateTime(s.validUntil, lang, false)}
            </p>
          ) : null}
        </Box>
      );
    case 'services':
      return (
        <Box labelledBy={hid}>
          <H2 id={hid}>{w.services}</H2>
          <ul className={`grid gap-2 ${model.template === 'services' ? '@md:grid-cols-2' : ''}`}>
            {s.items.map((it, i) => (
              <li
                key={i}
                className="rounded-[calc(var(--bc-radius)*0.75)] p-3"
                style={{ background: 'color-mix(in srgb, var(--bc-primary) 7%, var(--bc-surface))' }}
              >
                <L t={it.title} as="h3" className="font-semibold" />
                <L t={it.description} as="p" className="mt-0.5 text-[0.9em] text-[color:var(--bc-muted)]" />
              </li>
            ))}
          </ul>
        </Box>
      );
    case 'hours':
      return (
        <Box labelledBy={hid}>
          <H2 id={hid} icon={Clock}>
            {w.hours}
          </H2>
          <HoursList rows={s.rows} lang={lang} />
          <L t={s.note} as="p" className="mt-2 text-[0.88em] text-[color:var(--bc-muted)]" />
        </Box>
      );
    case 'location':
      return (
        <Box labelledBy={hid}>
          <H2 id={hid} icon={MapPin}>
            {w.location}
          </H2>
          <L t={s.address} as="p" />
          {s.navHref ? (
            mode === 'public' ? (
              <a
                href={s.navHref}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2 inline-flex min-h-11 items-center gap-1.5 font-semibold underline underline-offset-4"
                onClick={(e) => {
                  const nav = model.actions.find((a) => a.type === 'navigate');
                  if (nav) onAction?.(nav, e);
                }}
              >
                {w.navigateTo}
              </a>
            ) : (
              <button
                type="button"
                className="mt-2 inline-flex min-h-11 items-center gap-1.5 font-semibold underline underline-offset-4"
                onClick={(e) => {
                  const nav = model.actions.find((a) => a.type === 'navigate') ?? {
                    id: 'navigate', type: 'navigate' as const, label: { text: w.navigateTo, lang }, href: s.navHref, style: 'secondary' as const, external: true, platform: null,
                  };
                  onAction?.(nav, e);
                }}
              >
                {w.navigateTo}
              </button>
            )
          ) : null}
        </Box>
      );
    case 'social':
      return (
        <Box labelledBy={hid}>
          <H2 id={hid}>{w.social}</H2>
          <ul className="flex flex-wrap gap-2">
            {s.links.map((l) => {
              const Icon = PLATFORM_ICONS[l.platform];
              const action: PublicAction = { id: `social-${l.platform}`, type: 'link', label: l.label, href: l.url, style: 'secondary', external: true, platform: l.platform };
              const cls = 'inline-flex min-h-11 items-center gap-1.5 rounded-full px-3.5 text-[0.92em] font-medium';
              const style = { background: 'color-mix(in srgb, var(--bc-primary) 10%, var(--bc-surface))', color: 'var(--bc-text)' };
              return (
                <li key={l.url}>
                  {mode === 'public' ? (
                    <a href={l.url} target="_blank" rel="noopener noreferrer" className={cls} style={style} onClick={(e) => onAction?.(action, e)}>
                      <Icon aria-hidden className="size-4" />
                      <L t={l.label} />
                    </a>
                  ) : (
                    <button type="button" className={cls} style={style} onClick={(e) => onAction?.(action, e)}>
                      <Icon aria-hidden className="size-4" />
                      <L t={l.label} />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </Box>
      );
    case 'files':
      return (
        <Box labelledBy={hid}>
          <H2 id={hid}>{w.files}</H2>
          <ul className="grid gap-2">
            {s.files.map((f) => {
              const action: PublicAction = { id: `file-${f.url}`, type: 'file', label: f.title, href: f.url, style: 'secondary', external: true, platform: null };
              const inner = (
                <>
                  <FileText aria-hidden className="size-5 shrink-0" />
                  <L t={f.title} className="min-w-0 flex-1 truncate font-medium" />
                  {f.bytes ? <span className="text-[0.82em] text-[color:var(--bc-muted)]">{formatBytes(f.bytes)}</span> : null}
                </>
              );
              const cls = 'flex min-h-11 w-full items-center gap-2 rounded-[calc(var(--bc-radius)*0.75)] px-3 py-2 text-start';
              const style = { background: 'color-mix(in srgb, var(--bc-text) 5%, var(--bc-surface))' };
              return (
                <li key={f.url}>
                  {mode === 'public' ? (
                    <a href={f.url} target="_blank" rel="noopener noreferrer" className={cls} style={style} onClick={(e) => onAction?.(action, e)}>
                      {inner}
                    </a>
                  ) : (
                    <button type="button" className={cls} style={style} onClick={(e) => onAction?.(action, e)}>
                      {inner}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </Box>
      );
    case 'support':
      return (
        <Box labelledBy={hid}>
          <H2 id={hid} icon={Headset}>
            {w.support}
          </H2>
          {s.phone ? (
            mode === 'public' ? (
              <a href={`tel:${s.phone.e164}`} dir="ltr" className="inline-flex min-h-11 items-center font-semibold underline underline-offset-4">
                {s.phone.display}
              </a>
            ) : (
              <p dir="ltr" className="font-semibold">
                {s.phone.display}
              </p>
            )
          ) : null}
          <L t={s.hours} as="p" className="text-[0.92em]" />
          <L t={s.note} as="p" className="mt-1 text-[0.92em] text-[color:var(--bc-muted)]" />
          {s.url && mode === 'public' ? (
            <a href={s.url} target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex min-h-11 items-center underline underline-offset-4">
              {w.support}
            </a>
          ) : null}
        </Box>
      );
    case 'enquiry':
      return model.enquiry && props.renderEnquiry ? (
        <Box id="enquiry" labelledBy={hid}>
          <H2 id={hid}>{w.enquiry}</H2>
          <L t={s.intro} as="p" className="mb-3 text-[0.92em] text-[color:var(--bc-muted)]" />
          {props.renderEnquiry(model.enquiry)}
        </Box>
      ) : null;
    case 'actions':
      return null;
  }
}

function HoursList({ rows, lang }: { rows: HoursRow[]; lang: CardLang }) {
  return (
    <dl className="grid gap-1">
      {rows.map((r, i) => (
        <div key={i} className="flex items-baseline justify-between gap-3 border-b border-dashed border-[color:color-mix(in_srgb,var(--bc-text)_14%,transparent)] py-1 last:border-0">
          <dt>{daysLabel(r.days, lang)}</dt>
          <dd dir="ltr" className="font-medium tabular-nums">
            {r.open}–{r.close}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Footer({ model, words: w, langHref, onLangChange, mode }: Inner) {
  const { accessibilityUrl, privacyUrl } = model.legal;
  const linkCls = 'inline-flex min-h-11 items-center underline underline-offset-4';
  const legalLink = (href: string | null, label: string) =>
    href ? (
      mode === 'public' ? (
        <a href={href} target="_blank" rel="noopener noreferrer" className={linkCls}>
          {label}
        </a>
      ) : (
        <span className={linkCls}>{label}</span>
      )
    ) : null;
  return (
    <footer className="flex flex-col items-center gap-1 pt-2 text-center text-[0.86em] text-[color:var(--bc-muted)]">
      {model.languages.length > 1 ? (
        <nav aria-label={w.language} className="flex gap-2">
          {model.languages.map((l) => {
            const label = l === 'he' ? 'עברית' : 'English';
            const current = l === model.lang;
            const cls = `inline-flex min-h-11 min-w-11 items-center justify-center rounded-full px-3 font-semibold ${current ? '' : 'underline underline-offset-4'}`;
            const style = current ? { background: 'var(--bc-primary)', color: 'var(--bc-on-primary)' } : undefined;
            if (mode === 'public' && langHref) {
              return (
                <a key={l} href={langHref(l)} hrefLang={l} lang={l} aria-current={current ? 'page' : undefined} className={cls} style={style}>
                  {label}
                </a>
              );
            }
            return (
              <button key={l} type="button" lang={l} aria-pressed={current} className={cls} style={style} onClick={() => onLangChange?.(l)}>
                {label}
              </button>
            );
          })}
        </nav>
      ) : null}
      <div className="flex flex-wrap items-center justify-center gap-x-4">
        {legalLink(accessibilityUrl, w.accessibility)}
        {legalLink(privacyUrl, w.privacy)}
      </div>
      <p className="text-[0.85em] opacity-90">{w.poweredBy}</p>
    </footer>
  );
}
