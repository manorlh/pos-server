# מבנה הקיוסק (layouts), אייקונים לקטגוריות, "ברוכים הבאים" וכל הטקסטים

בקשת הבעלים (07.10.2026): "לקיוסקים תבנה הכל, גם מקדונלדס סטייל, תכניס את זה למערכת!!! הכל! ותדייק, תתאים
לקיוסק ותבדוק את עצמך לאחר מכן."

המסמך מתאר את **שלב 1**: המסגרת (הגדרות, ירושה, אימות, תאימות לאחור), חמשת המבנים הראשונים, סט האייקונים,
בלוק "ברוכים הבאים", רישום הטקסטים, העורך בדשבורד, ואת נקודות החיבור של **שלב 2** (בית קפה, ארוחות, רשימה,
מגזין, קיר כפתורים, ווריאנטים של מסכי השירות והשם).

הקיוסקים: Android (‏1080×1920 לאורך, כ-785dp רוחב) ו-Windows (‏1080×1920, מצויר ב-540 פיקסלי CSS ×2, אותם
מסכים כמו התצוגה החיה בדשבורד — `client/src/kiosk-shared`).

## 1. ההגדרה `layout`

`layout` הוא חלק חדש בתצורת הקיוסק (`kioskConfig.ts` / `kiosk_config.py` / `KioskAppConfig.kt`). ברירות המחדל
= הקיוסק של היום בדיוק: עסק שלא נוגע בשום דבר לא רואה שום שינוי.

| מפתח | ערכים | ברירת מחדל | משמעות |
|---|---|---|---|
| `template` | standard, guided, tabs, landing, fastfood, cafe, combo, list, magazine, wall | standard | המבנה — שכבה שממלאת את שאר המפתחות (כמו `uiStyle` למראה) |
| `catalog` | null, rail, top, landing, list, shelves, magazine, wall | null | איפה הקטגוריות; null = לפי `theme.categoryLayout` (כמו היום) |
| `categoryIcons` | null, photo, line, filled, duotone, emoji, none | null | אייקון הקטגוריה; null = התמונה שלה, אחרת האות הראשונה (כמו היום) |
| `railSize` | s, m, l | m | במסילה: 12 / 8 / 6 קטגוריות על המסך |
| `landingColumns` | 2, 3, 4 | 3 | עמודות בדף המחלקות |
| `landingShowCounts` | bool | true | "8 מנות" מתחת לכל מחלקה |
| `hero` | off, manual, auto | off | באנר מומלצים (שלב 2) |
| `magazineFeed` | bool | false | פיד מגזין (שלב 2) |
| `card` | null, tile, row, plate, bleed, button, outlined | null | כרטיס מנה; null = אריח (כמו היום) |
| `flow` | free, guided | free | guided: פס שלבים וכפתור "המשך" |
| `itemView` | sheet, full, modal, inline, steps, popover | sheet | חלון המנה |
| `quickAdd` | off, no_required, always | off | נגיעה במנה בלי בחירות חובה מוסיפה אותה |
| `mealView` | sheet, steps, tray | sheet | בניית ארוחה (tray — שלב 2) |
| `mealUpsell` | off, first, after | off | "רוצים להפוך לארוחה?" (after — שלב 2) |
| `basket` | null, bar, panel, summary, fab, drawer, receipt | null | הסל בזמן ההזמנה; null = לפי `theme.cartStyle` |
| `service` | cards, split, rows, sheet | cards | מסך לקחת/לשבת (ווריאנטים — שלב 2) |
| `name` | card, dock, avatar | card | מסך השם (ווריאנטים — שלב 2) |
| `nameAvatars` | עד 12 מחרוזות, עד 24 תווים | [] | כינויים למסך avatar (שלב 2) |
| `reach` | normal, low | normal | low: הכל בחצי התחתון, החצי העליון רק מציג |
| `reachToggle` | bool | false | כפתור ♿ ללקוח שהופך את `reach` להזמנה הנוכחית |

ערך שהגרסה לא מציירת (למשל `catalog: shelves` בשלב 1) — הקיוסק מציג את המסך של היום; שום דבר לא נשבר.
הרשימות: `LAYOUT_CATALOGS_READY`, `LAYOUT_TEMPLATES_READY`, `LAYOUT_VALUES_READY` (`client/src/lib/kioskLayout.ts`),
`KioskLayoutConfig.READY` / `KioskLayouts.CATALOGS_READY` (Android), `implemented` בפיקסצ'ר.

### 1.1 המבנים (templates)

