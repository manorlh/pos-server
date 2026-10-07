# סוג מכשיר (תפקיד) ודגם מכשיר בהוספת מכשיר — אפיון ומימוש

גרסה 1.1 · 07.10.2026 · ענף `feat/r2m-pos-2026-10`

> משלים את `docs/SPEC_KIOSK.md` (הקיוסק עצמו, ההמרה, הקופות השולטות ונעילת המכשיר), `docs/PAIRING.md` (קודי צימוד),
> `docs/SPEC_INDEPENDENT_TILL.md` (קופה ראשית ובדיקות "שבירה נקייה"), `docs/SPEC_OFFLINE_TILL_Z.md` (Z ללא חיבור)
> ו-`docs/SPEC_KDS.md` (מסכי המטבח ומסך האיסוף).

## 1. הבקשה והחלטות הבעלים

- "בהוספת מכשיר, צריך לבחור סוג קיוסק/קופה וסוג מכשיר": בדיאלוג הוספת מכשיר שתי בחירות חובה — **סוג מכשיר (תפקיד)** ו**דגם מכשיר**.
- **1.1 (07.10.2026)** — "אני רוצה שההתקנה של הווינדוס יכולה לכלול KDS, קופה, קיוסק, מסך מוכן/לא מוכן, וההגדרה מה הוא
  יהיה בהוספת מכשיר בענן במהלך הצימוד. חשוב מאוד: מכשירים KDS ומסך מוכן/לא מוכן אינם מערכות קופה וחשבונאיות."
  ארבעה תפקידים ופלטפורמה (Android / Windows) נבחרים בהוספת מכשיר; KDS ומסך מוכן / לא מוכן הם **מכשירי תצוגה** — §2.2.
  (זה מחליף את ההחלטה של 1.0 "kds לא יהיה ניתן זה בנפרד": מסך מטבח לא נצמד יותר כקופה מעמוד ה-KDS — ראו §2.4.)
- "מכשירי הסליקה הם חיצוניים": **קיוסק מחייב תמיד במסופון חיצוני ברשת, לעולם לא במסוף מובנה** — ראו §3.

## 2. תפקידים

| תפקיד | הסבר (כפי שמוצג בדיאלוג) | מקור האמת |
|---|---|---|
| קופה (`till`) | עמדת מכירה רגילה לעובדים: מכירות, משמרות, Z ודוחות. | אין שורת `kiosk_devices` |
| קיוסק (`kiosk`) | עמדת הזמנה עצמית ללקוחות: בוחרים, משלמים ומקבלים מספר איסוף. צוות נכנס בקוד מנהל. | שורת `kiosk_devices` (`app/services/kiosk_control.py`) |
| מסך מטבח (`kds`) | מסך — לא קופה, בלי מכירות ובלי חשבונאות. מציג למטבח את ההזמנות לפי עמדות. | `is_fiscal = false` + שורת `kds_devices` (station / expo / manager) |
| מסך מוכן / לא מוכן (`order_status_board`) | מסך — לא קופה, בלי מכירות ובלי חשבונאות. מספרי הזמנות בהכנה ומוכנות לאיסוף. | `is_fiscal = false` + שורת `kds_devices` בתפקיד `pickup` |

- **אין עמודת תפקיד.** התפקיד נגזר משורת `kiosk_devices` / `kds_devices` — אותם מקורות שעמוד הקיוסקים ועמוד ה-KDS משתמשים בהם,
  כך שהעמודים לעולם לא סותרים זה את זה (`app/services/device_profile.py` `role_of` / `current_role` / `effective_role`).
- קיוסק כבוי (`enabled = false`) מוצג "קיוסק (כבוי)" ועובד כקופה רגילה, בדיוק כמו ש-`kiosk/sync` עונה לו `kiosk: false`.
  לכן `GET /machines/me` מחזיר `deviceRole: "kiosk"` רק לקיוסק פעיל.

### 2.1 הוספת מכשיר כקיוסק — בלי שלב המרה אחר כך

1. בדיאלוג "הוספת מכשיר" (דשבורד ← מכשירים) בוחרים **קיוסק**, דגם, שם, **חברה וסניף (חובה לקיוסק)**, ואת אפשרויות הקיוסק — אותן
   שלוש של "הפוך קופה לקיוסק": שם הקיוסק, **קופות שולטות** (אותה חברה, לא קיוסק), **"נעל את המכשיר (מצב קיוסק)"** — ובנוסף
   **כתובת המסופון החיצוני** (§3).
