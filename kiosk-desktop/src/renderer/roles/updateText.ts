/** The update status in one Hebrew line (technician screens of every role). */

import type { TechnicianInfo } from '../../shared/bridge';
import type { UpdateView } from '../../shared/roles';

const PHASE_TEXT: Record<string, string> = {
  idle: 'לא נבדק עדיין',
  checking: 'בודק…',
  up_to_date: 'הגרסה עדכנית',
  downloading: 'מוריד ברקע…',
  ready: 'הורד ונבדק — מוכן להתקנה',
  installing: 'מתקין…',
  failed: 'נכשל',
  not_checked: 'לא נבדק',
};

export function updateLine(u: TechnicianInfo['update'] | UpdateView | null | undefined): string {
  if (!u) return '';
  const phase = 'phase' in u ? u.phase : u.status;
  const pct = typeof u.progress === 'number' && phase === 'downloading' ? ` ${Math.round(u.progress * 100)}%` : '';
  const avail = u.available ? ` · גרסה ${u.available}` : '';
  return `${PHASE_TEXT[phase] ?? phase}${pct}${avail}${u.message ? ` · ${u.message}` : ''}`;
}
