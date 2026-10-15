/**
 * Cash credits ("זיכוי להזמנה הבאה", P:/specs/cash-paylink.md §11.15א): change the cash station could not
 * pay, which the customer chose to keep for a next order. The code is the transaction's slip code
 * (`C-K7Q3MX`, core/cash/tx.ts `slipCodeOf`); the slip's QR carries "CC:" + the code.
 *
 * Read here: a scan ("CC:C-K7Q3MX", maybe after the scanner's AIM prefix) or a typed code
 * ("C-K7Q3MX", "CK7Q3MX", any case) → the code as stored, or null.
 *
 * Pure.
 */

export const CASH_CREDIT_QR_PREFIX = 'CC:';
const BODY = /^[A-Z0-9]{6}$/;

function trim(raw: string): string {
  // eslint-disable-next-line no-control-regex
  return raw.replace(/^[\s\u0000-\u001f\u007f]+|[\s\u0000-\u001f\u007f]+$/g, '');
}

/** "C-K7Q3MX" from a typed code ("c-k7q3mx", "CK7Q3MX", "CC:C-K7Q3MX"), or null. */
export function cashCreditCodeOf(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let t = trim(raw).toUpperCase();
  if (t.startsWith(CASH_CREDIT_QR_PREFIX)) t = t.slice(CASH_CREDIT_QR_PREFIX.length).trim();
  t = t.replace(/[\s_]/g, '');
  if (!t.startsWith('C')) return null;
  const body = t.slice(t[1] === '-' ? 2 : 1);
  return BODY.test(body) ? `C-${body}` : null;
}

/** A scan: only with the "CC:" prefix (after an AIM identifier) is it a cash credit. */
export function scannedCashCreditCode(raw: string): string | null {
  let t = trim(raw);
  if (t.length > 3 && t[0] === ']' && /[A-Za-z]/.test(t[1]) && /\d/.test(t[2])) t = trim(t.slice(3));
  if (!t.toUpperCase().startsWith(CASH_CREDIT_QR_PREFIX)) return null;
  return cashCreditCodeOf(t);
}

/** What the slip's QR carries. */
export function cashCreditQr(code: string): string {
  return `${CASH_CREDIT_QR_PREFIX}${code}`;
}

/**
 * A cloud refusal's code and words, from either shape (§11.11): FastAPI's `{"detail": {"code", "message", …}}` or a
 * plain `{"error", "message"}`; a `detail` that is text has no code.
 */
export function refusalOf(body: unknown): { code: string | null; message: string | null; extra: Record<string, unknown> } {
  const b = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const d = b.detail;
  if (d && typeof d === 'object') {
    const o = d as Record<string, unknown>;
    return { code: typeof o.code === 'string' ? o.code : null, message: typeof o.message === 'string' ? o.message : null, extra: o };
  }
  if (typeof d === 'string') return { code: null, message: d, extra: {} };
  return { code: typeof b.error === 'string' ? b.error : null, message: typeof b.message === 'string' ? b.message : null, extra: b };
}

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * The cash credits a payment carries (`StartPaymentIn.credits`), read field by field — the browser kiosk's bridge sends
 * them over HTTP. None: []. Anything malformed (or the same redemption twice): null — the payment is refused.
 */
export function creditLegsOf(raw: unknown): Array<{ redemptionId: string; code: string; amountAgorot: number }> | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > 10) return null;
  const out: Array<{ redemptionId: string; code: string; amountAgorot: number }> = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const o = item && typeof item === 'object' ? (item as Record<string, unknown>) : null;
    const id = typeof o?.redemptionId === 'string' && UUID.test(o.redemptionId) ? o.redemptionId : null;
    const code = cashCreditCodeOf(o?.code);
    const amount = typeof o?.amountAgorot === 'number' && Number.isInteger(o.amountAgorot) && o.amountAgorot > 0 && o.amountAgorot <= 10_000_000 ? o.amountAgorot : null;
    if (!id || !code || amount === null || seen.has(id)) return null;
    seen.add(id);
    out.push({ redemptionId: id, code, amountAgorot: amount });
  }
  return out;
}