כל מבנה הוא שכבה (`KIOSK_LAYOUT_TEMPLATES`, `LAYOUT_TEMPLATES` בשרת, `KioskLayoutConfig.TEMPLATES` ב-Android):

| מבנה | השכבה |
|---|---|
| standard | (ריקה) |
| guided | catalog landing, icons line, flow guided, itemView steps, basket bar, card row, landingColumns 2 |
| tabs | catalog top, icons filled, itemView full, basket bar, service sheet + `catalog.oneCategory: false` |
| landing | catalog landing, icons duotone, itemView modal, basket summary, landingColumns 3 |
| fastfood | catalog rail, icons photo, basket summary, service split, railSize l, mealUpsell first, card plate |
| cafe / combo / list / magazine / wall | לפי ההצעה (שלב 2); list גם `general.searchEnabled: true` |

מבנה רשאי לקבוע מפתח של חלק אחר (tabs → תפריט אחד שגולל; list → חיפוש).

### 1.2 סדר הפתרון

```
DEFAULTS ⊕ presetLayer(theme.uiStyle) ⊕ layoutTemplate(layout.template) ⊕ חברה ⊕ סניף ⊕ קיוסק
```

`template` עצמו נקבע לפי השכבה הגבוהה ביותר שקבעה אותו (`templateOf`). null בשכבה = ירושה; מילונים
מתמזגים, רשימות וערכים מחליפים. ערך שנקבע במפורש בשכבה כלשהי גובר על המבנה — כמו מול הסגנון.

### 1.3 תאימות לאחור