2. `POST /pairing/generate` שומר על הקוד `device_role = "kiosk"` ו-`kiosk_options` (שם, קופות שולטות, נעילה, כתובת מסופון).
   הבדיקות נעשות כבר כאן, כשהדיאלוג פתוח: בלי סניף — `400 kiosk_requires_shop`; קופה שולטת לא תקינה — `422 invalid_controller`;
   כתובת מסופון לא תקינה — `422 pinpad_host_invalid` / `pinpad_port_invalid`. כל סירוב נושא `message` בעברית שמוצג כפי שהוא.
3. כשהמכשיר מממש את הקוד (`POST /pairing/validate`), המכונה נוצרת, נכנסת לסניף, ומיד אחר כך **מומרת לקיוסק** בשירות ההמרה הקיים
   (`kiosk_control.convert`) עם הקופות השולטות והנעילה (`device_profile.apply_on_pairing`). קופה שולטת שהפסיקה להיות תקינה בינתיים
   (הוצאה משימוש, הפכה לקיוסק) — נשמטת, לא מכשילה. **שום כשל בשלב הזה לא מכשיל את הצימוד**: במקרה כזה המכשיר נשאר קופה, ואפשר
   להמיר מעמוד הקיוסקים.
4. **הקופה נפתחת כקיוסק בסנכרון הראשון:** מיד אחרי הצימוד הקופה קוראת `GET /machines/me`, שמחזיר כבר `deviceRole: "kiosk"`; הקופה
   שומרת אותו (`SettingKeys.TILL_DEVICE_ROLE`) ומבקשת `kiosk/sync` מיד (`KioskRepository.syncForRole` מתוך `MainActivity`),
   במקום לחכות לסקר של קופה רגילה (כל 2 דק׳). `kiosk/sync` עונה `kiosk: true` והקופה עוברת למסך "הפעלת קיוסק".
   כל עוד התפקיד ששמור והמצב בקופה לא מסכימים (למשל תפקיד שונה בעמוד המכשיר), `syncIfDue` מבקש `kiosk/sync` בלי לחכות למרווח —
   לכל היותר פעם ב-15 שנ׳ (`kioskSyncForced`); תשובת `kiosk/sync` מעדכנת את התפקיד השמור, כך שאין לולאה.
5. קוד החלפה (`replacement-code`) לא משנה תפקיד: המכשיר החדש יורש את שורת המכונה, ושורת `kiosk_devices` נשארת עליה.

> מסלול "התקנה בשטח" (QR מהנייד, `/mobile/pair`) מקבל את הדגמים החדשים אך עדיין מצמיד כקופה; הופכים לקיוסק מעמוד המכשיר (§5).

### 2.2 KDS ומסך מוכן / לא מוכן — מכשירי תצוגה, לא קופה

`pos_machines.is_fiscal` (NOT NULL, ברירת מחדל `true`, מאונדקס) הוא `false` למכשיר תצוגה. נקבע **רק בצימוד** (או בהמרה מעמוד
ה-KDS, §2.4). מקור: `app/services/display_devices.py`.

- **בצימוד:** קוד `kds` / `order_status_board` מחייב סניף (`400 kds_requires_shop` / `order_status_board_requires_shop`); למסך עמדה —
  לפחות עמדה אחת של הארגון (`422 station_device_needs_a_station` / `station_not_found`), אותם כללים כמו `kds.save_device`. הקוד שומר
  `kds_options` (`name`, `screenRole`, `stationIds`; ללוח: `pickup`). המכונה **נוצרת לא-חשבונאית**: בלי מספר קופה (`pos_number` null),
  בלי קידומת מסמכים. מיד אחרי הכניסה לסניף נכתבים שורת `kds_devices` (לוח ← `pickup`; KDS ← סוג המסך והעמדות) והפרמטר `kdsScreen`,
  כך שמכשיר אנדרואיד נפתח במסך המטבח. כשל בשלב הזה לא מכשיל את הצימוד ולעולם לא משאיר את המכונה חשבונאית (עמדה שנמחקה בינתיים
  נשמטת; מסך עמדה בלי עמדות הופך ל-Expo; אחרת משייכים בעמוד ה-KDS).
