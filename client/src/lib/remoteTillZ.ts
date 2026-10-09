/**
 * "סגירת משמרת / הפקת Z מרחוק" (pos-server app/services/remote_till_z.py, behind the server's
 * REMOTE_TILL_Z_ENABLED): the manager confirms the till's current totals, and the till closes (or
 * makes its Z) once no sale or card payment is open — never forced, never automatic. The pure parts.
 */

export interface RemoteClosePreview {
  machineId: string;
  name: string;
  posNumber: string | null;
  online: boolean;
  kind: 'till_z' | 'close_shift';
  kindLabel: string;
  openShift: { id: string; openedAt: string | null; openedBy: string | null } | null;
  shiftsCount: number;
  totals: {
    transactions: number;
    sales: number;
    creditNotes: number;
    totalSales: number;
    totalRefunds: number;
    net: number;
    discounts: number;
    tips: number;
    byTender: Record<string, number>;
    firstDocument: string | null;
    lastDocument: string | null;
  };
  lastZNumber: number | null;
  nextZNumber: number | null;
  pending:
    | ({ kind: string; id: string; status: string; errorCode: string | null; waitForRest: boolean; createdAt: string | null } & Omit<
        import('./heldSales').HeldSalesState,
        'keepHeldSales'
      > & { keepHeldSales?: boolean; keepOffer?: import('./heldSales').HeldSalesOffer | null })
    | null;
  totalsKey: string;
  canRequest: boolean;
  whyNot: string | null;
}

const TENDERS: Record<string, string> = {
  cash: 'מזומן',
  card: 'אשראי',
  credit_card: 'אשראי',
  voucher: 'שובר',
  prepaid_voucher: 'שובר מראש',
  bit: 'ביט',
  check: "צ'ק",
  exchange: 'קיזוז',
  unknown: 'לא ידוע',
};

export function tenderLabel(method: string): string {
  return TENDERS[method] ?? method;
}

export function money(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return '—';
  return `₪${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * The confirm button's words: "הפק Z הבא" / "סגור משמרת". Never a predicted number: the Z is
 * numbered when it is made (another Z may come first).
 */
export function confirmLabel(p: Pick<RemoteClosePreview, 'kind'>): string {
  if (p.kind === 'till_z') return 'הפק Z הבא';
  return 'סגור משמרת';
}

const WAITS: Record<string, string> = {
  sale_open: 'ממתין לסיום המכירה בקופה',
  held_sales: 'ממתין — מכירות מושהות',
  payment_in_progress: 'ממתין לסיום התשלום בקופה',
  card_in_flight: 'ממתין לעסקת אשראי שבדרך',
  printing: 'ממתין למדפסת',
  kiosk_ordering: 'לקוח מזמין בקיוסק',
  kiosk_paying: 'לקוח משלם בקיוסק',
  open_tables: 'יש שולחנות פתוחים בקופה',
  no_open_shift: 'אין משמרת פתוחה בקופה',
};

/** A request's state in words: "נשלח · ממתין לסיום המכירה בקופה", "בוצע", "נכשל: …". */
export function requestStateLabel(status: string, errorCode: string | null | undefined): string {
  const why = errorCode ? WAITS[errorCode] ?? errorCode : null;
  if (['completed', 'done'].includes(status)) return 'בוצע';
  if (['failed', 'expired', 'cancelled'].includes(status)) {
    const word = status === 'failed' ? 'נכשל' : status === 'expired' ? 'פג תוקף' : 'בוטל';
    return why && status === 'failed' ? `${word}: ${why}` : word;
  }
  return why ? `נשלח · ${why}` : 'נשלח · ייסגר כשהקופה פנויה';
}
