# שירות הודעות (019 SMS) ומועדון לקוחות — P0

מסמך יישום ל"חלק ב — שירות הודעות ו-019" (§13–20), "חלק ג — מועדון לקוחות" (§21–29) והחלקים
המתאימים ב-§30–37 של מסמך האפיון המאוחד (06.10.2026).

> **שורה תחתונה:** הכול עובד מקצה לקצה במצב **mock** (ספק מדומה בתוך התהליך, בלי רשת). לא
> נשלח אף SMS אמיתי, לא נקרא ה-endpoint החי של 019, ולא נקרא גם `/api/test` (אין token בדיקה
> מוגדר). מה שלא אומת מול 019 מפורט ב-§8 ו-§11.

---

## 1. היקף P0 (לפי §35)

| נושא | מצב |
|---|---|
| NotificationService משותף, קטגוריות service / authentication / marketing / internal_operations | ✅ |
| תור durable + worker: lease, TTL, retries עם backoff+jitter, עדיפויות, dedupe, מצבי §16 | ✅ |
| `adapter019` — mock / test / live עם שערים; DLR polling לפי התיעוד | ✅ (live/test לא נבדקו מול 019) |
| הודעת "הזמנה מוכנה" מאירוע `ReadyForPickup` של KDS (outbox) | ✅ |
| סטטוס קצר ל-KDS/Expo | ✅ (API; התצוגה במסכי KDS — של סוכן ה-KDS) |
| לוח בקרה "הודעות": יומן, תבניות + preview, הגדרות ספק, pause/resume, קמפיינים (שלד, שליחה חסומה) | ✅ |
| מועדון: Customer / Membership / ConsentEvent / Suppression / OtpChallenge / LandingPageConfig | ✅ |
| דף הרשמה ציבורי `/join/{token}` + OTP מקומי + רישום אטומי + הטבת הרשמה אחת | ✅ |
| זיהוי חבר בקופה (טלפון / QR) ושמירת customer + membership על המכירה | ✅ |
| נקודות, מימוש, שריונים, אזור אישי, קמפיינים פעילים | P1 (מודלים בלבד לנקודות/שריונים) |

---

## 2. החלטות

1. **שכבה אחת לשליחה.** שום קוד עסקי (KDS, מועדון) לא קורא לספק. כולם מכניסים הודעה לתור דרך
   `app/services/notifications/service.py::enqueue`; ה-worker בלבד מדבר עם `adapter019`. ה-DB של
   Runner הוא מקור האמת ללקוחות, הסכמות, אירועים והיסטוריה — לא רשימות אנשי קשר אצל 019.
2. **mock כברירת מחדל, live רק במפורש.** חשבון ספק חדש נוצר במצב `mock`. שליחה חיה מחייבת **את כל**
   התנאים: (א) מתג שרת `NOTIFICATIONS_LIVE_SENDING_ENABLED=true` (כבוי כברירת מחדל); (ב) `mode=live`
   בחשבון — רק super admin יכול לבחור; (ג) כל עוד `live_restricted_to_test_numbers` דלוק (ברירת
   מחדל) — נשלח **רק** למספרים ברשימת `test_numbers` המאושרת (smoke). כיבויו — פעולה נפרדת של super
   admin. `HttpTransport` עצמו מסרב לכל URL שאינו שני ה-URL המתועדים, ול-URL החי בלי הדגל.
3. **Secrets.** ה-token של 019 נשמר במנגנון הקיים `payment_integration_secrets` (מפתח
   `sms019Token`, Fernet, מפתח `PAYMENT_SECRETS_KEY` או נגזר מ-`JWT_SECRET_KEY`), בשכבה של החשבון
   (company / tenant). כתיבה בלבד מהדשבורד ("••••" משאיר, "" מוחק); הדשבורד רואה רק "מוגדר/לא מוגדר"
   ותאריך. לא בדפדפן, לא בקופה, לא ב-KDS, לא ב-QR, לא בלוגים (נוספו מפתחות ל-redaction של גופי בקשות:
   `token`, `otp`, `registrationToken`, `clientSession`, `memberToken`, `phone`, `recipient`,
   `testNumbers`, וקוד מספרי בשדה `code`).
