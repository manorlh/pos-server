# R2M Kiosk לווינדוס — קיוסק הזמנה עצמית

קיוסק ההזמנה העצמית של R2M POS למחשב Windows (x64): אותה זרימה, אותם מסכים ואותם כללים פיסקליים כמו
הקיוסק באנדרואיד (`docs/SPEC_KIOSK.md`), עובד מהדיסק המקומי — גם בלי אינטרנט — עם מסופון Nayax ברשת
ומדפסת SNBC BTP-880.

## איך זה בנוי

- **Electron** — חלון אחד במסך מלא (מצב קיוסק), נפתח עם הכניסה ל-Windows, בלי מסגרת, בלי תפריט ובלי
  קיצורי מקשים החוצה.
- **המסכים (renderer, React):** אותם רכיבים שמציירים את התצוגה המקדימה בדשבורד —
  `client/src/components/dashboard/kiosks/preview-screens.tsx` ו-`client/src/lib/kioskConfig.ts`,
  דרך התיקייה המשותפת `client/src/kiosk-shared/`. מה שהקיוסק האמיתי מוסיף (תשלום אמיתי, מספר איסוף,
  כפתורי חזרה, הערה למטבח, עזרה) עובר בשדה האופציונלי `live` של המודל — בדשבורד הוא לא קיים והתצוגה
  המקדימה מציירת בדיוק כמו קודם. זרימת הלקוח היא העתק של `domain/KioskFlow.kt` (`src/core/kioskFlow.ts`).
- **השירות המקומי (main process, Node):** SQLite (`node:sqlite`, מובנה ב-Node של Electron — בלי מודול
  נייטיב לבנות), סנכרון לענן בקצב של הקופה, מאגר מדיה, תשלום, מדפסת, משמרות ו-Z. המסכים לא ניגשים
  לרשת אף פעם: הכול מגיע מהשירות, מנתונים מקומיים.
- **מדיה:** כל תמונה, סרטון וגופן נשמרים בדיסק לפי ה-SHA-256 של התוכן (`<sha256>.<ext>`), עם גרסאות
  מוקטנות (WebP ‏480/960) לתמונות, ומוגשים דרך `kiosk://media/…` (כולל טווחי בתים לסרטונים).
- **תשלום:** מסופון Nayax ברשת (TweezerComm JSON-RPC ל-`https://<host>:8080/SPICy`, הצמדת תעודה בפעם
  הראשונה) — אותן מסגרות כמו בקופה. ספק תשלום נוסף (SynqPay) נכנס דרך `src/main/payment/registry.ts`.
  כללי השחזור (`docs/SPEC_CARD_RECOVERY.md`) חלים על כל ספק: לעולם לא חיוב שני על תוצאה לא ידועה.
- **מדפסת:** כל דף הוא תמונה (כמו בקופה): הקבלה, הבון ופתק האיסוף מצוירים על canvas בחלון נסתר,
  הופכים ל-raster של ESC/POS ‏(576 נקודות) ונשלחים ל-spooler של Windows במצב RAW, או ל-TCP 9100.

## דרישות

- Windows 10/11 ‏x64. לפיתוח: Node.js 22.13 ומעלה (נבדק על 24), npm.
- Electron 44 (Node 24 בפנים — `node:sqlite` זמין).

## פיתוח והרצה

```bash
cd kiosk-desktop
npm install                # ב-npm install רגיל Electron מוריד את ה-binary שלו (מ-GitHub)
npm run dev                # בונה ומריץ בחלון 540×960 (לא במסך מלא), עם DevTools
npm run dev:web            # המסכים בדפדפן עם נתוני הדגמה (http://localhost:5178) — בלי Electron, בלי תשלום
npm run smoke -- --server http://localhost:8001 --code ABCD1234 --record test/fixtures/recorded
                           # צימוד וסנכרון מול API פיתוח, ב-Node (בלי Electron, בלי חיוב, בלי מדפסת)
npm run smoke -- --bench   # כמה זמן מהדיסק המקומי עד מסך ראשון
```

בדיקות:

```bash
npm test                   # vitest — מספור, רצף Z, שחזור אשראי, ESC/POS, מדיה, חוזה הסנכרון, זרימה, טכנאי
npm run typecheck
npm run lint
```

`test/fixtures/contract/*.json` — מה שהקיוסק שולח (מסמך 320, מסמך שבוטל, פתיחה וסגירת משמרת, הזמנות
קיוסק). אותם בתים נמצאים ב-`server/tests/fixtures/kiosk_desktop/` ונבדקים מול הסכמות של השרת
(`server/tests/test_kiosk_desktop_contract.py`). עדכון: `UPDATE_GOLDEN=1 npm test`, והעתקה לשרת.
`test/fixtures/recorded/` — תשובות אמיתיות של השרת (בלי טוקנים) שהבדיקות מריצות דרך השירות.

## בניית מתקין

```bash
npm run dist               # release/R2M-Kiosk-<גרסה>-setup.exe (NSIS, התקנה למחשב, נפתח אחרי ההתקנה)
```

`electron-builder` מוריד בזמן הבנייה את NSIS ואת Electron למחשב הבנייה.

## התקנה על הקיוסק

1. **משתמש ייעודי:** משתמש Windows מקומי לקיוסק, עם כניסה אוטומטית (`netplwiz`).
2. **המתקין:** מריצים את `R2M-Kiosk-<גרסה>-setup.exe`. התוכנה נרשמת לפתיחה אוטומטית בכניסה ל-Windows
   ונפתחת במסך מלא (מצב קיוסק).
