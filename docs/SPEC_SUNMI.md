# SUNMI — תמיכה מלאה במכשירי SUNMI (קופה ושרת)

גרסה 1.0 · 06.10.2026 · ענף `feat/r2m-pos-2026-10`

> משלים את `docs/SPEC_DEVICE_ROLE_MODEL.md` (דגמים ויכולות, `hasCashDrawerPort`) ואת `docs/SPEC_PRINT_BY_ZONE.md` (מדפסות
> בונים). הקופה: `pos-android` (Kotlin, flavor `device`, חבילה `il.co.runnersys.pos.hardware.sunmi`).

## 1. הבקשה

- "כולם יש לי, תבנה אותם": כל דגמי SUNMI נתמכים — ידניים (V/P), מסופונים בלי מדפסת (L/M), שולחניים (T/D) והקיוסק (K2).
- הדפסה במדפסת המובנית (קבלות, בונים, Z, דוחות, פתקי קיוסק), סכין חיתוך איפה שיש, מצב המדפסת (נייר, התחממות, מכסה פתוח)
  בנורות הקיימות, מגירת כסף ביציאת המגירה של השולחניים, סורק מובנה, ורשימת הדגמים בענן עם זיהוי אוטומטי.
- ה-SDK רק מ-Maven Central כתלויות Gradle (Apache-2.0) — שום jar/aar ידני.

## 2. זיהוי (בקופה, בזמן ריצה)

- **SUNMI** = `Build.MANUFACTURER` **או** `Build.BRAND` הוא `SUNMI` (בלי תלות באותיות/רווחים).
- **הדגם** = `Build.MODEL` אחרי נרמול: אותיות גדולות, בלי `SUNMI` בהתחלה, בלי סיומת אזור (`-G`, `-GL`, `-EU`, `-B18`…), בלי
  רווחים / מקפים / קווים תחתונים (`V2_PRO` ו-`V2 Pro` → `V2PRO`, `T1-G` → `T1`, `T2s_LITE` → `T2SLITE`). אחר כך **הקידומת
  הארוכה ביותר** בטבלה (`V2SPLUS` לפני `V2S` לפני `V2`; `D3MINI` לפני `D3`). SUNMI שלא בטבלה = `SUNMI` (כללי).
- **אותה טבלה בשני המקומות:** `pos-android .../hardware/sunmi/SunmiModels.kt` ו-`pos-server server/app/models/sunmi.py`, ננעלות
  בקובץ משותף `sunmi_models_golden.json` (`server/tests/fixtures` + `app/src/test/resources`, אותם בייטים, SHA-256 נעוץ בשתי
  הבדיקות): הטבלה עצמה ו-49 מקרי זיהוי.
- הקופה שולחת בצימוד `model`, `manufacturer` ועכשיו גם `brand` (`PairingRepository.deviceInfo`); השרת מזהה ב-`detect_device_model`.
- `DeviceHardware` (flavor `device`) שואל את `SunmiHardware.model`: ב-SUNMI — מדפסת, מגירה, סורק וזהות של SUNMI; בכל מכשיר
  אחר (F20 / Nova 55F) — FT SDK ו-Agamento בדיוק כמו קודם. סליקה לא משתנה: Agamento איפה שיש, אחרת מסופון ברשת / Z-Credit
  (הענן אומר `hasBuiltinTerminal=false` לכל SUNMI).

## 3. טבלת הדגמים

