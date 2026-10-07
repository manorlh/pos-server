/**
 * The kitchen screen's colours per theme (docs/SPEC_KDS.md §14): CSS variables set on the screen's
 * root, read by every part (`bg-[var(--k-bg)]`…). "dark" is the screen as it always looked; "light"
 * for a bright kitchen or a counter, "contrast" (black, white, yellow) for the farthest reading, and
 * "brand" (navy) with the shop's colour as the accent. One accent per theme; the status colours
 * (ready, late, warning) keep their meaning in every theme, always with words beside them.
 */

import { createContext, useContext, type CSSProperties } from 'react';
import type { KdsDisplay, ScreenThemeName } from '@/lib/kdsScreenTypes';
import type { TimerLevel } from '@/lib/kdsBoard';
import { DEFAULT_KDS_DISPLAY, textOn } from '@/lib/screenLook';

interface Level {
  /** The card's frame. */
  ring: string;
  /** The card's header band and the list row's tint. */
  head: string;
  /** The minutes. */
  time: string;
}

export interface KdsTheme {
  bg: string;
  panel: string;
  card: string;
  line: string;
  text: string;
  muted: string;
  faint: string;
  chip: string;
  chipText: string;
  /** Buttons by tone. */
  start: string;
  onStart: string;
  ready: string;
  onReady: string;
  pickup: string;
  onPickup: string;
  handover: string;
  onHandover: string;
  quiet: string;
  onQuiet: string;
  urgent: string;
  urgentText: string;
  /** The accent: the header's mark, the "תוספת" band, the new order's glow. */
  accent: string;
  accentSoft: string;
  accentText: string;
  warn: string;
  late: string;
  /** The order's note band. */
  note: string;
  onNote: string;
  ringWidth: string;
  levels: Record<TimerLevel, Level>;
}

export const KDS_THEMES: Record<ScreenThemeName, KdsTheme> = {
  dark: {
    bg: '#0d1016',
    panel: '#12161d',
    card: '#171b22',
    line: 'rgba(255,255,255,0.10)',
    text: '#ffffff',
    muted: 'rgba(255,255,255,0.62)',
    faint: 'rgba(255,255,255,0.45)',
    chip: 'rgba(255,255,255,0.10)',
    chipText: 'rgba(255,255,255,0.86)',
    start: '#0284c7',
    onStart: '#ffffff',
    ready: '#059669',
    onReady: '#ffffff',
    pickup: '#10b981',
    onPickup: '#022c22',
    handover: '#0ea5e9',
    onHandover: '#082f49',
    quiet: 'rgba(255,255,255,0.10)',
    onQuiet: 'rgba(255,255,255,0.86)',
    urgent: 'rgba(220,38,38,0.20)',
    urgentText: '#fecaca',
    accent: '#38bdf8',
    accentSoft: 'rgba(14,165,233,0.15)',
    accentText: '#7dd3fc',
    warn: '#fbbf24',
    late: '#ef4444',
    note: '#fbbf24',
    onNote: '#000000',
    ringWidth: '2px',
    levels: {
      normal: { ring: 'rgba(255,255,255,0.10)', head: 'rgba(255,255,255,0.06)', time: '#ffffff' },
      warn: { ring: '#fbbf24', head: 'rgba(245,158,11,0.25)', time: '#fcd34d' },
      late: { ring: '#ef4444', head: 'rgba(220,38,38,0.35)', time: '#fca5a5' },
      done: { ring: 'rgba(16,185,129,0.70)', head: 'rgba(5,150,105,0.20)', time: '#6ee7b7' },
    },
  },
  light: {
    bg: '#eceff3',
    panel: '#ffffff',
    card: '#ffffff',
    line: '#d5dae1',
    text: '#0f172a',
    muted: '#475569',
    faint: '#64748b',
    chip: '#eef1f5',
    chipText: '#1e293b',
    start: '#1d4ed8',
    onStart: '#ffffff',
    ready: '#15803d',
    onReady: '#ffffff',
    pickup: '#15803d',
    onPickup: '#ffffff',
    handover: '#1d4ed8',
    onHandover: '#ffffff',
    quiet: '#e7ebf0',
    onQuiet: '#1e293b',
    urgent: '#fee2e2',
    urgentText: '#991b1b',
    accent: '#1d4ed8',
    accentSoft: '#e0e7ff',
    accentText: '#1e40af',
    warn: '#b45309',
    late: '#b91c1c',
    note: '#fde68a',
    onNote: '#000000',
    ringWidth: '2px',
    levels: {
      normal: { ring: '#d5dae1', head: '#f6f7f9', time: '#0f172a' },
      warn: { ring: '#d97706', head: '#fef3c7', time: '#b45309' },
      late: { ring: '#dc2626', head: '#fee2e2', time: '#b91c1c' },
      done: { ring: '#16a34a', head: '#dcfce7', time: '#15803d' },
    },
  },
  contrast: {
    bg: '#000000',
    panel: '#000000',
    card: '#000000',
    line: '#ffffff',
    text: '#ffffff',
    muted: '#ffffff',
    faint: '#d4d4d4',
    chip: '#262626',
    chipText: '#ffffff',
    start: '#ffff00',
    onStart: '#000000',
    ready: '#00e05a',
    onReady: '#000000',
    pickup: '#00e05a',
    onPickup: '#000000',
    handover: '#ffff00',
    onHandover: '#000000',
    quiet: '#262626',
    onQuiet: '#ffffff',
    urgent: '#ff3b30',
    urgentText: '#000000',
    accent: '#ffff00',
    accentSoft: '#262626',
    accentText: '#ffff00',
    warn: '#ffd400',
    late: '#ff3b30',
    note: '#ffff00',
    onNote: '#000000',
    ringWidth: '4px',
    levels: {
      // Black everywhere: the level is the frame, the minutes and the word, at full strength.
      normal: { ring: '#ffffff', head: '#000000', time: '#ffffff' },
      warn: { ring: '#ffd400', head: '#000000', time: '#ffd400' },
      late: { ring: '#ff3b30', head: '#000000', time: '#ff3b30' },
      done: { ring: '#00e05a', head: '#000000', time: '#00e05a' },
    },
  },
  brand: {
    bg: '#0b1220',
    panel: '#0f1a2e',
    card: '#121d33',
    line: 'rgba(255,255,255,0.12)',
    text: '#ffffff',
    muted: '#cbd5e1',
    faint: '#94a3b8',
    chip: 'rgba(255,255,255,0.08)',
    chipText: '#e2e8f0',
    start: '#2563eb',
    onStart: '#ffffff',
    ready: '#16a34a',
    onReady: '#ffffff',
    pickup: '#22c55e',
    onPickup: '#052e16',
    handover: '#2563eb',
    onHandover: '#ffffff',
    quiet: 'rgba(255,255,255,0.10)',
    onQuiet: '#e2e8f0',
    urgent: 'rgba(239,68,68,0.20)',
    urgentText: '#fecaca',
    accent: '#3b82f6',
    accentSoft: 'rgba(37,99,235,0.18)',
    accentText: '#93c5fd',
    warn: '#f59e0b',
    late: '#ef4444',
    note: '#fbbf24',
    onNote: '#000000',
    ringWidth: '2px',
    levels: {
      normal: { ring: 'rgba(255,255,255,0.12)', head: 'rgba(255,255,255,0.05)', time: '#ffffff' },
      warn: { ring: '#f59e0b', head: 'rgba(245,158,11,0.22)', time: '#fcd34d' },
      late: { ring: '#ef4444', head: 'rgba(239,68,68,0.30)', time: '#fca5a5' },
      done: { ring: 'rgba(34,197,94,0.70)', head: 'rgba(22,163,74,0.20)', time: '#86efac' },
    },
  },
};

