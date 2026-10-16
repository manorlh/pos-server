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
import type { CdConfig, CdState } from '@dash-lib/customerDisplay';

interface Frame {
  config: CdConfig;
  branding: { shopName: string; logoUrl: string; primaryColor: string | null };
  state: CdState;
}

function Display() {
  const [frame, setFrame] = useState<Frame | null>(null);
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
