'use client';

/**
 * The dashboard's light / dark choice: light by default, switched from the sidebar, kept per
 * browser. `.dark` on <html> re-themes the whole app through the tokens of globals.css (the
 * shell's and the control board's alike). lib/themeScript applies the choice before the
 * first paint, so a dark page never flashes light.
 */

import { useSyncExternalStore } from 'react';
import { THEME_KEY as KEY } from './themeScript';

export type ThemeMode = 'light' | 'dark';

const listeners = new Set<() => void>();

function read(): ThemeMode {
  try {
    return localStorage.getItem(KEY) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

function apply(mode: ThemeMode) {
  const root = document.documentElement;
  root.classList.toggle('dark', mode === 'dark');
  root.style.colorScheme = mode;
}

export function setTheme(mode: ThemeMode) {
  try {
    localStorage.setItem(KEY, mode);
  } catch {
    // Storage blocked (a private window): the choice lasts for this page only.
  }
  apply(mode);
  listeners.forEach((l) => l());
}

function subscribe(onChange: () => void) {
  // Once mounted, put the class back: a client re-render of <html> (React regenerating the tree
  // after a hydration mismatch) drops the one THEME_INIT_SCRIPT added before the first paint.
  apply(read());
  listeners.add(onChange);
  // Another tab switched: follow it.
  const onStorage = (e: StorageEvent) => {
    if (e.key !== KEY) return;
    apply(read());
    onChange();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener('storage', onStorage);
  };
}

export function useTheme(): ThemeMode {
  return useSyncExternalStore(subscribe, read, () => 'light');
}