| `device_model` | דגמים (`Build.MODEL`) | מדפסת | נייר | סכין | יציאת מגירה | סורק מובנה | הערה |
|---|---|---|---|---|---|---|---|
| `SUNMI_V1` | V1, V1s | ✓ | 58 | ✗ | ✗ | ✗ | AIDL ישן |
| `SUNMI_V2` | V2 | ✓ | 58 | ✗ | ✗ | ✗ | AIDL ישן |
| `SUNMI_V2_PRO` | V2 PRO | ✓ | 58 | ✗ | ✗ | ✓ | AIDL ישן; גרסה עם סורק |
| `SUNMI_V2S` | V2s | ✓ | 58 | ✗ | ✗ | ✗ | PrinterX |
| `SUNMI_V2S_PLUS` | V2s PLUS | ✓ | **80** | ✗ | ✗ | ✓ | PrinterX; ידני עם 80 מ"מ |
| `SUNMI_V3` | V3, V3 MIX | ✓ | 58 | ✗ | ✗ | ✓ | PrinterX |
| `SUNMI_P1` | P1, P1 4G | ✓ | 58 | ✗ | ✗ | ✗ | קורא EMV של SUNMI — לא בשימוש |
| `SUNMI_P2` | P2, P2 PRO, P2 lite, P2 SE | ✓ | 58 | ✗ | ✗ | ✗ | קורא EMV של SUNMI — לא בשימוש |
| `SUNMI_P3` | P3, P3 MIX | ✓ | 58 | ✗ | ✗ | ✗ | קורא EMV של SUNMI — לא בשימוש |
| `SUNMI_L2` | L2, L2s, L2H, L2K, L3 | ✗ | — | ✗ | ✗ | ✓ | מסופון סורק, מדפיס במדפסת של הסניף |
| `SUNMI_M2` | M2, M2 MAX, M3, FLEX | ✗ | — | ✗ | ✗ | ✗ | טאבלט, מדפיס במדפסת של הסניף |
| `SUNMI_T1` | T1, T1 mini | ✓ | 80 | ✓ | ✓ | ✗ | AIDL ישן |
| `SUNMI_T2` | T2, T2 lite | ✓ | 80 | ✓ | ✓ | ✗ | AIDL ישן |
| `SUNMI_T2_MINI` | T2 mini | ✓ | 80 (יש גם 58) | ✓ | ✓ | ✗ | הרוחב בפועל — מה שהשירות מדווח |
| `SUNMI_T2S` | T2s, T2s LITE | ✓ | 80 | ✓ | ✓ | ✗ | PrinterX (גם AIDL ישן) |
| `SUNMI_T3` | T3, T3 PRO, T3 PRO MAX | ✓ | 80 | ✓ | ✓ | ✗ | PrinterX |
| `SUNMI_D2_MINI` | D2 mini | ✓ | 58 | ✗ | ✓ | ✗ | |
| `SUNMI_D2S` | D2s, D2s LITE | ✓ | 58 | ✗ | ✓ | ✗ | הרוחב בפועל — מה שהשירות מדווח |
| `SUNMI_D2S_PLUS` | D2s PLUS, D2s Combo | ✓ | 80 | ✓ | ✓ | ✗ | |
| `SUNMI_D3` | D3, D3 PRO | ✓ | 80 | ✓ | ✓ | ✗ | PrinterX |
| `SUNMI_D3_MINI` | D3 MINI | ✓ | 58 | ✗ | ✓ | ✗ | PrinterX |
| `SUNMI_K2` | K2, K2 MINI | ✓ | 80 | ✓ | ✗ | ✓ | קיוסק |
| `SUNMI` | כל SUNMI אחר | ✓* | לפי השירות | לפי השירות | ✗ | ✗ | *מדפיס אם שירות ההדפסה עונה |

- **מסוף אשראי מובנה: ✗ לכל SUNMI.** בדגמי P יש קורא EMV, אבל הוא של SUNMI (PayHardware) — אין לקופה מנהל עבורו ואין הסמכה
  ישראלית; לכן `builtinTerminal=false` והחיוב במסופון חיצוני ברשת / Z-Credit, כמו P18. (סימון `paymentHw` בטבלה — מידע בלבד.)
- **"נייר" בטבלה** הוא מה שהדגם נמכר איתו ומה שהדשבורד מציג. הקופה מדפיסה ברוחב **שהשירות מדווח** (§5); הטבלה רק גיבוי.
- **מגירה ו"סורק"** — אין SDK שמדווח עליהם, ולכן הטבלה היא המקור: שולחני = יציאת מגירה; ידני / קיוסק = אין.

## 4. ה-SDK — בחירה וגיבוי

| | PrinterX | InnerPrinter (ישן) |
|---|---|---|
| תלות | `com.sunmi:printerx:1.0.20` | `com.sunmi:printerlibrary:1.0.24` |
| מקור | Maven Central, Apache-2.0 | Maven Central, Apache-2.0 |
| שירות | חבילה `woyou.aidlservice.jiuiv5`, action `com.sunmi.action.PrinterService` | אותה חבילה, action `woyou.aidlservice.jiuiv5.IWoyouService` |
| דגמים | החדשים: T2s, T3, D3, V2s, V3, P3, K2… | V1, V2, V2 PRO, P1, P2, T1, T2 |
| קוד | `PrinterXBackend.kt` | `InnerPrinterBackend.kt` |

