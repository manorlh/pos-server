# מיפוי האפיון המאוחד מול הקוד — Runner POS / R2M

מקור: `Runner_POS_Full_Claude_Spec_HE.md` (06.10.2026, 563 שורות).
מצב הקוד שנבדק: ענף `feat/r2m-pos-2026-10` בשני המאגרים (pos-android `d4ccfd5`, pos-server `0dcaa05`), כולל שינויים שעוד לא נכנסו לקומיט.
המסמך הוא מיפוי בלבד. לא שונה קוד.

**קיצורי נתיבים**
- `A` = `P:\pos-android\app\src\main\java\il\co\runnersys\pos`
- `S` = `P:\pos-server\server\app`
- `C` = `P:\pos-server\client\src`
- `D` = `P:\pos-server\docs`

**סימונים:** ✅ קיים · ◐ חלקי · ✗ חסר · ⚠ התנגשות עם התנהגות שהבעלים כבר ביקש או שכבר קיימת.

---

## תקציר — הממצאים העיקריים

1. **אין מושג של תצורת עבודה.** בשום מאגר אין `workflow_mode`, ערוץ (קופה/מסופון/קיוסק), `payment_policy` או פרופיל עמדה. סוג השירות (`Cart.dining`) נשמר רק בזיכרון ועל הבון. הוא לא נשמר במכירה. אין מספר הזמנה או מספר איסוף. זה הבסיס שהקיוסק, ה-KDS וה-SMS נשענים עליו.
2. **"קיוסק" בקוד היום הוא נעילת מכשיר.** הפרמטר `kioskMode` הוא נעילת מכשיר (`A\system\KioskLock.kt`, `P:\pos-android\docs\KIOSK.md`). אין הזמנה עצמית של לקוח. ⚠ יש התנגשות שמות.
3. **אין KDS.** ניתוב לתחנות קיים ומלא (`KitchenStation`, `KitchenStationTarget`, `KitchenPrinterRoute`), וגם תור הדפסה עמיד עם גיבוי מדפסת. אבל אין משימות מטבח, מצבי הכנה, Expo או מסך איסוף.
4. **אין SMS, OTP, הסכמות, נקודות או דף הרשמה.** טבלת `customers` הקיימת היא לקוח לחשבונית (ח.פ.). כפתור "מועדון" הוא הנחה קבועה באחוזים, לא חברות.
5. **⚠ מסך התשלום (§10) מתנגש עם בקשה קודמת של הבעלים.** הכפתורים "אשראי מהיר" ו"מזומן מהיר" מחייבים בלחיצה אחת. §10 דורש "בחירה → כפתור ראשי". קוד "בחר ואשר" כבר קיים אבל כבוי (`if (false)` ב-`CheckoutScreen.kt:516`), כך שהחזרתו זולה. ההחלטה של הבעלים.
6. **סיכון כספי: אשראי עם תוצאה לא ידועה.** אחרי `TRANSPORT_ERROR` ניסיון חוזר נשלח עם vuid חדש (`vuids.next()`, `CheckoutViewModel.kt:2028`), בלי לברר קודם את סטטוס העסקה. האפיון (§10, J) אוסר זאת. מומלץ P0.
7. **מסך השולחן במסופון קיים ברובו**, עם פערים התנהגותיים:
   - אין שאלה ביציאה עם פריטים שלא נשלחו.
   - אחרי שליחה המסך חוזר למפה, והאפיון דורש להישאר בשולחן.
   - הערה מוגבלת ל-120 תווים ונחתכת בשקט.
   - אין "תוספת אזלה".
   - Grid של 2 עמודות לא אפשרי (⚠ גדלי אריחים שהבעלים קבע).
8. **מלצרים: אין תפקיד מלצר.** יש רק `cashier` / `shop_manager`, וההרשאות קבועות בקוד. אין מצב "מסייע". החלפת מלצר וגבייה פתוחות בלי בדיקת הרשאה.
9. **אין ישות "תפריט" (בוקר/ערב/Happy hour).** "menu" בקוד הוא שכבת תוספות. ⚠ המונח "שידור" כבר תפוס לפרסום קטלוג (`SPEC_MENU_BROADCAST_REVIEW.md`). §F דורש להפריד אותו מ"שדר" למטבח.

---

## 0. טבלת מצב לפי סעיף

| סעיף באפיון | מצב | הפער המרכזי | בעבודה ע״י |
|---|---|---|---|
| §1–8 תצורת עבודה `workflow_mode` | ✗ | אין פרמטר, אין snapshot בהזמנה, אין ערוץ | סוכן KDS + workflow (חדש) |
| A קיוסק BON/KDS | ✗ | יש רק נעילת מכשיר | — (תלוי ב-workflow) |
| B חוויית קיוסק | ✗ | — | — |
| C מלצרים והרשאות | ◐ | אין תפקיד מלצר, אין "מסייע", החלפת owner לא מוגנת | נוכחות (חלקית) |
| D מפה | ◐/✅ | אין "תשלום בתהליך", אין badges של לא-נשלח, אין חלונית פרטים בטאבלט | לוגו/ויזואל מפה |
| E הזמנה מהירה | ◐/✅ | אין מספר הזמנה, אין "שלח למטבח" לפני תשלום | סדר אמצעי תשלום |
| F תפריטים והפצה | ◐ | אין ישות תפריט; סקירת שידור קיימת לקטלוג | — |
| G טיימרים וגיבוי מדפסת | ◐ / ✅ | אין טיימר לכל מצב; גיבוי מדפסת קיים | — |
| H לוח בקרה | ✅/◐ | יום עסקי, שולחנות פתוחים, export ו-KDS/SMS חסרים בבית | — |
| I נוכחות וטיפים | ◐ | שלב 1 בשרת בלבד, ללא קומיט; אין ledger טיפים | נוכחות שלב 1 |
| J אבטחה ו-adapters | ✗ | אין Wolt/Cibus/10bis/ValueCard/KASHASH (וזה תקין) | — |
| מסך הזמנה במסופון §1–9 | ◐/✅ | ראו §11 | — |
| מסך תשלום §10 | ◐ ⚠ | התנגשות one-tap; תוצאה לא ידועה | סדר אמצעי תשלום |
| KDS (חלק א §4–12) | ✗ | ניתוב קיים; אין lifecycle | סוכן KDS (חדש) |
| הודעות 019 (חלק ב §13–20) | ✗ | — | סוכן SMS + מועדון (חדש) |
| מועדון (חלק ג §21–29) | ✗ (◐ לקוחות) | — | סוכן SMS + מועדון (חדש) |
| §30–37 נתונים, API ובדיקות | — | משותף לכל המודולים החדשים | — |

---

## 1. תצורת עבודה — `workflow_mode` (חלק ראשון §1–8)

| דרישה | מצב | מה יש בפועל |
|---|---|---|
| `workflow_mode` DIRECT_SALE / ORDER_PROCESS | ✗ | אין שום התאמה בשלושת המאגרים |
| ערוץ: קופה / מסופון / קיוסק | ✗ | הפריסה נקבעת אוטומטית לפי רוחב המסך (`A\ui\common\Adaptive.kt`), לא לפי הגדרה. `KitchenTicket.source` = table/sale/test. `table_orders.source` = synced/local (מצב סנכרון, לא ערוץ) |
| סוג שירות: טייק אווי / ישיבה | ◐ | `enum Dining {EAT_IN, TAKE_AWAY}` ב-`A\domain\Cart.kt`. פרמטרים `askEatInTakeAway`, `askOrderName`, `orderDetailsAt` (`A\ui\sell\MenuSheetState.kt`, `OrderNameSheet.kt`). בורר בטאבלט (`TabletQuickOrder.kt`). **נשמר רק בבון** (`S\schemas\kitchen_printers.py` `dining`), לא ב-`TransactionEntity` ולא ב-`transactions` |
| "סוגי עבודה" לסניף | ◐ מידע בלבד | `ShopWorkTypes` (`S\models\menu_broadcast.py`), `C\components\dashboard\work-types-card.tsx`. "שום דבר לא קורא אותם". רק "שולחנות" כותב את `tablesMode` |
| שליחה למטבח לפני / אחרי תשלום | ◐ קבוע | הזמנה מהירה מדפיסה **רק אחרי תשלום** (`kitchenTicketsOnSale`, `CheckoutViewModel.kt:2414`). שולחן שולח לפני תשלום |
| שכבות הגדרה: חברה → סניף → אזור → עמדה | ✅ | פרמטרי קופה: `S\services\till_parameters.py` (`TILL_PARAMETER_SCOPES`, `resolve_till_parameters`), נשמרים בקופה כ-`param.<key>`. הגדרות POS: `S\services\settings_merge.py` |
| effective config preview | ◐ | קיים להגדרות POS (`?includeEffective=true`, `entity-settings-dialog.tsx`) ולהגדרות מדפסות. **אין "ערך אפקטיבי לקופה X" לפרמטרי קופה** |
| snapshot בהזמנה (`config_version`, `workflow_mode`, `fulfillment_mode`) | ✗ | רק `shifts.area_id/area_name` |
| `service_type` / `table_ref` נפרדים משולחן פיזי | ✗ | `table_orders.table_id` הוא FK ל-`dining_tables` |
| Validation בצד השרת (READY SMS דורש ORDER_PROCESS וכו׳) | ✗ | — |
| החלפת מצב ע״י עובד מורשה עם audit | ✗ | יש תשתית audit: `TillEventRecorder`, `S\services\exceptions.py` |

