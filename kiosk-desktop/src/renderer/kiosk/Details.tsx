/**
 * "פרטים" — only what the kiosk asks, once per order, at the configured step (the Android
 * kiosk's DetailsScreen): the name to call, a phone ("רק להזמנה הזו — לא מועדון ולא דיוור"), the
 * table for eat-in, the tip (off by default; "בלי טיפ" chosen first). With the kiosk's keyboard.
 */

import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { cardStyle, type PreviewModel } from '@kiosk-shared/index';
import { phoneValid } from '../../core/kioskOrders';
import { applyKey, Keyboard } from './Keyboard';
import { t } from '../i18n';

export interface DetailsValue {
  name: string;
  phone: string;
  table: string;
  tipPct: number | null;
}

type Field = 'name' | 'phone' | 'table';

export function DetailsScreen({
  m,
  value,
  onChange,
  onDone,
  onBack,
  service,
  afterPay,
}: {
  m: PreviewModel;
  value: DetailsValue;
  onChange: (v: DetailsValue) => void;
  onDone: () => void;
  onBack: (() => void) | null;
  service: 'take_away' | 'eat_in' | null;
  afterPay: boolean;
}) {
  const cfg = m.cfg;
  const payment = cfg.payment as typeof cfg.payment & { tableNumber?: string };
  const askName = cfg.payment.customerName !== 'off';
  const askPhone = cfg.payment.customerPhone !== 'off';
  const askTable = service === 'eat_in' && (cfg.general.askTableNumber || (payment.tableNumber !== undefined && payment.tableNumber !== 'off'));
  const askTip = cfg.payment.tipEnabled && !afterPay;
  const fields: Field[] = [...(askName ? ['name' as const] : []), ...(askPhone ? ['phone' as const] : []), ...(askTable ? ['table' as const] : [])];
  const [focus, setFocus] = useState<Field | null>(fields[0] ?? null);
  const [tried, setTried] = useState(false);

  const required = (f: Field) => (f === 'name' ? cfg.payment.customerName === 'required' : f === 'phone' ? cfg.payment.customerPhone === 'required' : true);
  const errorOf = (f: Field): string | null => {
    const v = value[f].trim();
    if (!v) return required(f) ? t('required') : null;
    if (f === 'phone' && !phoneValid(v)) return t('phoneInvalid');
    return null;
  };
  const ok = fields.every((f) => errorOf(f) === null);
  const label = (f: Field) => (f === 'name' ? t('nameLabel') : f === 'phone' ? t('phoneLabel') : t('tableLabel'));

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 px-4 pt-4">
        {onBack ? (
          <button type="button" aria-label={t('back')} onClick={onBack} className="flex h-9 w-9 items-center justify-center rounded-full" style={{ background: `${m.c.button}1A`, color: m.c.button }}>
            <ChevronRight className="h-5 w-5" />
          </button>
        ) : null}
        <h2 className="flex-1 text-xl font-extrabold">{t('detailsTitle')}</h2>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4 [scrollbar-width:none]">
        {fields.length > 0 ? (
          <p className="kt-11 leading-snug" style={{ color: m.c.mutedText }}>
            {m.txt('customerExplain')}
          </p>
        ) : null}
        {fields.map((f) => {
          const err = tried ? errorOf(f) : null;
          return (
            <button
              key={f}
              type="button"
              onClick={() => setFocus(f)}
              className="block w-full px-3 py-2.5 text-start"
              style={{ border: `2px solid ${focus === f ? m.c.button : err ? '#DC2626' : m.c.border}`, borderRadius: Math.min(m.radius, 14), background: m.c.surface }}
            >
              <div className="text-xs" style={{ color: m.c.mutedText }}>
                {label(f)}
                {required(f) ? <span style={{ color: '#DC2626' }}> *</span> : null}
              </div>
              <div className="min-h-6 text-lg font-semibold" dir={f === 'name' ? 'rtl' : 'ltr'} style={{ textAlign: 'start' }}>
                {value[f] || <span style={{ color: m.c.mutedText, fontWeight: 400 }}>{f === 'name' ? t('nameHint') : f === 'phone' ? '05X-XXXXXXX' : ''}</span>}
                {focus === f ? <span className="ms-0.5 inline-block h-5 w-0.5 animate-pulse align-middle" style={{ background: m.c.button }} /> : null}
              </div>
              {err ? <div className="text-xs font-medium" style={{ color: '#DC2626' }}>{err}</div> : null}
            </button>
          );
        })}
        {askTip ? (
          <div className="space-y-2 p-3" style={cardStyle(m)}>
            <div className="text-sm font-bold">{t('tipTitle')}</div>
            <div className="flex flex-wrap gap-2">
              {[null, ...cfg.payment.tipPresets].map((p) => {
                const on = value.tipPct === p;
                return (
                  <button
                    key={p ?? 'none'}
                    type="button"
                    onClick={() => onChange({ ...value, tipPct: p })}
                    className="min-w-16 px-3 py-2 text-sm font-bold"
                    style={on ? { background: m.c.button, color: m.c.buttonText, borderRadius: m.btnRadius } : { ...cardStyle(m), borderRadius: m.btnRadius }}
                  >
                    {p === null ? t('tipNone') : `${p}%`}
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}
      </div>
      <div className="shrink-0 space-y-2 p-3" style={{ background: m.c.background }}>
        {focus ? <Keyboard m={m} mode={focus === 'name' ? 'text' : 'digits'} onKey={(k) => onChange({ ...value, [focus]: applyKey(value[focus], k, focus === 'name' ? 40 : focus === 'phone' ? 12 : 8) })} /> : null}
        <button
          type="button"
          onClick={() => {
            setTried(true);
            if (ok) onDone();
          }}
          className={`flex w-full items-center justify-center px-4 py-3 kt-15 font-bold ${ok ? '' : 'opacity-60'}`}
          style={{ background: m.c.button, color: m.c.buttonText, borderRadius: m.btnRadius }}
        >
          {afterPay ? t('continue') : m.txt('checkoutCta')}
        </button>
      </div>
    </div>
  );
}
