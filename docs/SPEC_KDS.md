# KDS ותצורת עבודה לעמדה (`workflow_mode`) — P0

מקור: מסמך האפיון של הבעלים (06.10.2026) — "החלטה אחרונה וקובעת — תצורת עבודה לעמדה" §1–8, "סדר קריאה והכרעה", §A (החלטת BON/KDS), §G (חוסר פעילות), "חלק א — KDS" §4–12 וחלקי ה-KDS של §30–36.

קוד:
- שרת: `server/app/models/kds.py`, `server/app/services/kds.py` (המנוע), `kds_workflow.py` (תצורת העבודה), `kds_routing.py` (ניתוב), `kds_outbox.py` (צד הצרכן), `server/app/routers/kds.py`, `server/app/schemas/kds.py`, מיגרציה `e8a4c6b2d0f1_kds.py`.
- בדיקות: `server/tests/test_kds.py`, `server/tests/test_kds_workflow.py`.
- קופה (Android): `ui/kds/*`, `domain/Kds*.kt`, `res/values*/strings_kds.xml`.
- דשבורד: `/dashboard/workflow` (כרטיס "תצורת עבודה"), `/dashboard/kds` (מסכים, תחנות, תצוגה חיה).

---

## 1. החלטות

1. **השם הקובע הוא `workflow_mode`**: `DIRECT_SALE` (מכירה במקום) או `ORDER_PROCESS` (תהליך הזמנה). BON/KDS הם *פרופילים* (presets) בלבד, לא ההגדרה. "מכירה במקום" היא מכירה ישירה ולא "ישיבה במקום" — סוג השירות (`service_type`: `eat_in`/`take_away`) הוא ציר נפרד ואינו משנה את המצב.
2. **איפה ההגדרה נשמרת — פרמטרים לקופות** (לא שכבת ה-settings): כל שדה הוא פרמטר מובנה (`till_parameters`), נקבע ברמת חברה → סניף → נקודת מכירה → קופה, והרמה הספציפית ביותר גוברת. זו השכבה שכל קופה כבר מסנכרנת (`param.<key>`), עם הרשאות והתראות קיימות. הפרמטרים מסומנים `managedOn: "workflow"` ולכן לא מוצגים בדף הפרמטרים הכללי — רק בכרטיס "תצורת עבודה".
3. **כבוי כברירת מחדל**: `kdsEnabled=false` ⇒ התצורה האפקטיבית היא הישנה (DIRECT_SALE + מדפסת), מה שלא יהיה שמור בשאר השדות. הקופה לא קוראת לשום endpoint של KDS, ובוני המטבח מודפסים בדיוק כמו היום.
4. **`config_version`** = 12 תווי hash של התצורה המנורמלת. אותה תצורה ⇒ אותה גרסה. בהזמנה ננעלים בשחרור הראשון: `workflow_mode`, `config_version` והתצורה המלאה (`config_snapshot`). שינוי הגדרה חל על הזמנות חדשות בלבד; סבב נוסף של הזמנה קיימת רץ לפי ה-snapshot שלה.
5. **הסמכות לתצורה היא השרת**: בשחרור הראשון השרת מחשב את התצורה של הקופה בעצמו; הקופה רק מבקשת מצב (החלפה ע״י עובד), וזה מכובד רק כש-`workerCanSwitch` ושני המצבים מותרים (נרשם כ-`KitchenAction` מסוג `mode_switch`).
6. **DIRECT_SALE אינו מנהל הכנה**: עם מדפסת בלבד — שחרור רושם snapshot ולא יוצר שום משימה (`noTasks`). עם KDS — המשימות לצפייה בלבד (`targetKind=view`), לא חוסמות כלום ולעולם לא יוצרות אירוע מוכנות/SMS. אין הסקת מוכנות מהדפסה.
7. **ORDER_PROCESS תמיד מנהל lifecycle** (גם עם מדפסת בלבד — אז התהליך מנוהל במסך Expo/מנהל בקופה).
8. **קיוסק** (החלטה §A): `kiosk_fulfillment_mode` נגזר ואינו פרמטר נפרד — BON ⇔ `KIOSK+DIRECT_SALE+printer`, KDS ⇔ `KIOSK+ORDER_PROCESS+kds`. אחרי תשלום נוצרות משימות אוטומטית, בלי שלב "אישור הזמנה" ע״י עובד, ובלי שולחן פיקטיבי (`table_ref=null`, מקור `kiosk`). ממשק הקיוסק עצמו אינו חלק מעבודה זו (ראו §10).

