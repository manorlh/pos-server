import { createRoot } from 'react-dom/client';
import './styles.css';
import { App } from './App';
import { kiosk } from './bridge';
import { shell } from './roles/shellBridge';
import { OnScreenKeyboard } from './osk/OnScreenKeyboard';

// The view is local (SQLite in the main process): the first frame is already the role's screen.
void Promise.all([kiosk.bootstrap(), shell.view().catch(() => null)]).then(([view, shellView]) => {
  createRoot(document.getElementById('root')!).render(<App initial={view} initialShell={shellView ?? null} />);
});

// "מקלדת מסך" on the shell's screens (pairing, the technician's, the manager's menu) — 'off' on the kiosk's own.
if (kiosk.oskMode) {
  const holder = document.createElement('div');
  document.body.appendChild(holder);
  const getMode = () => kiosk.oskMode!();
  createRoot(holder).render(<OnScreenKeyboard getMode={getMode} />);
}

// A kiosk has no context menu, no pinch zoom, no text selection.
window.addEventListener('contextmenu', (e) => e.preventDefault());
window.addEventListener('wheel', (e) => e.ctrlKey && e.preventDefault(), { passive: false });
