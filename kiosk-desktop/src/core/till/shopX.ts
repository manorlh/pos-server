/**
 * "דוח X סניפי" on the Windows till (P:/specs/shop-x-report.md §3, §4, §6 — the Android till's domain/ShopX.kt, cloud
 * route only): an interim report of every till of the shop, built by the cloud — no number, never a document, closes
 * nothing. The till decides by itself whether the menu shows it:
 *
 *  - `shopXTills` all (default) | selected (this till's id in `shopXTillIds`) | master (the shop Z's main till,
 *    `shopZMasterTill` / `mainTill`) | off;
 *  - the user's SHOP_X_REPORT (allow / a manager's code / deny) — the engine's gate;
 *  - the menu key `shop_x` (hiddenMenuItems) hides it.
 *
 * `GET|POST /sync/{m}/shop-x` answers `{available, report, printDocument}`; the paper is `printDocument` as the cloud
 * wrote it (`title`, `businessName`, `subtitle`, `sections[{title, rows[{label, value, emphasis}]}]`, `footer`), printed
 * on the receipt printer like the till's X. Offline: "דוח X סניפי דורש חיבור לענן" — the till's own X stays.
 *
 * Pure.
 */

export const SHOP_X_PERMISSION = 'SHOP_X_REPORT';

export const SHOP_X_TEXT = {
  menu: 'דוח X סניפי',
  needsCloud: 'דוח X סניפי דורש חיבור לענן. אפשר להפיק X של הקופה עצמה.',
  notHere: 'דוח X סניפי אינו מופעל בקופה זו',
  failed: 'הענן לא החזיר את דוח X הסניפי. נסו שוב.',
  printed: 'דוח X סניפי נשלח להדפסה',
} as const;

/** Whether the till's parameters put "דוח X סניפי" on this till (before the user's right and the menu's hiding). */
export function shopXOffered(params: Record<string, unknown> | null | undefined, machineId: string | null): boolean {
  const p = params ?? {};
  const mode = typeof p.shopXTills === 'string' ? p.shopXTills.trim().toLowerCase() : '';
  const id = (machineId ?? '').trim().toLowerCase();
  switch (mode) {
    case 'off':
      return false;
    case 'selected': {
      const raw = p.shopXTillIds;
      const ids = (Array.isArray(raw) ? raw.map(String) : typeof raw === 'string' ? raw.split(',') : []).map((x) => x.trim().toLowerCase()).filter(Boolean);
      return !!id && ids.includes(id);
    }
    case 'master': {
      const master = [p.shopZMasterTill, p.mainTill].find((v) => typeof v === 'string' && v.trim() !== '') as string | undefined;
      return !!id && !!master && master.trim().toLowerCase() === id;
    }
    default:
      // `all`, unset or anything else: every till of the shop (the default).
      return true;
  }
}

export interface ShopXRow {
  label: string;
  value: string;
  emphasis: boolean;
}

export interface ShopXDocument {
  title: string;
  businessName: string | null;
  subtitle: string | null;
  sections: Array<{ title: string | null; rows: ShopXRow[] }>;
  footer: string | null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);

/** The cloud's `printDocument`, read field by field (anything missing is left out, never invented). Null: not one. */
export function shopXDocumentOf(raw: unknown): ShopXDocument | null {
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as Record<string, unknown>;
  const sections = Array.isArray(d.sections) ? d.sections : [];
  return {
    title: str(d.title) ?? SHOP_X_TEXT.menu,
    businessName: str(d.businessName),
    subtitle: str(d.subtitle),
    sections: sections
      .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
      .map((s) => ({
        title: str(s.title),
        rows: (Array.isArray(s.rows) ? s.rows : [])
          .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
          .map((r) => ({ label: String(r.label ?? ''), value: r.value === null || r.value === undefined ? '' : String(r.value), emphasis: r.emphasis === true })),
      })),
    footer: str(d.footer),
  };
}

/** The refusal of the cloud, in the till's words. */
export function shopXRefusal(status: number, body: unknown): string {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const detail = (b.detail && typeof b.detail === 'object' ? b.detail : b) as Record<string, unknown>;
  if (status === 403 && (detail.code === 'shop_x_not_available' || b.code === 'shop_x_not_available')) return SHOP_X_TEXT.notHere;
  if (status === 0) return SHOP_X_TEXT.needsCloud;
  return SHOP_X_TEXT.failed;
}