### 1.1 השדות (פרמטר ← שדה)

| שדה | פרמטר | ברירת מחדל | משמעות |
|---|---|---|---|
| enabled | `kdsEnabled` | false | הפעלת התצורה |
| defaultMode | `workflowMode` | DIRECT_SALE | מצב ברירת מחדל |
| allowedModes | `workflowAllowedModes` | DIRECT_SALE | CSV של מצבים מותרים |
| workerCanSwitch | `workflowWorkerCanSwitch` | false | עובד מורשה מחליף מצב לפני שליחה/תשלום |
| targets | `workflowTargets` | printer | CSV: `printer`, `kds`, `kds_view`, `expo`, `pickup_screen` |
| paymentPolicy | `workflowPaymentPolicy` | AFTER_PAYMENT | הזמנה מהירה: שחרור אחרי/לפני תשלום |
| requireStartPreparation | `workflowRequireStart` | false | אי אפשר "מוכן" לפני "התחל" |
| requireExpo | `workflowRequireExpo` | false | "מוכן לאיסוף" רק מה-Expo |
| trackHandover | `workflowTrackHandover` | true | מוכן נשאר עד "נמסר" |
| readyNotification | `workflowReadyNotification` | false | אירוע מוכנות לשירות ההודעות (SMS) |
| printerFallback | `workflowPrinterFallback` | true | הדפסת גיבוי כשה-KDS לא זמין |
| source | `workflowSource` | POS | POS / HANDHELD / KIOSK |
| inactivityTable/Quick/Kiosk | `inactivity{Table,Quick,Kiosk}Seconds` | ריק (כבוי) | §G: 15–3600 שניות; `0` = כבוי ברמה זו (גובר על טיימר מרמה עליונה) |

### 1.2 פרופילים (§5)
`kiosk_bon`, `kiosk_kds`, `counter` (קופה בדלפק), `counter_prep` (קופה עם הכנה ואיסוף), `handheld_tables` (מסופון שולחנות). פרופיל הוא מילוי מהיר של השדות; הכרטיס מציג "פרופיל: …" כשהתצורה זהה לאחד מהם.

## 2. ולידציה (§7) — אכיפה בשרת

`kds_workflow.validate` רץ על התצורה האפקטיבית ברמה הנשמרת (ערכים חדשים + ירושה). שגיאה ⇒ `422 {"code":"workflow_invalid","errors":[…],"warnings":[…]}` ושום דבר לא נשמר. בנוסף `normalize` מיישם את אותם כללים בזמן ריצה (כפייה בטוחה) — כך שגם ערך שנכתב דרך ה-API הכללי של פרמטרים לא יגרום למנוע לפעול על צירוף לא חוקי.

| קוד | סוג | כלל |
|---|---|---|
| `ready_notification_requires_order_process` | שגיאה | READY SMS דורש ORDER_PROCESS |
| `ready_notification_requires_ready_source` | שגיאה | …ומקור מוכנות: `kds` או `expo` |
| `pickup_screen_requires_order_process` / `pickup_screen_requires_managed_state` | שגיאה | מסך איסוף דורש state מנוהל |
| `require_expo_requires_expo_target` | שגיאה | require_expo דורש Expo |
| `order_process_field_in_direct_sale` | שגיאה | requireStart/requireExpo בלי ORDER_PROCESS |
| `kiosk_releases_after_payment` | שגיאה | קיוסק משחרר רק אחרי תשלום |
| `default_mode_not_allowed`, `allowed_modes_empty`, `targets_empty`, `unknown_*`, `inactivity_out_of_range` | שגיאה | תקינות |
| `kds_target_without_device` | שגיאה (סניף/נקודה/קופה) | יעד הכנה חובה צריך מסך תחנה פעיל בסניף |
| `expo_target_without_device` | שגיאה עם requireExpo, אחרת אזהרה | |
| `pickup_screen_without_device` | אזהרה | אפשר מסך איסוף ציבורי בטוקן |
| `devices_checked_per_shop` | אזהרה (חברה) | ברמת חברה אין מכשירים; נבדק בכל סניף |
| `switch_needs_two_modes` | אזהרה | אין selector מיותר בעמדה עם מצב אחד |
| `kds_view_only_in_direct_sale` | אזהרה | KDS במכירה במקום = צפייה בלבד |
| `process_managed_at_till` | אזהרה | ORDER_PROCESS עם מדפסת בלבד |

