/**
 * The demo till's catalog: a café, in Hebrew, no pictures (tiles show the name) — what the
 * mock engine sells in demo mode (an App Store reviewer, `?demo=1`, `npm run dev:web`).
 * `size` repeats the catalog to a long grid, to try the virtualised grid (§13.3: 200 products).
 * "שם פריט מלא ותג i" (P:/specs/product-tile-text.md): descriptions, dietary tags and allergens, a long
 * name, a long price, sizes, and a blocked item with its reason — what the tiles and the "i" show.
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

type Extra = Pick<Product, 'description' | 'dietaryTags' | 'allergens' | 'variants' | 'blocked'>;

const BASE: Array<[string, string, number, Extra?]> = [
  ['hot', 'אספרסו', 900],
  ['hot', 'אספרסו כפול', 1200],
  ['hot', 'הפוך קטן', 1300],
  ['hot', 'הפוך גדול', 1600, { description: 'אספרסו כפול עם חלב מוקצף, בכוס גדולה.', dietaryTags: ['vegetarian', 'dairy'], allergens: ['milk'], variants: [{ name: 'רגיל', priceAgorot: 1600 }, { name: 'חלב שקדים', priceAgorot: 1900 }] }],
  ['hot', 'אמריקנו', 1200],
  ['hot', 'תה', 1000],
  ['hot', 'שוקו חם', 1500],
  ['cold', 'מים מינרליים', 800],
  ['cold', 'סודה', 900],
  ['cold', 'לימונדה', 1400],
  ['cold', 'אייס קפה', 1700],
  ['cold', 'מיץ תפוזים סחוט', 1800],
  ['pastry', 'קרואסון חמאה', 1200],
  ['pastry', 'קרואסון שקדים', 1600, { description: 'קרואסון חמאה במילוי קרם שקדים, פרוסות שקדים קלויות מעל.', dietaryTags: ['vegetarian', 'dairy'], allergens: ['gluten', 'milk', 'nuts', 'eggs'] }],
  ['pastry', 'בורקס גבינה', 1400],
  ['pastry', 'מאפה שמרים', 1300],
  ['sandwich', 'כריך טונה', 3200],
  ['sandwich', 'כריך חביתה', 2900],
  ['sandwich', 'טוסט גבינות', 3400],
  ['sandwich', 'בייגל סלמון', 4200, { description: 'בייגל שומשום, סלמון מעושן, גבינת שמנת, בצל סגול וצלפים.', allergens: ['gluten', 'fish', 'milk', 'sesame'], blocked: { kind: 'sold_out', reason: 'נגמר הסלמון להיום' } }],
  ['sandwich', 'פלטת גבינות זהב עם ירקות טריים ולחם הבית', 16800, { description: 'מבחר גבינות קשות ורכות, ירקות עונה טריים, זיתים ולחם הבית החם. לשניים עד שלושה סועדים.', dietaryTags: ['vegetarian', 'dairy'], allergens: ['milk', 'gluten'] }],
  ['sandwich', 'מגש אירוח משפחתי גדול במיוחד', 126850, { description: 'סלטים, גבינות, דגים מעושנים, לחמים ומטבלים — לעשרה סועדים. בהזמנה מראש.', allergens: ['gluten', 'milk', 'fish', 'sesame'] }],
  ['salad', 'סלט יווני', 4600, { description: 'עגבניות, מלפפון, בצל סגול, זיתי קלמטה ופטה, שמן זית ואורגנו.', dietaryTags: ['vegetarian', 'dairy'], allergens: ['milk'] }],
  ['salad', 'סלט קינואה', 4900],
  ['sweet', 'עוגת גבינה', 2600],
  ['sweet', 'בראוניז', 1800],
  ['sweet', 'עוגיית שוקולד', 900],
];

export function demoCatalog(size = BASE.length): Catalog {
  const products: Product[] = [];
  for (let i = 0; i < size; i++) {
    const [departmentId, name, priceAgorot, extra] = BASE[i % BASE.length];
    const round = Math.floor(i / BASE.length);
    products.push({
      id: `p${i + 1}`,
      departmentId,
      name: round === 0 ? name : `${name} ${round + 1}`,
      priceAgorot: priceAgorot + round * 100,
      ...(extra ?? {}),
    });
  }
  return { version: 1, departments: DEPARTMENTS.slice(), products };
}