4. **OTP מנוהל מקומית** (§24) ולא שירות ה-OTP של 019: התגובה המתועדת של `send_otp` מחזירה את הקוד
   עצמו לשרת (`"code": "494036"`), וממילא אסור שני מקורות אימות. הקוד נשלח כ-SMS רגיל בקטגוריה
   authentication (עדיפות 0) דרך אותו תור.
5. **`ClubCustomer` נפרד מ-`customers`.** `customers` הם לקוחות חשבונית (שם, ח.פ., כתובת) ומסונכרנים
   **במלואם** לכל קופה בדייר. חבר מועדון הוא אדם פרטי לפי טלפון; סנכרון כל הטלפונים לכל קופה מפר את
   עקרון צמצום המידע (§26/§32). הקופה **מחפשת** חבר — לא מחזיקה את הרשימה. `tax_customer_id` מאפשר
   קישור עתידי.
6. **היקף מועדון = חברה.** מועדון אחד לחברה (`club_programs.company_id` ייחודי), משרת את סניפי החברה
   ואת סניפי חברות-הבת (החברה הקרובה במעלה העץ שיש לה מועדון פעיל). טלפון ייחודי בתוך החברה, לא בכל
   המערכת. אין שיתוף בין דיירים/חברות.
7. **טלפונים.** פנימית E.164 (`+972501234567`), מוצפן במנוחה + hash מפתחי (HMAC-SHA256) להשוואה +
   צורה ממוסכת (`050-•••-4567`) לתצוגה. ההמרה ל-019 (`05XXXXXXXX`) רק ב-adapter. "‎+972 050…" מטופל
   (מסירים את ה-0 שאחרי קידומת המדינה, לא "מוחקים ‎+972 בפשטות"). P0 שולח רק לניידים ישראליים.
8. **DLR ב-polling** (reports.html). ה-Push של 019 נשלח כ-form-urlencoded **בלי חתימה** — לא משתמשים
   בו בלי מנגנון אימות (§14).
9. **תוצאה לא ידועה לא נשלחת שוב אוטומטית.** timeout אחרי שליחה, 5xx, או קריסה בין הקריאה לשמירת
   התוצאה → `unknown_outcome` → בירור לפי ה-external id בדוחות. לא נמצא דוח תוך 30 דקות → נשאר
   `unknown_outcome` להחלטת מפעיל (שליחה חוזרת ידנית מורשית).
10. **ה-worker** רץ כ-thread בתהליך ה-API (`NOTIFICATIONS_WORKER_ENABLED`, ברירת מחדל דלוק), כל 2
    שניות; DLR כל ~60 שניות. בטוח לכמה תהליכים במקביל (`FOR UPDATE SKIP LOCKED` + lease).

---

## 3. חוזה OutboxEvent (KDS → שירות ההודעות)

טבלה `outbox_events` (`app/models/outbox.py`). נכתבת **באותה טרנזקציה** של המעבר העסקי
(app/services/kds.py `_set_ready` / `_suppress`), או דרך `app/services/outbox.emit_event` (אידמפוטנטי
לפי `dedupe_key`). הצרכן: `app/services/notifications/outbox.py` + `order_ready.py`.