כש-`enabled=false` נבדקות רק שגיאות פורמט.

## 3. מודל נתונים (`app/models/kds.py`)

תחנות: **שימוש חוזר** ב-`kitchen_stations` ו-`kitchen_station_targets` (מוצר/קטגוריה → תחנה) של מודול המדפסות — שיוך אחד משמש גם להדפסה וגם ל-KDS.

| טבלה | ישות | עיקר |
|---|---|---|
| `kds_devices` | KdsDevice | קופה כמסך: `role` = station / expo / pickup / manager, `station_ids`, ייחודי לפי `machine_id` |
| `kds_station_settings` | — | לכל סניף+תחנה: `target_kind` prep/view (יעד צפייה לא חוסם מוכנות), ספי כתום/אדום בדקות |
| `kds_route_overrides` | — | override לפי סניף / נקודת מכירה / סוג שירות (§6) |
| `kds_shop_state` | — | מונה שינויים לסניף (המסכים בודקים `since`), מספרי איסוף יומיים 1–999, טוקן אטום למסך האיסוף הציבורי |
| `kds_orders` | KitchenOrder | הזמנה שהשתחררה: מקור+`source_ref` (ייחודי לטננט), `display_ref`, `table_ref` (null בקיוסק/מהירה), `service_type`, `pickup_number`, `pickup_name`, `contact_phone` (snapshot; לא מוצג במסכים), **`workflow_mode`, `config_version`, `config_snapshot`**, `paid` (נפרד מהמטבח), `status`, `version` |
| `kds_dispatches` | KitchenDispatch | סבב: ה-id הוא מפתח ה-idempotency של הקופה; `round_no`, `trigger`, `fallback_printed`, `no_tasks`, payload (בלי טלפון) ו-result |
| `kds_tasks` | KitchenTask | פריט × תחנה × סבב: `ordered_qty`, `cancelled_qty`, `prepared_qty` (active = ordered − cancelled), `release_state` hold/released, `prep_state` queued/preparing/ready, snapshot של שם/תוספות/הסרות/הערות/אלרגיות/סועד/מנה, `fallback_printed`, `over_prepared`, `linked_task_id`+`remake_reason`, `version` |
| `kds_changes` | KitchenChange | ביטול / שינוי הערה / remake / override — `requires_ack`, `acked_at` |
| `kds_groups` | FulfillmentGroup | קבוצת הוצאה (P0: אחת להזמנה, `key="order"`): waiting → ready_for_pickup → handed_over / cancelled, `override_reason`, `version` |
| `kds_actions` | KitchenAction | כל פעולת מסך לפי מפתח idempotency, עם התוצאה (replay מחזיר אותה) |

אירועים: טבלת `outbox_events` המשותפת (`app/models/outbox.py`, של שירות ההודעות) — ראו §7.

## 4. כללי שחרור (§5)

| מקור | מתי | הערה |
|---|---|---|
| `table` | "שלח" של המלצר | תשלום מאוחר; סגירת חשבון לא מפנה הזמנה מהמטבח |
| `quick` | `AFTER_PAYMENT` (ברירת מחדל): רק עם `paid`/`trigger=payment`; `BEFORE_PAYMENT`: גם ב-"שלח למטבח" | בלי תשלום ⇒ `409 release_requires_payment` |
| `kiosk` | רק אחרי תשלום, תמיד | בלי אישור עובד; `table_ref=null` |
| `external` | אחרי אישור מנגנון ההתממשקות | API מוכן; אין מתממשק (P1) |

- טיוטה אינה משימה. PaymentAccepted, KitchenReceived ו-Ready הם עובדות נפרדות (`paid` ≠ מטבח קיבל ≠ מוכן).
- `trigger=cancel` מבטל את כל הכמות הפעילה. `trigger=payment` בלי פריטים רק מסמן `paid`.
- השחרור **idempotent**: אותו `id` שוב ⇒ אותה תוצאה (`replayed: true`), בלי משימה נוספת. אם בניסיון החוזר `fallbackPrinted=true` — הסבב מסומן לגיבוי (ראו §6.6).

## 5. ניתוב (§6)