/** The theme with the shop's accent (start / handover buttons, the accent marks), its text black or white. */
export function kdsTheme(name: ScreenThemeName | null | undefined, accent: string | null | undefined): KdsTheme {
  const base = KDS_THEMES[name ?? 'dark'] ?? KDS_THEMES.dark;
  if (!accent) return base;
  const on = textOn(accent);
  return { ...base, start: accent, onStart: on, handover: accent, onHandover: on, accent, accentText: accent };
}

/** The theme as CSS variables on the screen's root. */
export function themeVars(t: KdsTheme): CSSProperties {
  const v: Record<string, string> = {
    '--k-bg': t.bg,
    '--k-panel': t.panel,
    '--k-card': t.card,
    '--k-line': t.line,
    '--k-text': t.text,
    '--k-muted': t.muted,
    '--k-faint': t.faint,
    '--k-chip': t.chip,
    '--k-chip-text': t.chipText,
    '--k-start': t.start,
    '--k-on-start': t.onStart,
    '--k-ready': t.ready,
    '--k-on-ready': t.onReady,
    '--k-pickup': t.pickup,
    '--k-on-pickup': t.onPickup,
    '--k-handover': t.handover,
    '--k-on-handover': t.onHandover,
    '--k-quiet': t.quiet,
    '--k-on-quiet': t.onQuiet,
    '--k-urgent': t.urgent,
    '--k-urgent-text': t.urgentText,
    '--k-accent': t.accent,
    '--k-accent-soft': t.accentSoft,
    '--k-accent-text': t.accentText,
    '--k-warn': t.warn,
    '--k-late': t.late,
    '--k-note': t.note,
    '--k-on-note': t.onNote,
    '--k-ring-w': t.ringWidth,
  };
  return v as CSSProperties;
}

/** A card's (or a row's) level colours as CSS variables. */
export function levelVars(t: KdsTheme, level: TimerLevel): CSSProperties {
  const l = t.levels[level];
  return { '--k-lv-ring': l.ring, '--k-lv-head': l.head, '--k-lv-time': l.time } as CSSProperties;
}

/** The screen's theme and look, for every card and row under it. */
export const KdsLookContext = createContext<{ theme: KdsTheme; look: KdsDisplay }>({ theme: KDS_THEMES.dark, look: DEFAULT_KDS_DISPLAY });

export function useKdsLook() {
  return useContext(KdsLookContext);
}