| שדה | ערך |
|---|---|
| `event_type` | `ReadyForPickup` · `ReadyRevoked` · `HandedOver` · `OrderCancelled` |
| `aggregate_type` / `aggregate_id` | `fulfillment_group` / `kds_groups.id` — זהה בארבעת האירועים |
| `aggregate_version` | גרסת הקבוצה אחרי המעבר |
| `payload.orderId` | `kds_orders.id` |
| `payload.pickupNumber` | מספר האיסוף (או `displayRef`) |
| `payload.workflowMode` | `DIRECT_SALE` → **לעולם** לא נשלח SMS (§2, §8) |
| `payload.notify` | `false` → לא נשלח (העמדה לא ביקשה הודעת מוכנות) |
| `payload.partial` | `true` → לא נשלח (אין נוסח חלקי ב-P0) |
| `payload.contactPhone` (או `payload.contact.phone`) | צילום טלפון הקשר של ההזמנה — לא חברות ולא הסכמה שיווקית. מוסתר במקום אחרי הקריאה (`payload_redacted_at`) |
| `payload.contact.firstName` | רשות; אחרת המילה הראשונה של `kds_orders.pickup_name` |

כללי הצרכן: חשבון ספק קיים ו-`OrderReady` מופעל; מפתח dedupe
`tenant:group:OrderReady:hash(recipient):sms`; TTL מרגע המוכנות (`order_ready_ttl_minutes`, ברירת
מחדל 10); `ReadyRevoked/HandedOver/OrderCancelled` מבטלים הודעה שטרם נשלחה, ואם כבר נשלחה —
`result` מכיל `already_sent:N` (התראת צוות; SMS אי אפשר "לבטל"). **לפני כל ניסיון** ה-worker בודק
את `kds_groups.state` (סמכותי): רק `ready_for_pickup` נשלח; אחרת `cancelled` עם הסיבה.

ידוע: KDS מוציא `ReadyForPickup` אחד לקבוצה. undo **אחרי** שהאירוע נקרא ו-ready מחדש לא מייצר אירוע
חדש — ההודעה (אם טרם נשלחה) נשארת מבוטלת. זה שמרני (אין כפילות), אבל ייתכן שלקוח לא יקבל הודעה
במקרה הקצה הזה. הצרכן כבר תומך ב-"revive" אם KDS יוציא `ReadyForPickup` נוסף עם גרסה חדשה.

---

## 4. מודל נתונים (migration `a9d3f7c1e5b8_notifications_club`, additive + idempotent)

**הודעות** (`app/models/notifications.py`):
- `notification_provider_configs` — חשבון לחברה (`scope_key` = company id או `tenant`): provider,
  mode, `account_username`, `sender` (≤11), `brand_name`, `paused`, `rate_per_minute`, `daily_quota`,
  `alert_threshold`, `test_numbers`, `live_restricted_to_test_numbers`, `enabled_events`,
  `order_ready_ttl_minutes`, `dlr_polling_enabled`, `last_alert`. חשבון נורש מחברת-אם ואז מהדייר.
- `notification_templates` — tenant/company, category, channel, language, event_type, version,
  status (draft → approved → active → archived), body, fallback_body, allowed_variables.
- `notifications` — התור: category, event_type, `aggregate_ref`, נמען מוצפן + hash + ממוסך,
  template key/version, `body_snapshot` (סודות ממוסכים), טקסט מלא מוצפן רק כשיש סוד (נמחק בסיום),
  `dedupe_key` (unique per tenant), priority, state, `not_before`, `expires_at`, lease, ניסיונות,
  `provider_ref` (shipment_id), `provider_external_id`, resend_of/reason/created_by.
- `notification_attempts` — נרשם **לפני** הקריאה לספק ונסגר אחריה: sequence, correlation id, mode,
  outcome, error class, קוד/הודעת ספק מסוננים. בלי token ובלי מספר.
- `notification_delivery_events` — DLR גולמי מסונן (בלי טלפון), mapped state, `applied`, dedupe.
- `notification_campaigns`, `notification_campaign_recipients` — **שלד P1**.

**Outbox**: `outbox_events` (§3).