- **אכיפה בשרת:** כל נקודת קצה חשבונאית של הקופה תלויה ב-`require_fiscal_machine` / `require_fiscal_machine_token`
  (`app/middleware/auth.py`, `dependencies=FISCAL_SYNC_PATH` / `FISCAL_MACHINE_TOKEN`) ומחזירה למכשיר תצוגה
  `403 {"detail": "device_not_fiscal", "message": "מכשיר תצוגה (מסך מטבח / מסך מוכן) אינו קופה: אין בו מכירות, משמרות, Z או תשלומים."}`:
  מסמכים (`transactions`), משמרות (פתיחה / סגירה / ack), Z לקופה (`till-z`, ack), Z סניפי (`shop-z`, proceed, ו-Z סניפי מקומי: local,
  local-request/ack, remote-close, remote-part), שידורים (`transmissions`, `transmit/ack`), אישורי אשראי ללא חיבור, כתובת מסופון
  (`payment-terminal`), SynqPay, תשלומים שנכשלו, שוברים (lookup / redeem / reverse / transaction), כל כתיבות השולחנות, הזמנות קיוסק /
  מספר איסוף / פקודות לקיוסק / הזמנות פתוחות, מסמכי הדרכה. **פתוחות:** heartbeat, `machines/me`, משיכות קטלוג / הגדרות / פרמטרים,
  `kds/*`, עדכוני אפליקציה, הדפסות, זמינות מוצרים, משתמשים ונוכחות, הודעות ואירועים. `tests/test_display_devices.py` עובר על
  `app.routes`: כתיבה חדשה של קופה שאינה מסווגת (מוגנת או ברשימת הפתוחות) מכשילה את הבדיקה.
- **מחוץ לכל רשימת קופות חשבונאית:** משתתפי Z הסניף (`z_runs.is_seated_in` / `shop_tills`, ומכאן ה-Z הסניפי המקומי וכרטיס
  השתתפות ב-Z); הקופה הראשית וכל בחירת מארח — שולחנות, שרת הדפסות (`independent_till.lan_members`, `main_till` router); "Z לכל הקופות"
  (`till_z.shop_till_z_machines`); מספרי קופה וקידומת מסמכים (`register_number.assign_register_number` / `set_machine_shop`); קופות
  הסקירה (`overview`); קופות אירוע (`report_events.shop_tills`); קופות שולטות בקיוסק (`kiosk_control.validate_controllers`), וקיוסק
  לא נוצר ממכשיר תצוגה (`kiosk_control.convert`). בדשבורד: בקשת Z, שידור, קידומת ומצב Z למכשיר תצוגה — `409 device_not_fiscal`.
  סטטוס "אין משמרת פתוחה" לא חל עליו (מוצג מחובר / מנותק).
- **רשות המסים:** הקובץ במבנה אחיד נבנה ממסמכים בלבד; מכשיר תצוגה לא יכול לשלוח מסמך, ולכן אין לו שורה בייצוא. מסמכים של קופה
  שהפכה למסך (§2.4) נשארים בייצוא — הם מסמכים אמיתיים.

### 2.3 פלטפורמה — Android / Windows

- בהוספת מכשיר בוחרים פלטפורמה (ברירת מחדל Android); `pairing_codes.platform`. ההתקנה של ווינדוס יכולה להיות כל אחד מארבעת התפקידים.
- ב-`POST /pairing/validate`: `device_info.platform == "windows"` ← Windows, כל דבר אחר / חסר ← Android. קוד של פלטפורמה אחרת נדחה
  **לפני שנוצר משהו** — `422 {"detail": "platform_mismatch", "codePlatform", "devicePlatform", "message"}`, והקוד נשאר לא מנוצל.
  קוד בלי פלטפורמה (דשבורד ישן, קוד החלפה) — בלי בדיקה. למחשב ווינדוס לא נבחר דגם.
- `pos_machines.platform` נשמר בצימוד (ובהחלפה — של המכשיר החדש); מכונה ישנה — מ-`device_info`, אחרת Android.
- **דפדפן (Web):** קיוסק (`/k`, `SPEC_KIOSK.md` §27), מסך מטבח (`/kds`) ומסך מוכן / לא מוכן (`/board`) — `SPEC_KDS.md` §13;
  `device_info.platform == "web"` ← Web. קוד web לקופה נדחה — `422 web_platform_not_a_till`. מסך בדפדפן הוא מכשיר תצוגה כמו כל מסך.

### 2.4 עמוד ה-KDS ומכונות קיימות