**בסיס קיים לשימוש חוזר:**
- מנגנון הפרמטרים המדורג. הפרמטרים החדשים יתווספו ל-`BUILTIN_PARAMETERS` עם ברירת מחדל שמשמרת את ההתנהגות של היום, כפי שנעשה בנוכחות.
- `ElevationScope` לאישור החלפה.

**התנגשויות**
- ⚠ **השם "קיוסק".** `kioskMode` = "נעילת קופה (מצב קיוסק)" (`A\domain\Kiosk.kt`, `till_parameters.py:585`). האפיון משתמש ב-KIOSK כערוץ. אסור להשתמש ב-`kioskMode` לערוץ. מוצע:
  - `stationChannel` = POS | HANDHELD | KIOSK
  - `kioskFulfillmentMode` = BON | KDS
  - להשאיר את `kioskMode` כנעילה, ולשקול לשנות את התווית בדשבורד ל"נעילת מכשיר".
- ⚠ **פרמטר מול מצב שלא נשמר.** `Cart.dining` נקבע היום ע״י `orderDetailsAt` / `askEatInTakeAway`. מעבר ל-`service_type` שנשמר בהזמנה חייב לשמור את ההתנהגות הנוכחית של השאלה.

**תלוי ב:** אין. זה הבסיס.
**מי תלוי בו:** קיוסק, KDS (מדיניות שחרור), SMS מוכן, טיימרים לכל מצב, תחולת תפריטים לפי מצב, לוח בקרה (מקור).

---

## 2. קיוסק BON / KDS (A, B)

| דרישה | מצב | הערות וקבצים |
|---|---|---|
| `kiosk_fulfillment_mode` BON/KDS + `fulfillment_mode_snapshot` | ✗ | — |
| מסך המתנה (לוגו, hero, "להתחלת הזמנה", שפה) | ✗ | הקרוב ביותר: שומר מסך (`screensaverEnabled`, `screensaverMediaUrl`, `A\ui\common\ScreenSaver.kt`) ו-`splashMediaUrl` |
| בחירת טייק אווי / ישיבה | ◐ | קיים לקופאי בלבד (`OrderNameSheet`) |
| קטלוג ללקוח, סל sticky, sheet תוספות | ◐ | אפשר לעשות שימוש חוזר ב-`DishSheet` (`A\ui\sell\MenuSheets.kt`) וב-`DishDraft` / `ModifierMath`. אין UI ללקוח |
| Upsell לא חוסם | ◐ | `UpsellPopup.kt`, `upsell_rules` עם שעות, ימים ו-`place` (quick/tables/both). אין `place=kiosk` |
| תשלום מראש באשראי במסוף מחובר | ◐ | זרימת קופאי (`CheckoutViewModel`). אין מסך לקוח |
| מספר בון / איסוף | ✗ | יש רק `orderRef` = מספר עסקה |
| אחרי תשלום: הדפסה אוטומטית פעם אחת | ◐ | `kitchenTicketsOnSale` + תור עמיד (`KitchenQueue`). אין סטטוס "נשלח" מול "הודפס" |
| איפוס חוסר פעילות עם אזהרה (המשך / בטל) | ✗ | `idleLockSeconds` מנתק בלי אזהרה |
| מסך הצלחה שמתנקה | ◐ | `DONE_AUTO_RETURN_MS = 2000` (קופאי) |
| kiosk-mode שמונע יציאה ל-OS | ✅ | `KioskLock.kt` (device owner / pinning) + `KioskLeaveHost` (מנהל, `ElevationScope.KIOSK_UNLOCK`) |
| מסכי ניהול מוגנים, pause עמדה, recovery של הזמנות ששולמו | ◐ | `TechnicianCodeScreen`, `orphanedCardSales` בהגדרות. אין pause |
| טלפון להזמנה (לא חברות) | ✗ | `transactions.customer_phone` משמש רק לתעודות זיכוי |
| הצטרפות למועדון / QR | ✗ | תלוי במועדון |

**התנגשויות**
- ⚠ השם `kioskMode` (ראו סעיף 1).
- ⚠ ברירת המחדל של `tipAutoPrompt` היא `true`. בקיוסק האפיון דורש "טיפ כבוי כברירת מחדל". חובה override בפרופיל קיוסק.

**תלוי ב:**
- `workflow_mode` וערוץ
- מספר איסוף
- KDS (לקיוסק KDS)
- תור הדפסה (קיים)
- מסוף אשראי עם בירור תוצאה לא ידועה (סעיף 12)
- מועדון / OTP (אופציונלי)
- טיימרים לכל מצב
- החלטת חומרה

---

## 3. מלצרים, שיוך והרשאות (C)

| דרישה | מצב | מה יש בפועל |
|---|---|---|
| כניסה ב-PIN | ✅ | `A\ui\auth\LoginScreen.kt`, `A\domain\PinVerifier.kt` (bcrypt, offline) |
| כניסה בכרטיס | ✗ | — |
| שם, תפקיד, סניף | ◐ | `pos_users` (`first_name`, `last_name`, `worker_number`, `shop_id`). תפקידים: רק `cashier` / `shop_manager`. `employee_role_id` (מלצר/ברמן…) הוא תפקיד עבודה ולא הרשאה, בשרת בלבד וללא קומיט |
| נוכחות נפרדת מחיבור | ◐ | שלב 1 בשרת (סעיף 9) |
| נעילת session: מסופון אישי מול אייפד משותף | ◐ | `idleLockSeconds` לכל רמה. אין סוג מכשיר. מתבצעת התנתקות מלאה, לא נעילה קצרה |
| עובד אחד בקופה אחת | ✅ | `exclusiveUserLogin` (`D\SPEC_EXCLUSIVE_LOGIN.md`) |
| "שלי" כברירת מחדל | ◐ ⚠ | `FloorFilter.MINE` קיים, אבל ברירת המחדל היא `ALL` (`A\ui\tables\TablesViewModel.kt:123`, `listMine=false` בשורה 100) |
| בעלים נפרד ממבצע הפעולה | ✅ | `table_orders.waiter_pos_user_id` מול `opened_by_*` / `updated_by_*` / `closed_by_*`, ו-`table_events` לכל פעולה |
| מצב "מסייע" + כותרת "באחריות דנה • אתה מסייע" | ◐ | עובד בפועל, כי כל אחד פותח כל שולחן. אין מצב מוגדר ואין כותרת |
| העברת owner בהרשאה | ⚠ ◐ | `WaiterSheet` → `TablesRepository.setWaiter`, **בלי בדיקת הרשאה** ובלי event נפרד |
| הרשאות לפי פעולה | ◐ | `ElevationScope` / `Scope`: `discount`, `table:void` (קופה בלבד), `table:cancel` ו-`table:unlock` (נאכפים בשרת), `table:restore`, `table:reprint`, `refund`. **אין** הרשאות לשינוי מחיר, לגבייה ולהעברת owner |
| הרשאות נאכפות בשרת וניתנות להגדרה | ◐ | קבועות בקוד: `TillAuthority.SENIOR_MAY_ACT_ALONE`, `_POS_USER_SCOPES_BY_ROLE` (`S\services\permissions.py`). הדשבורד `access-settings` מגדיר רק דפים ומכשירים |
| מנהל PIN מאשר פעולה אחת | ✅ | `HeldGrants.consume()`, `LocalManagerSheet` (offline), `S\services\elevation.py` `PER_ACTION_SCOPES` |
| סיום משמרת: חשבונות פתוחים והעברת אחריות | ◐ | שרת בלבד, ללא קומיט: `attendance.open_tables_for`, `preventClockOutWithOpenTables`. אין מסך העברה. `blockCloseWithOpenTables` חוסם סגירת משמרת קופה |
| פתיחת שולחן אטומית | ✅ | `uq_table_orders_open_synced`, `try_lock`, 409 `table_version_conflict` |
| גרסאות שורה ו-conflicts | ◐ | גרסה אחת להזמנה (לא לשורה), `last_request_id`, `keepUnsavedAdditions` |
| הגנה על תשלום בתהליך מול מכשיר אחר | ◐ | נעילת שולחן ב-heartbeat בזמן checkout. השרת לא מסרב לתשלום שני (`pay_duplicate` / `pay_conflict`) |
| LAN host | ✅ | `A\domain\TablesHost.kt`, `TablesLanHost.kt`, `TablesHostDb.kt` |