`kds_routing.route` — הראשון שמתאים: override של המוצר (נקודה+שירות › נקודה › שירות › סניף) → תחנת המוצר → הקטגוריה ועליה בעץ (override ואז תחנה בכל רמה) → **לא מנותב**: נוצרת משימה בלי תחנה, מוצגת ב-Expo עם התראה ומדווחת ב-`unrouted` — לא נבלעת. עותק מקומי של מוצר בקופה מנותב כמוצר הגלובלי. שמות, תוספות, הסרות, הערות ואלרגיות נשמרים כ-snapshot בעת השחרור; שינוי קטלוג לא משנה הזמנות קיימות. ארוחה מגיעה מפורקת לרכיבים (מהקופה), כל רכיב לתחנה שלו — משימות מקושרות דרך `line_key` (`<line>:<component>`).

## 6. מצבים, כמויות וסבבים (§8–12)

1. **מצבים**: שחרור Hold/Released; הכנה Queued/Preparing/Ready; הוצאה (קבוצה) Waiting/ReadyForPickup/HandedOver. מצב תעבורה (Pending/Delivered/Failed) נשמר בקופה (תור durable).
2. **כמויות**: אי אפשר להכין מעבר ל-active, אלא ברישום מפורש "הוכן לפני ביטול" (`over_prepared` + change מסוג override). "מוכן" עם qty הוא תוספת (clamp), כך ששני מסכים לא מכפילים כמות.
3. **סבבים**: כל שליחה = dispatch עם `round_no`. תוספת לשורה = משימה חדשה בסבב החדש (2 מוכנים + 1 ⇒ משימה חדשה של 1 בלבד), בלי לאפס זמנים קודמים.
4. **ביטול**: יורד קודם מ-hold, אחר כך ממה שנותר להכין (הסבב החדש קודם), ורק אז ממה שהוכן (נרשם). נשאר על מסך התחנה עד "ראיתי". KDS לא מבצע החזר כספי.
5. **שינוי הערה**: במשימה שטרם התחילה — מתעדכן ומודגש; במשימה בהכנה/מוכנה — דורש "ראיתי". אישור צפייה אינו הכנה מחדש; "הכנה מחדש" (`remake`) יוצרת משימה מקושרת עם סיבה.
6. **גיבוי מדפסת (§12)**: כשהקופה לא מצליחה למסור שחרור ל-KDS בזמן קצוב והיעדים לא כוללים `printer` (KDS בלבד) ו-`printerFallback` פעיל — הקופה מדפיסה את הבון במדפסות הרגילות ומסמנת את השחרור הממתין `fallbackPrinted`. כשהוא מגיע, המשימות מסומנות "הודפס בגיבוי" ודורשות התאמה (`resolve_fallback`: "כבר הוכן" ⇒ מוכן, "להכין" ⇒ נשאר בתור) — לא שחרור כפול אוטומטי.
7. **Hold/Fire (§10)**: השורות המוחזקות בשולחן (מנה שלא הוצאה) נשלחות כ-`held` (הסט המלא) ⇒ משימות hold באזור נפרד, לא בתור ולא חוסמות מוכנות. כשהמלצר "מוציא" והשורה נשלחת, היא משחררת את משימות ה-hold במקום ליצור חדשות. הוצאת מנה מתבצעת בקופה בלבד ב-P0.
8. **Expo ומוכנות (§11)**: הקבוצה מוכנה כשכל המשימות הנדרשות (released, active>0, תחנת הכנה) מוכנות. תחנת צפייה ומנה מוחזקת לא חוסמות. בלי `requireExpo` — השירות המשותף (`_set_ready`) קובע ReadyForPickup אוטומטית; עם `requireExpo` — רק Expo/מנהל, ו-override לפני השלמה דורש סיבה ונרשם. מסך תחנה לא יכול לסמן "מוכן לאיסוף".
9. **מסירה**: "נמסר" מסיר את המספר ממסך האיסוף; "החזר" (`undo_pickup`) מחזיר אותו. בלי `trackHandover` — מספר מוכן יורד ממסך האיסוף אחרי 15 דקות.
10. **מספרי איסוף**: לכל סניף, מתאפסים כל יום עסקים (אזור הזמן של הטננט) ואחרי 999. הקופה רשאית לשלוח `pickupNumber` משלה.

## 7. אירועים — חוזה ה-Outbox (מול שירות ההודעות)

הכתיבה ב-**אותה טרנזקציה** של המעבר, לטבלה `outbox_events` (`app/models/outbox.py`).