- **ההחלטה:** שיוך קופה קיימת כמסך **בפעם הראשונה** בעמוד ה-KDS (`kds.save_device` ← `display_devices.make_screen`) הופך אותה למכשיר
  תצוגה — רק ב"שבירה נקייה" (`check_clean_break`), בלי משמרות סגורות שממתינות ל-Z (`kds_screen_shifts_awaiting_z`), בלי עסקאות אשראי
  שלא שודרו, לא קיוסק (`kds_screen_is_kiosk`) ולא הקופה הראשית. מספר הקופה נשאר "בשימוש" במונה הסניף (לא יינתן שוב), המכונה מוותרת
  עליו ועל הקידומת, והמסמכים שלה נשמרים. הדיאלוג מזהיר לפני כן. הסרת המסך מעמוד ה-KDS משאירה מכשיר תצוגה בלי מסך — לא קופה.
- **נתונים קיימים:** ה-migration לא משנה סטטוס חשבונאי של אף מכונה. קופה שכבר הציגה מסך KDS לפני הכלל (שורת `kds_devices` על
  מכונה חשבונאית) נשארת קופה — עריכת המסך שלה לא ממירה אותה — והדשבורד מסמן אותה "מסך מטבח על קופה" (`kdsScreen` על מכונה עם
  `fiscal: true`). כדי שתהיה מסך בלבד: מסירים ומוסיפים מחדש כ"מסך מטבח".

## 3. "מכשירי הסליקה הם חיצוניים" — קיוסק ומסופון

- **קיוסק — אין מסוף מובנה, ללא קשר לדגם.** `POSMachine.has_builtin_terminal` = יכולת הדגם **וגם** לא קיוסק
  (`POSMachine.is_kiosk`, נבדק פעם אחת למופע; ברשימות נטען לכולם בשאילתה אחת — `device_profile.prime_kiosks`). מכאן, בלי צנרת חדשה:
  - `GET /machines/me` → `hasBuiltinTerminal: false`, והקופה (`PaymentTerminalConfig`) עוברת למסופון ברשת (או ל-Z-Credit אם נבחר במפורש);
  - אינטגרציית האשראי האוטומטית בענן נקבעת `nayax_lan`, ו-`agamento` מפורש לא חל על קיוסק (`payment_integration.resolve`);
  - בתשובת המכונה `pinpadRequired: true`, ו-`pinpadAddressMissing: true` כשאף רמה לא נותנת כתובת — ההתראה הקיימת ברשימת המכשירים
    ("נדרשת כתובת IP למסופון") מופיעה גם לקיוסק.
  - המדפסת נשארת של הדגם (קיוסק F20 מדפיס במדפסת המובנית).
- **הכתובת — המפתחות הקיימים.** בדיאלוג (ובהפיכה לקיוסק מעמוד המכשיר) יש "מסופון חיצוני ברשת — חובה לקיוסק": כתובת IP ופורט.
  היא נכתבת לשכבת ההגדרות של המכונה עצמה — `nayaxEnabled`, `nayaxDeviceHost`, `nayaxDevicePort`, `nayaxSpicyPath` — דרך
  `payment_terminal.pinpad_settings_patch` ובניקוי של `clean_pinpad_host` / `clean_pinpad_port`, **בדיוק** כמו כתובת שמוזנת בקופה
  (`PUT /sync/{id}/payment-terminal`) או בהגדרות הקופה בדשבורד. ריק מותר: הכתובת יכולה לבוא מהסניף, או להיות מוזנת אחר כך בהגדרות
  הקופה (סוג אינטגרציית אשראי ← Nayax — מסופון ברשת) או בקופה עצמה. הקופה מקבלת התראת הגדרות (`notify_machine_settings`).
- **אזהרה בעמוד המכשיר:** קיוסק בלי כתובת מסופון באף רמה (ולא Z-Credit מפורש) מציג "לקיוסק לא הוגדרה כתובת מסופון: הוא לא יוכל
  לחייב בכרטיס…" (`kioskPinpadMissing`). חזרה לקופה רגילה — הדגם קובע שוב את המסוף המובנה; הגדרות המסופון נשארות.
- בצד הקופה, התנהגות הקיוסק כשאין מסוף חיצוני (מסך "התשלום אינו זמין כרגע") שייכת לעבודת הקיוסק (`domain/KioskTerminal.kt`,
  `docs/SPEC_KIOSK.md` §2.1) — האפיון הזה רק מבטיח שהענן לעולם לא אומר לקיוסק שיש לו מסוף מובנה.

## 4. דגמים ויכולות