**התנגשויות**
- ⚠ שינוי ברירת המחדל ל"שלי" משנה התנהגות קיימת. מוצע פרמטר `tablesDefaultFilter`, עם ברירת מחדל "הכול" לשמירה על המצב הנוכחי.
- ⚠ הוספת הרשאה להחלפת מלצר תחסום פעולה שעובדת היום לכולם. מוצע: פרמטר, או הרשאה שמותרת כברירת מחדל ל-`cashier`.
- ⚠ האפיון (I) אומר "אזהרת יציאה עם שולחנות פתוחים", כלומר אזהרה. `preventClockOutWithOpenTables` מוגדר כברירת מחדל `true` וחוסם. להעביר לסוכן הנוכחות לבדיקה.

**תלוי ב:**
- מודל תפקידים: תפקיד מלצר (שרת וקופה)
- מטריצת הרשאות שניתנת להגדרה
- נוכחות שלב 1 (העברת אחריות)

---

## 4. מפה (D)

| דרישה | מצב | מה יש בפועל |
|---|---|---|
| נתונים אחידים לכל המכשירים | ✅ | `dining_tables` / `table_zones` / `sketch`, `A\domain\TableSketch.kt` (fixture משותף) |
| מצבים: פנוי, פעיל, לתשלום, לניקוי, שמור | ✅ | `TableState` (`A\domain\Tables.kt`), `TableBadgeKind` (`A\domain\TableFloor.kt`), `cleaning_since`, `table_reservations` |
| מצב "תשלום בתהליך" | ✗ | מכשיר אחר רואה רק `LOCKED` |
| badges לחדש-לא-נשלח / כשל שליחה | ✗ | `LineKitchenState` קיים רק בתוך ההזמנה |
| כרטיס שולחן: מספר, מצב, סועדים, owner, זמן, סכום, התראה | ✅ | `TableObject` / `TableContent` (`A\ui\tables\TableVisuals.kt`), `tablesWarnMinutes` / `tablesAlertMinutes` |
| סינונים: שלי/כולם, פנויים/לתשלום | ✅ | `FloorFilter {ALL, FREE, MINE, AWAITING, OVERDUE, CLEANING}`. העמעום לא מזיז שולחנות |
| סינון אזור: פנים/חוץ/בר/חדר | ◐ | אזורים בשמות חופשיים (`ZoneSegments`), בלי סוג |
| חיפוש לפי מספר | ◐ | `NumberEntrySheet` פותח את השולחן, לא מסנן |
| מסופון: כרטיסים או מפה עם zoom/pan/fit | ✅ | `GridBody`, `MapBody`, `A\domain\FloorFit.kt` (מעבר לגריד במפה צפופה) |
| טאבלט וקופה: מפה במרכז + חלונית פרטים | ✗ | המפה במסך מלא. לחיצה פותחת את ההזמנה |
| portrait: sheet פרטי שולחן | ◐ | sheets לפעולות בלבד |
| סגירת חשבון → לניקוי לפי פרמטר | ✅ | `tablesCleaning` |
| עורך מפה: אזורים, ID, צורה, מושבים, סיבוב, קירות, כניסה | ✅ | `A\ui\tables\MapDesigner.kt`, `C\components\dashboard\tables\map-editor.tsx`, `SKETCH_KINDS` |
| גרירה בזמן שירות לא מזיזה שולחן | ✅ | בקופה. בדשבורד `set_positions` לא בודק שולחן בשימוש (פער קטן) |
| preview לפי מסך + פרסום מפורש | ✗ | "שמור" חל מיד. `FloorPreviews.kt` הוא preview למפתח בלבד |
| הערת שולחן | ✗ | הערות קיימות רק לשורה |

**התנגשויות**
- ⚠ "פרסום מפורש" למפה ישנה את ההתנהגות הנוכחית, שבה השמירה חלה מיד. מוצע לחבר את זה למנגנון הסקירה של `menuBroadcastReview` (אוטומטי / תמיד / אף פעם), עם ברירת מחדל ללא שינוי.
- קבצי המפה (`TableVisuals.kt`, `MapDesigner.kt`, `TablesScreen.kt`, `map-editor.tsx`) **בעריכה עכשיו** אצל סוכן הלוגו והוויזואל. לא לגעת בהם עד שהעבודה שלו נכנסת.

**תלוי ב:**
- מצב "תשלום בתהליך": מסך התשלום, ודגל בשרת.
- badges שליחה: מזהה שליחה יציב (משותף עם KDS).

---

## 5. הזמנה מהירה (E)

| דרישה | מצב | מה יש בפועל |
|---|---|---|
| Landscape: מוצרים 60–65%, חשבון 35–40% | ◐ | `SIDE_BY_SIDE` מרוחב 840dp. הפאנל הוא 30% (360–440dp), כלומר מוצרים בכ-66–72% (`A\ui\sell\SellPanes.kt`, `TabletQuickOrder.kt`) |
| "מוכרן: X" | ✅ | `QuickOrderHeader` |
| מספר הזמנה | ✗ | — |
| בורר טייק אווי / ישיבה | ✅ | נשמר רק בבון |
| Grid של 4 עמודות, 48dp | ◐ | לפי גודל אריח (`productColumnsFor`) |
| אשראי מתחיל עסקה אחת | ✅ | `startCheckoutWith(FAST_CARD)` |
| מזומן מאשר את הסכום; preset לא מחייב | ✅ | `CashBox` ("מדויק", 5–200 מצטברים). עם סכום שהוקלד, האישור אוטומטי (`PosNavigation.kt:619`) |
| התקבל / עודף | ✅ | `cashChangeInPanel` |
| פיצול ואמצעי נוסף | ◐ | פותחים את מסך התשלום המלא |
| Portrait: מוצרים למעלה, תשלום sticky | ✅ | `STACKED` עם ידית גרירה |
| סיבוב שומר את המצב | ✅ ברובו | הסל בזיכרון בלבד ונאבד אם התהליך נהרג |
| "שלח למטבח" משני לפי מדיניות | ✗ | הבון יוצא רק אחרי תשלום |
| unknown payment לא מתאפס | ◐ | ראו סעיף 12 |

**התנגשויות**
- אין התנגשות. §E ו-J ("direct tender buttons") **תואמים** את כפתורי הלחיצה האחת שהבעלים ביקש. ההתנגשות מתחילה רק בתשלום שולחן (סעיף 12).

**תלוי ב:**
- מספר איסוף (מ-workflow)
- `payment_policy` (שחרור לפני תשלום)

---

## 6. תפריטים והפצה (F)

| דרישה | מצב | מה יש בפועל |
|---|---|---|
| ישות Menu (בוקר/ערב/HH/טייק אווי), אותו מוצר בכמה תפריטים עם מחיר לתפריט | ✗ | "menu" בקוד הוא שכבת תוספות (`S\models\menu.py`: `modifier_groups`, `meal_slots`, `menu_courses`, `upsell_rules`). מחיר קיים רק ב-`products.price` + `shop_product_overrides.price` |
| תוקף לפי timezone, יום ושעה; עדיפות בחפיפה | ◐ | רק ב-`upsell_rules` וב-`promotions` (`start_time`, `end_time`, `weekdays`, `priority`) |
| תחולה: חברה/סניף/אזור/עמדה/מצב עבודה | ◐ | זמינות מוצר: חברה → סניף → אזור → מכונה (`S\services\product_availability.py`). זמינות קטגוריה: סניף/אזור/מכונה. אין תחולה לפי מצב |
| preview ורשימת שינויים לפני פרסום | ✅ מותנה | `D\SPEC_MENU_BROADCAST_REVIEW.md`, `catalog_publications`, `S\routers\menu_broadcast.py`. רק בסניפי שולחנות או כש-`menuBroadcastReview` = תמיד |
| גרסת קטלוג לכל עמדה + היסטוריה | ◐ | גרסה לסניף. ברמת העמדה יש רק `catalogPullStale` / `catalog_behind` |
| snapshot מחיר בשורה | ✅ | `transaction_items.unit_price`, `details`, `transaction_item_parts` |
| "הצג שינויים לפני שליחה למטבח" (diff → אישור "שדר"), בשולחנות בלבד | ✗ | אין diff בקופה, רק גיליון אישור ביטולים |

**התנגשויות**
- ⚠ **המונח "שידור" כבר תפוס.** בדשבורד: "אישור ושידור", `menu-broadcast`. האפיון דורש ש"שדר" לא ישמש לשני תהליכים. החלטה לבעלים: לשנות את הפרסום בדשבורד ל"פרסום קטלוג", או לקרוא לפעולה במטבח "שלח" (כמו היום) ולא "שדר".
- ⚠ ישות תפריט עם מחיר לתפריט משנה את חישוב המחיר בקופה (`CatalogRepository`, `MenuRepository`) ואת המבצעים. זה הסיכון הגבוה ביותר לשבור מכירות קיימות. חובה דגל ותחולה מפורשת.

**תלוי ב:**
- `workflow_mode` (תחולה לפי מצב)
- סקירת שידור (קיימת)

