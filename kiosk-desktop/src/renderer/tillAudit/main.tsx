/**
 * The layout audit's till page (/tillAudit.html?state=…): the real TillApp — as the Windows till draws it, with the menu
 * (not the demo's) — on the fixture engine of ./fixtures.ts. `npm run dev:web` only.
 */

import '../roles/till/till.css';
import { createRoot } from 'react-dom/client';
import { TillApp } from '../roles/till/TillApp';
import { createBrowserHost } from '../host/browser/browserHost';
import { browserEnv } from '../host/caps';
import { AuditEngine } from './fixtures';

const params = new URLSearchParams(window.location.search);
const host = createBrowserHost({
  engine: { kind: 'endpoint', endpoint: new AuditEngine(params.get('state') ?? 'sell') },
  env: browserEnv(navigator as unknown as Parameters<typeof browserEnv>[0], window as unknown as Parameters<typeof browserEnv>[1]),
  lite: params.get('lite') === '1',
});
createRoot(document.getElementById('root')!).render(<TillApp host={host} />);