| דגם (`device_model`) | תווית בדשבורד | מדפסת מובנית | מסוף אשראי מובנה | יציאת מגירה | הערה |
|---|---|---|---|---|---|
| `N55F` | Feitian F20 / Nova 55F | ✓ | ✓ (Agamento) | ✗ | ה-F20 נוהג ב-FT SDK (`ftsdk-api`). אין לו יציאת מגירה (`FtReceiptPrinter.hasCashDrawer = false`) |
| `MODO` | MODO | ✗ | ✓ (Agamento) | ✗ | מדפיס במדפסת חשבוניות של הסניף |
| `P18` | Kozen Nebullar P18 (טאבלט) | ✗ | ✗ | ✗ | ה-SDK של Kozen לא מחובר; מחייב במסופון ברשת. מזוהה לבד (`model`) |
| `LANDI` | LANDI | ✗ | ✗ | ✗ | **"תמיכה במדפסת/מגירה מובנית — בקרוב"**. מזוהה לבד לפי היצרן (`manufacturer` = LANDI) |
| `FEITIAN_TABLET` | Feitian טאבלט | ✗ | ✗ | ✗ | **"תמיכה במדפסת/מגירה מובנית — בקרוב"**. לא מזוהה לבד (אותו יצרן כמו ה-F20) |
| `GENERIC_ANDROID` | טאבלט / אנדרואיד כללי (ללא מדפסת וללא מסוף מובנים) | ✗ | ✗ | ✗ | בהגדרה |
| `SUNMI_*` (23 דגמים) | SUNMI … | לפי הדגם | ✗ | שולחניים ✓ | ראו `docs/SPEC_SUNMI.md`. מזוהים לבד (יצרן / מותג SUNMI + `model`) |
| לא צוין (`null`) | לא צוין | ✓ | ✓ | ✗ | נקרא כ-55F, כמו כל קופה שקדמה לעמודה |
| **כל דגם בתפקיד קיוסק** | | כמו הדגם | **✗ תמיד** | ✗ | §3 |

- **מקור אמת:** `app/models/pos_machine.py` (`device_capabilities`, `device_has_printer`, `device_has_builtin_terminal`,
  `device_has_cash_drawer_port`, `device_driver_pending`). הדשבורד מציג למכונה את הדגלים של השרת (`hasPrinter`, `hasBuiltinTerminal`,
  `hasCashDrawerPort`, `deviceDriverPending`); הטבלה ב-`client/src/lib/deviceProfile.ts` משמשת רק לתיאור דגם לפני שיש מכונה (דיאלוג
  ההוספה). שתי הטבלאות ננעלות בבדיקות זהות (`tests/test_device_profile.py`, `src/lib/deviceProfile.test.ts`).
- **מה הקופה עושה עם הדגלים** (`GET /machines/me`):
  - `hasPrinter` — כבר קיים (`SettingKeys.TILL_HAS_PRINTER`): בלי מדפסת מובנית מדפיסים רק במדפסת חיצונית / של הסניף.
  - `hasBuiltinTerminal` — כבר קיים (`TILL_HAS_BUILTIN_TERMINAL`, `domain/PaymentTerminalConfig.kt`): בלי מסוף — מסופון ברשת / Z-Credit.
  - `hasCashDrawerPort` — **חדש** (`TILL_HAS_CASH_DRAWER_PORT`): כש-`false` המדפסת המובנית לא מציעה מגירה (`ownDrawerAvailable` →
    `receiptDestinationsOf(localDrawer = false)`). מגירה של מדפסת חשבוניות חיצונית (`cashDrawer` שלה, או מדפסת חיצונית שהפרמטר של
    הקופה מגדיר) נשארת. שרת ישן שלא שולח את השדה — הכול כמו קודם. בפועל זה מסיר כפתור "פתיחת מגירה" שב-F20 לא עשה דבר.
- **LANDI ו-Feitian טאבלט — לעולם לא "מדפיס".** אין להם מנהל מדפסת/מגירה (ה-SDK של היצרן לא בידינו), ולכן כל היכולות כבויות
  והדשבורד מציג "בקרוב" עם הסבר: בינתיים הדפסה במדפסת חשבוניות של הסניף ומגירה דרך מדפסת עם יציאת מגירה.

### 4.1 זיהוי אוטומטי ואזהרה

- `detect_device_model(device_info)` נשמר: לפי `model` (P18), ואם לא — לפי `manufacturer` (LANDI). הקופה שולחת עכשיו גם
  `manufacturer` (`Build.MANUFACTURER`) בצימוד.
- **כמו שהצימוד כבר עשה:** הדגם שהמכשיר מזהה בעצמו **גובר** על הדגם שנבחר בקוד (טאבלט שצומד בקוד של 55F הוא טאבלט). זה לא נעשה
  בשקט: הבחירה נשמרת ב-`pos_machines.device_model_chosen`, והדגם המדווח נגזר מ-`device_info` (`deviceModelReported`).