**מועדון** (`app/models/club.py`): `club_programs`, `club_document_versions` (terms / privacy /
marketing_sms / marketing_email — גרסאות), `club_landing_pages`, `club_source_tokens` (token אטום
ל-QR), `club_customers`, `club_memberships` (סטטוס, מספר חבר, `qr_token`, `unsubscribe_token`),
`club_consent_events` (append-only, עם גרסה ונוסח שהוצג), `club_suppressions`,
`club_otp_challenges`, `club_benefit_grants` (unique key), `club_sale_links` (customer + membership
על מסמך), `club_audit_events`, ו-P1 בלבד: `club_points_ledger`, `club_redemption_reservations`.

---

## 5. מכונת מצבים ותור (§15–16)

מצבים: `queued → processing → provider_accepted → delivered`, וגם `failed_retryable`,
`failed_permanent`, `unknown_outcome`, `suppressed`, `expired`, `cancelled`. **Accepted אינו
Delivered**; DLR אינו הוכחת קריאה.

- עדיפויות: authentication 0, service 10, internal 50, marketing 100 — ה-claim ממיין לפי עדיפות, כך
  שקמפיין לא חוסם OTP/מוכן.
- ניסיונות מקסימליים: authentication 3, service 5, marketing 3. backoff:
  `min(15min, 30s·2^(n-1))` עם jitter מלא בטווח [½, 1]. retry רק כשבטוח שהבקשה לא נקלטה (כשל
  התחברות, 429, קודי 019 4/5/6/12).
- בדיקות לפני כל ניסיון: TTL, pause, תוקף עסקי (KDS), suppression, שערי live/רשימת בדיקה, קצב לדקה,
  מכסה יומית (24 שעות מתגלגלות; פתוח: יום מקומי).
- token נדחה (019 3/10/11, HTTP 401/403) → circuit breaker: החשבון עובר ל-paused + `last_alert`.
- DLR מונוטוני: דוח כפול נשמר פעם אחת; דוח ישן/סותר אחרי מצב סופי לא משנה כלום.

---

## 6. ממשקי API

לוח בקרה (`app/routers/notifications.py`): `GET /notifications/log|overview|{id}|templates|provider|
campaigns|order-status`, `POST /notifications/{id}/resend|cancel|reveal-recipient`,
`POST/PATCH /notifications/templates…`, `POST /notifications/templates/{id}/approve|activate|archive`,
`POST /notifications/templates/preview|test-send`, `PUT /notifications/provider`,
`POST /notifications/provider/pause|resume`, `POST /notifications/campaigns` (טיוטה בלבד; כל פעולה
אחרת → 409 `campaigns_disabled`). dev: `GET /notifications/mock-inbox` (super admin + 
`NOTIFICATIONS_MOCK_INBOX=true`), `POST /notifications/worker/run-once` (super admin).

מועדון (`app/routers/club.py`): `GET/PUT /club`, `PUT /club/landing`, `POST /club/documents`,
`POST /club/documents/{id}/publish`, `POST /club/sources`, `POST /club/sources/{id}/deactivate`,
`GET /club/members`, `GET /club/members/{id}`, `POST /club/members/{id}/reveal-phone|status`.

קופה (machine JWT): `GET /sync/{machine_id}/club/lookup?phone=|qr=` (שם פרטי, אות ראשונה של משפחה,
סטטוס, מספר חבר, הטבות זמינות; בלי טלפון; כל חיפוש מתועד), `GET /sync/{machine_id}/notifications/
order-status?refs=`. בדחיפת מסמך: שדה רשות `clubMembershipId` → `club_sale_links`.

ציבורי (בלי התחברות, throttling, הכול לפי token אטום): `GET /public/club/{token}`,
`POST /public/club/{token}/otp/start|otp/resend|otp/verify|register`,
`GET|POST /public/club/unsubscribe/{token}`.

שגיאות: `{"detail": {"code", "userMessage", "retryable", "correlationId", …}}` — בלי stacktrace.

