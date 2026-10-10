/**
 * "כרטיסי ביקור דיגיטליים" (spec §25–28) — the card document, its defaults and the one
 * resolver that turns a card (draft or published) into what a visitor sees.
 *
 * The same computation runs on the server (pos-server app/services/business_card_resolve.py):
 * the public page `/c/<slug>` gets the server's answer, the editor's live preview runs this one
 * on the unsaved draft. Both are pinned by one golden fixture
 * (server/tests/fixtures/business_cards/resolve_golden.json, read by both test suites), so the
 * preview cannot drift from the public page.
 *
 * Self-contained (relative imports only, no React/Next), so `npm test` compiles it alone.
 *
 * Rules that matter:
 * - Every field is explicitly `public` or `private`. Private values never reach the public
 *   model, the VCF, or a child card that inherits from this one.
 * - Every field is `inherit`, `local` or `hidden`. A blank local value is blank, never "hidden";
 *   removing the local value (back to `inherit`) restores inheritance.
 * - Inheritance reads the parent card's *published* public values, then the organisation's own
 *   records (company / branch / point names, address, logo). Each effective value says where it
 *   came from (`source`).
 * - Actions are fixed, validated types. URLs are https only (media from our own store may be
 *   http://localhost in development); no markup is ever taken from the document.
 */

// ── Vocabulary ────────────────────────────────────────────────────────────────

export const CARD_LANGS = ['he', 'en'] as const;
export type CardLang = (typeof CARD_LANGS)[number];
export type LocalText = Partial<Record<CardLang, string>>;

export const CARD_TYPES = ['company', 'branch', 'point', 'personal'] as const;
export type CardType = (typeof CARD_TYPES)[number];

export const CARD_TEMPLATES = ['minimal', 'cover', 'dark', 'portrait', 'location', 'services', 'event', 'links'] as const;
export type CardTemplate = (typeof CARD_TEMPLATES)[number];

export const CARD_STATUSES = ['draft', 'saved', 'published', 'paused', 'archived'] as const;
export type CardStatus = (typeof CARD_STATUSES)[number];

export const FIELD_MODES = ['inherit', 'local', 'hidden'] as const;
export type FieldMode = (typeof FIELD_MODES)[number];
export const FIELD_VISIBILITIES = ['public', 'private'] as const;
export type FieldVisibility = (typeof FIELD_VISIBILITIES)[number];

export const FIELD_KEYS = [
  'title',
  'role',
  'orgLine',
  'description',
  'avatar',
  'cover',
  'phone',
  'whatsapp',
  'email',
  'website',
  'address',
  'navigation',
  'hours',
  'services',
  'social',
  'files',
  'announcement',
  'ctaText',
  'event',
  'offer',
  'support',
  'accessibilityUrl',
  'privacyUrl',
] as const;
export type FieldKey = (typeof FIELD_KEYS)[number];

export type FieldKind =
  | 'text'
  | 'image'
  | 'phone'
  | 'email'
  | 'url'
  | 'navigation'
  | 'hours'
  | 'services'
  | 'social'
  | 'files'
  | 'announcement'
  | 'event'
  | 'offer'
  | 'support';

/** Where an inherited value may come from, nearest first. */
type InheritSource = 'parent' | 'org';

interface FieldSpec {
  kind: FieldKind;
  /** Max characters per language (text) or per string. */
  max?: number;
  inherit: InheritSource[];
  /** Personal cards: never inherited (a person's phone is not the company's or the branch's). */
  personalLocalOnly?: boolean;
  /** Personal cards: private until someone deliberately makes it public. */
  personalPrivate?: boolean;
}

export const FIELD_SPECS: Record<FieldKey, FieldSpec> = {
  title: { kind: 'text', max: 120, inherit: ['org'] },
  role: { kind: 'text', max: 120, inherit: [] },
  orgLine: { kind: 'text', max: 160, inherit: ['org'] },
  description: { kind: 'text', max: 600, inherit: ['parent'] },
  avatar: { kind: 'image', inherit: ['parent', 'org'] },
  cover: { kind: 'image', inherit: ['parent'] },
  phone: { kind: 'phone', inherit: ['parent', 'org'], personalLocalOnly: true, personalPrivate: true },
  whatsapp: { kind: 'phone', inherit: ['parent', 'org'], personalLocalOnly: true, personalPrivate: true },
  email: { kind: 'email', inherit: ['parent', 'org'], personalLocalOnly: true, personalPrivate: true },
  website: { kind: 'url', inherit: ['parent', 'org'] },
  address: { kind: 'text', max: 200, inherit: ['org', 'parent'], personalPrivate: true },
  navigation: { kind: 'navigation', max: 200, inherit: ['parent'], personalPrivate: true },
  hours: { kind: 'hours', inherit: ['parent'] },
  services: { kind: 'services', inherit: ['parent'] },
  social: { kind: 'social', inherit: ['parent'] },
  files: { kind: 'files', inherit: ['parent'] },
  announcement: { kind: 'announcement', inherit: ['parent'], personalLocalOnly: true },
  ctaText: { kind: 'text', max: 80, inherit: [] },
  event: { kind: 'event', inherit: [] },
  offer: { kind: 'offer', inherit: [] },
  support: { kind: 'support', inherit: ['parent'] },
  accessibilityUrl: { kind: 'url', inherit: ['parent', 'org'] },
  privacyUrl: { kind: 'url', inherit: ['parent', 'org'] },
};

export const SECTION_KINDS = [
  'actions',
  'announcement',
  'about',
  'event',
  'offer',
  'services',
  'hours',
  'location',
  'social',
  'files',
  'support',
  'enquiry',
] as const;
export type SectionKind = (typeof SECTION_KINDS)[number];

export const ACTION_TYPES = [
  'call',
  'whatsapp',
  'email',
  'navigate',
  'save_contact',
  'share',
  'digital_menu',
  'order_online',
  'website',
  'link',
  'file',
  'enquiry',
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export const SOCIAL_PLATFORMS = ['instagram', 'facebook', 'tiktok', 'linkedin', 'youtube', 'x', 'telegram', 'other'] as const;
export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number];

/** Hosts each platform's links must live on (the host itself or a subdomain); `other` is any https host. */
export const SOCIAL_HOSTS: Record<SocialPlatform, string[]> = {
  instagram: ['instagram.com'],
  facebook: ['facebook.com', 'fb.com', 'fb.me'],
  tiktok: ['tiktok.com'],
  linkedin: ['linkedin.com'],
  youtube: ['youtube.com', 'youtu.be'],
  x: ['x.com', 'twitter.com'],
  telegram: ['t.me', 'telegram.me'],
  other: [],
};

export const NAV_PROVIDERS = ['google', 'waze'] as const;
export type NavProvider = (typeof NAV_PROVIDERS)[number];

export const ENQUIRY_FIELD_KEYS = ['name', 'phone', 'email', 'topic', 'message'] as const;
export type EnquiryFieldKey = (typeof ENQUIRY_FIELD_KEYS)[number];
export const ENQUIRY_REQUIREMENTS = ['required', 'optional', 'off'] as const;
export type EnquiryRequirement = (typeof ENQUIRY_REQUIREMENTS)[number];

// ── The document ──────────────────────────────────────────────────────────────

export interface CardImage {
  url: string;
  alt?: LocalText;
}
export interface HoursRow {
  /** 0 = Sunday … 6 = Saturday. */
  days: number[];
  open: string;
  close: string;
}
export interface HoursValue {
  rows: HoursRow[];
  note?: LocalText;
}
export interface ServiceItem {
  title: LocalText;
  description?: LocalText;
}
export interface SocialLink {
  platform: SocialPlatform;
  url: string;
}
export interface PublicFile {
  title: LocalText;
  url: string;
  bytes?: number | null;
}
export interface AnnouncementValue {
  title?: LocalText;
  body?: LocalText;
  /** Last day shown, YYYY-MM-DD (business time). */
  until?: string | null;
}
export interface EventValue {
  title?: LocalText;
  venue?: LocalText;
  /** YYYY-MM-DDTHH:MM, business local time. */
  startsAt?: string | null;
  endsAt?: string | null;
  /** Last day the event section is shown, YYYY-MM-DD. */
  expiresAt?: string | null;
}
export interface OfferValue {
  title?: LocalText;
  body?: LocalText;
  validUntil?: string | null;
}
export interface SupportValue {
  phone?: string | null;
  hours?: LocalText;
  note?: LocalText;
  /** An existing service-request page (https). */
  url?: string | null;
}

export interface CardField<V = unknown> {
  mode: FieldMode;
  visibility: FieldVisibility;
  value: V | null;
}