| `event_type` | מתי | `dedupe_key` | aggregate |
|---|---|---|---|
| `ReadyForPickup` | מעבר הקבוצה ל-ready_for_pickup (ORDER_PROCESS בלבד) | `ReadyForPickup:<group_id>` — **אחד לקבוצה, לתמיד** | `fulfillment_group` / group id / group version |
| `ReadyRevoked` | undo אחרי שצרכן כבר לקח את ה-ReadyForPickup | `ReadyRevoked:<group>:<version>` | |
| `HandedOver` | מסירה אחרי שצרכן כבר לקח | `HandedOver:<group>:<version>` | |
| `OrderCancelled` | ביטול אחרי שצרכן כבר לקח | `OrderCancelled:<group>:<version>` | |

Payload של `ReadyForPickup` (מינימלי): `orderId, groupId, shopId, source, displayRef, pickupNumber, workflowMode, configVersion, readyAt, override, hasContact, notify` ו-`contactPhone` **רק** כש-`notify=true` (הצרכן ממסך אותו אחרי שלקח — `payload_redacted_at`). אין שם/הערות.

- **undo/ready לא משכפל**: undo לפני שצרכן לקח ⇒ השורה מסומנת `state=processed, result="suppressed:undo"`; ready מחדש ⇒ אותה שורה חוזרת ל-`pending`. אחרי שצרכן לקח ⇒ נכתב `ReadyRevoked`, ו-ready מחדש לא יוצר ReadyForPickup שני (ברירת מחדל: לא שולחים שוב — §15).
- **מסירה/ביטול לפני ה-worker**: ReadyForPickup שעוד `pending` ⇒ `result="suppressed:handed_over|cancelled"`.
- **על הצרכן** (שירות ההודעות): לפני כל ניסיון שליחה לקרוא ל-`kds_outbox.still_valid(db, event)` (הקבוצה עדיין מוכנה, ORDER_PROCESS, `readyNotification` ב-snapshot, יש טלפון) ולקרוא את הטלפון/שם האיסוף/שם הסניף דרך `kds_outbox.order_contact` — ה-snapshot של ההזמנה, לא כרטיס הלקוח. dedupe של ההודעה עצמה (tenant+group+OrderReady+recipient+channel) באחריות שירות ההודעות.
- DIRECT_SALE לעולם לא כותב ReadyForPickup; אירוע הדפסה לעולם לא מייצר מוכנות.

## 8. API

הקופה (`/api/v1/sync/{machine_id}/…`, טוקן הקופה):

| | |
|---|---|
| `GET kds/device` | `{device|null, workflow (מנורמל + configVersion + profile + steps), stationSettings, shopName}` |
| `GET workflow` | התצורה האפקטיבית של הקופה |
| `GET kds/board?since=<version>` | לוח המסך לפי התפקיד; `syncType: unchanged` כשאין שינוי. תחנה: רק משימות התחנות שלה (+ `otherStations`), Expo/מנהל: הכול, איסוף: `pickup {preparing, ready}` בלבד |
| `POST kds/release` | `KdsReleaseIn` — `id` (idempotency), `source`, `sourceRef`, `trigger`, `paid`, `workflowMode?`, כותרת (`displayRef, tableRef, zoneName, serviceType, guests, waiterName, pickupName, contactPhone, orderNote, pickupNumber, transactionNumber`), `items[]` (דלתא: + הוספה, − ביטול; `lineKey, productId, categoryId, name, quantity, mods, removals, notes, allergies, important, seat, course, mealName`), `held[]?`, `noteUpdates[]`, `fallbackPrinted` |
| `POST kds/actions` | `KdsActionIn` — `id` (idempotency), `type` ∈ `start, item_ready (qty), undo_ready, station_ready, ack_change, ready_for_pickup (override+reason), undo_pickup, handover, priority (reason), resolve_fallback (prepared/prepare), remake (reason)`, `expectedVersion?`, `occurredAt` |
| `GET kds/orders/status?source=table&refs=a,b` | תגים לקופה: מצב, משימות, מוכנות, בהכנה, מוחזקות |

שגיאות: `{"detail": {"code": …}}` — `release_requires_payment`, `order_of_another_shop`, `dispatch_id_taken`, `not_a_kds_device`, `task_of_another_station`, `pickup_screen_is_read_only`, `expo_or_manager_only`, `reason_required`, `version_conflict`. תוצאת פעולה: `outcome` = applied / noop / rejected (+`reason`).

