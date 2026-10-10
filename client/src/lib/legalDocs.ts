/**
 * The four legal pages of the public digital channels (plan §17): kinds, public paths, which ones a
 * channel needs before it may be published, and the limited markdown their text is written in.
 *
 * The server owns the content and the rules (app/services/digital_legal/); this module mirrors the
 * constants the public pages and the footer need — legalDocs.test.ts pins them against the server's
 * gate.py. Pure (no React).
 */

export const LEGAL_KINDS = ['accessibility', 'privacy', 'terms', 'cookies'] as const;
export type LegalKind = (typeof LEGAL_KINDS)[number];

export type DigitalProduct = 'menu' | 'online' | 'card';

/** Plan §17.5 — the server's `gate.REQUIRED_KINDS`. */
export const REQUIRED_LEGAL_KINDS: Record<DigitalProduct, LegalKind[]> = {
  menu: ['accessibility', 'privacy', 'cookies'],
  card: ['accessibility', 'privacy', 'cookies'],
  online: ['accessibility', 'privacy', 'cookies', 'terms'],
};

export type PublicLang = 'he' | 'en';

export const LEGAL_TITLES: Record<PublicLang, Record<LegalKind, string>> = {
  he: {
    accessibility: 'הצהרת נגישות',
    privacy: 'מדיניות פרטיות',
    terms: 'תקנון ותנאי הזמנה',
    cookies: 'מדיניות עוגיות',
  },
  en: {
    accessibility: 'Accessibility statement',
    privacy: 'Privacy policy',
    terms: 'Terms of use and ordering',
    cookies: 'Cookie policy',
  },
};

export function isLegalKind(value: unknown): value is LegalKind {
  return typeof value === 'string' && (LEGAL_KINDS as readonly string[]).includes(value);
}

/** The public page of a legal document: `/legal/{companyId}/{kind}` (+ `?shop=` for a shop's own). */
export function legalPagePath(companyId: string, kind: LegalKind, shopId?: string | null): string {
  const base = `/legal/${encodeURIComponent(companyId)}/${kind}`;
  return shopId ? `${base}?shop=${encodeURIComponent(shopId)}` : base;
}

// ── Limited markdown ─────────────────────────────────────────────────────────

export type MdInline = { type: 'text'; text: string } | { type: 'strong'; text: string };

export type MdBlock =
  | { type: 'h1' | 'h2' | 'h3'; text: string }
  | { type: 'p'; lines: string[] }
  | { type: 'ul'; items: string[] };

/**
 * `#`, `##`, `###` headings, `-` / `*` list items, blank-line separated paragraphs. Nothing else is
 * markup — in particular no HTML and no links: the page renders the text as text.
 */
export function parseLimitedMarkdown(src: string): MdBlock[] {
  const blocks: MdBlock[] = [];
  let para: string[] = [];
  let list: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ type: 'p', lines: para });
    if (list.length) blocks.push({ type: 'ul', items: list });
    para = [];
    list = [];
  };
  for (const raw of (src ?? '').replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trim();
    if (!line) {
      flush();
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      const level = heading[1].length as 1 | 2 | 3;
      blocks.push({ type: `h${level}` as 'h1' | 'h2' | 'h3', text: heading[2].trim() });
      continue;
    }
    const item = /^[-*]\s+(.*)$/.exec(line);
    if (item) {
      if (para.length) {
        blocks.push({ type: 'p', lines: para });
        para = [];
      }
      list.push(item[1].trim());
      continue;
    }
    if (list.length) {
      blocks.push({ type: 'ul', items: list });
      list = [];
    }
    para.push(line);
  }
  flush();
  return blocks;
}

/** `**bold**` only. */
export function parseInline(text: string): MdInline[] {
  const out: MdInline[] = [];
  const re = /\*\*(.+?)\*\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ type: 'text', text: text.slice(last, m.index) });
    out.push({ type: 'strong', text: m[1] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ type: 'text', text: text.slice(last) });
  return out;
}