**מי תלוי בו:** קיוסק ("תפריט ומחיר לפי סוג ושעה"). אפשר להתחיל קיוסק עם הקטלוג הקיים.

---

## 7. פרמטרים תפעוליים (G): טיימרים וגיבוי מדפסת

| דרישה | מצב | מה יש בפועל |
|---|---|---|
| טיימר נפרד לשולחן, להזמנה מהירה ולקיוסק | ✗ | גלובלי בלבד: `idleLockSeconds` (התנתקות), `screensaverAfterMinutes` |
| שולחן: חזרה למפה אחרי 60 שניות עם טיוטה | ◐ | `idleLockSeconds` שומר את השולחן (`tables.readyForIdleSignOut`) ומנתק. אין "חזרה למפה בלי ניתוק" |
| אין מעבר בזמן תשלום | ✅ | `HoldScreenSaver()` ב-`CheckoutScreen.kt:105`. לא אומת שזה מוחזק גם בתשלום בתוך הפאנל בטאבלט |
| איפוס על פעילות אמיתית | ✅ | `A\core\UserActivity.kt` |
| גיבוי מדפסת: "לשלוח למדפסת אחרת?" ליעדים מורשים | ✅ | `printerFailoverPrompt`, `A\hardware\kitchen\KitchenFailover.kt`, `A\ui\kitchen\PrinterFailoverHost.kt`, `ReceiptFailover.kt`, `D\SPEC_PRINT_BY_ZONE.md` §3, יומן ב-`kitchen_print_redirects` |
| מצב disabled → מדיניות fallback / התראה | ✅ | כבוי משאיר בתור + פס אדום + צפצוף |
| בלי בון כפול אחרי timeout לא ידוע | ◐ | relay/LAN: dedupe לפי id. TCP ישיר: אין הגנה ("כפילות עדיפה על אובדן") |
| "נשלח להדפסה" מול "הודפס" | ✗ | DONE = הבתים נכתבו |
| הלקוח בקיוסק לא בוחר מדפסת | — | אין קיוסק. יידרש לכבות את השאלה בפרופיל קיוסק |

**פער אפשרי:** ייתכן ש-`printerFailoverPrompt` לא מופיע באף מסך בדשבורד. הוא לא נמצא ב-`GROUPS` של `options-card.tsx`, ודף פרמטרי הקופה מסתיר מפתחות `managedOn:'printers'`. לבדוק בדפדפן.

---

## 8. לוח בקרה אונליין (H)

הקבצים: `C\app\dashboard\page.tsx` ו-`C\components\dashboard\control-board\*`. מקור הנתונים: `S\services\overview.py` (`/reports/overview`).

| דרישה | מצב | הערות |
|---|---|---|
| מסננים מדורגים עם "הכול"; הורה מנקה ילד | ✅ | `board-filters.tsx`, `scope-bar.tsx` |
| טווח זמן | ◐ | יום אחד + יום להשוואה |
| יום עסקי לפי הגדרות | ✗ | בבית: חצות קלנדרית. יום שמתחיל ב-04:00 קיים רק ב-Insights |
| KPI: מכירות, עסקאות, ממוצע, עמדות פעילות | ✅ | הגדרה אחת ל-gross/net ב-`_sales_buckets` |
| החזרים ✅ · הנחות ◐ · טיפים ✅ בנפרד | ◐ | הנחות קיימות ב-payload, לא מוצגות |
| חשבונות פתוחים | ✗ בבית | קיים ב-`/dashboard/compare` |
| פילוח לפי אמצעי תשלום בפועל | ◐ | אשראי / מזומן / אחר. פירוט מלא ב-`sales-by-payment` |
| פיצול נספר כסכומים | ✅ | `S\services\reports.py` |
| גרף שעתי, מוצרים מובילים | ✅ | |
| קטגוריות מובילות | ✗ | |
| drilldown | ✅ | |
| מחובר / משמרת / last_sync בנפרד; stale | ✅ | `S\services\machine_status.py` |
| mobile: כרטיסים + sheet | ✅ | |
| התראות KDS / SMS | ✗ | אין מודולים כאלה |
| התראות ציוד / sync | ✅ | |
| export באותם מסננים | ✗ בבית | |

---

## 9. נוכחות וטיפים (I)

| דרישה | מצב | מה יש בפועל |
|---|---|---|
| Attendance session נפרד מ-login וממשמרת קופה | ◐ | שרת בלבד, **ללא קומיט**: `S\models\attendance.py` (`attendance_shifts`, `attendance_breaks`, `attendance_adjustments`, `employee_roles` עם `tip_weight`), `S\routers\attendance.py`, migration `c4e6a8b0d2f4` |
| clock-in/out/הפסקות, מקור/עמדה, משמרת מעבר לחצות | ◐ | שרת בלבד |
| תיקון מנהל עם לפני/אחרי וסיבה | ◐ | `attendance_adjustments` (`old_value` / `new_value`) |
| פרמטרים | ◐ | `attendanceEnabled`, `requireClockInBeforeLogin`, `preventClockOutWithOpenTables`, `requireManagerForClockOut` |
| קופה ודשבורד | ✗ | אין קוד Android ואין דף `attendance` |
| `SPEC_ATTENDANCE.md` | ✗ | הקוד מפנה אליו, אבל הקובץ לא קיים |
| טיפ נרשם בנפרד, עם אמצעי | ✅ | `transactions.tip_amount`, `tip_payment_method` |
| בלי כפילות טיפ POS + מסוף | ✅ | `terminalTipPrompt`, `A\hardware\payment\TerminalTip.kt`, `D\SPEC_TERMINAL_TIP.md` |
| כללי pool (אישי/משותף/תפקיד/שעות/משקל) | ◐ | `tipDistribution` = direct / equal_pool / by_sales, מחושב בזמן אמת (`S\services\tips.py`) |
| allocation ledger, preview → אישור → reverse | ✗ | |
| דוח עובד מול מנהל; לא לחשוף טיפים של אחרים | ◐ | `tips` בדשבורד בלבד |

⚠ חסימה מול אזהרה ביציאה עם שולחנות פתוחים (ראו סעיף 3).

---

## 10. אבטחה, בדיקות ו-adapters (J)

- **Wolt / Cibus / 10bis / ValueCard / KASHASH:** אין שום אזכור בקוד. זה תואם את האפיון, שאומר לא להציג כאילו מומש. נדרש לאסוף תיעוד וחשבונות בדיקה לפני שמתחילים.
- **קריטריוני BON:** "מדפיס פעם אחת" תלוי במזהה הדפסה יציב. ב-relay/LAN יש כזה. ב-TCP ישיר אין (סעיף 7).

---

## 11. מסך הזמנה בתוך שולחן — מסופון (§1–9)

הקבצים:
- `A\ui\sell\TableOrderLayout.kt`, `TableMenuUi.kt`, `MenuSheets.kt`, `MenuSheetState.kt`, `NoteWordBuilder.kt`
- `A\ui\tables\TableOrderBar.kt`, `TablesViewModel.kt`
- `A\data\repo\TablesRepository.kt`
- `A\hardware\kitchen\KitchenTickets.kt`, `KitchenPrintService.kt`

