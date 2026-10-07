# R2M POS ל-Windows — אפליקציה אחת לכל תפקיד (קיוסק, מסך מטבח, מסך מוכן / לא מוכן; קופה בהמשך)

> **מה המכשיר יהיה נקבע בענן**, בהוספת המכשיר בדשבורד (סוג מכשיר + פלטפורמה Windows), ונלקח בצימוד — אין בחירת תפקיד במחשב.
> קיוסק הוא האפליקציה של היום, בלי שינוי בהתנהגות. מסך מטבח (KDS) ומסך מוכן / לא מוכן **אינם קופה ואינם מערכת חשבונאית**:
> בלי מסמכים, משמרות, Z או תשלומים. קופה ל-Windows ומסך לקוח — מסך "תפקיד זה יגיע בגרסה הבאה". עדכונים: `docs/SPEC_UPDATES.md`.

קיוסק ההזמנה העצמית של R2M POS למחשב Windows (x64): אותה זרימה, אותם מסכים ואותם כללים פיסקליים כמו
הקיוסק באנדרואיד (`docs/SPEC_KIOSK.md`), עובד מהדיסק המקומי — גם בלי אינטרנט — עם מסופון Nayax ברשת
ומדפסת SNBC BTP-880.

## איך זה בנוי

- **מעטפת אחת, מודולים לפי תפקיד** (`src/main/roles/types.ts`):

  | שכבה | קבצים |
  |---|---|
  | מעטפת Electron (חלון, `kiosk://`, IPC, זהות ההתקנה) | `src/main/index.ts`, `src/main/shell/identity.ts`, `src/preload` |
  | שכבת שירות משותפת (צימוד, הרשאה, סנכרון, מדיה, הדפסה SNBC/ESC-POS RAW, ספקי תשלום Nayax LAN / SynqPay, יומנים, טכנאי) | `src/main/service.ts` + `sync/`, `media/`, `printer/`, `payment/`, `db/`, `fiscal/` |
  | עדכונים | `src/main/update/updater.ts`, הכללים ב-`src/core/updatePolicy.ts` |
  | בחירת תפקיד (מהענן) | `src/core/roles.ts`, `src/main/roles/manager.ts` |
  | קיוסק | הזרימה בשירות + `src/renderer/kiosk` (כמו קודם) |
  | מסך מטבח (KDS) | `src/main/roles/kds.ts`, `src/core/kdsBoard.ts`, `src/renderer/roles/kds` |
  | מסך מוכן / לא מוכן | `src/main/roles/board.ts`, `src/core/pickupBoard.ts`, `src/renderer/roles/board` |
  | קופה, מסך לקוח | `src/renderer/roles/RolePlaceholder.tsx` ("תפקיד זה יגיע בגרסה הבאה") |

  התפקיד: `deviceRole` של `machines/me` (קופה / קיוסק / `kds` / `order_status_board`); קיוסק פעיל (`kiosk/sync` → `kiosk: true`)
  תמיד קיוסק; מכשיר שהוגדר מעמוד מסכי המטבח (`kds/device`, תפקיד `pickup` = מסך מוכן). המסכים מקבלים אותו דרך `window.r2m`
  (`src/shared/roles.ts`), לצד `window.kiosk` של הקיוסק.
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
npm run dist               # release/R2M-POS-Windows-<גרסה>-setup.exe (NSIS, התקנה למשתמש, נפתח אחרי ההתקנה)
npm run publish:release -- --server https://api.example.com   # העלאה לענן כגרסת Windows (ראו docs/SPEC_UPDATES.md)
```

`electron-builder` מוריד בזמן הבנייה את NSIS ואת Electron למחשב הבנייה.

- **זהות ההתקנה** (`src/main/shell/identity.ts`): `appId` נשאר `il.co.runnersys.kiosk` ושם המוצר `R2M Kiosk` (שם ה-exe ותיקיית
  ההתקנה) — כך כל קיוסק מותקן מתעדכן במקום, ולא מותקנת אפליקציה שנייה לצדו. תיקיית הנתונים `%APPDATA%\R2M Kiosk` נעוצה בקוד
  (בה הטוקן, המונים, המשמרות וה-Zים) ולעולם לא משנה שם. מה שרואים — כותרת החלון, מסך הצימוד, הקיצור "R2M POS" ושם קובץ ההתקנה — R2M POS.
- **התקנה למשתמש (per-user), לא למחשב:** מ-0.2.0 `perMachine: false` — המתקין לא מבקש הרשאות מנהל, ולכן העדכון האוטומטי
  (`/S --force-run`) רץ בשקט גם תחת משתמש הקיוסק (התקנה למחשב הייתה פותחת חלון UAC שאיש לא עונה עליו). ההתקנה נכנסת ל-
  `%LOCALAPPDATA%\Programs\R2M Kiosk` של המשתמש שמריץ אותה — **מריצים את המתקין כשמחוברים כמשתמש הקיוסק**.
- **מעבר מ-0.1.0 (שהותקנה למחשב):** ב-0.1.0 העדכון ידני בלבד — משייכים את 0.2.0 בענן, ובמסך הטכנאי של 0.1.0 (שבודק ומוריד כשהוא
  נפתח) לוחצים פעם אחת "התקן עכשיו"; 0.2.0 נכנסת להתקנה למשתמש, רושמת את עצמה לפתיחה
  בכניסה ל-Windows ומשתמשת באותה תיקיית נתונים (אותו צימוד, אותם מונים). ההתקנה הישנה ב-Program Files נשארת רדומה — מסירים אותה
  פעם אחת מ"אפליקציות" (דורש מנהל); הנתונים לא נמחקים.
- **בלי חתימת קוד (עדיין):** בהתקנה הראשונה מקובץ שהורד בדפדפן Windows SmartScreen מציג "Windows protected your PC" ← "More info"
  ← "Run anyway". עדכונים אוטומטיים לא מוצגים ל-SmartScreen (הקובץ לא הורד בדפדפן, אין לו mark-of-the-web) — מה שמגן עליהם הוא
  HTTPS, הטוקן של המכונה וה-SHA-256 שהענן חישב. Smart App Control של Windows 11 (אם פעיל) חוסם תוכנה לא חתומה — יש לכבות אותו
  במכשירים עד שתהיה חתימה (`docs/SPEC_UPDATES.md`).

## התקנה על המכשיר (קיוסק, מסך מטבח, מסך מוכן)

1. **משתמש ייעודי:** משתמש Windows מקומי למכשיר, עם כניסה אוטומטית (`netplwiz`).
2. **המתקין:** מחוברים כמשתמש הזה ומריצים את `R2M-POS-Windows-<גרסה>-setup.exe`. התוכנה נרשמת לפתיחה אוטומטית בכניסה ל-Windows
   ונפתחת במסך מלא.
3. **נעילה (מומלץ):** Windows Assigned Access / Shell Launcher עם `R2M Kiosk.exe` כמעטפת, או לכל הפחות:
   מדיניות קבוצתית "Allow edge swipe" = Disabled, כיבוי מקלדת המגע האוטומטית, שינה/כיבוי מסך = אף פעם,
   Windows Update בשעות שהקיוסק סגור.
4. **צימוד:** במסך הראשון — כתובת השרת וקוד הצימוד מהדשבורד ("הוספת מכשיר": סוג המכשיר — קיוסק / מסך מטבח / מסך מוכן —
   פלטפורמה Windows, וסניף). המכשיר נפתח בתפקיד שבקוד.
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

מהענן, באותו מסך כמו הקופות באנדרואיד ("עדכוני גרסה" בדשבורד; המפרט המלא: `docs/SPEC_UPDATES.md`):

- **בדיקה:** בהפעלה (אחרי דקה) וכל 15 דקות (`updateCheckMinutes` ב-kiosk.json), ו"בדוק עכשיו" במסך הטכנאי —
  `GET /sync/{m}/app-update?versionCode=&versionName=&platform=windows`. רק הצעה של `platform: "windows"`.
- **הורדה ברקע, תמיד אוטומטית**, ל-`%APPDATA%\R2M Kiosk\updates`, ובדיקת SHA-256 וגודל מול הענן; קובץ שלא תואם נמחק.
- **התקנה:** אוטומטית רק כשהשיוך בענן מסומן "התקנה אוטומטית", וגם אז רק כשהמכשיר פנוי — קיוסק במסך הפתיחה / סגור, בלי הזמנה
  ובלי תשלום (גם לא תשלום שממתין לבירור), ואם בשיוך (או ב-`updateWindow` של kiosk.json) יש חלון — רק בתוכו (למשל 02:00–05:00).
  "התקן עכשיו" במסך הטכנאי — בכל זמן, **חוץ מבזמן הזמנה או תשלום**. המתקין רץ בשקט (`/S --force-run`), מחליף את האפליקציה
  ומפעיל אותה מחדש.
- **דיווח לענן:** downloading → downloaded → installing → installed, או failed עם הסיבה; הגרסה הרצה ב-heartbeat.

```json
{ "updateWindow": "02:00-05:00", "updateCheckMinutes": 15 }
```

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

## גשר לדפדפן (מצב `bridge`)

אותה אפליקציה ואותו מתקין יכולים לרוץ **כגשר** לקיוסק / KDS / מסך מוכן שרצים ב-Chrome / Edge באותו מחשב
(`docs/SPEC_KIOSK.md` §28): בלי חלון קיוסק — אייקון ליד השעון, חלון קטן, ו-API מקומי על `http://127.0.0.1:47615` לאשראי (Nayax LAN /
SynqPay, ספר המסמכים של הקיוסק), להדפסה (ESC/POS), למגירה ולפתיחת הדפדפן במצב קיוסק בעליית Windows.