**הקופה (pos-android):** כפתור "חבר מועדון" במסך המכירה פותח `InWindowFormSheet` עם טלפון (מקלדת
מספרים) ושדה קוד חבר (קלט סורק חומרה; קישור סרוק מצומצם ל-token). אונליין בלבד; התוצאה: שם + אות
משפחה, סטטוס, מספר חבר, הטבות לקריאה בלבד ו"מימוש הטבות אינו זמין בשלב זה". "שייך לעסקה" מוסיף chip
לסל; המזהה נשמר בעמודה חדשה `transactions.clubMembershipId` (Room 27→28) ונשלח כ-`clubMembershipId`
רק כשהוא UUID תקין. חבר מושעה/סגור מוצג אך לא משויך. אין סריקת מצלמה, אין הדפסה על הקבלה, ואין שמירה
בעסקאות מוחזקות/שולחנות (P1).

**לוח הבקרה:** `/dashboard/notifications` ("הודעות": יומן · תבניות · הגדרות ספק · קמפיינים P1) ו-
`/dashboard/club` ("מועדון לקוחות": הגדרות · דף נחיתה · מסמכים · מקורות QR · חברים).

**דף ההרשמה:** `/join/{token}` בלוח הבקרה (Next.js, ציבורי), ו-`/join/unsubscribe/{token}`. כתובת
ה-QR: `CLUB_JOIN_BASE_URL/{token}` (ברירת מחדל `PAIRING_MOBILE_APP_BASE_URL/join`).

---

## 7. OTP והרשמה (§23–25)

- קוד 6 ספרות מ-`secrets` (CSPRNG); נשמר רק HMAC(server key, challenge id + code). תוקף 5 דקות, 5
  ניסיונות (נספרים ב-`UPDATE … WHERE attempts < max_attempts` — מקביליות לא עוברת את התקרה), resend
  אחרי 60 שניות ועד 3 קודים; resend מנפיק קוד חדש ולא מאפס ניסיונות.
- קשור ל-purpose, מועדון, hash טלפון ו-`clientSession` (hash). challenge חדש באותו session (החלפת
  טלפון) או לאותו טלפון — מבטל את הקודמים. אימות חד-פעמי (pending → verified מותנה) → registration
  token חד-פעמי (15 דקות).
- Throttling בשרת (DB): טלפון 5/שעה ו-10/יום, session 5/שעה, IP 20/שעה, מועדון 300/שעה + rate limit
  בזיכרון לכל endpoint. CAPTCHA — לא ב-P0 (פתוח).
- התגובה הציבורית זהה לחבר ולמי שאינו חבר — לא חושפת חברות לפני אימות.
- רישום: הטופס נבדק **לפני** שה-challenge נצרך; הטלפון נלקח מה-challenge (לא מהדפדפן); customer +
  membership get-or-create על unique keys; consent events עם גרסה ונוסח; הסכמה קיימת לא משתנה בלי
  בחירה מפורשת (תיבה ריקה בהרשמה חוזרת לא מבטלת opt-in; תיבה מסומנת = opt-in חדש ומסירה
  suppression מסוג unsubscribe); הטבת הרשמה אחת לפי `signup:<club>:<customer>`.
- אין תיבה מסומנת מראש; אישור תנאים נפרד מהסכמה שיווקית; אפשר להצטרף בלי שיווק; הטבות מוצגות רק
  כפי שהעסק הגדיר (ריק = לא מוצג דבר).

---

## 8. החוזה של 019 — כפי שאומת מהתיעוד (לא מול השרת)

מקורות שנקראו (06.10.2026): docs.019sms.co.il/sms/, /sms/send-sms.html, /sms/reports.html,
/sms/errors-and-status.html, /sms/push-api.html, /otp/sms-otp.html, /guide/.