3. **נעילה (מומלץ):** Windows Assigned Access / Shell Launcher עם `R2M Kiosk.exe` כמעטפת, או לכל הפחות:
   מדיניות קבוצתית "Allow edge swipe" = Disabled, כיבוי מקלדת המגע האוטומטית, שינה/כיבוי מסך = אף פעם,
   Windows Update בשעות שהקיוסק סגור.
4. **צימוד:** במסך הראשון — כתובת השרת וקוד הצימוד מהדשבורד (קופות → צימוד, בתפקיד "קיוסק" ובסניף).
5. **מדפסת SNBC BTP-880:**
   - **USB:** מתקינים את מנהל ההתקן של SNBC ל-BTP-880 (או "Generic / Text Only" על יציאת ה-USB של
     המדפסת). הקיוסק מוצא לבד תור ששמו מכיל `BTP` או `SNBC` (אחרת `Generic / Text Only`); אפשר לבחור
     תור אחר במסך הטכנאי. שם התור המומלץ: **`SNBC BTP-880`**. נייר 80 מ״מ; ההדפסה RAW, בלי חלון.
   - **רשת:** כתובת IP של המדפסת, פורט 9100 (במסך הטכנאי), או "מדפסת חשבוניות — כתובת" בענן.
   - מצב (נגמר הנייר, מכסה פתוח, לא מחוברת): מ-Windows ב-USB, מ-`DLE EOT` ברשת.
6. **מסופון:** כתובת ה-Nayax מוגדרת בענן (הגדרות התשלום של הקופה/הקיוסק: `nayaxDeviceHost`, פורט, נתיב),
   או בהמרה לקיוסק. HTTPS עם הצמדת תעודה בחיבור הראשון; HTTP רק לכתובת פרטית עם הפרמטר
   `pinpadAllowHttp`.
7. **בדיקה:** מסך הטכנאי ← "הדפסת בדיקה" ו"בדיקת מסופון" (קריאה בלבד, בלי חיוב).

## צוות

- **ניהול הקיוסק:** לחיצה ארוכה (2 שנ׳) בפינה הימנית העליונה ← קוד מנהל סניף (נבדק במחשב מול משתמשי
  הקופה המסונכרנים, גם בלי אינטרנט). מצב, מסופון ותשלומים לבירור ("בדוק שוב" / "סמן כלא אושר והמשך"),
  מדפסת, סנכרון, הזמנות היום (הדפסה חוזרת של בון/קבלה — לעולם לא חיוב), Z, השהיה, יציאה מהתוכנה.
- **בדיקות ומידע קיוסק (טכנאי):** שש נגיעות תוך 3 שניות בפינה השמאלית העליונה ← קוד 1995 (או הקוד
  שהענן קבע בפרמטר `technicianCode`). שיוך, רשת, מדפסת (בחירת תור / IP, הדפסת בדיקה), מסופון (בדיקה
  בלבד), עדכונים, תמיכה מרחוק (TeamViewer QuickSupport כשמותקן), זום, ניתוק.

## עדכוני גרסה

- **מהענן ("עדכון קופות"):** הקיוסק שואל `GET /sync/{m}/app-update?…&platform=windows` ולוקח רק הצעה
  שאומרת `platform: "windows"`. **בשרת עדיין אין סוג קובץ לווינדוס** — הוא היה מציע את ה-APK, והקיוסק
  מתעלם ממנו. השינוי (תוספתי) שנדרש בשרת: עמודה `app_releases.platform` (ברירת מחדל `android`),
  סינון ה-resolver לפי platform, פרמטר `platform` ב-`app-update` (ומשוב שלו בתשובה), סוג קובץ לפי
  platform בהורדה ובהעלאה, ו-`software.py` של קובץ המבנה האחיד מסונן ל-android.
- **עד אז — תיקיית שחרור:** `npm run dist` כותב `latest.yml` ליד המתקין. מעלים את שניהם לתיקייה ב-HTTPS
  ומגדירים בקובץ `%APPDATA%\R2M Kiosk\kiosk.json`:

  ```json
  { "updateFeedUrl": "https://downloads.example.com/r2m-kiosk/" }
  ```

  הקיוסק בודק (מסך הטכנאי ← "בדיקת עדכונים"), מוריד, בודק SHA-512 ומתקין בשקט — לעולם לא בזמן תשלום.

## נתונים

`%APPDATA%\R2M Kiosk\data\` — `kiosk.db` (הגדרות, קטלוג, מסמכים, משמרות, Zים, מונים, outbox, הזמנות,
הדפסות) ו-`media\` (קבצי המדיה לפי התוכן). הטוקן של המכונה מוצפן ב-DPAPI (safeStorage). מונים, Zים
ומסמכים לעולם לא נמחקים מקומית; איפוס רק בפקודה מהענן.

## תלויות חדשות (npm)

זמן ריצה (בתוך המתקין): `sharp` (גרסאות התמונות; בינארי מ-npm). נארזים בתוך הקוד: `bcryptjs`,
`react`, `react-dom`, `lucide-react`, `qrcode.react`, `clsx`, `tailwind-merge`,
`@fontsource/noto-sans-hebrew`, `@fontsource/roboto`. פיתוח: `electron`, `electron-builder`, `vite`,
`@vitejs/plugin-react`, `tailwindcss`, `@tailwindcss/vite`, `tw-animate-css`, `esbuild`, `typescript`,
`vitest`, `eslint`, `typescript-eslint`, `@eslint/js`, `eslint-plugin-react-hooks`, `globals`,
`@types/*`.