- **בחירת המצב:** מתקין ששמו מכיל `bridge` (`R2M-POS-Windows-bridge-setup.exe`, ההורדה מהדשבורד) כותב
  `%APPDATA%\R2M Kiosk\bridge.mode` (`build/installer.nsh`); או "הפעלה כגשר לדפדפן" במסך הצימוד; או `--bridge` / `kiosk.json`
  `"mode": "bridge"`; `--app` גובר. העדכונים שומרים את המצב.
- **קוד:** `src/core/bridgeProtocol.ts`, `bridgePairing.ts`, `bridgeLauncher.ts`, `src/main/bridge/*`, `src/main/shell/mode.ts`,
  `src/renderer/bridgeWindow/`. הצד של הדפדפן: `client/src/lib/kioskBridge.ts`.
- **נתונים:** `%APPDATA%\R2M Kiosk\bridge\` (צימוד, הגדרות, יומן פניות `logs\`, תיקייה לכל מכונה `machines\<id>\kiosk.db`,
  פרופיל הדפדפן `browser-profile\`).
- **בדיקות:** `test/bridge.test.ts` (השרת והלקוח של הדפדפן מול מסופון ומדפסת מדומים).
- `kiosk.json`: `{ "bridgeOrigins": ["https://dashboard.example"], "bridgePort": 47615 }` (הדף מחפש רק את הפורט הקבוע).