| נושא | מהתיעוד | מימוש |
|---|---|---|
| Endpoint | `POST https://019sms.co.il/api`; בדיקות `https://019sms.co.il/api/test` ("won't submit the actions") | `PROD_URL` / `TEST_URL` בלבד |
| פורמט | JSON או XML; התגובה באותו פורמט | JSON |
| הזדהות | API token; בדף ה-guide: `Content-Type: application/json`, `Authorization: Bearer <token>` | Bearer header. **TODO(019):** בתיעוד ה-header מוצג במפורש רק לקריאת יצירת token — לאמת ב-`/api/test` שגם `sms`/`dlr` מקבלים אותו |
| שליחה | `{"sms":{"user":{"username"},"source","destinations":{"phone":[{"$":{"id"},"_":"05…"}]},"message"}}` | זהה; `id` = external id לכל ניסיון |
| source | עד 11 תווים, אותיות אנגליות/ספרות, בלי "+" | נבדק בשמירה ובשליחה |
| message | עד 1005 תווים | נבדק ברינדור |
| טלפון | `5xxxxxxxx` או `05xxxxxxxx` | `05XXXXXXXX`; ניידים ישראליים בלבד |
| תגובה | `{"status":0,"message":"SMS will be sent","shipment_id":"…"}` | status 0 → provider_accepted |
| קודי שגיאה | 3/10/11 token; 4/12 קרדיט; 5 שעה; 6 כשל; 8 כל המספרים חסומים; 515 source לא מאומת; 715 חסום זמנית; 998/999 לא ידוע | 3/10/11→נדחה+התראה+pause; 4/12/5/6→retry; 8/715→suppressed; 515→נדחה+התראה; 998/999→unknown; אחר→נדחה |
| DLR | `{"dlr":{"user":{"username"},"transactions":{"external_id":[…]},"from","to"}}`, `dd/mm/yy hh:mm`, טווח ≤ שבוע, ≤1000 ids | זהה; polling 1–60 דק' עד 48 שעות |
| סטטוסי DLR | 0/102 הגיע; ‎-1 נשלח ללא אישור; 2 timeout; 17 חסום פרסומי; 201 נחסם לפי בקשה; 15 כשר; 1,3–7,14,16,18,101,103–132,747,998,999 כשל | 0/102→delivered; ‎-1/2→ללא שינוי; 17/201→suppressed (+חסימת ספק); השאר→failed_permanent |
| Push DLR | form-urlencoded, ללא חתימה מתועדת | לא בשימוש |
| OTP של 019 | `send_otp` מחזיר את הקוד בתגובה | לא בשימוש (OTP מקומי) |

**מה לא אומת בכלל מול 019:** שהשליחה ב-`/api/test` מתקבלת עם ה-header; מה `/api/test` מחזיר לבקשת
`dlr`; אזור הזמן של התאריכים (הנחה: Asia/Jerusalem); אישור ה-sender בחשבון; הרשאות ה-token; מגבלות
קצב; מחירים וספירת segments בעברית (התצוגה היא הערכה GSM-7/UCS-2 בלבד, בלי מחיר); idempotency בצד
019 (dedupe מקומי אינו exactly-once); מספרים זרים (`includes_international`); API יתרה (לא ממומש —
"יתרה לא ידועה").

---

## 9. הרשאות

| פעולה | super admin | distributor | company manager | shop manager |
|---|---|---|---|---|
| יומן הודעות, סטטוס, preview | ✓ | ✓ | החברות שלו | הסניף שלו |
| שליחה חוזרת / ביטול ממתינה (סיבה) | ✓ | ✓ | ✓ | הסניף שלו |
| חשיפת מספר מלא (סיבה, audit) | ✓ | ✓ | ✓ | ✗ |
| תבניות (עריכה, אישור, הפעלה) | ✓ | ✓ | ✓ | ✗ |
| הגדרות ספק, token, pause | ✓ | ✓ | ✓ | ✗ |
| mode=live / כיבוי "רק למספרי בדיקה" | ✓ | ✗ | ✗ | ✗ |
| מועדון: הגדרות, מסמכים, QR, חברים | ✓ | ✓ | ✓ | ✗ |
| חיפוש חבר בקופה | קופה מצומדת (machine token), מתועד | | | |