| דרישה | מצב | פרטים |
|---|---|---|
| Header: שולחן, סועדים, מלצר, שעה, חזרה, ⋮ | ✅ | `TableOrderBar` |
| תפריט ⋮: פרטים, סועדים, העברה, איחוד, פיצול, מלצר, חשבון ביניים, הערת שולחן, ביטול | ◐ | יש: סועדים, הערות, מלצר, פיצול, העברה, העברת פריטים, זרז, הדפסה חוזרת, ביטול. **אין:** הערת שולחן, פרטים מלאים |
| חיפוש לפי שם, קוד, ברקוד, שם מקוצר | ◐ | בלי שם מקוצר (`SellViewModel.kt:325`) |
| קטגוריות אופקיות כולל "מומלצים" | ◐ | אין "מומלצים" |
| Grid של 2 עמודות, כרטיס 4:3 | ◐ ⚠ | `tableDishColumnsFor`: ברירת המחדל MEDIUM = 4 עמודות. **2 עמודות לא אפשרי** |
| אזל מושבת; "נשארו 3" | ◐ | לא זמין = מושבת. אזל = לפי `outOfStockPolicy`. הטקסט "מלאי N", סף קבוע 5 |
| בלי חובה → הוספה מיד; עם חובה → sheet | ✅ | `menuIntercepts`, `modifiersAutoOpen` |
| sheet תוספות: radio/checkbox, חובה/min/max, מחיר דינמי, כמות | ✅ | `DishSheet`, `ModifierMath.validate` |
| שגיאה ליד קבוצה + גלילה אליה | ◐ | הסימון הופך לאדום. אין גלילה |
| תוספת אזלה מושבתת | ✗ | ב-`MenuOption` אין שדה זמינות |
| "הוסף להזמנה • ₪" / "שמור שינויים" | ◐ | בפועל "הוסף ₪" / "עדכן ₪" |
| X או Back עם שינויים → "המשך / בטל" | ✗ | `dismissDish()` סוגר מיד |
| הערה: chips + טקסט חופשי + מונה, 250 תווים, בלי חיתוך שקט | ◐ | `NOTE_MAX = 120`. `NoteSheet` מציג מונה. **ב-DishSheet יש חיתוך שקט** (`SellViewModel.kt:1150`) |
| אלרגיה מודגשת במטבח | ◐ | מה-DishSheet: כן (`KitchenTicketRenderer.kt:251`). מה-chip ב-NoteSheet: לא |
| Mini cart + "שלח למטבח • N" | ✅ | `TableBottomBar`, `SendButton` |
| שכבת סיכום 70–80%, ±, 1→0 עם אישור, Undo | ✅ | `OrderSheet` (0.72), `removeAsk`, `undoRemove` |
| תפריט שורה: עריכה, הערה, שינוי מנה, אורח, העתק, ביטול | ◐ | אין: שינוי מנה, העתק, אורח (`TableLineSeatPicker` נמצא רק ב-`CartScreen`) |
| סטטוסים: חדש, נשלח+זמן, שונה, בוטל, לא נשלח | ◐ | `LineKitchenState {NEW, SENT, CHANGED, HELD}`. אין בוטל ואין כשל |
| שליחה של פריטים חדשים בלבד + הפרשים | ✅ | `KitchenDiff.plan` (`A\domain\Tables.kt:806`) |
| מצב תעבורה Pending/Sending/Sent/Failed | ◐ | לכל job הדפסה (`KitchenQueue`), לא בשורה |
| מזהה יציב לכל שליחה | ✗ | `requestId` חדש בכל `syncedSave`. אין מזהה dispatch |
| נשאר בשולחן אחרי הצלחה | ⚠ ✗ | `end(a)` יוצא למפה אחרי שליחה |
| Offline: תור מקומי לשליחה | ◐ | single-till: כן. synced/LAN offline: שליחה נחסמת (`TableProblem.OFFLINE`) |
| חזרה עם פריטים שלא נשלחו: שלח וצא / המשך / צא בלי לשלוח | ✗ ⚠ | Back שומר טיוטה ויוצא בלי שאלה (`PosNavigation.kt:876`) |
| שמירת מצב בסיבוב, ברקע ובמוות תהליך | ◐ | `remember` ולא `rememberSaveable`. הסל נשמר אוטומטית; sheets פתוחים נאבדים |
| אורחים ומנות (P1) | ◐ | `tableSeats`, `coursesEnabled`, `CourseFire` |
| Hold/Fire (P2) | ◐ | הוצאת מנה קיימת. hold לשורה לא קיים |
| מומלצים, אחרונים, מועדפים (P2) | ✗ | |

**התנגשויות** (כל אחת משנה התנהגות שקיימת היום; החלטה לבעלים)
1. ⚠ **2 עמודות מול גדלי אריחים.** הבעלים קבע גדלי אריחים (commit "tile sizes", `productTileSizeTables`). מוצע להוסיף גודל "גדול מאוד = 2 עמודות", בלי לשנות את ברירת המחדל.
2. ⚠ **אחרי שליחה: להישאר בשולחן או לחזור למפה?** מוצע פרמטר `tablesStayAfterSend`.
3. ⚠ **יציאה בלי שאלה מול שאלה בשלוש אפשרויות.** מוצע: שאלה רק כשיש פריטים חדשים, עם "צא בלי לשלוח" ששומר טיוטה כמו היום.
4. ⚠ **מגבלת הערה 120 מול 250.** להעלות את `NOTE_MAX` דורש לבדוק רוחב בון ושדות בשרת.

**תלוי ב:**
- מזהה dispatch יציב (משותף ל-KDS; אותו קובץ `TablesRepository.send`)
- הכרעת המונח "שדר" (סעיף 6)
- הרשאות (ביטול פריט שנשלח)

---

## 12. מסך התשלום (§10)

הקבצים:
- `A\ui\checkout\CheckoutScreen.kt` (`PayNowButtons`:557), `CheckoutViewModel.kt`, `SplitTender.kt`, `TerminalTipCheckout.kt`
- `A\domain\QuickCash.kt`, `PaymentOptions.kt`, `PayOrder.kt`

| דרישה | מצב | פרטים |
|---|---|---|
| מסך ייעודי, יתרה גדולה 32–40sp, סה״כ/שולם/יתרה | ✅ | `SummaryCard` (40sp) |
| טיפ: ללא / presets / אחר, בלי סימון אוטומטי | ✅ | `TipCard`. שאלת טיפ אוטומטית לפי `tipAutoPrompt` (ברירת מחדל true) היא שאלה, לא סימון |
| טיפ במערכת מול טיפ במסוף | ✅ | `terminalTipPrompt`, `tillTipOptions` |
| כרטיסי אמצעי (2 עמודות) + מפוצל + נוסף | ◐ | כפתורים גדולים + `OptionRow`. `MethodCard` לא בשימוש |
| **בחירת אמצעי לא מחייבת; רק הכפתור הראשי** | ⚠ ✗ | ראו התנגשות 1 |
| אשראי: סטטוס אמיתי, השבתת כפילות | ✅ | `cardBusy`, `canEnterOption`, חסימת הקפצה 700ms |
| ביטול רק כשנתמך | ◐ | הכפתור מוצג תמיד. `TerminalCapabilities` לא נבדק |
| **תוצאה לא ידועה → בירור לפני ניסיון חוזר** | ✗ (סיכון) | `TRANSPORT_ERROR` → `voidCardSale` + `retryable=true` + **vuid חדש** (`:2028`). `getTransactionByVuid` לא נקרא. רק גשר Z-Credit מברר בעצמו |
| מזומן: מקלדת עם נקודה עשרונית | ✅ | `IosKeypad` |
| קיצורים דינמיים (מדויק, 230/250/300) | ◐ ⚠ | ה-UI מציג שטרות קבועים 5–200 שמצטברים (בקשת הבעלים, `d4ccfd5`). `roundTenders()` קיים ולא בשימוש |
| עודף בולט + אישור נפרד | ✅ | "אשר תשלום מזומן". בטאבלט, עם סכום שהוקלד, האישור אוטומטי |
| תשלום חלקי מפורש | ✅ | `takePartialCash`, עד 4 רגליים |
| פיצול לפי סכום / פריטים / אורחים / שווה | ◐ | ב-checkout: בין משלמים (2–20) וסכום אחר. בשולחן (`SplitBillSheet`): פריטים, מושב, שווה. **בהזמנה מהירה אין פיצול לפי פריטים** |
| חלק ששולם לא נגבה שוב | ✅ | `PartsCard`, `TableExtras.partials` |
| מסך סיום: קבלה / חזרה לשולחנות | ◐ | `DoneStep`, חוזר אוטומטית אחרי 2 שניות **גם כשיש עודף** |
| כשל הדפסה לא מבטל תשלום | ✅ | `printWarning`, `retryPrint` |
| Offline ושחזור עסקה אחרי רקע | ◐ | הרשומה הממתינה נכתבת לפני הקריאה למסוף. `pendingTxId` / `activeVuid` נשמרים רק ב-ViewModel |
| סדר אמצעי תשלום | ✅ | `payOrder` (`S\services\payment_options.py`, `C\app\dashboard\payment-methods`) — בעבודה |

### ⚠ התנגשות 1 — לחיצה אחת מול "בחר ואשר" (החלטה לבעלים)

**מה יש היום** (בקשת הבעלים, commits `3124e9b` ו-`d4ccfd5`):
- **"אשראי מהיר"** מחייב מיד: `chargeCardNow()` → `chargeCard()`.
- **"מזומן מהיר"** מאשר מיד: `cashExact()` → `confirmCash()`.
- **"מזומן עם עודף"** פותח מקלדת עם אישור נפרד.
- **חריג:** כשמסך הטיפ של הלקוח נפתח קודם, החיוב לא מיידי.
- **אותם כפתורים מופיעים** בתשלום שולחן, בהזמנה מהירה, בפאנל הטאבלט ובחלקי פיצול.
- **פרמטרים:** `fastCard` / `fastCash` (`till_parameters.py:619/629`) ו-`pay*Enabled`.

**מה האפיון אומר:**
- §10 (תשלום שולחן): בחירת אמצעי לא מחייבת; רק "גביית אשראי • ₪X" / "אשר תשלום מזומן".
- §E ו-J (הזמנה מהירה): direct tender buttons.

**אפשרויות לפשרה (לא הוכרע):**

