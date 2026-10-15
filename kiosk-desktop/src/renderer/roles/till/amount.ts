/** "123.40" / "123" / "₪1,234.5" → agorot; null when it is not an amount. */
export function parseAmount(text: string): number | null {
  const t = text.trim().replace(/[₪,\s]/g, '');
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(t)) return null;
  const [whole, frac = ''] = t.split('.');
  return Number(whole) * 100 + Number((frac + '00').slice(0, 2));
}
