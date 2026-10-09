import { createRoot } from 'react-dom/client';
import './styles.css';
import { App } from './App';
import { kiosk } from './bridge';
import { shell } from './roles/shellBridge';

// The view is local (SQLite in the main process): the first frame is already the role's screen.
void Promise.all([kiosk.bootstrap(), shell.view().catch(() => null)]).then(([view, shellView]) => {
  createRoot(document.getElementById('root')!).render(<App initial={view} initialShell={shellView ?? null} />);
});

// A kiosk has no context menu, no pinch zoom, no text selection.
window.addEventListener('contextmenu', (e) => e.preventDefault());
window.addEventListener('wheel', (e) => e.ctrlKey && e.preventDefault(), { passive: false });