| # | הצעה | עלות |
|---|---|---|
| א | **לפי הקשר:** הזמנה מהירה וטאבלט = לחיצה אחת (כמו היום). תשלום שולחן = בחר ואשר | נמוכה. בלוק "בחר ואשר" קיים ככבוי (`CheckoutScreen.kt:516`, `MethodCard`) |
| ב | **פרמטר** `payScreenStyle` = "לחיצה אחת" / "בחר ואשר", מדורג לחברה/סניף/אזור/קופה, ואופציונלית נפרד לשולחן (`payScreenStyleTables`). ברירת מחדל: לחיצה אחת, ללא שינוי | נמוכה–בינונית |
| ג | לחיצה אחת בכל מקום, אבל באשראי בשולחן מוצג אישור קצר | נמוכה. לא עונה במלואו על §10 |

### ⚠ התנגשות 2 — שטרות מצטברים מול סכומים עגולים דינמיים

הבעלים ביקש שטרות 5–200 שמצטברים. §10 מבקש סכום מדויק וסכומים עגולים מעל היתרה. אפשר לשלב: שורת "מדויק / 230 / 250 / 300" (`roundTenders()` קיים) מעל שורת השטרות. החלטה לבעלים.

**תלוי ב:**
- יכולת מסוף: `getTransactionByVuid` ב-Agamento; ל-Z-Credit יש בירור
- `tableSeats` (פיצול לפי אורחים)
- מצב "תשלום בתהליך" במפה

---

## 13. KDS (חלק א, §4–12)

| דרישה | מצב | מה יש בפועל |
|---|---|---|
| תחנות וניתוב: מוצר → תחנה, קטגוריה כברירת מחדל, override לסניף | ✅ | `S\models\printers.py`: `KitchenStation`, `KitchenStationTarget`, `KitchenStationPrinter`, `KitchenPrinterRoute`, `KitchenNoTicketProduct`, `KitchenZoneRedirect`. `A\hardware\kitchen\KitchenRouting.kt` `split()`. דשבורד: `kitchen-printers` (`stations-card.tsx`, `routing-editor.tsx`) |
| יעד הכנה מול צפייה מול Expo | ✗ | יעד = מדפסת בלבד |
| override לפי סוג שירות | ✗ | לפי אזור (zone redirect) בלבד |
| מסכים: תחנה, Expo, מנהל מטבח, איסוף, ניהול | ✗ | |
| KitchenDispatch עם מספר סבב | ◐ | `send_count`, `sent_at`, "תוספת" (`isAddition`). אין מספר סבב מודפס |
| KitchenTask: Queued/Preparing/Ready, Waiting/ReadyForPickup/HandedOver | ✗ | יש רק מצבי job הדפסה (`KitchenQueue`: pending → printing → done/relayed/failed) |
| כמויות ordered/cancelled/prepared | ✗ | |
| שינוי/ביטול עם diff ואישור צפייה | ◐ | בבון: `voided` / `noteUpdates` עם קידומות. אין acknowledgement |
| Hold/Fire | ◐ | `CourseFire`, `firedCourses`, פס "הוצא: עיקריות" (שולחנות בלבד) |
| snapshot ניתוב ושמות בשליחה | ◐ | `ticketJson` שמור ב-job (`kitchen.db`) |
| התראה על יעד חסר | ◐ | `unroutedToTill` |
| ספי זמן כתום/אדום לתחנה | ✗ | `tablesWarnMinutes` מודד ישיבה, לא הכנה |
| ענן מנותק ושירות מקומי זמין | ◐ | דפוס `TablesHost` / LAN host קיים לשולחנות, וגם LAN להדפסה |
| גיבוי מדפסת + התאמה בחזרת KDS | ◐ | גיבוי קיים. התאמה מול KDS לא |

**החלטת ארכיטקטורה פתוחה:** איפה רץ ה-KDS?
- כמסך בתוך אפליקציית הקופה (Android): מאפשר offline דרך ה-LAN host הקיים.
- כדף web (Next.js): רק עם ענן.

**תלוי ב:**
- `workflow_mode` (שחרור ומקור)
- מזהה dispatch יציב (משותף למסך השולחן)
- מספר איסוף
- `TablesHost` (offline)

**מי תלוי בו:** SMS מוכן, קיוסק KDS, מסך איסוף, התראות בלוח הבקרה.

---

## 14. הודעות ו-019 (חלק ב, §13–20)

✗ **אין כלום.** חיפוש של sms / 019 / otp / campaign / consent / unsubscribe לא החזיר תוצאות בקוד.

**מה אפשר לעשות בו שימוש חוזר:**
- **דפוס Outbox בקופה:** `OutboxEntity` (`A\data\local\Entities.kt:458`), `A\data\sync\OutboxSync.kt` (ids מהלקוח, idempotent).
- **job relay בשרת עם lease:** `kitchen_print_jobs` (`JOB_LEASE`, `JOB_TTL`) — דוגמה ל-worker עם נעילה.
- **Ably** (`S\services\ably_notify.py`): לקופות בלבד, לא ללקוחות.
- **סודות:** `S\models\payment_secret.py` / `services\payment_secrets.py`. דפוס לשמירת token של 019 בשרת בלבד.

**חסר הכול:**
- `NotificationService`, `Notification`, `NotificationAttempt`, `DeliveryEvent`, `ProviderConfig`
- adapter019 (test/live)
- תבניות, יומן, קמפיינים, Suppression
- worker עם backoff ו-DLR polling

**תלוי ב:**
- אירוע ReadyForPickup מ-KDS (רק להודעת "מוכן")
- טלפון הזמנה (snapshot)
- החלטות: חשבון 019 ושם שולח

---

## 15. מועדון לקוחות (חלק ג, §21–29)

| דרישה | מצב | מה יש בפועל |
|---|---|---|
| Customer | ◐ ⚠ | `S\models\customer.py`: לקוח לחשבונית. `vat_number` ייחודי ל-tenant, `phone` לא מנורמל, אין דף ניהול בדשבורד. בקופה: `CustomerEntity` לקריאה בלבד, חיפוש ב-`CustomerPickerSheet` (`A\ui\sell\SellSheets.kt:678`) |
| Membership / מצבים / דרגות | ✗ | |
| ConsentEvent / Suppression | ✗ | |
| OTP / OtpChallenge | ✗ | |
| דף הרשמה ציבורי + QR עם מזהה מקור אטום | ✗ | הדשבורד כולו מאחורי Clerk. נדרש route ציבורי |
| PointsLedger, BenefitGrant, RedemptionReservation | ✗ | |
| זיהוי במכירה | ◐ | חיפוש לקוח קיים. `transactions.customer_ref_id` + snapshot שם/טלפון |
| כפתור "מועדון" | ◐ ⚠ | `clubButtonEnabled`, `clubDiscountPercent` (10%), `clubRequiresCustomer` (`A\domain\OthClub.kt`, `OthClubUi.kt`). נשמר כ-`basket_discount_kind='club'`. דוח: `S\services\discounts_report.py` |
| OTH | ✅ | הנחת שורה של 100%, `oth_reason`, `oth_approved_by` (לא קשור למועדון) |
| אזור אישי ומנהל מועדון | ✗ | |

**התנגשויות**
- ⚠ **כפתור "מועדון" הוא היום הנחה בלי אימות חברות.** §26 קובע ש"lookup טלפון אינו הרשאה למימוש", ו-§27 שהטבות לא יוגדרו כתשלום. החלטה: להשאיר את הכפתור כ"הנחת מועדון ידנית" (legacy) עד שיהיה מועדון אמיתי, ואחר כך לחבר אותו ל-`BenefitGrant` מאומת. לא לשבור את הדוח הקיים (`basket_discount_kind='club'`).
- ⚠ **להרחיב את `customers` או ליצור ישות נפרדת?** האפיון מבקש לא ליצור מקור מקביל, אבל `customers` הוא לקוח עסקי עם ח.פ. ייחודי. אפשרויות:
  - (א) להרחיב את `customers` (שדות טלפון מנורמל, `kind`) ולהוסיף `memberships` נפרד.
  - (ב) ישות `club_customers` נפרדת עם קישור.
  החלטה לבעלים או לארכיטקט.

**תלוי ב:**
- OTP (דרך 019 או מנגנון מקומי)
- NotificationService (קטגוריית authentication)
- route ציבורי ב-Next.js
- מנוע המבצעים או `basket_discount` (מימוש)
- סנכרון עסקאות (צבירה אחרי תשלום, היפוך בהחזר)

---

## 16. נתונים, API, אבטחה ודוחות (§30–37) — הערות רוחב

- **migrations:** חייבות להיות additive ו-idempotent (`has_table`). מזהי revision ייחודיים: לבדוק עם `grep` לפני שימוש. **אסור `alembic downgrade`**, כי סוכנים עובדים במקביל.
- **Room:** ל-`PosDatabase` ול-`kitchen.db` יש גרסאות נפרדות. מי שמגיע ראשון מעלה גרסה. לקרוא את הקובץ שוב לפני העלאה.
- **שגיאות מובנות** (code, user_message, retryable, correlation_id): אין תקן אחיד היום. מומלץ לקבע תקן במודולים החדשים.
- **tenant isolation:** קיים דפוס `tenant_id` + `S\services\scoping.py` / `access.py`.
- **feature flags לפי tenant וסניף (§35):** פרמטרי הקופה המדורגים משמשים כדגלים. לשרת בלבד אין מנגנון דגלים לפי tenant.

