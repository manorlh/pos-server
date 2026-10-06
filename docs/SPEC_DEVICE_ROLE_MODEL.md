# סוג מכשיר (תפקיד) ודגם מכשיר בהוספת מכשיר — אפיון ומימוש

גרסה 1.0 · 06.10.2026 · ענף `feat/r2m-pos-2026-10`

> משלים את `docs/SPEC_KIOSK.md` (הקיוסק עצמו, ההמרה, הקופות השולטות ונעילת המכשיר), `docs/PAIRING.md` (קודי צימוד),
> `docs/SPEC_INDEPENDENT_TILL.md` (קופה ראשית ובדיקות "שבירה נקייה") ו-`docs/SPEC_OFFLINE_TILL_Z.md` (Z ללא חיבור).
> מסך מטבח (KDS) **אינו** חלק מהאפיון הזה — ראו §1.

## 1. הבקשה והחלטות הבעלים

- "בהוספת מכשיר, צריך לבחור סוג קיוסק/קופה וסוג מכשיר": בדיאלוג הוספת מכשיר שתי בחירות חובה — **סוג מכשיר (תפקיד)** ו**דגם מכשיר**.
- "kds לא יהיה ניתן זה בנפרד": התפקידים הם **קופה** ו**קיוסק** בלבד. מסך מטבח ממשיך להיצמד בדיוק כמו היום, מעמוד ה-KDS
  (`client/src/components/dashboard/kds/devices-section.tsx`, הפרמטר `kdsScreen`); לא בשדה התפקיד, לא בעמוד המכשיר ולא בתגיות.
  בדיאלוג יש רק שורת הפניה: "מסך מטבח (KDS) מצמידים בנפרד, מעמוד מסכי המטבח".
- "מכשירי הסליקה הם חיצוניים": **קיוסק מחייב תמיד במסופון חיצוני ברשת, לעולם לא במסוף מובנה** — ראו §3.

## 2. תפקידים

| תפקיד | הסבר (כפי שמוצג בדיאלוג) | מקור האמת |
|---|---|---|
| קופה (`till`) | עמדת מכירה רגילה לעובדים: מכירות, משמרות, Z ודוחות. | אין שורת `kiosk_devices` |
| קיוסק (`kiosk`) | עמדת הזמנה עצמית ללקוחות: בוחרים, משלמים ומקבלים מספר איסוף. צוות נכנס בקוד מנהל. | שורת `kiosk_devices` (`app/services/kiosk_control.py`) |

- **אין עמודת תפקיד.** התפקיד נגזר משורת `kiosk_devices` — אותו מקור שעמוד הקיוסקים משתמש בו, כך שעמוד הקיוסקים ועמוד המכשיר לעולם
  לא סותרים זה את זה (`app/services/device_profile.py` `role_of`).
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

`PUT /machines/{id}/device-profile` `{deviceRole?, deviceModel?, kiosk?}` — רק מה ששונה נשלח. גם `PUT /machines/{id}` עם `deviceModel`
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

- רשימת המכשירים ועמוד הסניף: תגית **קופה / קיוסק** (קיוסק כבוי — "קיוסק (כבוי)") ותגית הדגם.
- פרטי השורה ברשימה: "סוג מכשיר (תפקיד)" ו"דגם מכשיר". פריט התפריט "שינוי תפקיד / דגם" פותח את אותו דיאלוג של עמוד המכשיר.
- עמוד המכשיר: תפקיד (וקישור "הגדרות הקיוסק"), דגם, רשימת יכולות (✓/✗), "בקרוב" ל-LANDI/Feitian, אזהרת דגם, ואזהרת מסופון לקיוסק.

## 7. API (תוספות)

| | |
|---|---|
| `POST /pairing/generate` | + `deviceRole` (`till`/`kiosk`), + `kiosk {name, controllerMachineIds, lockDevice, pinpadHost, pinpadPort}`; `deviceModel` מקבל את ששת הדגמים |
| `GET /pairing/codes…` | + `deviceRole` |
| `PUT /machines/{id}/device-profile` | חדש — §5 |
| `PUT /machines/{id}` | `deviceModel` — אותם כללים (§5) |
| `GET /machines`, `GET /machines/{id}` | + `deviceRole`, `kioskEnabled`, `deviceModelChosen`, `deviceModelReported`, `hasCashDrawerPort`, `deviceDriverPending`; `hasBuiltinTerminal` false לקיוסק |
| `GET /machines/me` | + `deviceRole` (מצב הפתיחה: `kiosk` לקיוסק פעיל), + `hasCashDrawerPort`; `hasBuiltinTerminal` false לקיוסק |
| `POST /machines/{id}/replacement-code` | `deviceModel` מקבל את ששת הדגמים |

**Migration:** `c4e8a2d6f0b3_device_role_model` (אחרי `f3a9c2d7e1b4`), additive ומוגן: `pos_machines.device_model_chosen`,
`pairing_codes.device_role`, `pairing_codes.kiosk_options`. הערכים החדשים של `device_model` נכנסים ב-`String(16)` הקיים.

## 8. מימוש — קבצים

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
- **התקנה בשטח (QR):** בחירת תפקיד במסלול הנייד — לא מומש; מצמידים כקופה והופכים לקיוסק מעמוד המכשיר.
- **מסמכים שלא סונכרנו** נבדקים לפי הדיווח האחרון של הקופה (`pending_documents`); קופה מנותקת עם דיווח ישן — הבדיקה לפי הישן.
- הקופה מתעדכנת ב-`hasBuiltinTerminal` של קיוסק דרך `machines/me` (בצימוד ובסנכרון התקופתי); לוגיקת הקיוסק בקופה עצמה ממילא לא
  מחייבת במסוף מובנה (`KioskTerminal`).
