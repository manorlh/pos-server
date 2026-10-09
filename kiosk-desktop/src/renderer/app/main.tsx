/**
 * The entry of the one app bundle (`r2m-app`, vite.app.config.mts): the host first, then the
 * role's screens. This skeleton runs the till; the other roles come in through the /app router
 * (S0-10) — until then they say so.
 */

import '../roles/till/till.css';
import { createRoot } from 'react-dom/client';
import { TillApp } from '../roles/till/TillApp';
import { pickHost } from './pickHost';

void pickHost().then((host) => {
  const root = createRoot(document.getElementById('root')!);
  if (host.role === 'till') root.render(<TillApp host={host} />);
  else
    root.render(
      <div dir="rtl" style={{ padding: 24, fontFamily: 'Arial, sans-serif' }}>
        התפקיד &quot;{host.role}&quot; נטען דרך הנתב של /app (S0-10) — לא בשלד הזה.
      </div>,
    );
});

// A till has no context menu and no pinch zoom (the inputs keep text selection, till.css).
window.addEventListener('contextmenu', (e) => e.preventDefault());
window.addEventListener('wheel', (e) => e.ctrlKey && e.preventDefault(), { passive: false });