- **אזהרה בעמוד המכשיר** (`deviceModelWarning`):
  - "בהוספה נבחר {chosen}, אבל המכשיר זיהה את עצמו כ-{stored} בחיבור — נשמר {stored}." — הצימוד דרס את הבחירה;
  - "המכשיר מדווח שהוא {reported}, אבל הדגם הרשום הוא {stored}…" — דגם שנבחר אחר כך בעמוד המכשיר סותר את מה שהמכשיר דיווח.
    בחירה בעמוד המכשיר **לא נדרסת** (עד צימוד מחדש).

## 5. שינוי תפקיד או דגם (עמוד המכשיר)

`PUT /machines/{id}/device-profile` `{deviceRole?, deviceModel?, kiosk?, kds?}` — רק מה ששונה נשלח.

- **קופה / קיוסק ↔ מסך:** כל שינוי בין תפקיד חשבונאי (קופה, קיוסק) לתפקיד תצוגה (KDS, מסך מוכן / לא מוכן) נדחה —
  `409 device_role_change_requires_pairing` ("…הסירו את המכשיר והוסיפו אותו מחדש עם קוד צימוד חדש"). KDS ↔ מסך מוכן / לא מוכן מותר
  (שורת `kds_devices` מתעדכנת: לוח ← `pickup`; KDS ← `kds.screenRole`, ברירת מחדל Expo). גם `PUT /machines/{id}` עם `deviceModel`
עובר את אותם כללים. הרשאות: כמו כל עריכת מכונה (`get_current_machine_admin` — סופר-אדמין, מפיץ לקופות שלו, מנהל חברה בעץ שלו, מנהל
סניף בסניף שלו); שינוי תפקיד עובר גם את בדיקת התחום של עמוד הקיוסקים (`kiosk_control.check_machine_scope`).

כללים — כל שינוי רק ב"שבירה נקייה" (`device_profile.check_clean_break`, אותם כללים כמו העברה לקופה עצמאית וקוד החלפה):

| כלל | קוד (`409`) | מקור הבדיקה |
|---|---|---|
| אין Z בתהליך שכולל את הקופה (ריצת Z או בקשת Z לקופה) | `device_profile_z_in_progress` | `till_z.live_z_run_item`, בקשות Z ממתינות |
| אין משמרת פתוחה — בענן, או שהקופה מדווחת ב-heartbeat | `device_profile_open_shift` | `independent_till._open_shift` |
| אין מסמכים שהקופה דיווחה שטרם סונכרנו | `device_profile_unsynced_documents` | `pending_documents` (דיווח אחרון) |
| אין דוחות Z שנסגרו ללא חיבור וטרם סונכרנו (או קופה שיכולה לסגור כך ולא נראתה) | `device_profile_offline_zs` | `till_z.may_be_producing_offline` |
| **לקיוסק:** מכשיר פעיל ומשויך לסניף | `device_profile_not_assigned` | כמו `machine_not_assigned` של ההמרה |
| **לקיוסק:** לא הקופה הראשית של הסניף | `device_profile_main_till` | `main_till.main_till_of_shop` |
| **דגם בלי מסוף** (כשלקודם היה): אין עסקאות אשראי שלא שודרו | `device_profile_untransmitted` | `transmissions.has_untransmitted` |
| קופה שולטת לא תקינה / כתובת מסופון לא תקינה | `422 invalid_controller` / `pinpad_*` | `kiosk_control.validate_controllers`, `payment_terminal` |

