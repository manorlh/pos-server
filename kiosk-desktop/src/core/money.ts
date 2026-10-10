/**
 * Money as integer agorot, as on the till (pos-android core/Money.kt, domain/Vat.kt): shekel
 * doubles only at the edges (the cloud's JSON). Rounding is Java's BigDecimal HALF_UP on the
 * double's shortest decimal form — `Math.round(x * 100)` gets 0.145 wrong (14 instead of 15) and
 * rounds −14.5 toward zero; this does not.
 */

/** BigDecimal.valueOf(d).movePointRight(digits).setScale(0, HALF_UP) without a decimal library. */
export function halfUpScaled(d: number, digits: number): number {
  if (!Number.isFinite(d)) throw new Error(`not a number: ${d}`);
  if (d === 0) return 0;
  const neg = d < 0;
  // The shortest round-trip form, as Double.toString / BigDecimal.valueOf read it.
  let s = String(Math.abs(d));
  let exp = 0;
  const e = s.indexOf('e');
  if (e >= 0) {
    exp = Number(s.slice(e + 1));
    s = s.slice(0, e);
  }
  const dot = s.indexOf('.');
  let intPart = dot >= 0 ? s.slice(0, dot) : s;
  let frac = dot >= 0 ? s.slice(dot + 1) : '';
  // Move the point right by digits + exp.
  let shift = digits + exp;
  if (shift >= 0) {
    if (frac.length < shift) frac = frac.padEnd(shift, '0');
    intPart = intPart + frac.slice(0, shift);
    frac = frac.slice(shift);
  } else {
    shift = -shift;
    const padded = intPart.padStart(shift + 1, '0');
    frac = padded.slice(padded.length - shift) + frac;
    intPart = padded.slice(0, padded.length - shift);
  }
  let n = Number(intPart || '0');
  if (frac.length > 0 && frac.charCodeAt(0) >= 53 /* '5' */) n += 1;
  return neg ? -n : n;
}

/** Shekels (the cloud's float) → agorot, HALF_UP. */
export function ofShekels(shekels: number): number {
  return halfUpScaled(shekels, 2);
}

export function toShekels(agorot: number): number {
  return agorot / 100;
}

/** unit × quantity, HALF_UP to the agora (Money.times). */
export function times(unitAgorot: number, quantity: number): number {
  if (Number.isInteger(quantity)) return unitAgorot * quantity;
  return halfUpScaled(unitAgorot * quantity, 0);
}

/** Java's Math.round(double): floor(x + 0.5) — the same as JS Math.round. */
export const javaRound = (x: number) => Math.floor(x + 0.5);

/** Prices include VAT: the net part of `grossAgorot` at `rate` (a fraction, 0.18). */
export function vatNet(grossAgorot: number, rate: number): number {
  return rate <= 0 ? grossAgorot : javaRound(grossAgorot / (1 + rate));
}

export function vatAmount(grossAgorot: number, rate: number): number {
  return grossAgorot - vatNet(grossAgorot, rate);
}

/** "123.45" — no thousands separator, as the receipt prints (Money.format(withSymbol=false)). */
export function formatAgorot(agorot: number): string {
  const neg = agorot < 0;
  const a = Math.abs(Math.trunc(agorot));
  const s = `${Math.trunc(a / 100)}.${String(a % 100).padStart(2, '0')}`;
  return neg ? `-${s}` : s;
}

/** "₪123.45" (or "-₪12.00"): the sign before the ₪. */
export function formatShekelSign(agorot: number): string {
  const neg = agorot < 0;
  return `${neg ? '-' : ''}₪${formatAgorot(Math.abs(agorot))}`;
}

/** Wrap in LRI … PDI so numbers stay left-to-right inside Hebrew text. */
export function ltr(s: string): string {
  return `⁦${s}⁩`;
}