export interface CardSection {
  kind: SectionKind;
  enabled: boolean;
}

export interface CardAction {
  id: string;
  type: ActionType;
  enabled: boolean;
  /** Empty → the built-in label for the type in each language. */
  label?: LocalText;
  style: 'primary' | 'secondary';
  /** `link`: the destination and its platform. */
  url?: string | null;
  platform?: SocialPlatform | null;
  /** `file`: one of the card's public files, by its URL. */
  fileUrl?: string | null;
  /** `whatsapp`: an optional prefilled message. */
  message?: LocalText;
  /** `navigate`. */
  navProvider?: NavProvider;
}

export interface CardPalette {
  primary: string;
  accent: string;
  background: string;
  surface: string;
  text: string;
  muted: string;
}

export const CARD_FONTS = ['heebo', 'rubik', 'assistant', 'frank', 'system'] as const;
export type CardFont = (typeof CARD_FONTS)[number];

export interface CardDesign {
  /** `inherit`: palette and font come from the parent card's published design. */
  brandMode: 'inherit' | 'local';
  palette: CardPalette;
  font: CardFont;
  textScale: 'sm' | 'md' | 'lg';
  spacing: 'compact' | 'normal' | 'airy';
  radius: 'none' | 'sm' | 'md' | 'lg' | 'xl';
  background: 'solid' | 'gradient';
  cover: { height: 'none' | 'sm' | 'md' | 'lg'; fit: 'cover' | 'contain'; focusX: number; focusY: number; overlay: number };
  avatar: { shape: 'circle' | 'rounded' | 'square'; position: 'center' | 'start' | 'overlap'; size: 'sm' | 'md' | 'lg' };
  buttons: { style: 'filled' | 'outline' | 'soft' | 'pill'; columns: 1 | 2 | 3; content: 'icon_text' | 'text' | 'icon' };
  motion: { mode: 'none' | 'subtle' | 'lively'; durationMs: number };
}

export interface EnquiryConfig {
  mode: 'disabled' | 'internal';
  fields: Record<EnquiryFieldKey, EnquiryRequirement>;
  topics: LocalText[];
  intro?: LocalText;
  /** Attribution stored with each enquiry (e.g. "summer-2026"). */
  campaign?: string;
}

export interface CardDoc {
  schema: 1;
  languages: CardLang[];
  template: CardTemplate;
  fields: Partial<Record<FieldKey, CardField>>;
  sections: CardSection[];
  actions: CardAction[];
  design: CardDesign;
  enquiry: EnquiryConfig;
  seo: { indexable: boolean };
  /** An event / campaign card stops showing after this day (YYYY-MM-DD, business time). */
  expiresAt?: string | null;
}

// ── Templates ─────────────────────────────────────────────────────────────────

interface TemplatePreset {
  palette: CardPalette;
  font: CardFont;
  spacing: CardDesign['spacing'];
  radius: CardDesign['radius'];
  background: CardDesign['background'];
  cover: CardDesign['cover'];
  avatar: CardDesign['avatar'];
  buttons: CardDesign['buttons'];
  sections: SectionKind[];
}

const DEFAULT_ORDER: SectionKind[] = [
  'actions',
  'announcement',
  'about',
  'event',
  'offer',
  'services',
  'hours',
  'location',
  'social',
  'files',
  'support',
  'enquiry',
];

export const TEMPLATE_PRESETS: Record<CardTemplate, TemplatePreset> = {
  minimal: {
    palette: { primary: '#1f2937', accent: '#2563eb', background: '#ffffff', surface: '#f8fafc', text: '#0f172a', muted: '#475569' },
    font: 'heebo',
    spacing: 'compact',
    radius: 'md',
    background: 'solid',
    cover: { height: 'none', fit: 'cover', focusX: 50, focusY: 50, overlay: 0 },
    avatar: { shape: 'rounded', position: 'start', size: 'md' },
    buttons: { style: 'outline', columns: 1, content: 'icon_text' },
    sections: DEFAULT_ORDER,
  },
  cover: {
    palette: { primary: '#1d4ed8', accent: '#0ea5e9', background: '#f1f5f9', surface: '#ffffff', text: '#0f172a', muted: '#475569' },
    font: 'heebo',
    spacing: 'normal',
    radius: 'lg',
    background: 'solid',
    cover: { height: 'lg', fit: 'cover', focusX: 50, focusY: 50, overlay: 0 },
    avatar: { shape: 'circle', position: 'overlap', size: 'lg' },
    buttons: { style: 'soft', columns: 2, content: 'icon_text' },
    sections: DEFAULT_ORDER,
  },
  dark: {
    palette: { primary: '#f59e0b', accent: '#22d3ee', background: '#0b1120', surface: '#111827', text: '#f8fafc', muted: '#cbd5e1' },
    font: 'rubik',
    spacing: 'normal',
    radius: 'lg',
    background: 'gradient',
    cover: { height: 'md', fit: 'cover', focusX: 50, focusY: 50, overlay: 40 },
    avatar: { shape: 'circle', position: 'overlap', size: 'md' },
    buttons: { style: 'filled', columns: 2, content: 'icon_text' },
    sections: DEFAULT_ORDER,
  },
  portrait: {
    palette: { primary: '#6d28d9', accent: '#db2777', background: '#faf5ff', surface: '#ffffff', text: '#1e1b4b', muted: '#4b5563' },
    font: 'assistant',
    spacing: 'airy',
    radius: 'xl',
    background: 'gradient',
    cover: { height: 'none', fit: 'cover', focusX: 50, focusY: 50, overlay: 0 },
    avatar: { shape: 'circle', position: 'center', size: 'lg' },
    buttons: { style: 'pill', columns: 2, content: 'icon_text' },
    sections: DEFAULT_ORDER,
  },
  location: {
    palette: { primary: '#047857', accent: '#b45309', background: '#f0fdf4', surface: '#ffffff', text: '#052e16', muted: '#374151' },
    font: 'heebo',
    spacing: 'normal',
    radius: 'md',
    background: 'solid',
    cover: { height: 'md', fit: 'cover', focusX: 50, focusY: 50, overlay: 0 },
    avatar: { shape: 'rounded', position: 'start', size: 'md' },
    buttons: { style: 'filled', columns: 2, content: 'icon_text' },
    sections: ['actions', 'location', 'hours', 'announcement', 'about', 'event', 'offer', 'services', 'social', 'files', 'support', 'enquiry'],
  },
  services: {
    palette: { primary: '#0f766e', accent: '#4f46e5', background: '#f8fafc', surface: '#ffffff', text: '#0f172a', muted: '#475569' },
    font: 'rubik',
    spacing: 'normal',
    radius: 'lg',
    background: 'solid',
    cover: { height: 'sm', fit: 'cover', focusX: 50, focusY: 50, overlay: 0 },
    avatar: { shape: 'rounded', position: 'center', size: 'md' },
    buttons: { style: 'soft', columns: 2, content: 'icon_text' },
    sections: ['about', 'services', 'offer', 'actions', 'enquiry', 'announcement', 'event', 'hours', 'location', 'social', 'files', 'support'],
  },
  event: {
    palette: { primary: '#be123c', accent: '#c2410c', background: '#fff7ed', surface: '#ffffff', text: '#1c1917', muted: '#57534e' },
    font: 'rubik',
    spacing: 'normal',
    radius: 'md',
    background: 'solid',
    cover: { height: 'lg', fit: 'cover', focusX: 50, focusY: 50, overlay: 30 },
    avatar: { shape: 'rounded', position: 'start', size: 'sm' },
    buttons: { style: 'filled', columns: 1, content: 'icon_text' },
    sections: ['event', 'actions', 'announcement', 'location', 'about', 'offer', 'services', 'hours', 'social', 'files', 'support', 'enquiry'],
  },
  links: {
    palette: { primary: '#111827', accent: '#be185d', background: '#fdf2f8', surface: '#ffffff', text: '#111827', muted: '#4b5563' },
    font: 'heebo',
    spacing: 'normal',
    radius: 'xl',
    background: 'gradient',
    cover: { height: 'none', fit: 'cover', focusX: 50, focusY: 50, overlay: 0 },
    avatar: { shape: 'circle', position: 'center', size: 'md' },
    buttons: { style: 'pill', columns: 1, content: 'icon_text' },
    sections: ['actions', 'social', 'files', 'about', 'announcement', 'event', 'offer', 'services', 'hours', 'location', 'support', 'enquiry'],
  },
};

const OFF_BY_DEFAULT: SectionKind[] = ['event', 'offer', 'support', 'enquiry'];

