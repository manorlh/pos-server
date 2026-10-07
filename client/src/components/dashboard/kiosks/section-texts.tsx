'use client';

/**
 * "טקסטים" — every text a kiosk customer sees (the shared registry, lib/kioskTexts.ts), per screen
 * and per language: the kiosk's first language in `texts` (an older kiosk reads them), the others
 * in `textsByLang`. Each text shows what this level inherits (or the built-in text) as its
 * placeholder, "בירושה" / "דורס…" with a reset, its limit and its placeholders; the focused text is
 * marked in the live preview, on its screen, in the tab's language.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Search } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { getPath } from '@/lib/kioskConfig';
import { layoutOf } from '@/lib/kioskLayout';
import {
  KIOSK_TEXTS,
  KIOSK_TEXT_GROUPS,
  KIOSK_TEXT_REGISTRY,
  configuredText,
  defaultText,
  primaryLanguage,
  textShownUnder,
  type KioskTextDef,
} from '@/lib/kioskTexts';
import { sameSetting, useKioskEditor, useKioskField, type PreviewScreen } from './editor-context';
import { FieldErrors, OverrideMark, SectionCard } from './fields';

/** The preview's screen for each group of the registry. */
const GROUP_SCREEN: Record<string, PreviewScreen> = {
  attract: 'attract',
  help: 'attract',
  service: 'service',
  menu: 'catalog',
  search: 'catalog',
  item: 'product',
  meal: 'catalog',
  upsell: 'cart',
  basket: 'cart',
  details: 'details',
  keyboard: 'details',
  tip: 'tip',
  checkout: 'tip',
  payMethod: 'pay',
  pay: 'pay',
  success: 'success',
  slip: 'success',
  idle: 'catalog',
  leave: 'catalog',
  rest: 'paused',
  offline: 'paused',
  errors: 'catalog',
  dietary: 'catalog',
  layoutLanding: 'catalog',
  layoutBasket: 'catalog',
  layoutMeal: 'catalog',
  layoutGuided: 'catalog',
  layoutReach: 'catalog',
};

export function screenOfTextGroup(group: string): PreviewScreen {
  return GROUP_SCREEN[group] ?? 'catalog';
}

/** Where a level keeps `key` in `lang`: the first language's in `texts`, the others' in `textsByLang`. */
export function textPathOf(lang: string, primary: string, key: string): string {
  return lang === primary ? `texts.${key}` : `textsByLang.${lang}.${key}`;
}

const RTL = new Set(['he', 'ar']);

