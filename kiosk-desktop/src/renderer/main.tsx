import { createRoot } from 'react-dom/client';
import './styles.css';
import { App } from './App';
import { kiosk } from './bridge';

// The view is local (SQLite in the main process): the first frame is the attract screen.
void kiosk.bootstrap().then((view) => {
  createRoot(document.getElementById('root')!).render(<App initial={view} />);
});

// A kiosk has no context menu, no pinch zoom, no text selection.
window.addEventListener('contextmenu', (e) => e.preventDefault());
window.addEventListener('wheel', (e) => e.ctrlKey && e.preventDefault(), { passive: false });