function defaultActions(type: CardType): CardAction[] {
  const a = (id: string, t: ActionType, enabled: boolean, style: CardAction['style'] = 'secondary'): CardAction => ({
    id,
    type: t,
    enabled,
    style,
    ...(t === 'navigate' ? { navProvider: 'google' as NavProvider } : {}),
  });
  if (type === 'personal') {
    return [
      a('call', 'call', true, 'primary'),
      a('whatsapp', 'whatsapp', true),
      a('email', 'email', true),
      a('save_contact', 'save_contact', true, 'primary'),
      a('website', 'website', true),
      a('share', 'share', true),
      a('navigate', 'navigate', false),
      a('enquiry', 'enquiry', false),
    ];
  }
  return [
    a('call', 'call', true, 'primary'),
    a('whatsapp', 'whatsapp', true),
    a('navigate', 'navigate', true),
    a('digital_menu', 'digital_menu', false),
    a('order_online', 'order_online', false),
    a('website', 'website', true),
    a('email', 'email', true),
    a('save_contact', 'save_contact', true),
    a('share', 'share', true),
    a('enquiry', 'enquiry', false),
  ];
}

export function designFromTemplate(template: CardTemplate, base?: CardDesign): CardDesign {
  const p = TEMPLATE_PRESETS[template];
  return {
    brandMode: base?.brandMode ?? 'local',
    palette: { ...p.palette },
    font: p.font,
    textScale: base?.textScale ?? 'md',
    spacing: p.spacing,
    radius: p.radius,
    background: p.background,
    cover: { ...p.cover },
    avatar: { ...p.avatar },
    buttons: { ...p.buttons },
    motion: base?.motion ? { ...base.motion } : { mode: 'subtle', durationMs: 450 },
  };
}

export function defaultField(key: FieldKey, type: CardType): CardField {
  const spec = FIELD_SPECS[key];
  return {
    mode: 'inherit',
    visibility: type === 'personal' && spec.personalPrivate ? 'private' : 'public',
    value: null,
  };
}

/** A new card's document. Branch / point / personal cards inherit the brand from their parent. */
export function defaultDoc(type: CardType, template: CardTemplate, hasParent = false): CardDoc {
  const preset = TEMPLATE_PRESETS[template];
  const fields: Partial<Record<FieldKey, CardField>> = {};
  for (const key of FIELD_KEYS) fields[key] = defaultField(key, type);
  const design = designFromTemplate(template);
  design.brandMode = hasParent ? 'inherit' : 'local';
  return {
    schema: 1,
    languages: ['he'],
    template,
    fields,
    sections: preset.sections.map((kind) => ({ kind, enabled: !OFF_BY_DEFAULT.includes(kind) })),
    actions: defaultActions(type),
    design,
    enquiry: {
      mode: 'disabled',
      fields: { name: 'required', phone: 'required', email: 'optional', topic: 'off', message: 'optional' },
      topics: [],
    },
    seo: { indexable: type !== 'personal' },
  };
}

/**
 * Template switch: the template's look (palette unless inherited, layout tokens) — never the
 * content, the actions, their targets or the section order (spec §27 "Design changes preserve
 * content/action targets").
 */
export function applyTemplate(doc: CardDoc, template: CardTemplate): CardDoc {
  const next = designFromTemplate(template, doc.design);
  if (doc.design.brandMode === 'inherit') {
    next.palette = { ...doc.design.palette };
    next.font = doc.design.font;
  }
  next.textScale = doc.design.textScale;
  return { ...doc, template, design: next };
}

// ── Built-in words (the public card is Hebrew and English) ────────────────────

export const ACTION_LABELS: Record<ActionType, Record<CardLang, string>> = {
  call: { he: 'חיוג', en: 'Call' },
  whatsapp: { he: 'וואטסאפ', en: 'WhatsApp' },
  email: { he: 'אימייל', en: 'Email' },
  navigate: { he: 'ניווט', en: 'Directions' },
  save_contact: { he: 'שמירת איש קשר', en: 'Save contact' },
  share: { he: 'שיתוף', en: 'Share' },
  digital_menu: { he: 'לתפריט', en: 'View menu' },
  order_online: { he: 'הזמנה אונליין', en: 'Order online' },
  website: { he: 'לאתר', en: 'Website' },
  link: { he: 'קישור', en: 'Link' },
  file: { he: 'הורדת קובץ', en: 'Download' },
  enquiry: { he: 'השאירו פרטים', en: 'Get in touch' },
};

export const PLATFORM_LABELS: Record<SocialPlatform, Record<CardLang, string>> = {
  instagram: { he: 'אינסטגרם', en: 'Instagram' },
  facebook: { he: 'פייסבוק', en: 'Facebook' },
  tiktok: { he: 'טיקטוק', en: 'TikTok' },
  linkedin: { he: 'לינקדאין', en: 'LinkedIn' },
  youtube: { he: 'יוטיוב', en: 'YouTube' },
  x: { he: 'X', en: 'X' },
  telegram: { he: 'טלגרם', en: 'Telegram' },
  other: { he: 'קישור', en: 'Link' },
};

/** Words the public card and its simulation use, by language. */
export const CARD_WORDS = {
  he: {
    about: 'אודות',
    services: 'שירותים',
    hours: 'שעות פעילות',
    location: 'כתובת והגעה',
    social: 'ברשתות',
    files: 'קבצים להורדה',
    support: 'שירות ותמיכה',
    announcement: 'עדכון',
    event: 'האירוע',
    offer: 'הצעה',
    enquiry: 'השאירו פרטים',
    navigateTo: 'ניווט ליעד',
    accessibility: 'הצהרת נגישות',
    privacy: 'מדיניות פרטיות',
    language: 'שפה',
    copyLink: 'העתקת קישור',
    linkCopied: 'הקישור הועתק',
    shareFallback: 'אפשר להעתיק את הקישור ולשלוח אותו',
    vcfHint: 'הקובץ נפתח באנשי הקשר של הטלפון — שם בוחרים "שמירה".',
    closed: 'סגור',
    until: 'עד',
    validUntil: 'בתוקף עד',
    starts: 'מתחיל',
    ends: 'מסתיים',
    venue: 'מיקום',
    name: 'שם',
    phone: 'טלפון',
    email: 'אימייל',
    topic: 'נושא',
    message: 'הודעה',
    chooseTopic: 'בחרו נושא',
    required: 'חובה',
    optional: 'רשות',
    consent: 'קראתי ואני מאשר/ת את {privacy}',
    consentDoc: 'מדיניות הפרטיות',
    submit: 'שליחה',
    sending: 'שולח…',
    saved: 'נשמר. פנייתכם התקבלה ונחזור אליכם בהקדם.',
    duplicate: 'נשמר. הפנייה הזו כבר התקבלה קודם — אין צורך לשלוח שוב.',
    notSaved: 'הפנייה לא נשמרה. בדקו את החיבור ונסו שוב.',
    rateLimited: 'נשלחו יותר מדי פניות. נסו שוב מאוחר יותר.',
    errRequired: 'שדה חובה',
    errPhone: 'מספר טלפון לא תקין',
    errEmail: 'כתובת אימייל לא תקינה',
    errContact: 'יש למלא טלפון או אימייל',
    errConsent: 'יש לאשר את מדיניות הפרטיות',
    fixErrors: 'יש לתקן את השדות המסומנים',
    paused: 'הכרטיס אינו זמין כרגע.',
    notFound: 'הכרטיס לא נמצא.',
    days: ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'],
    poweredBy: 'כרטיס ביקור דיגיטלי',
    close: 'סגירה',
    unavailable: 'הכרטיס לא נטען. נסו לרענן בעוד רגע.',
    sim: 'סימולציה',
    simNothingSent: 'בתצוגה המקדימה שום דבר לא נשלח ולא מחויג.',
    simWouldOpen: 'בכרטיס האמיתי ייפתח:',
    simEnquiry: 'הטופס תקין. בכרטיס האמיתי הפנייה הייתה נשמרת — כאן לא נשלח דבר.',
    simShare: 'בכרטיס האמיתי ייפתח חלון השיתוף של המכשיר, ואם אין — העתקת קישור.',
    simVcf: 'בכרטיס האמיתי יורד קובץ איש קשר (VCF) עם השדות הציבוריים בלבד.',
  },
  en: {
    about: 'About',
    services: 'Services',
    hours: 'Opening hours',
    location: 'Address & directions',
    social: 'Follow us',
    files: 'Downloads',
    support: 'Support',
    announcement: 'Update',
    event: 'The event',
    offer: 'Offer',
    enquiry: 'Get in touch',
    navigateTo: 'Get directions',
    accessibility: 'Accessibility statement',
    privacy: 'Privacy policy',
    language: 'Language',
    copyLink: 'Copy link',
    linkCopied: 'Link copied',
    shareFallback: 'Copy the link and send it',
    vcfHint: 'The file opens in your phone’s contacts — choose “Save” there.',
    closed: 'Closed',
    until: 'Until',
    validUntil: 'Valid until',
    starts: 'Starts',
    ends: 'Ends',
    venue: 'Venue',
    name: 'Name',
    phone: 'Phone',
    email: 'Email',
    topic: 'Topic',
    message: 'Message',
    chooseTopic: 'Choose a topic',
    required: 'required',
    optional: 'optional',
    consent: 'I have read and accept the {privacy}',
    consentDoc: 'privacy policy',
    submit: 'Send',
    sending: 'Sending…',
    saved: 'Saved. We received your enquiry and will get back to you soon.',
    duplicate: 'Saved. This enquiry was already received — no need to send it again.',
    notSaved: 'Your enquiry was not saved. Check your connection and try again.',
    rateLimited: 'Too many enquiries were sent. Please try again later.',
    errRequired: 'Required',
    errPhone: 'Invalid phone number',
    errEmail: 'Invalid email address',
    errContact: 'Enter a phone number or an email',
    errConsent: 'Please accept the privacy policy',
    fixErrors: 'Please fix the marked fields',
    paused: 'This card is not available right now.',
    notFound: 'Card not found.',
    days: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
    poweredBy: 'Digital business card',
    close: 'Close',
    unavailable: 'The card could not be loaded. Try again in a moment.',
    sim: 'Simulation',
    simNothingSent: 'Nothing is sent or dialled in the preview.',
    simWouldOpen: 'On the live card this opens:',
    simEnquiry: 'The form is valid. On the live card the enquiry would be saved — nothing was sent here.',
    simShare: 'On the live card the device’s share sheet opens, or the link is copied.',
    simVcf: 'On the live card a contact file (VCF) with public fields only is downloaded.',
  },
} as const;
export type CardWords = (typeof CARD_WORDS)[CardLang];