פיצול עורך/מאשר תבניות וקמפיינים — פתוח (§33).

---

## 10. בדיקות (§36) — `tests/test_notifications_sms.py`, `tests/test_club_signup.py`

| # | מכוסה ב- |
|---|---|
| 3 | `test_same_ready_twice_and_undo_then_ready_again_send_once`, `test_undo_before_sending_cancels_and_ready_again_revives_once`, `test_authorised_resend_is_a_new_explicit_message_with_reason_and_rate_limit` |
| 4 | `test_handover_or_cancel_before_the_worker_suppresses_the_message`, `test_the_worker_rechecks_the_kds_group_before_sending` |
| 5 | `test_timeout_after_send_is_unknown_and_reconciled_not_resent`, `test_crash_between_call_and_result_goes_to_reconciliation` |
| 6 | `test_duplicate_and_late_dlrs_never_move_a_delivered_message_back`, `test_ready_for_pickup_queues_one_service_sms_with_the_spec_text` |
| 7 | `test_ttl_expires_an_old_message`, `test_marketing_never_blocks_otp_or_ready` |
| 9 | `test_the_token_is_stored_encrypted_and_never_read_back`, `test_request_logs_redact_token_code_and_phone`, `test_attempts_and_events_hold_no_secret_and_no_number`, `test_provider_accounts_never_cross_tenants`, `test_short_status_is_per_tenant`, `test_dashboard_log_scope_keeps_other_companies_out`, `test_live_endpoint_cannot_be_reached_without_the_switch` |
| 10 | `test_code_expires_after_five_minutes`, `test_server_throttles_per_phone`, `test_brute_force_locks_after_five_attempts_even_for_the_right_code`, `test_a_verified_code_cannot_be_replayed`, `test_phone_swap_kills_the_previous_challenge`, `test_attempts_are_counted_atomically_in_the_database`, `test_another_session_cannot_use_the_challenge` |
| 11 | `test_two_signups_same_phone_one_membership_one_benefit` |
| 12 | `test_joining_without_marketing_works_and_reregistering_never_flips_consent`, `test_no_marketing_member_can_still_get_order_ready`, `test_suppression_blocks_marketing_but_not_service` |
| 19 | `test_public_api_errors_are_structured_and_never_reveal_membership`, `test_public_page_resolves_only_from_an_active_published_token`, `test_no_benefits_are_invented` (צד שרת; הנגישות/RTL — בדף עצמו) |
| 20 | `test_order_contact_snapshot_reaches_only_its_own_order` |

ועוד: פורמט 019 (`test_send_body_is_the_documented_schema…`, `test_dlr_body…`), מיפוי קודים, שערי live
ורשימת בדיקה, pause, rate limit, circuit breaker, תבניות, lookup בקופה, קישור מכירה, הסרה מדיוור.

---

## 11. מה עובד ב-mock / test, ומה לא אומת live

- **mock (ברירת מחדל):** כל הזרימות — outbox → תור → "שליחה" → accepted → DLR "102" → delivered;
  OTP מקצה לקצה; retries, unknown, crash, DLR כפול (בבדיקות). אין רשת.
- **test:** הקוד מוכן (`/api/test` + Bearer), **לא הורץ** — אין token בדיקה מוגדר. כדי להפעיל:
  לשמור token בהגדרות הספק, username, sender, ולבחור mode=test. לזכור: test אינו מוכיח מסירה.
- **live:** לא הופעל ולא נבדק. דורש את שלושת השערים ב-§2.2, ובהתחלה רק למספרי בדיקה.
- **פיתוח מקומי של דף ההרשמה:** ליצור חשבון ספק (mock, sender), מועדון, terms + privacy מפורסמים, דף
  מפורסם ו-QR source; כדי לראות את הקוד ב-mock: `NOTIFICATIONS_MOCK_INBOX=true` ב-`.env.local` ו-
  `GET /notifications/mock-inbox` כ-super admin (בזיכרון התהליך בלבד; לעולם לא בייצור).

