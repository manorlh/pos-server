/**
 * "מסך לקוח" — the till's second screen (main/shell/customerDisplayWindow.ts): the dashboard's own `CustomerScreen`
 * (client/src/components/customer-display-web/display-screen.tsx), fed by the till over IPC — the settings, the branding and
 * the one state (`customer_display_state` v1). It never talks to the network or the till's engine itself.
 */

import '@fontsource/noto-sans-hebrew/hebrew-400.css';
import '@fontsource/noto-sans-hebrew/hebrew-700.css';
import '@fontsource/noto-sans-hebrew/hebrew-900.css';
import '../styles.css';
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CustomerScreen } from '@/components/customer-display-web/display-screen';
import { DEFAULTS as CD_DEFAULTS, type CdConfig, type CdState } from '@dash-lib/customerDisplay';

interface Frame {
  config: CdConfig;
  branding: { shopName: string; logoUrl: string; primaryColor: string | null };
  state: CdState;
}

/**
 * `npm run dev:web` (no Electron, no `window.kioskDisplay`): the layout audit's frame (P:/specs/layout-audit-1610/README.md)
 * — `?phase=basket|tip|paying|change|thanks&layout=auto|split|full&theme=dark|light|brand`, 24 lines with long Hebrew and
 * English names, ₪99,999.90. Never in the till (the till always gives the bridge).
 */
function auditFrame(): Frame | null {
  if (typeof window === 'undefined' || window.kioskDisplay || !__WEB_BRIDGE__) return null;
  const q = new URLSearchParams(window.location.search);
  const phase = (q.get('phase') ?? 'basket') as CdState['phase'];
  const names = [
    'שניצל עוף בציפוי פנקו עם פירה תפוחי אדמה ורוטב פטריות שמנת',
    'Double Smash Burger with Caramelized Onions, Aged Cheddar & Truffle Mayo',
    'Ultimate בורגר XXL Special Edition',
    'מגש אירוח ענק לאירועים — Party Platter Deluxe',
    'קפה הפוך גדול על חלב שיבולת שועל',
    'אספרסו',
  ];
  const lines = Array.from({ length: 24 }, (_, i) => ({
    id: `l${i}`,
    name: names[i % names.length],
    qty: i % 5 === 0 ? 12 : 1,
    unit: null,
    total: i === 3 ? 9_999_990 : 1_290 + i * 731,
    modifiers: i % 3 === 0 ? ['+ ביצת עין', 'בלי בצל', 'Sauce on the side', 'רוטב צ׳ילי מתוק בצד'] : [],
    discount: i % 4 === 1 ? 500 : 0,
    promo: i % 4 === 1 ? '1+1 על כל המשקאות הקרים — Happy Hour' : null,
    refund: i === 6,
  }));
  const total = 10_123_456;
  const state: CdState = {
    v: 1,
    seq: 1,
    phase,
    lines: phase === 'idle' ? [] : lines,
    promotions: [{ name: '1+1 על כל המשקאות הקרים — Happy Hour', amount: 4_590 }],
    vouchers: [{ name: 'שובר #12 · ארוחת צהריים לעובדים — Annual Company Conference 2026', amount: 12_990 }],
    discount: 17_580,
    total,
    itemCount: 98,
    tip: phase === 'tip' ? { presets: [10, 12, 15], selectedPercent: 12, amount: 1_214_815 } : null,
    payment: phase === 'paying' ? { method: 'card', status: 'waiting_card', due: total, paid: 0, notice: 'בתשלום באשראי: לא ניתן לשלם בכרטיס דביט / דיירקט / כרטיס זר כרגע' } : null,
    cash: phase === 'change' ? { tendered: 10_200_000, change: 76_544 } : null,
    thanks: phase === 'thanks' ? { total, change: 76_544, tip: 1_214_815, receiptUrl: 'https://example.invalid/r/40000123' } : null,
  };
  const layout = (q.get('layout') ?? 'auto') as CdConfig['layout'];
  const theme = (q.get('theme') ?? 'dark') as CdConfig['theme'];
  return {
    config: { ...CD_DEFAULTS, enabled: true, layout, theme, welcomeText: 'ברוכים הבאים לרויאל בר — Welcome!', thanksText: 'תודה ולהתראות! Thank you, see you soon' },
    branding: { shopName: 'רויאל בר — סניף הרצליה פיתוח (מתחם הקניון)', logoUrl: '', primaryColor: '#1f6feb' },
    state,
  };
}

function Display() {
  const [frame, setFrame] = useState<Frame | null>(auditFrame);
  useEffect(() => {
    const off = window.kioskDisplay?.onState((f) => setFrame(f as Frame));
    window.kioskDisplay?.ready();
    return off;
  }, []);
  if (!frame) return <div style={{ background: '#0d1016', width: '100vw', height: '100vh' }} />;
  return (
    <CustomerScreen
      config={frame.config}
      brandName={frame.branding.shopName}
      logoUrl={frame.config.logoUrl || frame.branding.logoUrl}
      primaryColor={frame.branding.primaryColor}
      state={frame.state}
      online
    />
  );
}

createRoot(document.getElementById('root')!).render(<Display />);
window.addEventListener('contextmenu', (e) => e.preventDefault());