---

## 17. ריכוז התנגשויות — כולן מחכות להחלטת הבעלים

| # | נושא | היום | האפיון | הצעה |
|---|---|---|---|---|
| 1 | כפתורי תשלום | לחיצה אחת בכל מקום | §10: בחר ואשר בשולחן. §E: ישיר במהירה | לפי הקשר, או פרמטר `payScreenStyle` (סעיף 12) |
| 2 | קיצורי מזומן | שטרות 5–200 מצטברים | מדויק + עגולים דינמיים | שתי שורות |
| 3 | Grid במסופון | 4 עמודות (MEDIUM) | 2 עמודות | גודל אריח חדש = 2, בלי לשנות ברירת מחדל |
| 4 | אחרי שליחה למטבח | חוזר למפה | נשאר בשולחן | פרמטר `tablesStayAfterSend` |
| 5 | יציאה עם פריטים שלא נשלחו | שמירה שקטה | שאלה בשלוש אפשרויות | שאלה רק כשיש חדשים |
| 6 | מגבלת הערה | 120, חיתוך שקט ב-DishSheet | 250, בלי חיתוך שקט | להעלות + מונה בכל המקומות |
| 7 | ברירת מחדל במפה | "הכול" | "שלי" | פרמטר |
| 8 | החלפת מלצר | פתוחה לכולם | בהרשאה | הרשאה שמותרת כברירת מחדל |
| 9 | "קיוסק" | `kioskMode` = נעילת מכשיר | ערוץ הזמנה עצמית | שם פרמטר חדש |
| 10 | "שידור" | פרסום קטלוג | "שדר" = diff למטבח | לפצל מונחים |
| 11 | כפתור "מועדון" | % הנחה בלי אימות | הטבה לחבר מאומת | legacy עד מועדון אמיתי |
| 12 | `customers` | לקוח חשבונית | חבר מועדון | הרחבה או ישות נפרדת |
| 13 | יציאה ממשמרת עם שולחנות | חוסם (`preventClockOutWithOpenTables=true`) | אזהרה + העברת אחריות | לסוכן הנוכחות |
| 14 | מסך סיום תשלום | חוזר אחרי 2 שניות, גם עם עודף | "קבלה / חזרה לשולחנות" | לא לחזור אוטומטית כשיש עודף |
| 15 | פרופורציות בטאבלט | מוצרים כ-66–72% | 60–65% | ייתכן שנקבע ע״י הבעלים; לבדוק |
| 16 | תוויות | "הוסף ₪", "מלאי N" | "הוסף להזמנה • ₪", "נשארו 3" | שינוי טקסט |
| 17 | פרסום מפה | שמירה חלה מיד | preview + פרסום מפורש | אופציונלי, ברירת מחדל כמו היום |

---

## 18. תלויות בין סעיפים

```
workflow_mode + ערוץ + snapshot הזמנה + מספר איסוף   (בסיס)
   ├─► KDS (משימות, Expo, איסוף) ◄── מזהה dispatch יציב ◄── מסך שולחן (send)
   │      └─► ReadyForPickup ─► NotificationService ─► adapter019 ─► SMS "מוכן"
   ├─► קיוסק BON  (+ תור הדפסה ✅, + טיימר קיוסק, + בירור אשראי לא ידוע)
   ├─► קיוסק KDS  (+ KDS)
   ├─► הזמנה מהירה: מספר הזמנה, "שלח למטבח" לפני תשלום (payment_policy)
   ├─► טיימרים לכל מצב (שולחן / מהירה / קיוסק)
   └─► תחולת תפריטים לפי מצב (F)

NotificationService ─► OTP (קטגוריית auth) ─► דף הרשמה ─► Membership + Consent
   └─► Club: Points/Grants/Reservation ◄── עסקאות (צבירה אחרי תשלום, היפוך בהחזר)
   └─► קמפיינים ◄── Consent + Suppression

תפקיד מלצר + מטריצת הרשאות ─► "מסייע", העברת owner, גבייה
נוכחות שלב 1 ─► העברת אחריות בסוף משמרת ─► pool טיפים לפי שעות/משקל ─► ledger
מסך תשלום ─► מצב "תשלום בתהליך" במפה; פיצול לפי אורחים ◄── tableSeats
KDS + SMS ─► התראות בלוח הבקרה (H)
```

---

## 19. תוכנית בשלבים

**כללים לכל השלבים**
- כל פרמטר חדש נכנס עם ברירת מחדל שמשמרת את ההתנהגות של היום (כמו פרמטרי הנוכחות).
- migrations הן additive בלבד, בלי downgrade.
- דגלים לפי tenant/סניף, ו-rollout בפיילוט.
- לא נוגעים בקבצים שסוכן אחר עורך כרגע (סעיף 21).

### P0 — בסיס ובטיחות

| # | עבודה | קבצים עיקריים | מסלול |
|---|---|---|---|
| P0-1 | `workflow_mode`, ערוץ, `payment_policy`, `service_type` שנשמר, snapshot בהזמנה, מספר איסוף, טלפון הזמנה, preview אפקטיבי לפרמטרי קופה | `S\services\till_parameters.py`, מודל הזמנה/fulfillment חדש, `S\models\transaction.py` (עמודות additive), `A\domain\Workflow.kt` (חדש), `A\data\local\Entities.kt` + Room | **KDS/workflow** (בעבודה) |
| P0-2 | KDS: Dispatch עם מזהה יציב, Task, Expo, ReadyForPickup, מסך תחנה ומסך איסוף | מודלי `kds_*` חדשים, `A\ui\kds\*` (חדש), `A\hardware\kitchen\KitchenTickets.kt`, `A\data\repo\TablesRepository.kt` (`send` בלבד) | **KDS/workflow** (בעבודה) |
| P0-3 | NotificationService + outbox + adapter019 (test/live) + יומן ו-DLR + SMS "מוכן" | `S\models\notifications.py`, `S\services\notifications\*`, דפי `messages` בדשבורד (כולם חדשים) | **SMS/מועדון** (בעבודה) |
| P0-4 | דף הרשמה + OTP + consent + קישור לקוח | route ציבורי ב-`C\app\(public)\…`, `S\models\club.py`, `S\routers\club_public.py` (חדשים); החלטה לגבי `customers.py` | **SMS/מועדון** (בעבודה) |
| P0-5 | בטיחות אשראי: בירור תוצאה לא ידועה לפני ניסיון חוזר (אותו vuid או `getTransactionByVuid`), ושמירת `pendingTxId` / vuid מעבר למוות תהליך | `A\ui\checkout\CheckoutViewModel.kt`, `A\hardware\payment\*` | **תשלום** |
| P0-6 | מסך שולחן P0: שאלה ביציאה, sheet עם שינויים שלא נשמרו, גלילה לשגיאה, תוספת אזלה, הערה 250 + מונה, אפשרות 2 עמודות, הישארות בשולחן (לפי החלטה) | `A\ui\sell\TableOrderLayout.kt`, `MenuSheets.kt`, `MenuSheetState.kt`, `NoteWordBuilder.kt`, `A\domain\Menu.kt` (`MenuOption.available`), `A\ui\common\Adaptive.kt` | **מסך שולחן** |
| P0-7 | מסך תשלום לפי החלטת הבעלים (התנגשויות 1, 2, 14) | `A\ui\checkout\CheckoutScreen.kt`, `QuickCash.kt`, `S\services\till_parameters.py` (פרמטר) | **תשלום** (אחרי סוכן סדר אמצעי התשלום) |

### P1

| # | עבודה | תלוי ב- |
|---|---|---|
| P1-1 | קיוסק BON: מסך המתנה, קטלוג ללקוח, סל, תשלום מראש, בון ומספר, איפוס עם אזהרה | P0-1, P0-5, החלטת חומרה |
| P1-2 | קיוסק KDS | P1-1, P0-2 |
| P1-3 | מלצרים: תפקיד מלצר, מטריצת הרשאות ניתנת להגדרה (שינוי מחיר, גבייה, העברת owner), כותרת "מסייע", ברירת מחדל "שלי" כפרמטר, העברת אחריות בסוף משמרת | נוכחות שלב 1 |
| P1-4 | מפה: "תשלום בתהליך", badges לא-נשלח/כשל, חלונית פרטים בטאבלט, הערת שולחן, חיפוש מסנן, סוג אזור | P0-2 (badges), P0-7, סיום סוכן הוויזואל |
| P1-5 | הזמנה מהירה: מספר הזמנה, "שלח למטבח" לפני תשלום לפי `payment_policy`, פיצול לפי פריטים | P0-1 |
| P1-6 | טיימרים לכל מצב + אזהרה + חזרה למפה בלי ניתוק | P0-1 |
| P1-7 | מועדון: Points ledger, reservation, grants, אזור אישי, קמפיינים עם consent gating, reconciliation | P0-3, P0-4 |
| P1-8 | לוח בקרה: יום עסקי, שולחנות פתוחים, הנחות, קטגוריות, export, התראות KDS ו-SMS | P0-2, P0-3 (התראות) |
| P1-9 | טיפים: pool לפי שעות ומשקל + allocation ledger | נוכחות שלב 1 + Android |
| P1-10 | מסך שולחן P1: מנה, אורח, העתק בשורה; diff "הצג שינויים לפני שליחה" | P0-6, החלטת המונח |