function TextRow({ def, lang, primary }: { def: KioskTextDef; lang: string; primary: string }) {
  const t = useTranslations('kiosks.texts');
  const ed = useKioskEditor();
  const path = textPathOf(lang, primary, def.key);
  const f = useKioskField<string | null | undefined>(path);
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const value = typeof f.value === 'string' ? f.value : '';
  const inherited = typeof f.inheritedValue === 'string' && f.inheritedValue.trim() !== '' ? f.inheritedValue : null;
  const placeholder = inherited ?? defaultText(lang, def.key) ?? '';
  const multiline = def.max >= 150 || (defaultText(lang, def.key) ?? '').length > 50;
  const dir = RTL.has(lang) ? 'rtl' : 'ltr';
  const focus = () => {
    ed.setHighlightText(def.key);
    ed.showScreen(screenOfTextGroup(def.group));
  };
  const insert = (name: string) => {
    const el = ref.current;
    const token = `{${name}}`;
    if (!el) return f.set(`${value}${token}`);
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? value.length;
    f.set(`${value.slice(0, start)}${token}${value.slice(end)}`);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  };
  const common = {
    ref,
    dir,
    value,
    placeholder,
    disabled: f.disabled,
    onFocus: focus,
    onBlur: () => ed.setHighlightText(null),
    onChange: (e: { target: { value: string } }) => f.set(e.target.value),
    'aria-label': def.label,
  } as const;
  return (
    <li className="space-y-1.5 px-3 py-2.5" data-text-key={def.key}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{def.label}</span>
        <OverrideMark path={path} />
        <span dir="ltr" className="ms-auto font-mono text-[10px] text-muted-foreground">
          {def.key}
        </span>
      </div>
      {multiline ? (
        <textarea
          {...common}
          className="min-h-16 w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
        />
      ) : (
        <Input {...common} />
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        {def.placeholders.map((p) => (
          <button
            key={p}
            type="button"
            disabled={f.disabled}
            title={t('insertPlaceholder')}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => insert(p)}
            className="rounded-md border bg-muted/50 px-1.5 py-0.5 font-mono text-[11px] hover:bg-muted"
            dir="ltr"
          >
            {`{${p}}`}
          </button>
        ))}
        <span className={cn('ms-auto text-[11px] tabular-nums', value.length > def.max ? 'text-destructive' : 'text-muted-foreground')}>
          {value.length}/{def.max}
        </span>
      </div>
      <FieldErrors path={path} />
    </li>
  );
}

/** How many texts of `defs` this level sets in `lang`. */
function useSetHere(defs: KioskTextDef[], lang: string, primary: string): number {
  const ed = useKioskEditor();
  let n = 0;
  for (const d of defs) {
    const p = textPathOf(lang, primary, d.key);
    if (!sameSetting(getPath(ed.draft, p), getPath(ed.inherited, p))) n += 1;
  }
  return n;
}

function GroupButton({ id, label, on, shown, defs, lang, primary, onPick }: {
  id: string;
  label: string;
  on: boolean;
  shown: boolean;
  defs: KioskTextDef[];
  lang: string;
  primary: string;
  onPick: (id: string) => void;
}) {
  const t = useTranslations('kiosks.texts');
  const here = useSetHere(defs, lang, primary);
  return (
    <button
      type="button"
      onClick={() => onPick(id)}
      aria-pressed={on}
      title={shown ? undefined : t('notShownHint')}
      className={cn(
        'flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-start text-sm transition-colors',
        on ? 'bg-foreground text-background' : 'hover:bg-muted',
        !shown && !on && 'text-muted-foreground',
      )}
    >
      <span className="truncate">{label}</span>
      <span className="flex shrink-0 items-center gap-1 text-[10px] tabular-nums">
        {here > 0 ? <span className="rounded-full bg-sky-500 px-1.5 text-white">{here}</span> : null}
        <span className="opacity-60">{defs.length}</span>
      </span>
    </button>
  );
}

export function TextsSection() {
  const t = useTranslations('kiosks.texts');
  const tl = useTranslations('kiosks.general');
  const ed = useKioskEditor();
  const primary = primaryLanguage(ed.draft);
  const configured = (ed.draft.general.languages ?? []).filter((l) => KIOSK_TEXT_REGISTRY.languages.includes(l));
  const langs = configured.length > 0 ? configured : [primary];
  const lang = langs.includes(ed.previewLang) ? ed.previewLang : langs[0];
  const [group, setGroup] = useState<string>(KIOSK_TEXT_GROUPS[0]?.id ?? 'attract');
  const [query, setQuery] = useState('');
  const layout = layoutOf(ed.draft);

  // The preview speaks the tab's language while this section is open, and goes back after.
  const { setPreviewLang } = ed;
  useEffect(() => {
    setPreviewLang(lang);
  }, [lang, setPreviewLang]);
  useEffect(() => () => setPreviewLang(primary), [primary, setPreviewLang]);

  const byGroup = useMemo(() => {
    const out = new Map<string, KioskTextDef[]>();
    for (const d of KIOSK_TEXTS) out.set(d.group, [...(out.get(d.group) ?? []), d]);
    return out;
  }, []);
  const q = query.trim().toLowerCase();
  const shown: KioskTextDef[] = q
    ? KIOSK_TEXTS.filter((d) => {
        const own = configuredText(ed.draft, lang, d.key) ?? '';
        return [d.key, d.label, d.defaults.he, d.defaults.en, own].some((s) => s.toLowerCase().includes(q));
      })
    : (byGroup.get(group) ?? []);
  const groupDef = KIOSK_TEXT_GROUPS.find((g) => g.id === group);

  let list: ReactNode;
  if (shown.length === 0) list = <p className="p-4 text-center text-sm text-muted-foreground">{t('noMatch')}</p>;
  else {
    list = (
      <ul key={`${lang}-${q ? 'q' : group}`} className="divide-y rounded-xl border animate-in fade-in duration-200">
        {shown.map((d) => (
          <TextRow key={d.key} def={d} lang={lang} primary={primary} />
        ))}
      </ul>
    );
  }

  return (
    <SectionCard title={t('title')} description={t('hint', { n: KIOSK_TEXTS.length })} paths={['texts', 'textsByLang']}>
      <div className="flex flex-wrap items-center gap-2">
        <div role="tablist" aria-label={t('languages')} className="inline-flex gap-1 rounded-xl bg-muted p-1">
          {langs.map((l) => (
            <button
              key={l}
              type="button"
              role="tab"
              aria-selected={l === lang}
              onClick={() => ed.setPreviewLang(l)}
              className={cn(
                'rounded-lg px-3 py-1.5 text-sm transition-all duration-200',
                l === lang ? 'bg-background font-medium shadow-sm' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {tl.has(`lang.${l}`) ? tl(`lang.${l}`) : l}
              {l === primary ? <Badge variant="outline" className="ms-1.5 text-[10px]">{t('primary')}</Badge> : null}
            </button>
          ))}
        </div>
        <div className="relative ms-auto w-full sm:w-64">
          <Search className="pointer-events-none absolute start-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('search')} className="ps-8" aria-label={t('search')} />
        </div>
      </div>
      {langs.length === 1 ? <p className="text-xs text-muted-foreground">{t('oneLanguageHint')}</p> : null}
      <div className="grid gap-3 md:grid-cols-[180px_minmax(0,1fr)]">
        <nav aria-label={t('groups')} className={cn('space-y-0.5 md:max-h-[640px] md:overflow-y-auto', q && 'opacity-50')}>
          {KIOSK_TEXT_GROUPS.map((g) => (
            <GroupButton
              key={g.id}
              id={g.id}
              label={g.label.he}
              on={!q && g.id === group}
              shown={textShownUnder(g.shownWhen, layout)}
              defs={byGroup.get(g.id) ?? []}
              lang={lang}
              primary={primary}
              onPick={(id) => {
                setQuery('');
                setGroup(id);
                ed.showScreen(screenOfTextGroup(id));
              }}
            />
          ))}
        </nav>
        <div className="min-w-0 space-y-2">
          {!q && groupDef && !textShownUnder(groupDef.shownWhen, layout) ? (
            <p className="rounded-xl bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">{t('notShownHint')}</p>
          ) : null}
          {list}
        </div>
      </div>
    </SectionCard>
  );
}

/* ------------------------------------------------------------ the live mark */

/** The parts of a text without its placeholders, longest first ("{count} מנות" → "מנות"). */
function needlesOf(text: string): string[] {
  return text
    .split(/\{\w+\}/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2)
    .sort((a, b) => b.length - a.length);
}

interface MarkBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Around the live preview: marks where the focused text is on screen (the smallest elements whose
 * text holds it), following the preview as it animates.
 */
export function PreviewTextHighlight({ textKey, lang, children }: { textKey: string | null; lang: string; children: ReactNode }) {
  const ed = useKioskEditor();
  const ref = useRef<HTMLDivElement>(null);
  const [boxes, setBoxes] = useState<MarkBox[]>([]);
  const configured = textKey ? configuredText(ed.draft, lang, textKey) : null;
  const fallback = textKey ? defaultText(lang, textKey) : null;
  const needles = useMemo(() => {
    const out: string[] = [];
    for (const s of [configured, fallback]) if (s) out.push(...needlesOf(s));
    return Array.from(new Set(out));
  }, [configured, fallback]);

  useEffect(() => {
    const root = ref.current;
    const find = () => {
      if (!root || needles.length === 0) return setBoxes((b) => (b.length ? [] : b));
      const base = root.getBoundingClientRect();
      const found: MarkBox[] = [];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n && found.length < 6; n = walker.nextNode()) {
        const v = n.nodeValue ?? '';
        if (!needles.some((s) => v.includes(s))) continue;
        const el = n.parentElement;
        if (!el || el.closest('[data-text-mark]')) continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        found.push({ left: r.left - base.left - 3, top: r.top - base.top - 2, width: r.width + 6, height: r.height + 4 });
      }
      setBoxes(found);
    };
    const first = window.setTimeout(find, 60);
    const id = window.setInterval(find, 500);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(id);
    };
  }, [needles]);

  return (
    <div ref={ref} className="relative">
      {children}
      {boxes.map((b, i) => (
        <span
          key={i}
          data-text-mark
          aria-hidden
          className="pointer-events-none absolute z-50 rounded-md ring-2 ring-amber-400 ring-offset-1 transition-all duration-300 animate-pulse"
          style={{ left: b.left, top: b.top, width: b.width, height: b.height }}
        />
      ))}
    </div>
  );
}