- **סדר:** PrinterX קודם בכל מכשיר שה-action שלו נמצא (`queryIntentServices`); אם אינו, לא נקשר תוך 8 ש', או לא מצא מדפסת —
  ה-AIDL הישן, אם ה-action שלו נמצא (`SunmiSdk.order`). אין אף אחד — `hasBuiltInPrinter=false`: הקופה מדפיסה במדפסת חשבוניות /
  של הסניף כמו טאבלט.
- נבדק מול ה-AAR עצמם (מ-Maven Central, דרך Gradle): שני ה-SDK-ים נקשרים לאותה חבילה. PrinterX עצמו יודע ליפול ל-IWoyouService
  ("inner"), אבל בדגמים הישנים הקופה עובדת ישירות עם `printerlibrary` — שנותן גם מצב מגירה ומספר פתיחות (`getDrawerStatus`,
  `getOpenDrawerTimes`), ש-PrinterX לא חושף.
- PrinterX: מצב — `queryApi().getStatus()` (‏`Status`: ‏`READY`, ‏`ERR_PAPER_OUT`, ‏`ERR_PRINTER_HOT`/`ERR_MOTOR_HOT`, ‏`ERR_COVER`/
  `ERR_COVER_INCOMPLETE`, ‏`ERR_CUTTER`, ‏`ERR_PAPER_JAM`, ‏`OFFLINE`/`COMM`, ‏`WARN_*`…); רוחב — `getInfo(PrinterInfo.PAPER)` ("384"/"576");
  מסמך — `lineApi` במצב טרנזקציה (`enableTransMode` → `printBitmap` → `autoOut` / שוליים → `printTrans`, קוד 0 = הודפס); מגירה —
  `cashDrawerApi().open()` / `isOpen()`.
- ישן: `enterPrinterBuffer(true)` → `printBitmap` → `cutPaper` / שוליים → `exitPrinterBufferWithCallback(true)` (`onPrintResult` 0 = הודפס);
  מצב `updatePrinterState()`; רוחב `getPrinterPaper()`; מגירה `openDrawer` / `getDrawerStatus` / `getOpenDrawerTimes`.
- שני ה-SDK-ים מאחורי ממשק אחד, `SunmiPrinterBackend` (סטטוס, רוחב, הדפסת תמונה, חיתוך / הזנה, מגירה, ספירת פתיחות). כל
  ההחלטות (רוחב, סכין, תקלות, מגירה) ב-`SunmiReceiptPrinter`, אחת לשני ה-SDK-ים, ונבדקות מול backend מדומה.
- בכשל, ה-backend נזרק והעבודה הבאה נקשרת מחדש (שירות שהופעל מחדש).

## 5. הדפסה

- כל מה שהקופה מדפיסה כבר מצויר כתמונה ברוחב 384 נקודות (`PRINT_WIDTH_DOTS`) — עברית ו-RTL נכונים בלי code page.
- **רוחב:** מה שהשירות מדווח (PrinterX: מידע הנייר; ישן: `getPrinterPaper()` 1=58 / 2=80), אחרת הנייר של הדגם, אחרת 58.
  - 58 מ"מ (384) — התמונה כמו שהיא.
  - 80 מ"מ (576) — מוגדלת ל-540 וממורכזת על 576, בדיוק כמו מדפסות 80 מ"מ חיצוניות (`EscPos.receiptContentWidth`).