הדשבורד (משתמש מחובר): `GET/PUT /workflow/config` (`scopeType, scopeId, values`), `POST /workflow/config/preview` (לא שומר), `GET /kds/shops/{shop}`, `PUT|DELETE /kds/shops/{shop}/devices/{machine}`, `PUT /kds/shops/{shop}/stations/{station}`, `POST /kds/shops/{shop}/overrides`, `DELETE …/overrides/{id}`, `POST /kds/shops/{shop}/pickup-token`, `GET /kds/shops/{shop}/board`. הרשאות: עריכת חברה — סופר/מפיץ/מנהל חברה בתחומו; סניף ומטה — מנהלי הסניף (כמו מדפסות).

ציבורי: `GET /public/kds/pickup/{token}` (JSON: `shopName, preparing[], ready[]` — מספרים בלבד) ו-`GET /public/kds/pickup/{token}/screen` (HTML מוכן ל-TV, RTL, כהה/בהיר, רענון כל 3 שניות, "אין חיבור — מוצג המידע האחרון"). הטוקן אטום (24 בתים), מוחלף מהדשבורד.

## 9. קופה (Android)

- **מצב מכשיר KDS**: קופה שמשויכת ב-`kds_devices` מציגה במקום מסך הכניסה את מסך התחנה / Expo / מסך האיסוף (`ui/kds/KdsRoot.kt`). כרטיסים לפי §7: כותרת (מספר/שולחן, מקור, סוג שירות, זמן, עדיפות), מלצר/שם איסוף, הערת הזמנה, שורות עם תוספות/הסרות/הערות/אלרגיות מודגשות, סבבים, שינויים וביטולים עד "ראיתי", "הודפס בגיבוי". כפתורים גדולים: התחל, פריט מוכן, הכול מוכן, ראיתי, ובמסך Expo: מוכן לאיסוף, נמסר, החזר. מציג תמיד סניף, תחנה, חיבור, זמן עדכון אחרון ומספר משימות. RTL, מצב כהה, טיימר במילים ובמספר.
- **שיוך מסך**: שיוך קופה כמסך בדשבורד קובע לה גם את הפרמטר `kdsScreen=true` (ברמת הקופה). רק קופה כזו שואלת את `GET kds/device` (כל 15–60 שניות); קופה רגילה לא מבצעת שום קריאה נוספת. השיוך נשמר מקומית, כך שמסך המטבח עולה גם בלי רשת. "חזרה לקופה" (לחיצה ארוכה) מחזירה למסך הכניסה עד הפעלה מחדש של האפליקציה.
- **שחרור**: כש-`kdsEnabled` — "שלח למטבח" בשולחן (`TablesRepository.send`) ותשלום שהושלם בהזמנה מהירה או בקיוסק (`CheckoutViewModel`, אחרי תשלום, `source=kiosk` כשזה תשלום קיוסק) שולחים שחרור דרך `KdsBridge`. גם DIRECT_SALE עם מדפסת בלבד שולח (השרת רושם snapshot בלי משימות). התור durable בקבצים (`filesDir/kds_outbox`), בסדר קפדני, כל פריט עם idempotency key, retry עם backoff+jitter; סירוב 4xx סופי ומדווח. פעולות המסך עוברות באותו תור ומוצגות מיד על הלוח (אופטימי) עד אישור — בלי להחיות ביטול.
- **מדפסת**: כשהתצורה כבויה או כשהיעדים כוללים `printer` — הדפסת הבונים לא משתנה בכלל. כש-KDS בלבד — הבון לא מודפס, אלא בגיבוי (§6.6): אם השחרור לא נמסר תוך 8 שניות, הקופה מסמנת אותו `fallbackPrinted` ומדפיסה (עם הפס "גיבוי KDS").
- **תג בשולחן**: בתוך שולחן פתוח (פס מתחת לכותרת) — "מטבח: 2/5 מוכנים · 1 בהכנה · 1 בהמתנה" / "מטבח: מוכן להגשה", רק כשיש מסך מטבח בתצורה.
- **מסך מנותק**: הלוח האחרון נשמר בקובץ ומוצג אחרי הפעלה מחדש; הכותרת מציגה "אין חיבור · מוצג המידע האחרון (שעה)" ומספר הפעולות שממתינות לשליחה.

## 10. תלויות ופערים (ביושר)