### P2

- **ישות תפריט** (בוקר/ערב/HH) עם תוקף, עדיפות ומחיר לתפריט, ותחולה לפי מצב. כדאי להתחיל בתכנון בזמן P1. משפיע על התמחור, ולכן אחרון.
- **מנהל מטבח מתקדם:** ריכוז מנות, Hold/Fire לשורה, ספי זמן.
- **מועדון:** יום הולדת אוטומטי, פילוחים, ערוצים נוספים.
- **מפה:** preview לפי מסך + פרסום מפורש.
- **מסך שולחן:** מועדפים, אחרונים, המלצות.
- **כניסה בכרטיס.**
- **adapters חיצוניים** (Wolt/Cibus/10bis/ValueCard/KASHASH): רק אחרי תיעוד וחשבון בדיקה.

### מה אפשר להריץ במקביל בלי לגעת באותם קבצים

| מסלול | קבצים בבעלותו | אסור לו לגעת ב- |
|---|---|---|
| KDS/workflow | מודלים חדשים, `A\ui\kds\*`, `KitchenTickets.kt`, `TablesRepository.send`, `KitchenRouting.kt` | `CheckoutScreen.kt`, קבצי המפה |
| SMS/מועדון | `S\…\notifications*`, `club*`, route ציבורי ב-Next.js, דפי `messages` ו-`club` בדשבורד | קבצי הקופה (חוץ מחיבור מאוחר בקופה ל-P1-7) |
| תשלום | `CheckoutScreen.kt`, `CheckoutViewModel.kt`, `SplitTender.kt`, `QuickCash.kt`, `A\hardware\payment\*` | `TablesRepository.kt` |
| מסך שולחן | `TableOrderLayout.kt`, `MenuSheets.kt`, `MenuSheetState.kt`, `NoteWordBuilder.kt`, `TableMenuUi.kt` | `TablesRepository.send` (שייך ל-KDS) |
| לוח בקרה | `C\components\dashboard\control-board\*`, `S\services\overview.py` | — |
| מפה / מלצרים | `TableVisuals.kt`, `TablesScreen.kt`, `TablesViewModel.kt` (מסננים), `S\services\permissions.py` | עד שסוכן הלוגו והוויזואל מסיים |

**קבצים חמים** — כל עריכה בהם: הוספה בלבד, rebase לפני עריכה, ובדיקה שאין סוכן אחר באמצע:

| קובץ | מה צריך לשים לב |
|---|---|
| `S\services\till_parameters.py` | כולם מוסיפים פרמטרים |
| `S\routers\sync.py` | |
| `S\main.py`, `S\models\__init__.py` | |
| `A\data\local\PosDatabase.kt` | גרסת Room |
| `A\ui\nav\PosNavigation.kt` | |
| `C\messages\he.json`, `res\values\strings*.xml` | |
| alembic heads | |

**סדר שחובה לשמור**
1. P0-1 לפני P0-2 ולפני הקיוסק.
2. חוזה האירוע `ReadyForPickup` כבר נקבע ב-`D\SPEC_NOTIFICATIONS_CLUB.md` (`outbox_events`). KDS כותב אליו באותה טרנזקציה. מסלול ה-SMS עובד מול mock עד ש-KDS מוכן.
3. P0-7 נכנס רק אחרי שסוכן סדר אמצעי התשלום מסיים את `PayNowButtons` ו-`payOrder`.

---

## 20. החלטות פתוחות לבעלים (שלב 0, §35, ועוד)

| # | החלטה | הערה |
|---|---|---|
| 1 | **חשבון 019:** בעל החשבון (Runner מרכזי או חשבון לכל עסק), חיוב ותקציב | משפיע על `ProviderConfig` ועל בידוד ה-tokens |
| 2 | **שם שולח** (עד 11 תווים, אותיות אנגליות/ספרות) ואישורו בחשבון | |
| 3 | **שיטת OTP:** שירות ה-OTP של 019 או OTP מקומי בשרת | לא שני מקורות |
| 4 | **היקף המועדון:** tenant / חברה / סניף, ושיתוף בין סניפים | |
| 5 | **כללי צבירה ומימוש, תנאי מועדון, מדיניות פרטיות, נוסחי הסכמה, retention** | נוסחים משפטיים ע״י העסק |
| 6 | **האם Expo חובה** (ברירת מחדל ל-ReadyForPickup) | |
| 7 | **התנהגות מסך התשלום** | התנגשויות 1, 2, 14 |
| 8 | **חומרת קיוסק:** גודל מסך ואוריינטציה, מסוף (Nayax/Agamento, Z-Credit pinpad), מדפסת, מזומן (אין היום), device owner | |
| 9 | **איפה רץ ה-KDS:** מסך באפליקציה (offline דרך LAN) או web | |
| 10 | **`customers`:** הרחבה או ישות מועדון נפרדת | |
| 11 | **מונחים:** "שידור" (קטלוג) מול "שדר" / "שלח" (מטבח); שם הערוץ מול `kioskMode` | |
| 12 | **עתיד כפתור "מועדון"** (הנחה ידנית) | |
| 13 | **התנגשויות במסך השולחן:** 2 עמודות, הישארות אחרי שליחה, שאלת יציאה, 250 תווים, "שלי" כברירת מחדל | |
| 14 | **מספר איסוף:** היקף (סניף / עמדה / יום), מחזור, ותדירות איפוס | |
| 15 | **יום עסקי בלוח הבקרה:** כמו Insights (04:00) או קלנדרי | |
| 16 | **יציאה ממשמרת עם שולחנות:** חסימה או אזהרה | |
| 17 | **תוקף הודעת "מוכן"** (ברירת מחדל 10 דקות), והודעה חלקית | |
| 18 | **adapters חיצוניים:** מי מביא תיעוד וחשבונות בדיקה | |

---

## 21. בעבודה כרגע — לא לשכפל

| עבודה | עדות בקוד (ללא קומיט) |
|---|---|
| נוכחות שלב 1 | `S\models\attendance.py`, `routers\attendance.py`, `services\attendance.py`, `schemas\attendance.py`, migration `c4e6a8b0d2f4`, פרמטרי `attendance*` ב-`till_parameters.py`, `pos_user.employee_role_id`. חסרים קופה, דשבורד ו-`SPEC_ATTENDANCE.md` |
| התראות מוצר ומוצרים נלווים | `S\services\product_alerts.py`, `A\domain\ProductExtras.kt`, `ProductExtrasRepository.kt`, `C\components\dashboard\products\product-extras-sections.tsx`, `C\lib\productExtras.ts` |
| סדר אמצעי תשלום | `payOrder` / `PAY_ORDER_KEY` (`S\services\payment_options.py`), `C\app\dashboard\payment-methods`, `PayNowButtons` / `payButtonRows` |
| סוג עוסק | `D\SPEC_BUSINESS_TYPE.md`, `companies.dealer_type`, `A\domain\DealerType.kt` |
| לוגו במפה ונראות מקצועית | `A\ui\tables\SketchLogos.kt`, `TableVisuals.kt`, `MapDesigner.kt`, `FloorPreviews.kt`, `C\components\dashboard\tables\map-editor.tsx`, `tableSketch.ts`, `sketch_with_logo.json` |
| קופה עצמאית + Z חנות ב-LAN | `S\routers\sync.py`, `S\services\till_z.py` |
| מספור Z רציף ב-offline | `S\services\z_sequence.py`, `tests\test_offline_till_z.py` |
| KDS + `workflow_mode` (סוכן חדש) | P0-1, P0-2. לפי `SPEC_NOTIFICATIONS_CLUB.md`: `S\services\kds.py`, `kds_orders`, `kds_groups` (בבנייה) |
| SMS 019 + מועדון (סוכן חדש) | P0-3, P0-4. טיוטה `D\SPEC_NOTIFICATIONS_CLUB.md`: חוזה `outbox_events` (`S\models\outbox.py`, `S\services\outbox.emit_event`), אירועים `ReadyForPickup` / `ReadyRevoked` / `HandedOver` / `OrderCancelled`. **חוזה האירוע של P0-2 כבר נקבע שם**, ויש לתאם אליו |

**נוסף שנראה ללא קומיט:** התחלה ב-direct boot (`A\system\UnlockedStart.kt`, `A\data\sync\Scheduling.kt`, `PosApplication.kt`, `AndroidManifest.xml`) וצבע גופן (`textColor`, `A\ui\theme\Theme.kt`).