- **סוף מסמך:** ראש עם סכין — חיתוך (השירות מזין עד הסכין בעצמו); בלי סכין — שוליים לקריעה `TEAR_OFF_FEED_DOTS` (22 מ"מ), כמו ב-F20.
- **תקלות לפני הדפסה:** נגמר נייר / התחממות / מכסה פתוח / סכין / נייר תקוע / אין מדפסת — נכשל מיד במילים של הקופאי, בלי ניסיונות
  חוזרים. תקלה חולפת — עד 3 ניסיונות, 1.5 ש' ביניהם.
- **מצב → נורות** (`SunmiStatusMap`, `PrinterState.reportedFault` החדש):

| SUNMI | `PrinterFault` | heartbeat (`printer.status`) | קוד | הודעה לקופאי |
|---|---|---|---|---|
| תקין / מאתחל | — | `ok` | — | מוכנה |
| נגמר נייר | `OUT_OF_PAPER` | `no_paper` | 115 | `printer_no_paper` |
| התחממות | `OVERHEATED` | `overheated` | 116 | `printer_overheated` |
| מכסה פתוח | `COVER_OPEN` (חדש) | `error` | 9006 | `printer_cover_open` (חדש) |
| סכין / נייר תקוע | `CUTTER` (חדש) | `error` | 9007 | `printer_cutter` (חדש) |
| אין מדפסת / אין תקשורת | (כשל קריאה) | `unavailable` | 9505 / 9003 | `printer_unavailable` |

  קודי SUNMI הם 9000 + קוד המצב הישן, מחוץ לטבלת `ErrCode` של FT. קריאה נקייה מנקה כשל קודם של מכסה / סכין (`clearedByACleanRead`).
  נורית מדפסת בשאלת "באיזו מדפסת להדפיס?" צהובה בכל תקלה (`fault`), לא רק בנייר.

## 6. מגירת כסף

- **מתי נפתחת — בדיוק כמו היום:** אחרי תשלום שהזיז מזומן (`AppContainer.openDrawerForCash` / `CheckoutViewModel`) ובכפתור
  "פתיחת מגירה" (`PosNavigation`), לפי הפרמטר "פתיחת מגירה". שני המסלולים → `AppContainer.openDrawer(destination)` → למדפסת
  של הקופה עצמה `printer.openCashDrawer()` → `SunmiReceiptPrinter.openCashDrawer()` → PrinterX: ה-API של המגירה; ישן: `openDrawer()`.
- **רק בדגמים עם יציאת מגירה (שולחניים).** `HardwareProvider.builtInCashDrawer()` (חדש): SUNMI שולחני `true`, ידני / קיוסק `false`,
  F20 `null`. `ownDrawerAvailable(ownExternal, hasCashDrawerPort, hardwareDrawer)`: מה שהמכשיר יודע על היציאה שלו **גובר** על דגל
  הענן (שתלוי בדגם שמישהו בחר); `null` — כמו קודם. ידני: הכפתור והפתיחה במזומן מוסתרים, ומגירה של מדפסת חשבוניות חיצונית נשארת.
  `openCashDrawer()` בדגם ידני לא עושה דבר.
- **אבחון:** מסך הטכנאי — "מגירת כסף (יציאת המגירה של המכשיר)": פתוחה / סגורה, מספר פתיחות, דרך איזה SDK, וכפתור "פתח מגירה
  (בדיקה)" (`CashDrawerDiagnosticsSection`). בידני — "למכשיר אין יציאת מגירה". ב-F20 — לא מוצג.
- הענן: `_CASH_DRAWER_PORT_MODELS` = כל השולחניים, ולכן `machines/me` מחזיר `hasCashDrawerPort: true` עבורם.

## 7. סורק מובנה

- שירות הסורק של SUNMI מוסר כל קריאה גם כמקלדת וגם כ-broadcast `com.sunmi.scanner.ACTION_DATA_CODE_RECEIVED` (`data` — טקסט,
  `source_byte` — בייטים), לפי הגדרות המכשיר ← סורק.
- במסך המכירה אין שדה טקסט שהמקלדת תקליד אליו, ולכן הקופה מאזינה ל-broadcast (`SunmiScanner.codes`, נרשם רק כל עוד מסך
  המכירה פתוח) וכל קוד הולך בדיוק לאן שסריקת מצלמה הולכת: `SellViewModel.addByCode` (מוצר לפי ברקוד, או שובר `PV:`). אותו
  חסם כמו כפתור הסריקה: כשהסריקה כבויה בענן (`sellScanEnabled`) — מתעלמים.
- **בשטח:** הגדרות ← סורק ← "פלט broadcast" מופעל. כדאי לכבות "פלט מקלדת", אחרת קריאה כשהחיפוש פתוח תוקלד גם לשדה החיפוש.
- ניקוי: CR / LF / TAB ותווי בקרה בקצוות יורדים; broadcast אחר או ריק — מתעלמים.

## 8. מסך לקוח (שולחניים עם מסך שני)

לא מומש. לקופה אין היום מנגנון מסך שני (`Presentation` / `DisplayManager` לא קיימים בקוד), ולכן אין מה לבדוק מול T2 / T2s /
D2s / T3 עם מסך לקוח. כשיתווסף — `android.app.Presentation` על `DisplayManager.DISPLAY_CATEGORY_PRESENTATION` עובד ב-SUNMI
בלי SDK מיוחד.

## 9. ענן ודשבורד

- `app/models/sunmi.py` (חדש): הטבלה, הנרמול, `detect_sunmi`. `app/models/pos_machine.py`: `DEVICE_MODELS` + 23 דגמי SUNMI,
  `_NO_PRINTER_MODELS` (L2, M2), `_NO_BUILTIN_TERMINAL_MODELS` (כל SUNMI), `_CASH_DRAWER_PORT_MODELS` (השולחניים),
  `device_paper_width_mm`, `device_has_builtin_scanner`, ו-`device_capabilities` עם `paperWidthMm` ו-`builtinScanner`.
  `detect_device_model` בודק SUNMI ראשון (יצרן / מותג), אחר כך P18 ו-LANDI כמו קודם.
- סכמות: `DeviceModel` (`schemas/pos_machine.py`) ו-`ReplacementCodeBody.device_model` (`schemas/transmission.py`).
- **בלי migration:** `pos_machines.device_model` / `device_model_chosen` / `pairing_codes.device_model` הם `String(16)` חופשיים; המזהה
  הארוך ביותר (`SUNMI_V2S_PLUS`, `SUNMI_D2S_PLUS`) הוא 14 תווים.
- דשבורד: `src/lib/deviceProfile.ts` (`SUNMI_MODEL_IDS`, `paperWidthMm`, `builtinScanner`), `src/lib/types.ts` (`DEVICE_MODELS` =
  `DEVICE_MODEL_IDS`), `device-role.tsx` (רשימת היכולות: "מדפסת מובנית · נייר 80 מ״מ", "סורק מובנה" והסבר SUNMI), `he.json`
  (תוויות ותגיות לכל דגם). בדיקת הדשבורד קוראת את אותו golden fixture של השרת.

## 10. Gradle, R8, Manifest

- `gradle/libs.versions.toml`: `sunmiPrinterx = "1.0.20"`, `sunmiPrinterLibrary = "1.0.24"`, והספריות `sunmi-printerx`,
  `sunmi-printerlibrary`. `app/build.gradle.kts`: `"deviceImplementation"(libs.sunmi.printerx)` ו-`(libs.sunmi.printerlibrary)` —
  רק ב-flavor `device`; ה-mock לא מושפע.
- R8: `fast` בלי minify (אלא אם `-PfastR8=true`), `release` עם minify — `proguard-rules.pro` שומר `com.sunmi.**` (גם כללי הצרכן של
  PrinterX אומרים את זה). אין ב-AAR ספריות native.
- Manifest: בלוק `<queries>` נפרד ומוער עם `<package android:name="woyou.aidlservice.jiuiv5" />` (אחרת ב-Android 11+ אי אפשר לראות /
  לקשור את השירות). ה-manifest של PrinterX ממזג בעצמו את אותה שורה ואת ההרשאה `com.sunmi.permission.SET_PRINTER` (הרשאה של SUNMI;
  במכשיר שאינו SUNMI אין לה משמעות).

## 11. בדיקות

- קופה (`testDevice/.../hardware/sunmi/SunmiTest.kt`): fixture נעוץ; טבלה = טבלת הענן; זיהוי (49 מקרים); קידומת ארוכה וסיומות;
  רוחב (שירות → דגם → 58; 384 כמו שהוא, 576 → 540 ממורכז); מצבים (ישן ו-PrinterX) → `PrinterFault` / heartbeat / קודים; כשלים
  סופיים בלי ניסיון חוזר; desktop חותך, ידני מזין שוליים; מגירה רק בשולחני; `ownDrawerAvailable` עם החומרה; סדר ה-SDK; broadcast סורק.
- שרת (`tests/test_sunmi_models.py`): fixture נעוץ ושווה לעותק של הקופה; טבלה; זיהוי; יכולות; בקשות מקבלות כל דגם; צימוד T2s →
  `SUNMI_T2S` עם מגירה ובלי מסוף. `tests/test_device_profile.py` עודכן ל-`paperWidthMm` / `builtinScanner`.
- דשבורד (`src/lib/deviceProfile.test.ts`): אותה טבלה כמו ה-fixture, אין מסוף לאף SUNMI, תוויות ותגיות לכל דגם.

## 12. פתוח

- **בדיקה על מכשירים** (אין מכשיר זמין בפיתוח): שמות `Build.MODEL` המדויקים בכל דגם, ושהרוחב / הסכין שהשירות מדווח נכונים.
- קורא ה-EMV של דגמי P — לא מתוכנן (מסופון חיצוני).
- K2 כקיוסק: אם המדפסת הפנימית נראית גם כהתקן USB, ה-USB האוטומטי של הקיוסק (`UsbPrinters`) עלול לבחור בה לבונים — לבדוק על K2.
- פלט "מקלדת" של הסורק בלי שדה ממוקד — לא נקלט (רק broadcast).
- הדפסת מדבקות (V2 PRO / V2s PLUS במצב label) — לא בשימוש.