- **KDS מהשירות המקומי כשהענן נפול — P1.** שרת ה-LAN הקיים (`TablesLanHost` לשולחנות, שרת ההדפסות) אינו מריץ את מנוע ה-KDS; המנוע בענן בלבד. ב-P0: מסך KDS מנותק מציג את הנתונים האחרונים עם "אין חיבור · עודכן לפני X", פעולות נשמרות בתור ונשלחות בחזרה (בלי להחיות ביטולים), והקופה מדפיסה בגיבוי לפי §6.6. מימוש מקומי דורש העתקת המנוע לקופת ה-host וסנכרון דו-כיווני — לא בוצע.
- **שחרור לפני תשלום בהזמנה מהירה** — השרת תומך (`BEFORE_PAYMENT`); בקופה חסר כפתור "שלח למטבח" במסך ההזמנה המהירה (מסך של סוכן אחר). `KdsBridge.releaseQuick(...)` מוכן לחיבור.
- **קיוסק** — ממשק הקיוסק אינו חלק מעבודה זו. תשלום קיוסק שעובר דרך `CheckoutViewModel` (עם `KioskCheckoutTerms`) כבר משוחרר כ-`source=kiosk` אחרי התשלום. חסר: טלפון לקוח ושם איסוף מהקיוסק אל `contactPhone`/`pickupName` (נדרש להודעת SMS), והצגת מספר האיסוף שהשרת מקצה ללקוח במסך ההצלחה (התשובה מגיעה אסינכרונית מהתור).
- **החלפת מצב ע״י עובד בקופה** — השרת מכבד ומתעד; selector בממשק המכירה — P1.
- **טיוטה פתוחה בזמן שינוי תצורה** (החלטה מפורשת אם להחיל) — P1; כיום טיוטה שטרם שוחררה פשוט משתחררת לפי התצורה בזמן השחרור.
- **חוסר פעילות (§G)** — הפרמטרים, הוולידציה והפונקציה הטהורה בקופה (`KdsWorkflow.inactivityAction`) קיימים; החיבור למסכי שולחן/מהירה/קיוסק (של סוכנים אחרים) — P1.
- **SMS** — באחריות שירות ההודעות (צרכן ה-outbox).
- **Realtime** — המסכים מושכים כל 3 שניות עם `since`; דחיפה ב-Ably — P1.

## 11. P1 / P2

- P1: KDS מקומי ב-LAN; מנהל מטבח: העברת משימה בין תחנות (תיעוד יעד קודם/חדש), עדיפות עם PIN מנהל; מוצר שדורש כמה תחנות (משימות מקושרות מרובות); קבוצות הוצאה לפי מנה/אריזה; Fire מה-Expo; דחיפת realtime; מסך תחנה "מוכן אחרון" עם undo מורחב; dashboard התראות KDS; selector מצב בקופה; טיוטה מול תצורה חדשה; חיבור inactivity.
- P2: ריכוז מנות (aggregation) עם סימון למשימות מפורשות; מדדים ודוחות (המתנה/הכנה/מסירה, backlog, stale stations); ספי זמן לפי מוצר; מנהל מטבח מתקדם.

## 12. בדיקות

`tests/test_kds.py` (46), `tests/test_kds_workflow.py` (29) ו-`tests/test_kds_http.py` (2 — חוזה ה-JSON מול הקופה); בקופה `KdsDomainTest` (תצורה, payload, לוח, פעולות ממתינות, תג):
- §36.1 retry לא משכפל משימה; פעולה חוזרת מוחלת פעם אחת; שני מסכים לא מכפילים; סניף אחר מבודד.
- §36.2 מוכנות תחנה אחת אינה מוכנות ההזמנה; Expo נדרש; override עם סיבה.
- §36.3 undo ואז ready — אותו אירוע; אחרי שצרכן לקח — ReadyRevoked ולא ReadyForPickup שני.
- §36.4 מסירה/ביטול לפני ה-worker משתיקים את האירוע.
- §36.8 פעולה offline לא מחיה ביטול; "הוכן לפני ביטול" נרשם.
- §36.21 התאמת מדפסת גיבוי.
- החלטה §8: שינוי עמדה לא משנה הזמנות ישנות; DIRECT_SALE לא מבקש הכנה ולא שולח SMS; קיוסק נפתח אוטומטית אחרי תשלום; PRINTER+KDS לא מכפיל; שינוי סוג שירות לא משנה מצב; לקוח קיוסק חדש לא מוחק משימות קודמות.
