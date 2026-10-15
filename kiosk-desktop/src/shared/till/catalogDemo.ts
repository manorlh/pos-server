/**
 * The demo till's catalog: a café, in Hebrew, no pictures (tiles show the name) — what the
 * mock engine sells in demo mode (an App Store reviewer, `?demo=1`, `npm run dev:web`).
 * `size` repeats the catalog to a long grid, to try the virtualised grid (§13.3: 200 products).
 */

import type { Catalog, Department, Product } from './protocol';

const DEPARTMENTS: Department[] = [
  { id: 'hot', name: 'שתייה חמה', color: '#8a5a2b' },
  { id: 'cold', name: 'שתייה קרה', color: '#1f6feb' },
  { id: 'pastry', name: 'מאפים', color: '#b26b00' },
  { id: 'sandwich', name: 'כריכים', color: '#1a7f37' },
  { id: 'salad', name: 'סלטים', color: '#2e7d6b' },
  { id: 'sweet', name: 'קינוחים', color: '#a3346a' },
];

const BASE: Array<[string, string, number]> = [
  ['hot', 'אספרסו', 900],
  ['hot', 'אספרסו כפול', 1200],
  ['hot', 'הפוך קטן', 1300],
  ['hot', 'הפוך גדול', 1600],
  ['hot', 'אמריקנו', 1200],
  ['hot', 'תה', 1000],
  ['hot', 'שוקו חם', 1500],
  ['cold', 'מים מינרליים', 800],
  ['cold', 'סודה', 900],
  ['cold', 'לימונדה', 1400],
  ['cold', 'אייס קפה', 1700],
  ['cold', 'מיץ תפוזים סחוט', 1800],
  ['pastry', 'קרואסון חמאה', 1200],
  ['pastry', 'קרואסון שקדים', 1600],
  ['pastry', 'בורקס גבינה', 1400],
  ['pastry', 'מאפה שמרים', 1300],
  ['sandwich', 'כריך טונה', 3200],
  ['sandwich', 'כריך חביתה', 2900],
  ['sandwich', 'טוסט גבינות', 3400],
  ['sandwich', 'בייגל סלמון', 4200],
  ['salad', 'סלט יווני', 4600],
  ['salad', 'סלט קינואה', 4900],
  ['sweet', 'עוגת גבינה', 2600],
  ['sweet', 'בראוניז', 1800],
  ['sweet', 'עוגיית שוקולד', 900],
];

export function demoCatalog(size = BASE.length): Catalog {
  const products: Product[] = [];
  for (let i = 0; i < size; i++) {
    const [departmentId, name, priceAgorot] = BASE[i % BASE.length];
    const round = Math.floor(i / BASE.length);
    products.push({
      id: `p${i + 1}`,
      departmentId,
      name: round === 0 ? name : `${name} ${round + 1}`,
      priceAgorot: priceAgorot + round * 100,
    });
  }
  return { version: 1, departments: DEPARTMENTS.slice(), products };
}