APK ישן לא מכיר את `layout`. `repairLayout` (שרת ודשבורד) כותב ב**תצורה האפקטיבית** בלבד (לא בשכבות):
`theme.categoryLayout` לפי `layout.catalog` ו-`theme.cartStyle` לפי `layout.basket` (הטבלה `backCompat`
בפיקסצ'ר: landing/list/magazine/wall → side, shelves → top; summary/fab/drawer/receipt → bar). כך קיוסק ישן
מציג את הקרוב ביותר שהוא מכיר.

### 1.4 אימות

`validateLayout` (דשבורד) ו-`layout` ב-SCHEMA של `kiosk_config.py`: enum לכל מפתח, `nameAvatars` עד 12 × 24 תווים
בלי כפילויות, `attract.welcome` (צבעים ‎#RRGGBB, ‏`maxWidthPct` 40–100). השרת מחזיר את הקודים הרגילים
(`invalid_value`, `too_long`, `too_many`, `duplicate`...).

## 2. נקודת המעבר היחידה

**Android** — `ui/kiosk/layouts/KioskLayouts.kt`: הטבלאות `CATALOGS` (catalog → מסך) ו-`ITEM_VIEWS`,
`KioskLayoutCatalog`, `KioskLayoutItemView`, `KioskGuidedFrame`. `KioskApp.kt` קורא רק להן (וגם
`KioskReachFrame` / `KioskReachSheets` / `KioskReachToggleHost`). המצב של המבנים (♿, המחלקה שנכנסו אליה,
"להפוך לארוחה?") ב-`KioskLayoutModel` (`vm.layout`), ומתאפס במנוחה.

**Web** — `client/src/kiosk-shared/layouts/index.tsx`: `CATALOGS`, `LayoutCatalog`, `LayoutProductSheet`,
`GuidedFrame`, ו-`reach.tsx` (`ReachFrame`, `ReachSheets`, `ReachToggle`). התצוגה החיה (`kiosk-preview.tsx`) והקיוסק
של Windows (`kiosk-desktop/src/renderer/kiosk/KioskApp.tsx`) קוראים רק להם.

**הוספת מבנה בשלב 2** (בלי לגעת במבני שלב 1): מסך חדש בקובץ חדש ב-`layouts/` (web) וב-`ui/kiosk/layouts/`
(Android); שורה ב-`CATALOGS` / `ITEM_VIEWS`; הערכים ל-`LAYOUT_CATALOGS_READY` / `LAYOUT_VALUES_READY` /
`LAYOUT_TEMPLATES_READY` ו-`CATALOGS_READY` / `READY`; השם ל-`implemented` בפיקסצ'ר (ולהריץ את המחולל
ולעדכן את ה-SHA, §8). ווריאנטים של מסכי השירות/השם: אותו דבר ב-`service` / `name`.

## 3. המבנים של שלב 1

- **fastfood (מקדונלדס)** — מסילת קטגוריות בצד (RTL: ימין) עם תמונות גדולות (`railSize` l = 6 על המסך),
  כרטיסי "צלחת" עם "+" להוספה מהירה, פס הזמנה קבוע כהה בתחתית ("ההזמנה שלי · N פריטים · סכום · לתשלום"),
  ו"רוצים להפוך לארוחה?" לפני ההתאמה: המנה לבד או עד 3 ארוחות (הזולה ראשונה מסומנת "הכי משתלם"), לפי
  חריצי הארוחות בתפריט וכללי ה-upgrade של הקיוסק (`KioskMealUpsell` / `mealOptions`).
- **landing (דף מחלקות)** — מסך "מה בא לכם היום?" עם אריחי מחלקות (`landingColumns`, מספר מנות), נגיעה
  נכנסת למחלקה (פירורי לחם "התפריט › המחלקה", לשוניות מחלקות, "כל המחלקות"); חזרה (גם בכפתור חזרה) לדף.
- **tabs (לשוניות)** — לשוניות עם אייקונים דביקות מתחת לכותרת, תפריט אחד שגולל עם כותרת לכל מחלקה;
  הלשונית נדלקת לפי מה שעל המסך (scroll-spy) ונגיעה גוללת למחלקה; חלון מנה במסך מלא.
- **guided (מודרך)** — פס שלבים (שירות › תפריט › סל › טיפ › תשלום, לפי שלבי הקופה המופעלים) מעל המסכים,
  מחלקות גדולות בשתי עמודות, כרטיסי שורה, חלון מנה "שלב אחרי שלב" (קבוצה אחת בכל פעם, "המשך", "דלג"),
  וכפתור "לסל · N · סכום" בתחתית.
- **reach low + ♿** — החצי העליון מציג בלבד (לוגו, המסך/המחלקה/המנה/הסכום, על גוון עדין של צבע המותג) עם קו
  מקווקו; המסך וכל החלונות שלו (מנה, ארוחה, upsell) בחצי התחתון. `reachToggle`: כפתור "מצב נגיש" בפינה
  השמאלית־תחתונה ברצועה משלו (88dp / ‏56px), הופך את המצב להזמנה הנוכחית וחוזר להגדרה במנוחה.

מדדים: כל מטרת מגע ≥56dp, הכפתור הראשי ≥72dp (`LAYOUT_PRIMARY_DP`); RTL מלא (המסילה מימין, חצים מתהפכים);
4 הסגנונות × כל המבנים; `general.reduceMotion` וההנפשות (`motion`) מכובדים.

## 3א. המבנים של שלב 2 (08.10.2026)

כל עשרת המבנים מצוירים עכשיו (`implemented` בפיקסצ'ר = כולם; ה-SHA עודכן בשלוש הסוויטות). קבצים: Android
`ui/kiosk/layouts/KioskLayout{Shelves,List,Magazine,Wall,Tray,Compact,Baskets,Frame}.kt`, web
`client/src/kiosk-shared/layouts/{shelves,list,magazine,wall,hero,baskets,frame}.tsx` (+ `MealSheet tray`,
`ProductSheet variant="compact"`).

- **cafe (בית קפה, `catalog: shelves`)** — מדף לכל קטגוריה: כותרת עם האימוג'י/אייקון ושורת אריחים שגוללת לרוחב
  (`shelfCardDp`: כ-2.4 כרטיסים במסך ב-m); מעל המדפים **באנר מומלצים** (`hero`: manual — עומד, auto — מתחלף כל
  `HERO_TURN_MS`, לא בזמן נגיעה) מ-`catalog.featuredProductIds`. הבאנר גם בראש התפריט הגולל של `top`. הסל: **fab**.
- **combo (ארוחות, `mealView: tray`)** — מודל הארוחות האמיתי (`MealDraft`, חריצי הארוחה בתפריט): חלון הארוחה
  מצויר כמגש — מקום לכל חריץ (צלחת מקווקוות עד שנבחר, ואז תמונת המנה), החריץ הנוכחי מסומן, נגיעה חוזרת אליו;
  מתחת — מנות החריץ שלוש בשורה, "הבא", ובסוף הסיכום והכמות. המחיר והשורה בדיוק כמו החלון של היום.
- **list (רשימה, `catalog: list`)** — שדה חיפוש קבוע (המקלדת של הקיוסק; המבנה מדליק `searchEnabled`), צ'יפים של
  קטגוריות שעוקבים אחרי הגלילה, ושורה צפופה לכל מנה (תמונה קטנה, שם, שורת תיאור, מחיר, "+"); עמודה אחת לאורך, שתיים
  מ-1000dp (`listColumns`). הסל: **drawer** — הפס פותח את ההזמנה מהצד, מעל התפריט.
- **magazine (מגזין)** — מנה אחרי מנה בעמוד משלה (תמונה גדולה, שם, תיאור, מחיר ו"הוספה" 72dp), כ-78% מהגובה
  (`storyHeightDp`) כך שהבאה מציצה; הגלילה נעצרת על מנה. `magazineFeed`: פיד אחד לכל הקטגוריות (הצ'יפים עוקבים) או
  קטגוריה אחת בכל פעם.
- **wall (קיר כפתורים)** — כפתור גדול לכל מנה (שם ומחיר, בלי תמונה; פס בצבע הקטגוריה), שלושה בשורה (`wallColumns`);
  נגיעה אחת מוסיפה (`quickAdd: always` — גם מנה שברירות המחדל שלה עונות על כל בחירת חובה נכנסת עליהן, בכל הקיוסקים: `addPathOnTap` / `tapPathOf`, `dishOnDefaults`); מנה שחייבת
  בחירה נפתחת בחלון הקומפקטי (`itemView: popover`). הסל: **receipt** — שורות ההזמנה מתחת לתפריט עם − / +, הסכום
  ו"לתשלום".
- **חלון קומפקטי** (`itemView` inline / popover): שם, תמונה קטנה ומחיר בשורה אחת, הבחירות ו"הוספה להזמנה" — בלי
  התמונה הגדולה. inline נפתח כחלון קומפקטי מעל הרשימה (לא מתרחב בתוך השורה).
- **הסלים** fab / drawer / receipt בכל מבנה עם קטלוג משלו (`basketFloats` / `basketDocked`).

עדיין לא: כרטיסים bleed / button / outlined, `mealView: steps`, `mealUpsell: after`, והווריאנטים של מסכי השירות
והשם (`service` rows/split/sheet, `name` dock/avatar) — הקיוסק מציג בהם את המסך של היום, והעורך מסמן אותם "בקרוב".
בתצוגה המקדימה בדשבורד אין ארוחות: עם `mealView: tray` מנה מהקטגוריה הראשונה מראה מגש לדוגמה (היא ומנות שתי
הקטגוריות הבאות).

## 4. אייקונים לקטגוריות

44 אייקונים (`server/tests/fixtures/kiosk_category_icons.json`), כל אחד ב-3 סגנונות מאותם נתיבי SVG
(viewBox 24): **line** (קו), **filled** (מלא, הפרטים "חתוכים" בצבע האריח), **duotone** (מילוי שקוף + קו),
ובנוסף emoji וגוון (hue) לאריח "photo" כשאין לקטגוריה תמונה.

`catalog.categoryIconIds`: מזהה קטגוריה → מזהה אייקון (ממוזג מפתח־מפתח בין הרמות). בלי בחירה — **הצעה לפי השם**
(`suggestCategoryIcon` / `KioskCategoryIcons.suggest`): נרמול (אותיות וספרות בלבד, אותיות סופיות), מילות מפתח
בעברית ובאנגלית; מילת מפתח עד 3 תווים מתאימה רק למילה שלמה; הארוכה מנצחת, בתיקו — הראשונה. בלי התאמה —
`dine`. 198 מקרי בדיקה בפיקסצ'ר. Android בונה ImageVector מהנתיבים (`PathParser`), פעם אחת לכל אייקון/סגנון/צבע.

## 5. "ברוכים הבאים" (`attract.welcome`)

`enabled`, `position` (top/middle/bottom), `align` (start/center/end), `size` (s/m/l/xl = 28/34/42/54sp),
`weight` (regular/bold/black), `titleColor` / `subtitleColor` (null = לבן / כמו הכותרת), `backdrop`
(scrim/card/blur/none), `showSubtitle`, `maxWidthPct` (40–100). ברירת המחדל = הבלוק של היום (למטה, ימין, l, black,
scrim). `welcome` הוא גם פריט ב-`attract.sections`: מקומו בין הבלוקים התחתונים (קטגוריות, מועדון); רשימה
ישנה בלי `welcome` — ראשון, כמו היום. הטקסטים עצמם: `attractTitle` / `attractSubtitle`.

## 6. טקסטים

רישום אחד (`server/tests/fixtures/kiosk_text_registry.json`): **272 טקסטים ב-28 קבוצות** (23 מסכים + 5 של
המבנים, עם `shownWhen` — למשל "מסלול מודרך" רק ב-`flow: guided`), בעברית ובאנגלית (ערבית ורוסית — המפתח קיים,
ברירת המחדל עברית). לכל טקסט: תווית לעורך, ברירות מחדל, `max`, שדות בשם (`{count}`, `{total}`...), משאבי
Android שהוא מחליף, מפתחות ה-web שהוא מחליף, ו-`legacy` ל-103 מפתחות `texts` הקודמים (כולם נשמרו).

אחסון: השפה הראשונה של הקיוסק (`general.languages[0]`) ב-`texts` (APK ישן קורא רק אותו); השפות האחרות
ב-`textsByLang[lang][key]`. בירושה מפתח־מפתח ושפה־שפה. החיפוש:
`textsByLang[lang][key]` → (בשפה הראשונה) `texts[key]` → ברירת המחדל של השפה.

- **Android**: `KioskTextContext` עוטף את ה-Context של הקיוסק; `getText(id)` של המשאבים מחפש ברישום
  (`KioskTextRegistry.forResource`) ומחזיר את הטקסט המוגדר, עם המרת השדות בשם למיקומים של המחרוזת. כל
  `stringResource` במסכי הקיוסק עובר דרכו בלי שינוי בקוד המסכים.
- **Web**: `m.txt` / `m.t` / `m.kt` (`kioskTextOf`, `webTextOverride`, `webTextIn`).
- **שרת**: `texts` מקבל את מפתחות הרישום; `textsByLang` — שפות ידועות, מפתחות ידועים, `max`, ו-`unknown_placeholder`
  לשדה שהטקסט לא מכיר.

## 7. העורך בדשבורד

- **מראה** — "סגנון ממשק", ומיד אחריו **"מבנה הקיוסק"** (`section-layout.tsx`): 10 תמונות ממוזערות בצבעי
  הטיוטה (5 פעילים, 5 "בקרוב"), **נגישות** (גובה הכפתורים + כפתור ♿), **"מתקדם"** — כל מפתח לבד עם "כמו היום"
  לערכי null וסימון "בקרוב" לערכים של שלב 2, ו**"אייקונים לקטגוריות"** — לכל קטגוריה של קופת המקור האייקון
  (מוצע לפי השם / נבחר), "שינוי" פותח רשת של 44.
  בחירת מבנה (`setLayoutTemplate` → `switchLayoutTemplate`) מזיזה כל מפתח שעקב אחרי המבנה הקודם; מפתח שנבחר
  במפורש נשאר. הירושה מחושבת מול המבנה (`rebaseLayout`), כך שכל שדה מראה "בירושה" / "דורס" ואיפוס נכון,
  והשכבה שנשמרת מינימלית (רק `template` + מה ששונה באמת). איפוס `layout.template` חוזר למבנה של ההורה.
- **מסך פתיחה** — כרטיס **"ברוכים הבאים"** (`section-welcome.tsx`): הפעלה, הכותרות, מיקום ב-3×3, גודל, משקל,
  רקע, צבעים ורוחב; "ברוכים הבאים" ב"סדר המסך".
- **טקסטים** (לשונית חדשה, `section-texts.tsx`): לשוניות שפה (לפי `general.languages`), 28 קבוצות עם מונה של
  מה שהוגדר ברמה הזו, חיפוש בכל הטקסטים, לכל טקסט "בירושה"/"דורס" ואיפוס, הטקסט שבירושה כ-placeholder,
  מונה תווים מול `max`, כפתורי שדות (`{count}`). בפוקוס — התצוגה החיה עוברת למסך של הקבוצה, מדברת בשפת
  הלשונית, והטקסט מסומן במסגרת (`PreviewTextHighlight`). "תמונות למסכים" נשארה במראה.

## 8. נתונים משותפים ובדיקות

שלושה פיקסצ'רים ב-`server/tests/fixtures` (אותם בתים ב-`pos-android/app/src/test/resources`), ה-SHA-256 שלהם
(שורות LF) נעוץ בשלוש סוויטות: `server/tests/test_kiosk_layout.py`, `client/src/lib/kioskLayout.test.ts`,
`pos-android/.../KioskLayoutTest.kt`.

מחוללים:
- `server/scripts/kiosk_text_registry/gen_registry.py` — הרישום מ-`strings.xml` של Android, `he.json` ו-`registry_meta.json`.
- `server/scripts/gen_kiosk_layout_data.py` — מעתיק את הפיקסצ'רים ל-`server/app/services/kiosk_shared/` ולמשאבי
  הבדיקות של Android, ומייצר `client/src/lib/kioskIconData.ts`, `client/src/lib/kioskTextRegistryData.ts`,
  `domain/KioskCategoryIconData.kt`, `domain/KioskTextRegistryData.kt`.

שינוי בפיקסצ'ר: להריץ את המחולל, לחשב את ה-SHA החדש (LF) ולעדכן את שלושת הקבועים.