- כל סירוב: `{"detail": קוד, "message": "לא ניתן לשנות את הדגם של קופה 2: יש בה משמרת פתוחה…"}` — הדשבורד מציג את `message` כפי שהוא.
- אותו תפקיד / אותו דגם — לא שינוי, ותמיד עובר.
- **קופה ← קיוסק:** ההמרה הקיימת (שם, קופות שולטות, נעילת מכשיר, כתובת מסופון). הקופה עוברת למסך הקיוסק בסנכרון הבא שלה.
- **קיוסק ← קופה:** `kiosk_control.remove` — ההזמנות ויומן הפקודות נשמרים. **נעילת המכשיר (`kioskMode`) נשארת** (כמו "החזר לקופה
  רגילה" בעמוד הקיוסקים) — מכבים בפרמטרים לקופות. הגדרות המסופון נשארות.
- את אפשרויות קיוסק קיים (שם, שולטות, הפעלה) עורכים בעמוד הקיוסקים, לא כאן.

## 6. רשימות

- רשימת המכשירים ועמוד הסניף: תגית **קופה / קיוסק** (קיוסק כבוי — "קיוסק (כבוי)") ותגית הדגם. מסכי KDS ומסכי מוכן / לא מוכן
  מוצגים בקבוצה נפרדת **"מסכים"** בכל סניף (לא בין הקופות, לא בספירת הקופות ובסטטוסים), עם תגית מסך מטבח / מסך מוכן-לא מוכן ותגית
  Android / Windows; בעמוד המכשיר שלהם מוסתרים הקידומת, מצב ה-Z, המשמרת, השידורים ופעולות ה-Z, ומוצג "מסך — לא קופה".
- פרטי השורה ברשימה: "סוג מכשיר (תפקיד)" ו"דגם מכשיר". פריט התפריט "שינוי תפקיד / דגם" פותח את אותו דיאלוג של עמוד המכשיר.
- עמוד המכשיר: תפקיד (וקישור "הגדרות הקיוסק"), דגם, רשימת יכולות (✓/✗), "בקרוב" ל-LANDI/Feitian, אזהרת דגם, ואזהרת מסופון לקיוסק.

## 7. API (תוספות)

| | |
|---|---|
| `POST /pairing/generate` | + `deviceRole` (`till`/`kiosk`/`kds`/`order_status_board`), + `platform` (`android` ברירת מחדל / `windows`), + `kiosk {name, controllerMachineIds, lockDevice, pinpadHost, pinpadPort}`, + `kds {name?, screenRole: station/expo/manager (ברירת מחדל expo), stationIds}`; `deviceModel` מקבל את ששת הדגמים |
| `POST /pairing/validate` | `422 platform_mismatch` לפני שנוצר משהו; קוד KDS / לוח ← מכונה עם `is_fiscal = false`, בלי מספר קופה, עם שורת `kds_devices` ו-`kdsScreen` |
| `GET /pairing/codes…` | + `deviceRole`, `platform` |
| `PUT /machines/{id}/device-profile` | חדש — §5 |
| `PUT /machines/{id}` | `deviceModel` — אותם כללים (§5) |
| `GET /machines`, `GET /machines/{id}` | + `deviceRole` (4 התפקידים), `fiscal`, `platform`, `kdsScreen`, `kioskEnabled`, `deviceModelChosen`, `deviceModelReported`, `hasCashDrawerPort`, `deviceDriverPending`; `hasBuiltinTerminal` false לקיוסק |
| `GET /machines/me` | + `deviceRole` (מצב הפתיחה: `kiosk` לקיוסק פעיל, `kds` / `order_status_board` למכשיר תצוגה), + `fiscal`, `platform`, `hasCashDrawerPort`; `hasBuiltinTerminal` false לקיוסק |
| כל נקודת קצה חשבונאית של הקופה | `403 device_not_fiscal` למכשיר תצוגה (§2.2) |
| `POST /machines/{id}/replacement-code` | `deviceModel` מקבל את ששת הדגמים |

**Migration:** `c4e8a2d6f0b3_device_role_model` (אחרי `f3a9c2d7e1b4`), additive ומוגן: `pos_machines.device_model_chosen`,
`pairing_codes.device_role`, `pairing_codes.kiosk_options`. הערכים החדשים של `device_model` נכנסים ב-`String(16)` הקיים.
`f6c8e0a2b4d9_display_devices` (אחרי `f3a9c1e7b5d2`), מוגן ואידמפוטנטי: `pos_machines.is_fiscal` (NOT NULL, ברירת מחדל true, אינדקס),
`pos_machines.platform`, `pairing_codes.platform`, `pairing_codes.kds_options`; `pairing_codes.device_role` הורחב ל-`String(32)`.

## 8. מימוש — קבצים

- **מכשירי תצוגה (1.1):** `app/services/display_devices.py` (חדש), `app/middleware/auth.py` (`require_fiscal_machine*`), `app/main.py`
  (handler), ה-routers עם `dependencies=FISCAL_*` (sync, tables, prepaid_vouchers, till_shop_z, till_shop_z_local, failed_payments,
  kiosks, kiosk_open_orders, synqpay_pairing, training_mode), `services/{z_runs,independent_till,till_z,register_number,overview,
  kds,kiosk_control,pairing}.py`, `report_events/crud.py`, `routers/{machines,pairing,main_till}.py`, `tests/test_display_devices.py`;
  דשבורד: `deviceProfile.ts` (`DEVICE_ROLES`, `NON_FISCAL_ROLES`, `isFiscalRole`, `DEVICE_PLATFORMS`), `device-role.tsx`
  (`DevicePlatformPicker`, `KdsScreenFields`, `DisplayDeviceNote`), `machines-table.tsx` (קבוצת "מסכים"), `machine-row.tsx`,
  עמוד המכשיר, עמוד הסניף, `kds/devices-section.tsx` (אזהרה).
- **ענן:** `app/models/pos_machine.py` (דגמים, יכולות, זיהוי לפי יצרן, `device_model_chosen`, `is_kiosk`, `has_builtin_terminal`),
  `app/models/pairing_code.py`, `app/schemas/device_profile.py` (חדש), `app/schemas/pos_machine.py`, `app/schemas/pairing_code.py`,
  `app/schemas/transmission.py`, `app/services/device_profile.py` (חדש), `app/services/pairing.py`, `app/routers/pairing.py`,
  `app/routers/machines.py`, `alembic/versions/c4e8a2d6f0b3_device_role_model.py`, `tests/test_device_profile.py` (חדש).
- **דשבורד:** `src/lib/deviceProfile.ts` + `.test.ts` (חדשים), `src/components/dashboard/machines/device-role.tsx` (חדש),
  `device-model.tsx`, `machine-row.tsx`, `src/app/dashboard/machines/page.tsx` (דיאלוג ההוספה), `machines/[id]/page.tsx`,
  `shops/[id]/page.tsx`, `src/lib/types.ts`, `src/lib/posMachine.ts`, `src/messages/he.json` (`machines.deviceModel`, `machines.deviceRole`),
  `package.json` (קובץ הבדיקה).
- **קופה:** `domain/DeviceRole.kt` (חדש: `DeviceRole`, `kioskSyncForced`, `ownDrawerAvailable`), `domain/Documents.kt`
  (`TILL_DEVICE_ROLE`, `TILL_HAS_CASH_DRAWER_PORT`), `domain/TillIdentity.kt`, `data/remote/Dtos.kt` (`deviceRole`, `hasCashDrawerPort`),
  `data/repo/KioskRepository.kt` (`syncForRole`, סנכרון כפוי, עדכון התפקיד השמור), `MainActivity.kt` (שורה אחת אחרי הצימוד),
  `domain/ReceiptPrinterConfig.kt` + `AppContainer.kt` (מגירה), `data/repo/PairingRepository.kt` (`manufacturer`),
  בדיקות `DeviceRoleTest.kt` (חדש).

## 9. פתוח / בהמשך

- **LANDI ו-Feitian טאבלט:** חסרות ערכות הפיתוח של היצרנים (מדפסת ומגירה). כשיגיעו: מנהל מדפסת ב-flavor של המכשיר
  (`HardwareProvider.hasBuiltInPrinter`), להוציא את הדגם מ-`_NO_PRINTER_MODELS` / `_DRIVER_PENDING_MODELS` ולהוסיף ל-
  `_CASH_DRAWER_PORT_MODELS` אם יש יציאה — ובטבלה של הדשבורד. מסוף מובנה של LANDI (מסוף EMV של היצרן) — לא מתוכנן; מסופון חיצוני.
- **זיהוי Feitian טאבלט:** לא אפשרי לפי `manufacturer` (זהה ל-F20); אפשרי לפי `Build.MODEL` כשיהיה מכשיר לבדיקה.
- **התקנה בשטח (QR):** בחירת תפקיד במסלול הנייד — לא מומש; מצמידים כקופה והופכים לקיוסק מעמוד המכשיר. מסך מצמידים בקוד.
- **אנדרואיד:** `DeviceRole.parse` של הקופה לא מכיר `kds` / `order_status_board` (מחזיר null — אין שינוי התנהגות); המסך נפתח דרך
  `kdsScreen`. כדאי שהקופה תקרא `fiscal: false` ותסתיר את מסך המכירה גם אחרי "חזרה לקופה" (השרת ממילא דוחה).
- **מסמכים שלא סונכרנו** נבדקים לפי הדיווח האחרון של הקופה (`pending_documents`); קופה מנותקת עם דיווח ישן — הבדיקה לפי הישן.
- הקופה מתעדכנת ב-`hasBuiltinTerminal` של קיוסק דרך `machines/me` (בצימוד ובסנכרון התקופתי); לוגיקת הקיוסק בקופה עצמה ממילא לא
  מחייבת במסוף מובנה (`KioskTerminal`).
