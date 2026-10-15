/**
 * Logs sent to the cloud ("שליחת לוגים לענן", P:/specs/device-logs-api.md §4): scrubbed on the device,
 * before compression — the same rules as the Android till's:
 *  - a card number (13–19 digits, spaces or dashes allowed, passing Luhn) → "************1234"; track 2 too;
 *  - the value of any key naming a secret (token, secret, password, passwd, pin, cvv, authorization, api_key,
 *    apikey, terminal_password) → "***", and "Bearer …" → "Bearer ***";
 *  - an Israeli mobile "05X-XXXXXXX" → "05X-***-XX12";
 *  - an e-mail → "a***@domain".
 * Idempotent: scrubbing twice changes nothing more.
 *
 * Pure.
 */

const SECRET_KEYS = 'token|secret|password|passwd|pin|cvv|authorization|api_key|apikey|terminal_password';

function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

export function scrubLogText(text: string): string {
  let out = text;
  // "key": "value" / key=value / key: value, for keys naming a secret.
  out = out.replace(new RegExp(`("?[A-Za-z_]*(?:${SECRET_KEYS})[A-Za-z_]*"?\\s*[:=]\\s*)("[^"]*"|[^\\s,;&}]+)`, 'gi'), (_m, key: string, value: string) =>
    value === '"***"' || value === '***' ? `${key}${value}` : `${key}${value.startsWith('"') ? '"***"' : '***'}`,
  );
  out = out.replace(/\bBearer\s+(?!\*\*\*)[A-Za-z0-9._~+/=-]+/g, 'Bearer ***');
  // Track 2 (";4580…=2512…?") before the card numbers.
  out = out.replace(/;?\d{13,19}=\d{4,}[\d]*\??/g, (m) => {
    const pan = m.replace(/^;/, '').split('=')[0];
    return `************${pan.slice(-4)}=***`;
  });
  out = out.replace(/\b\d(?:[ -]?\d){12,18}\b/g, (m) => {
    const digits = m.replace(/[ -]/g, '');
    if (digits.length < 13 || digits.length > 19 || !luhn(digits)) return m;
    return `************${digits.slice(-4)}`;
  });
  out = out.replace(/\b(05\d)-?(\d{3})-?(\d{4})\b/g, (_m, pre: string, _mid: string, end: string) => `${pre}-***-XX${end.slice(-2)}`);
  out = out.replace(/\b([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g, (_m, first: string, domain: string) => `${first}***@${domain}`);
  return out;
}