---

## 12. env (בלי סודות)

```
NOTIFICATIONS_LIVE_SENDING_ENABLED=false   # המתג הנפרד לשליחה חיה — כבוי
NOTIFICATIONS_WORKER_ENABLED=true          # ה-worker בתהליך ה-API
NOTIFICATIONS_MOCK_INBOX=false             # dev בלבד
CLUB_JOIN_BASE_URL=https://<dashboard>/join
PAYMENT_SECRETS_KEY=<Fernet key>           # מצפין גם את token ה-019 (מומלץ לקבוע בייצור)
```

## 13. פריסה ו-rollback

- migration `a9d3f7c1e5b8` (אחרי `f3b7d1a9c5e2`): טבלאות חדשות בלבד, idempotent. לא נוגע בנתונים
  קיימים.
- rollback בלי מחיקה: `NOTIFICATIONS_WORKER_ENABLED=false` (התור נשמר), או pause לחשבון; כיבוי
  `OrderReady` ב-`enabled_events`; ביטול פרסום דף ההרשמה / השבתת QR. לא מוחקים הודעות, הסכמות או
  חברויות. `downgrade` מוחק טבלאות — לא להריץ על DB משותף.

---

## 14. שאלות פתוחות (להחלטת בעל המוצר)

1. **בעל חשבון 019:** חשבון לכל עסק (token לכל חברה — הנתמך כעת) או חשבון Runner מרכזי עם sub-users
   (`getApiToken` מתעד "admin account username" + "requested account username")? מי משלם?
2. **Sender:** איזה שם שולח לכל עסק, ומי מאשר אותו מול 019 (קוד 515 = source לא מאומת)?
3. **שיטת OTP:** OTP מקומי (הנבחר) מול שירות ה-OTP של 019 (מחזיר את הקוד לשרת — לא מומלץ).
4. **היקף המועדון:** חברה (הנבחר) מול קבוצה/דייר שלם; האם חבר בחברת-אם הוא חבר בחברות-הבת אוטומטית.
5. **תנאים ופרטיות:** מי כותב ומאשר את נוסח התנאים, מדיניות הפרטיות ונוסח ההסכמה השיווקית (המערכת
   רק מגרסת ומתעדת).
6. **שמירת מידע (retention):** כמה זמן לשמור הודעות, ניסיונות, דוחות DLR, OTP challenges (מוצע: 30
   יום), audit; מדיניות מחיקה/אנונימיזציה של חבר.
7. **header ההזדהות** של `sms`/`dlr` ואזור הזמן של תאריכי 019 — לאמת ב-`/api/test` עם token.
8. מספרים זרים; הודעת מוכנות חלקית; שעות שקטות לשיווק; CAPTCHA אדפטיבי; תהליך החלפת טלפון לחבר;
   מיזוג כפילויות; Expo חובה לפני "מוכן".
9. undo אחרי שהאירוע נקרא ואז ready מחדש (§3) — האם KDS יוציא `ReadyForPickup` בגרסה חדשה.
10. מכסה יומית לפי יום מקומי (כעת 24 שעות מתגלגלות).

## 15. P1 / P2

- **P1:** points ledger + reservation + מימוש בטוח (reserve → commit/release), grants נוספים, אזור
  אישי לחבר, קמפיינים עם consent gating (Draft → קהל → אישור → Scheduled/Running/Paused) ו-frequency
  cap, reconciliation חסימות מול 019 (Blacklist API), local fallback, הודעת הצטרפות (ClubWelcome)
  כשתאושר, פיצול עורך/מאשר.
- **P2:** אוטומציית יום הולדת, פילוחים, ערוצים נוספים (WhatsApp/Email), Push DLR עם אימות,
  דוחות SMS/מועדון מתקדמים (§34).