export function cardWords(lang: CardLang): CardWords {
  return CARD_WORDS[lang] ?? CARD_WORDS.he;
}

export function dirOf(lang: CardLang): 'rtl' | 'ltr' {
  return lang === 'he' ? 'rtl' : 'ltr';
}

// ── Validation helpers (same rules as the server) ─────────────────────────────

const HTTPS_URL = /^https:\/\/([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}(:\d{1,5})?(\/[^\s<>"'`\\]*)?$/i;
const DEV_MEDIA_URL = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?\/media\/[^\s<>"'`\\]+$/i;
const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(\.[A-Za-z0-9-]{1,63})*\.[A-Za-z]{2,24}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const YMD = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const YMDHM = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d$/;
const HEX = /^#[0-9a-f]{6}$/i;
export const MAX_URL = 500;

/** An https URL with a real host, no credentials, no whitespace or quote characters. */
export function isSafeUrl(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_URL && HTTPS_URL.test(value);
}

/** A media URL: https, or this system's own media store on a development box. */
export function isSafeMediaUrl(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_URL && (HTTPS_URL.test(value) || DEV_MEDIA_URL.test(value));
}

export function urlHost(url: string): string {
  const m = /^https?:\/\/([^/:?#]+)/i.exec(url);
  return m ? m[1].toLowerCase() : '';
}

export function isPlatformUrl(platform: SocialPlatform, url: unknown): url is string {
  if (!isSafeUrl(url)) return false;
  const hosts = SOCIAL_HOSTS[platform] ?? [];
  if (hosts.length === 0) return true;
  const host = urlHost(url);
  return hosts.some((h) => host === h || host.endsWith(`.${h}`));
}

export function isEmail(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 254 && EMAIL.test(value);
}

export function isHhmm(value: unknown): value is string {
  return typeof value === 'string' && HHMM.test(value);
}

export function isYmd(value: unknown): value is string {
  return typeof value === 'string' && YMD.test(value);
}

export function isYmdHm(value: unknown): value is string {
  return typeof value === 'string' && YMDHM.test(value);
}

export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && HEX.test(value);
}

/**
 * A typed phone → E.164 ("+972501234567") or null. The server's
 * app/services/notifications/phone.py `normalize_phone`, line for line.
 */
export function normalizePhone(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let text = raw.trim().replace(/[\s\-.()\u200e\u200f\u202a-\u202e]/g, '');
  if (!text) return null;
  if (text.startsWith('00')) text = `+${text.slice(2)}`;
  const israeli = (national: string): string | null =>
    /^\d+$/.test(national) && (national.length === 8 || national.length === 9) && !national.startsWith('0') ? `+972${national}` : null;
  if (text.startsWith('+')) {
    const digits = text.slice(1);
    if (!/^\d+$/.test(digits)) return null;
    if (digits.startsWith('972')) {
      let national = digits.slice(3);
      if (national.startsWith('0')) national = national.slice(1);
      return israeli(national);
    }
    const e164 = `+${digits}`;
    return /^\+[1-9]\d{7,14}$/.test(e164) ? e164 : null;
  }
  if (!/^\d+$/.test(text)) return null;
  if (text.startsWith('972') && [11, 12, 13].includes(text.length)) {
    let national = text.slice(3);
    if (national.startsWith('0')) national = national.slice(1);
    return israeli(national);
  }
  if (text.startsWith('0')) return israeli(text.slice(1));
  if (text.length === 9 && text.startsWith('5')) return israeli(text);
  return null;
}

/** "+972501234567" → "050-123-4567"; "+97231234567" → "03-123-4567"; abroad stays "+…". */
export function displayPhone(e164: string): string {
  if (!e164.startsWith('+972')) return e164;
  const n = e164.slice(4);
  if (n.length === 9) return `0${n.slice(0, 2)}-${n.slice(2, 5)}-${n.slice(5)}`;
  if (n.length === 8) return `0${n.slice(0, 1)}-${n.slice(1, 4)}-${n.slice(4)}`;
  return e164;
}

/** encodeURIComponent, the same set Python's `quote(s, safe="-_.!~*'()")` leaves alone. */
export function encodeComponent(value: string): string {
  return encodeURIComponent(value);
}

// ── Colours and contrast (WCAG 2.x) ───────────────────────────────────────────

function channel(hex: string, i: number): number {
  const v = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
  return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

export function luminance(hex: string): number {
  return 0.2126 * channel(hex, 0) + 0.7152 * channel(hex, 1) + 0.0722 * channel(hex, 2);
}

/** The WCAG contrast ratio, rounded down to 2 decimals (so both languages agree). */
export function contrastRatio(a: string, b: string): number {
  if (!isHexColor(a) || !isHexColor(b)) return 1;
  const la = luminance(a);
  const lb = luminance(b);
  const ratio = (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  return Math.floor(ratio * 100) / 100;
}

/** Black or white text on [bg], whichever reads better. */
export function readableOn(bg: string): string {
  return contrastRatio('#ffffff', bg) >= contrastRatio('#111111', bg) ? '#ffffff' : '#111111';
}

// ── Inputs to the resolver ────────────────────────────────────────────────────

/**
 * What the organisation's own records supply: company / branch / point names and address, the
 * brand logo, the club's active privacy policy, and the public business profile in the settings
 * layers (`publicPhone`, `publicWhatsapp`, `publicEmail`, `publicWebsite`,
 * `publicAccessibilityUrl`, `publicPrivacyUrl` — plan §18.2) when those exist.
 */
export interface OrgDefaults {
  title?: string | null;
  orgLine?: string | null;
  address?: string | null;
  logoUrl?: string | null;
  privacyUrl?: string | null;
  phone?: string | null;
  whatsapp?: string | null;
  email?: string | null;
  website?: string | null;
  accessibilityUrl?: string | null;
  /** `org:company` etc. for each key above. */
  sources?: Partial<Record<'title' | 'orgLine' | 'address' | 'logoUrl' | 'privacyUrl' | 'phone' | 'whatsapp' | 'email' | 'website' | 'accessibilityUrl', string>>;
}

export interface CardMeta {
  id: string;
  slug: string;
  type: CardType;
  name?: string;
}

/** One card of the inheritance chain: its published document and its own org defaults. */
export interface ChainLink {
  meta: CardMeta;
  doc: CardDoc;
  org: OrgDefaults;
}

export interface MenuDestination {
  url: string;
  label?: LocalText;
}
export type Destinations = Partial<Record<'digital_menu' | 'order_online', MenuDestination>>;

export interface ResolveInput {
  /** The card itself (draft for the preview, published revision for the public page). */
  card: ChainLink;
  /** Its ancestors' published documents, root first (company → branch). */
  parents: ChainLink[];
  destinations: Destinations;
  lang: CardLang;
  /** Business-local date, YYYY-MM-DD: hides expired announcements, events and offers. */
  today: string;
}

// ── Effective fields ─────────────────────────────────────────────────────────

export interface EffectiveField {
  value: unknown;
  /** local | hidden | none | org:<level> | card:<id> */
  source: string;
  mode: FieldMode;
  visibility: FieldVisibility;
  /** Shown to visitors (and in the VCF): public, not hidden, and a usable value. */
  isPublic: boolean;
}
export type EffectiveFields = Record<FieldKey, EffectiveField>;

function asObj(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function cleanText(v: unknown, max = 600): LocalText | null {
  const o = asObj(v);
  if (!o) return null;
  const out: LocalText = {};
  for (const lang of CARD_LANGS) {
    const s = o[lang];
    if (typeof s === 'string' && s.trim()) out[lang] = s.trim().slice(0, max);
  }
  return Object.keys(out).length ? out : null;
}

function cleanStr(v: unknown, max: number): string | null {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
}

function hasHebrew(s: string): boolean {
  return /[\u0590-\u05ff]/.test(s);
}

/** An organisation record's text in the language its letters are in. */
export function orgText(value: string | null | undefined): LocalText | null {
  if (!value || !value.trim()) return null;
  const v = value.trim();
  return hasHebrew(v) ? { he: v } : { en: v };
}

/** A field value as the resolver uses it, or null when nothing usable is there. */
export function usableValue(key: FieldKey, raw: unknown): unknown {
  const spec = FIELD_SPECS[key];
  switch (spec.kind) {
    case 'text':
      return cleanText(raw, spec.max);
    case 'image': {
      const o = asObj(raw);
      if (!o || !isSafeMediaUrl(o.url)) return null;
      const alt = cleanText(o.alt, 200);
      return alt ? { url: o.url, alt } : { url: o.url };
    }
    case 'phone': {
      const e164 = normalizePhone(raw);
      return e164 ? e164 : null;
    }
    case 'email':
      return isEmail(typeof raw === 'string' ? raw.trim() : raw) ? (raw as string).trim() : null;
    case 'url':
      return isSafeUrl(typeof raw === 'string' ? raw.trim() : raw) ? (raw as string).trim() : null;
    case 'navigation':
      return cleanStr(raw, spec.max ?? 200);
    case 'hours': {
      const o = asObj(raw);
      if (!o || !Array.isArray(o.rows)) return null;
      const rows: HoursRow[] = [];
      for (const r of o.rows.slice(0, 14)) {
        const ro = asObj(r);
        if (!ro || !isHhmm(ro.open) || !isHhmm(ro.close) || !Array.isArray(ro.days)) continue;
        const days = Array.from(new Set(ro.days.filter((d): d is number => Number.isInteger(d) && d >= 0 && d <= 6))).sort((x, y) => x - y);
        if (days.length) rows.push({ days, open: ro.open, close: ro.close });
      }
      const note = cleanText(o.note, 200);
      if (!rows.length && !note) return null;
      return note ? { rows, note } : { rows };
    }
    case 'services': {
      if (!Array.isArray(raw)) return null;
      const items: ServiceItem[] = [];
      for (const it of raw.slice(0, 24)) {
        const o = asObj(it);
        const title = o ? cleanText(o.title, 120) : null;
        if (!title) continue;
        const description = cleanText(o!.description, 300);
        items.push(description ? { title, description } : { title });
      }
      return items.length ? items : null;
    }
    case 'social': {
      if (!Array.isArray(raw)) return null;
      const links: SocialLink[] = [];
      for (const it of raw.slice(0, 12)) {
        const o = asObj(it);
        if (!o) continue;
        const platform = (SOCIAL_PLATFORMS as readonly string[]).includes(o.platform as string) ? (o.platform as SocialPlatform) : null;
        const url = typeof o.url === 'string' ? o.url.trim() : null;
        if (platform && isPlatformUrl(platform, url)) links.push({ platform, url: url as string });
      }
      return links.length ? links : null;
    }
    case 'files': {
      if (!Array.isArray(raw)) return null;
      const files: PublicFile[] = [];
      for (const it of raw.slice(0, 12)) {
        const o = asObj(it);
        if (!o || !isSafeMediaUrl(o.url)) continue;
        const title = cleanText(o.title, 120);
        if (!title) continue;
        const bytes = typeof o.bytes === 'number' && Number.isInteger(o.bytes) && o.bytes >= 0 ? o.bytes : null;
        files.push({ title, url: o.url, bytes });
      }
      return files.length ? files : null;
    }
    case 'announcement': {
      const o = asObj(raw);
      if (!o) return null;
      const title = cleanText(o.title, 120);
      const body = cleanText(o.body, 600);
      if (!title && !body) return null;
      return { title, body, until: isYmd(o.until) ? o.until : null };
    }
    case 'event': {
      const o = asObj(raw);
      if (!o) return null;
      const title = cleanText(o.title, 120);
      const venue = cleanText(o.venue, 200);
      const startsAt = isYmdHm(o.startsAt) ? o.startsAt : null;
      if (!title && !startsAt) return null;
      return {
        title,
        venue,
        startsAt,
        endsAt: isYmdHm(o.endsAt) ? o.endsAt : null,
        expiresAt: isYmd(o.expiresAt) ? o.expiresAt : null,
      };
    }
    case 'offer': {
      const o = asObj(raw);
      if (!o) return null;
      const title = cleanText(o.title, 120);
      const body = cleanText(o.body, 600);
      if (!title && !body) return null;
      return { title, body, validUntil: isYmd(o.validUntil) ? o.validUntil : null };
    }
    case 'support': {
      const o = asObj(raw);
      if (!o) return null;
      const phone = normalizePhone(o.phone);
      const hours = cleanText(o.hours, 200);
      const note = cleanText(o.note, 300);
      const url = isSafeUrl(typeof o.url === 'string' ? o.url.trim() : null) ? (o.url as string).trim() : null;
      if (!phone && !hours && !note && !url) return null;
      return { phone, hours, note, url };
    }
  }
  return null;
}

function orgValue(key: FieldKey, org: OrgDefaults): { value: unknown; source: string } | null {
  const src = org.sources ?? {};
  switch (key) {
    case 'title': {
      const v = orgText(org.title);
      return v ? { value: v, source: src.title ?? 'org' } : null;
    }
    case 'orgLine': {
      const v = orgText(org.orgLine);
      return v ? { value: v, source: src.orgLine ?? 'org' } : null;
    }
    case 'address': {
      const v = orgText(org.address);
      return v ? { value: v, source: src.address ?? 'org' } : null;
    }
    case 'avatar':
      return isSafeMediaUrl(org.logoUrl) ? { value: { url: org.logoUrl }, source: src.logoUrl ?? 'org' } : null;
    case 'privacyUrl':
      return isSafeUrl(org.privacyUrl) ? { value: org.privacyUrl, source: src.privacyUrl ?? 'org' } : null;
    case 'phone':
    case 'whatsapp': {
      const e164 = normalizePhone(org[key]);
      return e164 ? { value: e164, source: src[key] ?? 'org' } : null;
    }
    case 'email': {
      const v = typeof org.email === 'string' ? org.email.trim() : null;
      return isEmail(v) ? { value: v, source: src.email ?? 'org' } : null;
    }
    case 'website':
    case 'accessibilityUrl': {
      const v = typeof org[key] === 'string' ? (org[key] as string).trim() : null;
      return isSafeUrl(v) ? { value: v, source: src[key] ?? 'org' } : null;
    }
    default:
      return null;
  }
}

function fieldOf(doc: CardDoc, key: FieldKey, type: CardType): CardField {
  const f = asObj(doc.fields?.[key]);
  const base = defaultField(key, type);
  if (!f) return base;
  return {
    mode: (FIELD_MODES as readonly string[]).includes(f.mode as string) ? (f.mode as FieldMode) : base.mode,
    visibility: (FIELD_VISIBILITIES as readonly string[]).includes(f.visibility as string)
      ? (f.visibility as FieldVisibility)
      : base.visibility,
    value: f.value === undefined ? null : f.value,
  };
}

/**
 * Every field's effective value and its source. [parentPublic] is the parent's own effective
 * fields (only its public ones are ever read).
 */
export function effectiveFields(link: ChainLink, parentPublic: EffectiveFields | null, parentId: string | null): EffectiveFields {
  const out = {} as EffectiveFields;
  const type = link.meta.type;
  for (const key of FIELD_KEYS) {
    const spec = FIELD_SPECS[key];
    const f = fieldOf(link.doc, key, type);
    let value: unknown = null;
    let source = 'none';
    if (f.mode === 'hidden') {
      source = 'hidden';
    } else if (f.mode === 'local') {
      value = usableValue(key, f.value);
      source = 'local';
    } else {
      for (const from of type === 'personal' && spec.personalLocalOnly ? [] : spec.inherit) {
        if (from === 'parent') {
          const pf = parentPublic?.[key];
          if (pf && pf.isPublic) {
            value = pf.value;
            source = pf.source.startsWith('card:') || pf.source.startsWith('org') ? pf.source : `card:${parentId}`;
            break;
          }
        } else {
          const ov = orgValue(key, link.org);
          if (ov) {
            value = ov.value;
            source = ov.source;
            break;
          }
        }
      }
    }
    const isPublic = f.mode !== 'hidden' && f.visibility === 'public' && value !== null;
    out[key] = { value, source, mode: f.mode, visibility: f.visibility, isPublic };
  }
  return out;
}

/** The brand (palette + font) a card shows, and where it came from. */
export interface EffectiveBrand {
  palette: CardPalette;
  font: CardFont;
  source: string;
}

function cleanDesign(raw: unknown, template: CardTemplate): CardDesign {
  const base = designFromTemplate(template);
  const d = asObj(raw);
  if (!d) return base;
  const pick = <T extends string>(v: unknown, allowed: readonly T[], dflt: T): T =>
    (allowed as readonly string[]).includes(v as string) ? (v as T) : dflt;
  const num = (v: unknown, lo: number, hi: number, dflt: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : dflt;
  const pal = asObj(d.palette) ?? {};
  const palette = {} as CardPalette;
  for (const k of ['primary', 'accent', 'background', 'surface', 'text', 'muted'] as const) {
    palette[k] = isHexColor(pal[k]) ? (pal[k] as string).toLowerCase() : base.palette[k];
  }
  const cover = asObj(d.cover) ?? {};
  const avatar = asObj(d.avatar) ?? {};
  const buttons = asObj(d.buttons) ?? {};
  const motion = asObj(d.motion) ?? {};
  const cols = buttons.columns === 1 || buttons.columns === 2 || buttons.columns === 3 ? buttons.columns : base.buttons.columns;
  return {
    brandMode: pick(d.brandMode, ['inherit', 'local'] as const, 'local'),
    palette,
    font: pick(d.font, CARD_FONTS, base.font),
    textScale: pick(d.textScale, ['sm', 'md', 'lg'] as const, 'md'),
    spacing: pick(d.spacing, ['compact', 'normal', 'airy'] as const, base.spacing),
    radius: pick(d.radius, ['none', 'sm', 'md', 'lg', 'xl'] as const, base.radius),
    background: pick(d.background, ['solid', 'gradient'] as const, base.background),
    cover: {
      height: pick(cover.height, ['none', 'sm', 'md', 'lg'] as const, base.cover.height),
      fit: pick(cover.fit, ['cover', 'contain'] as const, base.cover.fit),
      focusX: num(cover.focusX, 0, 100, 50),
      focusY: num(cover.focusY, 0, 100, 50),
      overlay: num(cover.overlay, 0, 60, base.cover.overlay),
    },
    avatar: {
      shape: pick(avatar.shape, ['circle', 'rounded', 'square'] as const, base.avatar.shape),
      position: pick(avatar.position, ['center', 'start', 'overlap'] as const, base.avatar.position),
      size: pick(avatar.size, ['sm', 'md', 'lg'] as const, base.avatar.size),
    },
    buttons: {
      style: pick(buttons.style, ['filled', 'outline', 'soft', 'pill'] as const, base.buttons.style),
      columns: cols as 1 | 2 | 3,
      content: pick(buttons.content, ['icon_text', 'text', 'icon'] as const, base.buttons.content),
    },
    motion: {
      mode: pick(motion.mode, ['none', 'subtle', 'lively'] as const, 'subtle'),
      durationMs: num(motion.durationMs, 0, 1500, 450),
    },
  };
}

function templateOf(doc: CardDoc): CardTemplate {
  return (CARD_TEMPLATES as readonly string[]).includes(doc?.template) ? doc.template : 'cover';
}

function languagesOf(doc: CardDoc): CardLang[] {
  const langs = Array.isArray(doc?.languages) ? doc.languages.filter((l): l is CardLang => (CARD_LANGS as readonly string[]).includes(l)) : [];
  const unique = Array.from(new Set(langs));
  return unique.length ? unique : ['he'];
}

// ── The public model ─────────────────────────────────────────────────────────

export interface PublicText {
  text: string;
  lang: CardLang;
}
export interface PublicImage {
  url: string;
  alt: PublicText | null;
}
export interface PublicPhone {
  e164: string;
  display: string;
}
export type PublicSection =
  | { kind: 'actions'; intro: PublicText | null }
  | { kind: 'announcement'; title: PublicText | null; body: PublicText | null; until: string | null }
  | { kind: 'about'; text: PublicText }
  | { kind: 'event'; title: PublicText | null; venue: PublicText | null; startsAt: string | null; endsAt: string | null }
  | { kind: 'offer'; title: PublicText | null; body: PublicText | null; validUntil: string | null }
  | { kind: 'services'; items: { title: PublicText; description: PublicText | null }[] }
  | { kind: 'hours'; rows: HoursRow[]; note: PublicText | null }
  | { kind: 'location'; address: PublicText | null; navHref: string | null }
  | { kind: 'social'; links: { platform: SocialPlatform; url: string; label: PublicText }[] }
  | { kind: 'files'; files: { title: PublicText; url: string; bytes: number | null }[] }
  | { kind: 'support'; phone: PublicPhone | null; hours: PublicText | null; note: PublicText | null; url: string | null }
  | { kind: 'enquiry'; intro: PublicText | null };

export interface PublicAction {
  id: string;
  type: ActionType;
  label: PublicText;
  /** The real destination; null for save_contact / share / enquiry (the page handles them). */
  href: string | null;
  style: 'primary' | 'secondary';
  external: boolean;
  platform: SocialPlatform | null;
}

export interface PublicEnquiry {
  fields: Record<EnquiryFieldKey, EnquiryRequirement>;
  topics: PublicText[];
  intro: PublicText | null;
  privacyUrl: string | null;
}

export interface PublicDesign extends CardDesign {
  onPrimary: string;
  onAccent: string;
}

export interface PublicCardModel {
  v: 1;
  cardId: string;
  slug: string;
  type: CardType;
  template: CardTemplate;
  lang: CardLang;
  dir: 'rtl' | 'ltr';
  languages: CardLang[];
  design: PublicDesign;
  header: {
    title: PublicText | null;
    role: PublicText | null;
    orgLine: PublicText | null;
    avatar: PublicImage | null;
    cover: PublicImage | null;
  };
  contact: {
    phone: PublicPhone | null;
    whatsapp: PublicPhone | null;
    email: string | null;
    website: string | null;
    address: PublicText | null;
  };
  sections: PublicSection[];
  actions: PublicAction[];
  enquiry: PublicEnquiry | null;
  legal: { accessibilityUrl: string | null; privacyUrl: string | null };
  indexable: boolean;
}

/** Why an enabled action is not on the public card (the editor explains it). */
export type ActionUnavailable =
  | 'missing_phone'
  | 'missing_whatsapp'
  | 'missing_email'
  | 'missing_address'
  | 'missing_website'
  | 'invalid_url'
  | 'missing_file'
  | 'menu_unavailable'
  | 'enquiry_off';

export interface ResolveResult {
  model: PublicCardModel;
  fields: EffectiveFields;
  brandSource: string;
  /** Enabled actions that the visitor will not see, and why. */
  unavailableActions: { id: string; type: ActionType; reason: ActionUnavailable }[];
}

export function pickText(lt: unknown, lang: CardLang, defaultLang: CardLang): PublicText | null {
  const o = asObj(lt);
  if (!o) return null;
  const order: CardLang[] = [lang, defaultLang, ...CARD_LANGS];
  for (const l of order) {
    const s = o[l];
    if (typeof s === 'string' && s.trim()) return { text: s.trim(), lang: l };
  }
  return null;
}

function phoneOut(e164: unknown): PublicPhone | null {
  return typeof e164 === 'string' && e164 ? { e164, display: displayPhone(e164) } : null;
}

const COORDS = /^(-?\d{1,2}(\.\d+)?),\s*(-?\d{1,3}(\.\d+)?)$/;

export function navigationHref(query: string, provider: NavProvider): string {
  const q = query.trim();
  const m = COORDS.exec(q);
  if (provider === 'waze') {
    return m ? `https://waze.com/ul?ll=${m[1]},${m[3]}&navigate=yes` : `https://waze.com/ul?q=${encodeComponent(q)}&navigate=yes`;
  }
  return `https://www.google.com/maps/search/?api=1&query=${encodeComponent(m ? `${m[1]},${m[3]}` : q)}`;
}

function expired(until: string | null | undefined, today: string): boolean {
  return !!until && isYmd(until) && isYmd(today) && until < today;
}

function sectionsOf(doc: CardDoc, template: CardTemplate): CardSection[] {
  const seen = new Set<SectionKind>();
  const out: CardSection[] = [];
  if (Array.isArray(doc?.sections)) {
    for (const s of doc.sections) {
      const o = asObj(s);
      if (!o || !(SECTION_KINDS as readonly string[]).includes(o.kind as string) || seen.has(o.kind as SectionKind)) continue;
      seen.add(o.kind as SectionKind);
      out.push({ kind: o.kind as SectionKind, enabled: o.enabled === true });
    }
  }
  // A section the document does not list yet (an older document) comes last, off.
  for (const kind of TEMPLATE_PRESETS[template].sections) if (!seen.has(kind)) out.push({ kind, enabled: false });
  return out;
}

function actionsOf(doc: CardDoc): CardAction[] {
  const out: CardAction[] = [];
  const ids = new Set<string>();
  if (!Array.isArray(doc?.actions)) return out;
  for (const a of doc.actions.slice(0, 24)) {
    const o = asObj(a);
    if (!o || !(ACTION_TYPES as readonly string[]).includes(o.type as string)) continue;
    const id = typeof o.id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(o.id) ? o.id : null;
    if (!id || ids.has(id)) continue;
    ids.add(id);
    out.push({
      id,
      type: o.type as ActionType,
      enabled: o.enabled === true,
      label: cleanText(o.label, 40) ?? undefined,
      style: o.style === 'primary' ? 'primary' : 'secondary',
      url: typeof o.url === 'string' ? o.url.trim() : null,
      platform: (SOCIAL_PLATFORMS as readonly string[]).includes(o.platform as string) ? (o.platform as SocialPlatform) : null,
      fileUrl: typeof o.fileUrl === 'string' ? o.fileUrl.trim() : null,
      message: cleanText(o.message, 300) ?? undefined,
      navProvider: o.navProvider === 'waze' ? 'waze' : 'google',
    });
  }
  return out;
}

function enquiryOf(doc: CardDoc): EnquiryConfig {
  const e = asObj(doc?.enquiry) ?? {};
  const f = asObj(e.fields) ?? {};
  const fields = {} as Record<EnquiryFieldKey, EnquiryRequirement>;
  const dflt: Record<EnquiryFieldKey, EnquiryRequirement> = { name: 'required', phone: 'required', email: 'optional', topic: 'off', message: 'optional' };
  for (const k of ENQUIRY_FIELD_KEYS) {
    fields[k] = (ENQUIRY_REQUIREMENTS as readonly string[]).includes(f[k] as string) ? (f[k] as EnquiryRequirement) : dflt[k];
  }
  const topics = Array.isArray(e.topics) ? e.topics.slice(0, 12).map((t) => cleanText(t, 80)).filter((t): t is LocalText => !!t) : [];
  return {
    mode: e.mode === 'internal' ? 'internal' : 'disabled',
    fields,
    topics,
    intro: cleanText(e.intro, 300) ?? undefined,
    campaign: cleanStr(e.campaign, 60) ?? undefined,
  };
}

/** Whether the card can take enquiries at all: internal mode and a way to reply. */
export function enquiryUsable(cfg: EnquiryConfig): boolean {
  return cfg.mode === 'internal' && (cfg.fields.phone !== 'off' || cfg.fields.email !== 'off');
}

/**
 * The visitor's card: effective fields → header, sections, actions, enquiry, legal links, design.
 * Pure and deterministic; the server's `resolve_card` gives the same answer for the same input.
 */
export function resolveCard(input: ResolveInput): ResolveResult {
  // Ancestors first: each one's public values feed the next.
  let parentFields: EffectiveFields | null = null;
  let parentId: string | null = null;
  let parentBrand: EffectiveBrand | null = null;
  for (const link of input.parents) {
    parentFields = effectiveFields(link, parentFields, parentId);
    const tpl = templateOf(link.doc);
    const d = cleanDesign(link.doc?.design, tpl);
    parentBrand =
      d.brandMode === 'inherit' && parentBrand
        ? parentBrand
        : { palette: d.palette, font: d.font, source: `card:${link.meta.id}` };
    parentId = link.meta.id;
  }
  const { card } = input;
  const fields = effectiveFields(card, parentFields, parentId);
  const template = templateOf(card.doc);
  const languages = languagesOf(card.doc);
  const defaultLang = languages[0];
  const lang: CardLang = languages.includes(input.lang) ? input.lang : defaultLang;
  const txt = (v: unknown) => pickText(v, lang, defaultLang);
  const pub = (k: FieldKey) => (fields[k].isPublic ? fields[k].value : null);

  // Design: the brand from the parent when inherited (and there is one), the rest local.
  const own = cleanDesign(card.doc?.design, template);
  let brandSource = 'local';
  const design: CardDesign = { ...own, palette: { ...own.palette } };
  if (own.brandMode === 'inherit' && parentBrand) {
    design.palette = { ...parentBrand.palette };
    design.font = parentBrand.font;
    brandSource = parentBrand.source;
  }
  const publicDesign: PublicDesign = { ...design, onPrimary: readableOn(design.palette.primary), onAccent: readableOn(design.palette.accent) };

  const image = (v: unknown): PublicImage | null => {
    const o = asObj(v);
    return o && typeof o.url === 'string' ? { url: o.url, alt: txt(o.alt) } : null;
  };

  const title = txt(pub('title'));
  const address = txt(pub('address'));
  const navQuery = (pub('navigation') as string | null) ?? address?.text ?? null;
  const files = (pub('files') as PublicFile[] | null) ?? [];
  const enquiry = enquiryOf(card.doc);
  const sections = sectionsOf(card.doc, template);
  const enquirySection = sections.find((s) => s.kind === 'enquiry');
  const enquiryOn = enquiryUsable(enquiry) && !!enquirySection?.enabled;
  const privacyUrl = (pub('privacyUrl') as string | null) ?? null;

  // Actions.
  const actions: PublicAction[] = [];
  const unavailable: ResolveResult['unavailableActions'] = [];
  for (const a of actionsOf(card.doc)) {
    if (!a.enabled) continue;
    let href: string | null = null;
    let reason: ActionUnavailable | null = null;
    let external = false;
    let label = pickText(a.label, lang, defaultLang);
    switch (a.type) {
      case 'call': {
        const p = pub('phone') as string | null;
        if (p) href = `tel:${p}`;
        else reason = 'missing_phone';
        break;
      }
      case 'whatsapp': {
        const p = pub('whatsapp') as string | null;
        if (p) {
          const msg = txt(a.message);
          href = `https://wa.me/${p.slice(1)}${msg ? `?text=${encodeComponent(msg.text)}` : ''}`;
          external = true;
        } else reason = 'missing_whatsapp';
        break;
      }
      case 'email': {
        const e = pub('email') as string | null;
        if (e) href = `mailto:${e}`;
        else reason = 'missing_email';
        break;
      }
      case 'navigate':
        if (navQuery) {
          href = navigationHref(navQuery, a.navProvider ?? 'google');
          external = true;
        } else reason = 'missing_address';
        break;
      case 'website': {
        const w = pub('website') as string | null;
        if (w) {
          href = w;
          external = true;
        } else reason = 'missing_website';
        break;
      }
      case 'link': {
        const platform = a.platform ?? 'other';
        if (isPlatformUrl(platform, a.url)) {
          href = a.url as string;
          external = true;
          if (!label) label = { text: PLATFORM_LABELS[platform][lang], lang };
        } else reason = 'invalid_url';
        break;
      }
      case 'file': {
        const f = files.find((x) => x.url === a.fileUrl);
        if (f) {
          href = f.url;
          external = true;
          if (!label) label = txt(f.title);
        } else reason = 'missing_file';
        break;
      }
      case 'digital_menu':
      case 'order_online': {
        const d = input.destinations[a.type];
        if (d && isSafeUrl(d.url)) {
          href = d.url;
          if (!label) label = txt(d.label);
        } else reason = 'menu_unavailable';
        break;
      }
      case 'enquiry':
        if (!enquiryOn) reason = 'enquiry_off';
        break;
      case 'save_contact':
      case 'share':
        break;
    }
    if (reason) {
      unavailable.push({ id: a.id, type: a.type, reason });
      continue;
    }
    actions.push({
      id: a.id,
      type: a.type,
      label: label ?? { text: ACTION_LABELS[a.type][lang], lang },
      href,
      style: a.style,
      external,
      platform: a.type === 'link' ? (a.platform ?? 'other') : null,
    });
  }

  // Sections, in the card's order, only when on and with something to show.
  const out: PublicSection[] = [];
  for (const s of sections) {
    if (!s.enabled) continue;
    switch (s.kind) {
      case 'actions':
        if (actions.length) out.push({ kind: 'actions', intro: txt(pub('ctaText')) });
        break;
      case 'announcement': {
        const v = pub('announcement') as AnnouncementValue | null;
        if (v && !expired(v.until, input.today)) out.push({ kind: 'announcement', title: txt(v.title), body: txt(v.body), until: v.until ?? null });
        break;
      }
      case 'about': {
        const t = txt(pub('description'));
        if (t) out.push({ kind: 'about', text: t });
        break;
      }
      case 'event': {
        const v = pub('event') as EventValue | null;
        if (v && !expired(v.expiresAt, input.today))
          out.push({ kind: 'event', title: txt(v.title), venue: txt(v.venue), startsAt: v.startsAt ?? null, endsAt: v.endsAt ?? null });
        break;
      }
      case 'offer': {
        const v = pub('offer') as OfferValue | null;
        if (v && !expired(v.validUntil, input.today)) out.push({ kind: 'offer', title: txt(v.title), body: txt(v.body), validUntil: v.validUntil ?? null });
        break;
      }
      case 'services': {
        const v = pub('services') as ServiceItem[] | null;
        if (v) {
          const items = v
            .map((it) => ({ title: txt(it.title), description: txt(it.description) }))
            .filter((it): it is { title: PublicText; description: PublicText | null } => !!it.title);
          if (items.length) out.push({ kind: 'services', items });
        }
        break;
      }
      case 'hours': {
        const v = pub('hours') as HoursValue | null;
        if (v) out.push({ kind: 'hours', rows: v.rows, note: txt(v.note) });
        break;
      }
      case 'location': {
        const nav = actions.find((a) => a.type === 'navigate');
        const navHref = nav?.href ?? (navQuery ? navigationHref(navQuery, 'google') : null);
        if (address || navHref) out.push({ kind: 'location', address, navHref });
        break;
      }
      case 'social': {
        const v = pub('social') as SocialLink[] | null;
        if (v) out.push({ kind: 'social', links: v.map((l) => ({ platform: l.platform, url: l.url, label: { text: PLATFORM_LABELS[l.platform][lang], lang } })) });
        break;
      }
      case 'files': {
        const list = files
          .map((f) => ({ title: txt(f.title), url: f.url, bytes: f.bytes ?? null }))
          .filter((f): f is { title: PublicText; url: string; bytes: number | null } => !!f.title);
        if (list.length) out.push({ kind: 'files', files: list });
        break;
      }
      case 'support': {
        const v = pub('support') as SupportValue | null;
        if (v) out.push({ kind: 'support', phone: phoneOut(v.phone), hours: txt(v.hours), note: txt(v.note), url: v.url ?? null });
        break;
      }
      case 'enquiry':
        if (enquiryOn) out.push({ kind: 'enquiry', intro: txt(enquiry.intro) });
        break;
    }
  }

  const model: PublicCardModel = {
    v: 1,
    cardId: card.meta.id,
    slug: card.meta.slug,
    type: card.meta.type,
    template,
    lang,
    dir: dirOf(lang),
    languages,
    design: publicDesign,
    header: {
      title,
      role: txt(pub('role')),
      orgLine: txt(pub('orgLine')),
      avatar: image(pub('avatar')),
      cover: image(pub('cover')),
    },
    contact: {
      phone: phoneOut(pub('phone')),
      whatsapp: phoneOut(pub('whatsapp')),
      email: (pub('email') as string | null) ?? null,
      website: (pub('website') as string | null) ?? null,
      address,
    },
    sections: out,
    actions,
    enquiry: enquiryOn
      ? {
          fields: enquiry.fields,
          topics: enquiry.topics.map((t) => txt(t)).filter((t): t is PublicText => !!t),
          intro: txt(enquiry.intro),
          privacyUrl,
        }
      : null,
    legal: { accessibilityUrl: (pub('accessibilityUrl') as string | null) ?? null, privacyUrl },
    indexable: asObj(card.doc?.seo)?.indexable === true,
  };
  return { model, fields, brandSource, unavailableActions: unavailable };
}

// ── Publication review ───────────────────────────────────────────────────────

export interface CardIssue {
  level: 'error' | 'warning';
  code: string;
  field?: FieldKey;
  actionId?: string;
}

/**
 * What blocks publication (errors) and what deserves a look (warnings). The server runs the
 * same checks before it publishes; the editor shows them live.
 */
export function cardIssues(input: ResolveInput, result?: ResolveResult): CardIssue[] {
  const r = result ?? resolveCard(input);
  const issues: CardIssue[] = [];
  const doc = input.card.doc;
  const type = input.card.meta.type;
  if (!r.fields.title.isPublic) issues.push({ level: 'error', code: 'title_required', field: 'title' });
  // A local value that is present but unusable (a typo'd phone, an http:// link…).
  for (const key of FIELD_KEYS) {
    const f = fieldOf(doc, key, type);
    if (f.mode !== 'local' || f.value === null || f.value === undefined || f.value === '') continue;
    const kind = FIELD_SPECS[key].kind;
    if (['phone', 'email', 'url', 'image'].includes(kind) && usableValue(key, f.value) === null) {
      issues.push({ level: 'error', code: `invalid_${kind}`, field: key });
    }
  }
  if (!r.model.legal.accessibilityUrl) issues.push({ level: 'error', code: 'accessibility_required', field: 'accessibilityUrl' });
  if (!r.model.legal.privacyUrl) issues.push({ level: 'error', code: 'privacy_required', field: 'privacyUrl' });
  const enquiry = enquiryOf(doc);
  if (enquiry.mode === 'internal' && !enquiryUsable(enquiry)) issues.push({ level: 'error', code: 'enquiry_contact_field' });
  const p = r.model.design.palette;
  if (contrastRatio(p.text, p.background) < 4.5 || contrastRatio(p.text, p.surface) < 4.5) issues.push({ level: 'error', code: 'contrast_text' });
  if (contrastRatio(p.muted, p.background) < 4.5 || contrastRatio(p.muted, p.surface) < 4.5) issues.push({ level: 'error', code: 'contrast_muted' });
  if (contrastRatio(p.primary, p.background) < 3) issues.push({ level: 'warning', code: 'contrast_primary' });
  if (!r.model.actions.length) issues.push({ level: 'warning', code: 'no_actions' });
  for (const u of r.unavailableActions) issues.push({ level: 'warning', code: `action_${u.reason}`, actionId: u.id });
  const ev = r.fields.event;
  if (ev.isPublic && expired((ev.value as EventValue).expiresAt, input.today)) issues.push({ level: 'warning', code: 'event_expired', field: 'event' });
  if (expired(asObj(doc)?.expiresAt as string | null | undefined, input.today)) issues.push({ level: 'warning', code: 'card_expired' });
  return issues;
}

// ── Slugs ─────────────────────────────────────────────────────────────────────

const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,58}[a-z0-9])$/;
export const RESERVED_SLUGS = ['admin', 'api', 'new', 'edit', 'preview', 'dashboard', 'vcard', 'qr', 'www', 'static', 'assets', 'c'];

/** 3–60 characters: lowercase latin letters, digits and inner hyphens (no "--"). */
export function isValidSlug(value: unknown): value is string {
  return typeof value === 'string' && SLUG.test(value) && !value.includes('--') && !RESERVED_SLUGS.includes(value);
}

/** A slug suggestion from a name typed in any language (latin letters and digits survive). */
export function suggestSlug(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 50)
    .replace(/-+$/g, '');
  return s.length >= 3 && isValidSlug(s) ? s : '';
}

/** The public card's path. */
export function cardPath(slug: string): string {
  return `/c/${slug}`;
}
