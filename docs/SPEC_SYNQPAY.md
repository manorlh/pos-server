# SynqPay — מסוף מובנה (כמו F20) ומסוף חיצוני (USB / LAN) — אפיון

> בקשת הבעלים (6.10.2026): "https://docs.synqpay.com/api/ — תבדוק, כנס לאן שצריך, עבודה בתצורת USB וגם
> ב-LAN, תמיכה בכל הפונקציות כולל משיכת מידע, אפשר להגדיר את סוג המכשיר וסוג התצורה שלו, לעבודה
> בטאבלט וקיוסק אנדרואיד וקיוסק ווינדוס."
>
> מקור יחיד: התיעוד הציבורי של SynqPay (נקרא כולו ב-6.10.2026, גרסת אפליקציה אחרונה ב-changelog: 1.8.5
> מ-24.9.2026). לא נוצר קשר עם מסוף או שרת SynqPay, ולא בוצעה אף עסקה. כל מה שמסומן **[לא מאומת]**
> הוא הסקה מהתיעוד או מדוגמה שבו, ולא נבדק מול מכשיר.

## 1. מה זה SynqPay — תקציר ה-API

- SynqPay היא אפליקציית תשלום (של Codeblocks בע"מ, רעננה) שרצה **על מסוף האשראי עצמו** (מסופי אנדרואיד
  של Ingenico/Castles/Verifone) ומדברת עם שב"א (אשראית) ישירות או דרך שער (Shva-Arena, Tranzila,
  Pelecard, CreditGuard). הקופה שלנו היא "לקוח מרוחק" של האפליקציה הזו
  ([Home](https://docs.synqpay.com/), [API](https://docs.synqpay.com/api/)).
- הפרוטוקול: **JSON-RPC 2.0** — `id` מחרוזת, אין batch, מספרים שלמים בלבד (בלי נקודה עשרונית, לא
  כמחרוזת), תאריכים RFC-3339, סכומים ביחידה הקטנה (אגורות, `currency` 376)
  ([API](https://docs.synqpay.com/api/), [Monetary Amount](https://docs.synqpay.com/getting-started/amount/)).
- **אימות:** מפתח API שמתקבל ב**צימוד** (`pair` עם המספר הסידורי → OTP בן 6 ספרות על מסך המסוף, תקף
  30 שניות → `authenticate` עם ה-OTP → `apiKey`, בדוגמה 8 תווים `1234abcd`). `pair`/`authenticate` לא
  דורשים מפתח ([Pairing](https://docs.synqpay.com/getting-started/pairing/),
  [pair](https://docs.synqpay.com/api/methods/pair/),
  [authenticate](https://docs.synqpay.com/api/methods/authenticate/)).
- **לא נדרש חשבון כדי לקרוא את התיעוד** — הוא ציבורי. כן נדרש: מסוף SynqPay פיזי לצימוד (המפתח נוצר
  על המסוף), ולמעבר בענן (Linq) גם חשבון DMS. **אין לנו מסוף ואין מפתח**, ולכן שום דבר לא נבדק מול
  מכשיר.

### 1.1 תעבורות (Transports)

| תעבורה | כתובת / פרמטרים | אימות | הערות |
|---|---|---|---|
| HTTP | `POST http://<IP>:8000/synqpay`, ‏HTTPS ‏`:8443` | כותרת `api-key` | 200 לכל תשובת JSON-RPC; ‏401 בלי גוף על מפתח שגוי; CORS; "Local mode" — מ-localhost בלי מפתח ([HTTP](https://docs.synqpay.com/api/transport/http/)) |
| WebSocket | `ws://<IP>:8000/synqpay`, ‏WSS ‏`:8443` | כותרת `api-key` ב-handshake | חיבור אחד בלבד; סגירה 1008 על מפתח שגוי, 1003 על BINARY ([WebSocket](https://docs.synqpay.com/api/transport/websocket/)) |
| TCP | פורט 9000, ‏TLS ‏9443 | 4 בתים בתוך המסגרת | לקוח אחד בלבד — לקוח חדש מנתק את הקודם; אין timeout; KeepAlive/ACK; "cached responses" — תשובה שלא נמסרה נשלחת שוב בהתחברות מחדש ([TCP](https://docs.synqpay.com/api/transport/tcp/)) |
| Serial (UART) | ‏115200, ‏8N1, בלי בקרת זרימה | 4 בתים בתוך המסגרת | אותה מסגרת כמו TCP. ב-changelog 1.3.1: "Serial connectivity (UART) for RX5000" ([Serial](https://docs.synqpay.com/api/transport/serial/)) |
| IP over USB | — | כמו LAN | מוזכר רק ב-changelog 1.2.0 ("IP Over USB"), בלי שום פרט **[לא מאומת]** ([Changelog](https://docs.synqpay.com/changelog/synqpay/)) |
| SDK (AIDL) | `com.synqpay:synqpay-sdk:1.4` (Maven Central) | — | **לאפליקציה שרצה על מסוף ה-SynqPay עצמו** (bind ל-service `com.synqpay.pos` באותו מכשיר) — מצב "מובנה", §1.5; לא לטאבלט/קיוסק שהם מכשיר נפרד ([SDK](https://docs.synqpay.com/sdk/), [Get Started](https://docs.synqpay.com/sdk/get-started/)) |
| Linq (ענן) | `POST https://<linq-application-host>/synqpay/rpc` + OAuth2 client_credentials | Bearer + `X-Device-ID` + `X-Idempotency-Key` | דורש חשבון DMS; שמות השרתים לא מפורסמים ([Linq](https://docs.synqpay.com/api/transport/linq/getting-started/)) |
| Driver | ספרייה מקורית (C++/Java/C#, Maven/NuGet `0.4`) | — | עטיפה ל-TCP/SSL/UART. **לא השתמשנו** — מימשנו את הפרוטוקול בעצמנו (בלי להוריד בינארי) ([Driver](https://docs.synqpay.com/driver/), [Setup](https://docs.synqpay.com/driver/setup/)) |

גילוי ברשת (NSD): `_synqpay._tcp.local.`, שם השירות = המספר הסידורי, TXT `transport` (ws/tcp/http) ו-`name`;
צריך להפעיל במסוף ([NSD](https://docs.synqpay.com/api/transport/nsd/)). לא מומש (כתובת מוגדרת ידנית) — אפשרי בהמשך.

TLS: תעודה חתומה ע"י "Synqpay Root CA" (Codeblocks), SHA-256
`61:AA:67:E7:…:1D:5C`, בתוקף עד 2035; ה-SAN הוא ה-IP המקומי והתעודה **מתחדשת כשה-IP משתנה**
([Certificate](https://docs.synqpay.com/api/transport/certificate/)).

### 1.2 מסגרת הקישור (TCP ו-Serial)

`STX(0x02) | Type(1) | Body | ETX(0x03)` ([Link Layer](https://docs.synqpay.com/api/transport/link/)):

- Request `0x01`: ‏`ApiKey(4) | Length(4, BE) | Payload(UTF-8 JSON) | CRC16(2)`. בצימוד המפתח אפסים.
- Response `0x02` / Event `0x03`: ‏`Length(4, BE) | Payload | CRC16(2)`.
- KeepAlive `0x04`, ACK `0x05`: בלי גוף. Error `0x06`: קוד אחד — ‏`01` INVALID_MESSAGE, ‏`02`
  INVALID_MSG_TYPE, ‏`03` CRC_ERROR, ‏`04` LEN_ERROR, ‏`05` NOT_AUTHENTICATED. **למסגרת שגיאה אין id.**
- CRC16: פולינום `0xA001` מוחזר, התחלה `0xFFFF` (= CRC-16/MODBUS) על Length+Payload; הטקסט אומר
  ש-Length ו-CRC הם big-endian.
- **[לא מאומת] סתירה בתיעוד:** ה-CRC בדוגמת ה-hex (`40 A2`) לא יוצא באלגוריתם המתועד על הבתים שבדוגמה
  (יוצא `33 3B`), ולא בשום וריאנט CRC-16 נפוץ. המימוש שלנו שולח לפי הטקסט (MODBUS, big-endian),
  ומקבל מהמסוף גם בסדר הבתים ההפוך. אם המסוף עונה CRC_ERROR לבדיקת חיבור — אנחנו מנסים פעם אחת בסדר
  ההפוך (רק בקריאה לקריאה בלבד, לעולם לא בעסקה).
- המפתח (`1234abcd`) נכנס כ-4 בתים (`12 34 AB CD`) — כך בדוגמה **[לא מאומת שזה הכלל]**.

### 1.3 הפונקציות

| קבוצה | Method | מה עושה |
|---|---|---|
| צימוד | `pair`, `authenticate` | OTP במסך → `apiKey` |
| כללי | `getStatus` | `deviceStatus` (IDLE, SCREEN_OFF, SCREEN_BUSY, TRANSACTION, WAITING_CONTINUE_TRANSACTION, SETTLEMENT, PAIRING, UPLOAD_LOGS, READ_CARD, PROMPT, SYSTEM) + `cancelable` |
| כללי | `cancel(referenceId)` | עוצר פעולה שבהמתנה (כרטיס, קלט, continue) — רק כש-cancelable |
| תשלום | `startTransaction` | ‏`transactionType`: SALE, REFUND, AUTH_ONLY, CASH(TBD), CASHBACK, VOID, CAPTURE, FORCED, TOP_UP, DISCHARGE, BALANCE; `referenceId` שלנו (1–64, `A-Za-z0-9_-`, **ייחודי לכל חיי המכשיר**); `creditTerms` (REGULAR/SPECIAL/IMMEDIATE/CREDIT/INSTALLMENTS + `noOtherInstallmentPayments`/`firstPayment`/`noCreditPayments`); `tipAmount`/`tipScreen`; `paymentType` (CARD_PRESENT/MOTO/SIGNATURE); `notifyUpdate`/`notifyReferral`/`notifyEvents`; `authorizationHost`; `forceAuthorization`, `deferMonth`, `dueDate`, `shiftId`, `dealId`, `addendum` |
| תשלום | `continueTransaction` | אחרי UPDATE/REFERRAL (שינוי סכום/תנאים, מספר אישור טלפוני); 60 ש' ואז ביטול אוטומטי |
| תשלום | `getTransaction` | ‏`lookupMethod` ‏REF_ID / TRANS_ID / LAST_TRANS → `{transactionResult, transaction}` — **משיכת מידע** |
| מסוף | `getTerminalStatus` | מספר מסוף, שם, READY/NOT_READY/SETTLE_NEEDED/NO_PARAMS, ההתחשבנות האחרונה |
| מסוף | `getBatchFileStatus` | רשימת העסקאות בקובץ (type R/V/I, referenceId, transactionId) — **רשימת עסקאות לא משודרות** |
| מסוף | `settlement(host="SHVA", reportFormat?)` | **שידור** — כל הקובץ יחד או כלום; מחזיר דוח טקסט ו-`settledTransactions` |
| מסוף | `getSettlement` (SETTLEMENT_ID/BATCH_NO/LAST_SETTLEMENT), `querySettlements(queryParams)` | **משיכת היסטוריית שידורים** |
| מסוף | `deposit(host="SHVA")` | הפקדה לשער (מסוף gateway) — עסקה-עסקה |
| מכשיר | `getDeviceInfo`, `getConfig`, `setConfig` (רק printTransactionReceipt, printSettlement, cachedResponses, nsd), `uploadLogs`, `reboot`, `restart` | |
| מסך | `readCard`, `userInput`, `userSelection`, `showQR`, `captureSignature` | מסכים מותאמים (כרטיס מגנטי/NFC לא-אשראי, קלט, בחירה, QR, חתימה) |
| הודעה | `transactionEvent` | ‏WAITING_FOR_CARD, CARD_DETECTED, PIN_STARTED, AUTHORIZATION_STARTED, TIP_SELECTION, ENTER_CVV, ENTER_CARDHOLDER_ID, COMBINED_CARD, CREDIT_CONFORMATION, ENTER_CARD_DETAILS (עם `notifyEvents`) — לא ב-HTTP |

**אין** pre-auth נפרד מעבר ל-AUTH_ONLY/CAPTURE, **אין** שאילתת רשימת עסקאות לפי תאריך (רק קובץ העסקאות
הנוכחי + עסקה בודדת + רשימת התחשבנויות), **אין** קישור של REFUND לעסקה מקורית (שדה כזה לא מתועד).

תוצאה (`result`): OK, GENERAL_ERROR, CANCELED, TIMEOUT, NETWORK_ERROR, HOST_ERROR, SMART_READER_ERROR,
SMART_CARD_ERROR, NONE_CREDIT_CARD, CARD_NOT_ALLOWED. מצב עסקה (`transactionStatus`): AUTHORIZED,
CAPTURED, DECLINED, SETTLED, DEPOSITED, VOIDED, INFORMATIVE. התיעוד ממליץ לבדוק את `transactionStatus`
ולא רק את `result` ([Error Handling](https://docs.synqpay.com/getting-started/error-handling/)).

שגיאות JSON-RPC של האפליקציה ([Errors](https://docs.synqpay.com/api/errors/)): 100 GeneralError, 101
IllegalRequest (`data` = סיבה, למשל AMOUNT_LIMIT_EXCEEDED, ILLEGAL_NEW_AMOUNT, NO_GATEWAY), 102
MissingParam, 103 InvalidParam, 201 IllegalState, 202 ScreenNotReady, 203 InsufficientBattery, 300
PaymentMethodDisabled, 301 HostNotReady, 302 TransactionNotFound, 303 TransactionAlreadyExist, 304
IllegalTransactionStatus, 401 HostDisabled **וגם** 401 SettlementNotFound (אותו קוד פעמיים בתיעוד —
**[לא מאומת]**), ו-‏-32700/-32600/-32601. קודי שב"א (`hostErrorCode`) — טבלת
[Ashrait Errors](https://docs.synqpay.com/api/errors/ashrait-errors/) (0 אושר, 3 התקשר לחברת האשראי, 4 סירוב, 6 CVV, 9 פג תוקף, 15/150–152 תקשורת…).

קבלה: `cardHolderReceipt` / `merchantReceipt` — `fields[]` של `{id, key, value}` בעברית, בסדר מחייב,
`language`, `collectSignature`. מותג/מנפיק/סולק כמספרים (`brand`, `issuer`, `acquirer`) + שמות; לפי הדוגמה
אלה קודי שב"א (brand 2 = ויזה, issuer 2 = כאל) **[לא מאומת שתמיד]**.

### 1.4 דגמים (סוג המכשיר)

התיעוד לא מפרסם רשימת דגמים; זה מה שמופיע בו: **Ingenico DX8000** (דוגמת `getDeviceInfo`), **DX6000**,
**RX5000** (1.0.0; UART ב-1.3.1; kiosk mode ב-1.4.0), **EX8000** (1.3.1), **Castles S1P2**, **Castles
S1U2-M4** (1.6.0, לא מאויש), **Verifone** (1.7.0, בלי דגם). "Type 25 unattended" (1.8.0). המותג של
DX6000/EX8000/RX5000 (כנראה Ingenico Axium) לא כתוב בתיעוד.

### 1.5 מצב מובנה — הקופה רצה על מסוף ה-SynqPay עצמו ("כמו F20")

כן — התיעוד מתאר עבודה מובנית: אפליקציה צד-ג' שרצה **על מסוף ה-SynqPay** (מכשיר אנדרואיד של Ingenico /
Castles / Verifone שמריץ את SynqPay) ופונה לשירות התשלום באותו מכשיר. שתי דרכים מתועדות:

1. **Local Mode** ([HTTP](https://docs.synqpay.com/api/transport/http/)) — השירות מקבל בקשות **רק
   מ-localhost**, ולכן **בלי מפתח API**, ומנהל את המסכים בעצמו. אותו JSON-RPC ב-`POST
   http://localhost:8000/synqpay`. איך מפעילים את המצב במסוף — לא כתוב (נראה שבהגדרות המסוף / DMS)
   **[לא מאומת]**. ב-changelog 1.4.0: "Local HTTP server with SynqpaySDK".
2. **SDK (AIDL)** ([SDK](https://docs.synqpay.com/sdk/), [Get Started](https://docs.synqpay.com/sdk/get-started/),
   [Api Connector](https://docs.synqpay.com/sdk/api-connector/)) — `com.synqpay:synqpay-sdk:1.4` מ-Maven Central,
   `<queries><package android:name="com.synqpay.pos"/></queries>`, `SynqpaySDK.get().init/bindService`, ואז
   `SynqpayAPI.sendRequest(json, callback)` — אותו JSON-RPC, בלי אימות. ב-SDK גם Printer (PAL), Manager ו-Device.

**אין** בתיעוד SoftPOS / Tap on Phone ואין Intent API.

**זה המצב העיקרי** (הבעלים: "הכוונה שהמכשיר שלהם יעבוד כמו F20"). אצלנו:

- **זיהוי אוטומטי**: אם אפליקציית התשלום של SynqPay (`com.synqpay.pos`) מותקנת במכשיר — זה מסוף SynqPay,
  והוא **המסוף המובנה של הקופה**, בדיוק כמו Agamento ב-F20 (`DeviceHardware.emv` → `SynqPayDevice.builtInEmv`).
  הדגם נקבע לפי `Build.MODEL` (DX8000, RX5000… — **[לא מאומת]** מה כל מסוף מדווח; לא מזוהה → "SynqPay — אחר").
  היצרן/דגם לבדם לא מספיקים: Ingenico בלי SynqPay אינו כזה.
- **התקשורת**: Local Mode — HTTP ל-`127.0.0.1:8000` בלי מפתח. אותו `SynqPayTerminal`, אותם חוקי בירור.
  ה-SDK **לא נוסף** (לא מורידים SDK) — `SynqPaySdkTransport.kt` מתעד בדיוק מה צריך כדי לעבור אליו.
- **בענן**: הקופה מדווחת בצימוד `device_info.synqpay = "true"`, והשרת רושם אותה כדגם SynqPay
  (`SYNQPAY_DX8000`, `SYNQPAY_RX5000`… `SYNQPAY`, `app/models/synqpay_devices.py`) עם **מסוף מובנה = כן**.
  "סוג אינטגרציית אשראי" אוטומטי / "מובנה" — ובמכשיר כזה גם `synqpay` — הם המסוף המובנה; הבחירה נקראת
  בדשבורד "מובנה — SynqPay במכשיר".
- **מדפסת ומגירה**: SynqPay מדפיסה בעצמה את שובר האשראי (ההגדרה `printTransactionReceipt` שלה). קבלות הקופה
  על המדפסת של המסוף דורשות את PAL, שקיים **רק ב-SDK** — לא נוסף, ולכן הדגמים מסומנים "מדפסת: בקרוב"
  (`driverPending`) והקופה מדפיסה במדפסת קבלות חיצונית. **אין** API למגירה בתיעוד.
- בקיוסק ווינדוס אין מצב מובנה (המחשב אינו המסוף).

## 2. ההגדרה אצלנו

הבעלים: "LAN/USB זה כשמדובר בקופה עם מסופון חיצוני". לכן:

- **מובנה** — **אין הגדרה**: קופה שרצה על מסוף SynqPay מזהה אותו בעצמה (§1.5).
- **חיצוני** — קופה אחרת (טאבלט P18, קיוסק אנדרואיד, קיוסק ווינדוס) שמחייבת במסוף SynqPay שמחובר אליה:
  "סוג אינטגרציית אשראי" = **`synqpay`** — "SynqPay — מסוף חיצוני", והגדרה פר קופה:

| מפתח | ערכים | חובה |
|---|---|---|
| `synqpayDeviceModel` | `dx8000` · `dx6000` · `ex8000` · `rx5000` · `s1p2` · `s1u2_m4` · `verifone` · `other` | כן |
| `synqpayConnection` | `lan` (רשת) · `usb` (כבל USB, זיהוי אוטומטי). `usb_serial` נקרא כ-`usb` | כן |
| `synqpayHost` | IPv4 או שם מארח (גם מסוף ב-"IP over USB" — הכתובת שהוא מקבל בכבל) | ב-`lan` |
| `synqpayProtocol` | `tcp` (ברירת מחדל) · `http` | לא |
| `synqpayPort` | 1–65535; ברירת מחדל tcp 9000 / tls 9443, http 8000 / tls 8443 | לא |
| `synqpayTls` | bool (ברירת מחדל false — צריך להתאים ל-`secureConnection` במסוף) | לא |
| `synqpayUsbDevice` | ריק = זיהוי אוטומטי (מומלץ) · `VVVV:PPPP` (hex) · `COMn` (ווינדוס) — רק כשיש כמה התקנים | לא |
| `synqpaySerialNumber` | המספר הסידורי של המסוף (לצימוד ולזיהוי מסוף אחר) | לא |
| `synqpayApiKey` | **סוד** — מוצפן בשרת (`payment_integration_secrets`), write-only, לא חוזר לדפדפן; נשלח רק בסנכרון של קופה שמחייבת ב-SynqPay חיצוני | כן |
| `expectedTerminalNumber` | (קיים) מספר המסוף הצפוי — **ברמת הקופה עצמה**, §2.1 | לנעילה |

- אין מיגרציה: הסוד בטבלת הסודות הקיימת (מפתח חדש), השדות ב-JSON של השכבות, הדגמים ב-`device_model` (String(16)).
- ולידציה בשרת: ערכים מהרשימות, host כמו של Nayax, פורט, `VVVV:PPPP`/`COMn`, מספר סידורי
  `[A-Za-z0-9-]{4,32}`, מפתח `[A-Za-z0-9]{1,64}` (הקופה דורשת 8 hex ב-TCP/USB ומודיעה אם לא).
- אזהרה בדשבורד (לא חסימה): `usb` מתועד ב-SynqPay רק ל-RX5000.

### 2.1 זהות המסוף (נעילת אשראי) — גם למסוף SynqPay חיצוני

אותו כלל של מסופון Nayax ברשת (`domain/CardLock.kt`, `terminal_status.card_lock_of`, SPEC_KIOSK.md §20):

- מספר המסוף הצפוי (`expectedTerminalNumber`) חייב להיות מוגדר **ברמת הקופה עצמה**; ערך בירושה מחנות/חברה
  לא נחשב (השרת לא שולח אותו למסוף חיצוני — `terminal_config_guard`, ו-SynqPay נחשב חיצוני כמו Z-Credit).
- הזהות נקראת **מהמסוף המחובר** — `getTerminalStatus.terminalId` (דרך `getRetailerInfo` בגשר הפריימים) —
  ונשמרת עם המסוף שממנו נקראה (`lan:synqpay:<הקישור>`); לא נקראה מהמסוף הזה → נעול.
- לא הוגדר / לא נקרא / מספר אחר → **האשראי נעול, לא הקופה**: מזומן וכל השאר ממשיכים, והנעילה משתחררת לבד
  כשהזהות תואמת. אפסים מובילים לא משנים (`0883198` = `883198`).
- מסוף מובנה (SynqPay על המכשיר) — כלל המסוף המובנה, כמו F20: נעול רק כשהמסוף מדווח מספר אחר.
- קיוסק ווינדוס: אותו כלל ב-`SynqPayProvider` (`cardLockOf`) — מכירה לא נשלחת, ובדיקת המסוף נכשלת עם הסיבה.

## 3. מיפוי לממשק המסוף שלנו

`PaymentTerminal` (אנדרואיד, `hardware/payment/nayax/PaymentTerminal.kt`) דרך `TerminalFrameBridge`
(כמו Z-Credit) — גם במובנה (דרך `hardware.emv`) וגם בחיצוני (דרך `SwitchingEmvDevice`); ו-`PaymentProvider`
בקיוסק ווינדוס (`kiosk-desktop/src/main/payment/provider.ts`).

| אצלנו | SynqPay | הערות |
|---|---|---|
| `connect` / `probe` | `getStatus` (+ `getTerminalStatus` כשהמכשיר IDLE, ופעם אחת `getDeviceInfo`) | IDLE+READY → מוכן; SETTLE_NEEDED → "אונליין בלבד"; NO_PARAMS → "לא הוקם"; כל מצב אחר → עסוק; 401/NOT_AUTHENTICATED → "מפתח API נדחה"; אין חיבור → מנותק; מספר סידורי אחר מהמוגדר → שגיאה |
| `sale` | `startTransaction` SALE | `referenceId` = `<תג התקנה>-<vuid>`; תשלומים → INSTALLMENTS + `noOtherInstallmentPayments = n-1`; טיפ → `amount` בלי טיפ + `tipAmount` |
| `refund` | `startTransaction` REFUND | זיכוי לא מקושר (אין שדה מקור ב-API) — כרטיס מוצג במסוף |
| `void` | `getTransaction(TRANS_ID)` → `startTransaction` VOID עם ה-`referenceId` **של המקור** | רק AUTHORIZED/CAPTURED לפני שידור; אחרי — זיכוי |
| `abort` | `cancel(referenceId)` | רק לפני הצגת הכרטיס |
| `lookup` | `getTransaction(REF_ID)` | 302 → לא נמצא (רק כש-IDLE); 201/202 → לא ידוע |
| `transmit` | `settlement(host="SHVA")` | `settledTransactions` → `queriedTransactions` (uid/transactionId/vuid) |
| `reportX` | `getBatchFileStatus` | מספר העסקאות בלבד (אין סכומים ב-API) |
| `identity` (חדש, ברירת מחדל null) | `getTerminalStatus` | מספר מסוף + שם — לנעילת האשראי (§2.1) |
| — (נוסף) | `getDeviceInfo`, `getConfig`, `setConfig`, `getTransaction(LAST_TRANS/TRANS_ID)`, `getSettlement`, `querySettlements`, `deposit`, `uploadLogs`, `reboot`, `restart`, `pair`, `authenticate`, מסכים מותאמים | פונקציות של `SynqPayTerminal` / `SynqPayClient` (משיכת מידע, תחזוקה) |

התשובה מומרת לצורת ה-ashrait שהקופה כבר קוראת (`statusCode`, `uid` = `transactionId` של SynqPay — ה-UID
שבקבלה, `issuerAuthNum`, `cardNumber` ממוסך, `amount` = `totalAmount`, `creditPayments`,
`firstPaymentAmount`, `mutag`/`manpik`/`solek` מ-brand/issuer/acquirer, `customerReceipt` /
`merchantReceipt` כ-`{fieldName, fieldValue}`, `provider: synqpay`, `vuid`).

`referenceId` נשמר אצל SynqPay לכל חיי המסוף ומסורב שוב (303), ומונה ה-vuid מתאפס עם נתוני האפליקציה —
לכן התג הוא **תג התקנה אקראי** (`SynqPayDevice.tag`, נשמר ב-SharedPreferences): התקנה חדשה = תג חדש, ועסקה
ישנה לעולם לא "עונה" על חדשה.

### 3.1 סיווג תשובה (חוקי בירור הכרטיס — SPEC_CARD_RECOVERY.md)

1. יש `transactionStatus`: CAPTURED/AUTHORIZED/SETTLED/DEPOSITED → **אושר** (גם אם `result` אינו OK).
   DECLINED/VOIDED/INFORMATIVE → **לא חויב** (CANCELED/VOIDED → בוטל).
2. אין סטטוס: CANCELED → בוטל; HOST_ERROR, SMART_READER_ERROR, SMART_CARD_ERROR, NONE_CREDIT_CARD,
   CARD_NOT_ALLOWED → נדחה; **TIMEOUT, NETWORK_ERROR, GENERAL_ERROR → לא ידוע** (בירור).
3. שגיאת JSON-RPC: 303 (referenceId קיים) → **בירור לפי אותו referenceId**, לעולם לא "נדחה"; 201/202
   → מסוף עסוק (לא נשלח); 101/102/103/203/300/301/302/304/401/‎-32xxx → סירוב לפני כרטיס.
4. בלי תשובה (ניתוק, timeout, מסגרת שגיאה בלי id) → **לא ידוע**: קודם `getTransaction(REF_ID)`; אם
   לא הכריע — `cancel` פעם אחת ועוד בירורים; "לא נמצא" רק פעמיים בהפרש ≥5 ש'. אף פעם לא חיוב שני תחת
   referenceId חדש לפני שזה הוכרע. מכירה נשלחת **פעם אחת**, בלי ניסיון חוזר אוטומטי.
5. לא נשלח בכלל (חיבור נדחה, TLS נכשל, אין התקן USB / אין הרשאה) → "לא חויב" ודאי (מסוף עסוק), בלי בירור.
6. ב-TCP/USB כל הבקשות על חיבור אחד (לקוח חדש מנתק את הקודם — `cancel` בחיבור נפרד היה מפיל את
   המכירה). KeepAlive כל 15 ש' בזמן המתנה; ACK חסר נרשם בלוג ולא מבטל המתנה.

## 4. לפי פלטפורמה

### 4.1 מסוף SynqPay עצמו (אנדרואיד) — מובנה, המצב העיקרי

- §1.5: זיהוי לפי `com.synqpay.pos` (שורת `<queries>` במניפסט), Local Mode ב-localhost, מסוף מובנה בענן
  ובקופה, שובר אשראי מודפס ע"י SynqPay, קבלות קופה במדפסת חיצונית עד שה-SDK (PAL) יתווסף.
- צריך: Local Mode מופעל במסוף; הרשאה להתקין אפליקציה צד-ג' על המסוף (מדיניות ה-DMS / TEM של היצרן) **[לא מאומת]**.

### 4.2 טאבלט Kozen P18 (אנדרואיד 13) וקיוסק HIT RK3568 (אנדרואיד 12) — מסוף חיצוני

- **LAN**: TCP (9000/9443) או HTTP (8000/8443) ב-socket גולמי — מדיניות ה-cleartext של OkHttp לא נפתחת
  לכל האפליקציה (כמו `RawPinpadHttp`). TLS: אמון לפי שרשרת שמסתיימת ב-Root CA המתועד (טביעת SHA-256),
  אחרת trust-on-first-use לכל host:port (כמו מסופוני Nayax). "IP over USB" = LAN בכתובת שבכבל.
- **USB**: USB host דרך `UsbManager`, מנהל CDC-ACM שלנו (SET_LINE_CODING 115200 8N1, DTR/RTS, bulk
  in/out), זיהוי אוטומטי (ההתקן הראשון מסוג CDC-ACM). מתאמי FTDI/CP210x/CH34x **לא נתמכים**. הרשאה בלי
  שאלה — `usb_synqpay_filter.xml` על activity-alias של `UsbAttachActivity` ("use by default" פעם אחת).
  **אסור לגעת ב-`/dev/ttyS1`** (שבב התשלום של Kozen) — אנחנו לא פותחים tty בכלל.
- הקיוסק משתמש באותו `CheckoutViewModel`; `KioskTerminal.configured` מכיר את SynqPay.
- נעילת אשראי לפי זהות המסוף — §2.1.

### 4.3 קיוסק ווינדוס (Electron/Node — `kiosk-desktop`) — מסוף חיצוני בלבד

- מודול TypeScript: `kiosk-desktop/src/main/payment/synqpay/` (קבצים חדשים) + שורת רישום אחת ב-
  `src/main/payment/registry.ts` (`PROVIDERS = [nayaxLanFactory, synqpayFactory]`, לפי ההוראה שבקובץ).
- LAN: ‏`net`/`tls` (TCP) או `http`/`https` של Node — בלי חבילות.
- USB: CDC-ACM מקבל COM ב-Windows 10/11 (usbser.sys מובנה); זיהוי אוטומטי = ה-COM היחיד מסוג USB. דרוש
  **`serialport`** (npm ציבורי) — נטען דינמית; לא הוסף ל-`package.json` — צריך `npm i serialport` אצל
  בעלי החבילה. בלעדיו: "חבילת serialport אינה מותקנת" (לא נשלח, לא חויב).
- זהות המסוף (§2.1) נבדקת לפני כל מכירה ובכל בדיקת מסוף.

## 5. קבצים

- שרת: `app/services/payment_integration.py`, `payment_secrets.py`, `schemas/pos_settings.py`,
  `services/settings_merge.py`, `observability/body_logging.py`, `services/terminal_config_guard.py`,
  `services/terminal_status.py` (נעילה למסוף SynqPay חיצוני, מובנה במכשיר SynqPay), `routers/payment_integration.py`
  (שם הבחירה המובנית), `models/synqpay_devices.py` (חדש), `models/pos_machine.py`, `schemas/pos_machine.py`,
  `schemas/transmission.py`; בדיקות `tests/test_synqpay_integration.py`, `tests/test_synqpay_devices.py`
  (+ התאמות ב-`test_device_profile.py`, `test_card_lock.py`).
- דשבורד: `client/src/lib/paymentIntegration.ts` (+test), `components/payment-integration-section.tsx`,
  `lib/types.ts`, `lib/deviceProfile.ts` (+test), `messages/he.json` (שמות הדגמים).
- אנדרואיד: `hardware/payment/synqpay/` (`SynqPayLink.kt` מסגרת+CRC, `SynqPayProtocol.kt` בקשות/
  תשובות/מיפוי, `SynqPayTransport.kt` TCP/HTTP/קישור/TLS, `SynqPayUsb.kt` CDC-ACM, `SynqPayTerminal.kt`,
  `SynqPayFactory.kt`, `SynqPayDevice.kt` (זיהוי המכשיר, מובנה, תג התקנה), `SynqPaySdkTransport.kt` — stub
  מתועד), `domain/SynqPaySettings.kt`, `domain/PaymentIntegration.kt`, `PaymentTerminalConfig.kt`,
  `KioskTerminal.kt`, `CardLock.kt` (`target` ל-SynqPay), `SwitchingEmvDevice.kt`, `TerminalFrameBridge.kt`
  (`getRetailerInfo`), `nayax/PaymentTerminal.kt` (`TerminalKind.SYNQPAY`, `identity()`), `AppContainer.kt`,
  `data/PaymentSecretStore.kt`, `data/repo/PairingRepository.kt` (`synqpay` ב-device_info),
  `src/device/.../DeviceHardware.kt` (המסוף המובנה), `ui/settings/SynqPayDiagnosticsSection.kt`
  (+ שורה ב-`PinpadDiagnosticsSection.kt`), `ui/kiosk/KioskAdmin.kt`, `res/values*/strings_synqpay.xml`,
  `strings_kiosk_app.xml`, `res/xml/usb_synqpay_filter.xml`, ושני hunks במניפסט (`<queries>` ל-`com.synqpay.pos`,
  ו-activity-alias ל-USB); בדיקות `SynqPayLinkTest`, `SynqPayProtocolTest`, `SynqPayTerminalTest`,
  `SynqLinkTransportTest`, `SynqPaySettingsTest` (+ התאמה ב-`CardLockTest`), fixtures ב-`app/src/test/resources/synqpay/`.
- ווינדוס: `kiosk-desktop/src/main/payment/synqpay/{link,protocol,transport,client,provider,index}.ts`,
  `registry.ts` (שורה), `test/synqpay.{link,protocol,client}.test.ts`, `test/fixtures/synqpay/`.

## 6. שאלות פתוחות ל-SynqPay

1. **CRC**: הדוגמה `40 A2` לא תואמת את האלגוריתם המתועד. מה בדיוק מחושב, ובאיזה סדר בתים?
2. **מפתח API ב-TCP/Serial**: האם תמיד 8 תווי hex שהופכים ל-4 בתים (`1234abcd` → `12 34 AB CD`)?
3. **USB**: אילו דגמים חושפים UART על USB ובאיזו מחלקה (CDC-ACM? FTDI?), מה ה-VID/PID; מה בדיוק
   "IP over USB" (RNDIS/ECM/NCM), איזה IP מקבל המסוף ואיזה המארח, ובאילו דגמים.
4. **שגיאות קישור**: למסגרת Error אין id — לאיזו בקשה היא שייכת כשיש שתיים בדרך (מכירה + cancel)?
5. **KeepAlive**: מה המרווח הנדרש, ומה המסוף עושה כשאין KeepAlive?
6. **סטטוס TIMEOUT / NETWORK_ERROR**: האם תמיד יש `transaction` עם `transactionStatus` כשעסקה הגיעה לשב"א?
7. **זיכוי מקושר**: האם יש דרך לקשר REFUND לעסקה מקורית?
8. **REFERRAL** בלי `notifyReferral` — מה המסוף עושה?
9. `WAITING_FOR_CONTINUE` (דף continueTransaction) מול `WAITING_CONTINUE_TRANSACTION` (DeviceStatus);
   ב-getTerminalStatus — `status` (טבלה) או `terminalStatus` (דוגמה)?
10. `cvvResponse` — מחרוזת או מספר (בדוגמה 0)? `DepositCandidate.gatewayToken` או `token`?
11. HostDisabled ו-SettlementNotFound — שניהם 401?
12. מסוף gateway: לשדר ב-`settlement` או ב-`deposit` כברירת מחדל?
13. סביבת בדיקה / מסוף דמו (`testEnv: true`) ותהליך הסמכה לקופה שמשתמשת ב-API.
14. **מובנה**: איך מפעילים Local Mode, באיזה פורט/סכמה; אילו דגמים מתירים התקנת אפליקציה צד-ג' לצד SynqPay;
    מה כל דגם מדווח כ-`Build.MODEL`; האם ההמלצה ל-POS מלא היא ה-SDK (AIDL) ולא Local Mode.
15. **מדפסת**: האם יש דרך להדפיס קבלה של אפליקציה צד-ג' בלי ה-SDK (PAL)? האם יש API למגירת כסף?
16. רישיון: דף הרישיון "Coming soon" — מה תנאי השימוש ב-API ובפרוטוקול.

## 7. סיכונים

- **חיוב כפול** — מטופל: מכירה נשלחת פעם אחת; כל אי-ודאות → בירור לפי referenceId; 303 → בירור; תג התקנה
  ב-referenceId (ייחודי לכל חיי המסוף, גם אחרי התקנה מחדש או כשמסוף עובר קופה).
- **פרוטוקול לא מאומת** (CRC, סדר בתים, מפתח כבתים, USB, Local Mode) — עד בדיקה על מכשיר, כל אחד מהם עלול
  לא לעבוד (הכשל יהיה "לא מחובר", לא חיוב שגוי). HTTP / Local Mode מתועדים הכי טוב; לבדיקה ראשונה של מסוף
  חיצוני — `synqpayProtocol = http`.
- **TCP לקוח יחיד** — כלי טכנאי שמתחבר למסוף באמצע מכירה ינתק את הקופה; התשובה תתברר בבירור.
- **מפתח API** ב-TCP/HTTP בלי TLS עובר גלוי ברשת החנות; TLS אפשרי (`synqpayTls`) — צריך גם במסוף.
- **שינוי IP** מחליף את תעודת ה-TLS — pin לפי host:port; אם ה-Root CA לא נשלח בשרשרת, נדרש איפוס pin.
- **USB באנדרואיד**: רק CDC-ACM; מסנן ה-USB תופס כל התקן CDC-ACM (אין VID/PID מתועדים) — ה-trampoline
  רק מעלה את הקופה, בלי השפעה אחרת.
- **ווינדוס**: `serialport` היא חבילה עם רכיב native — צריך rebuild ל-Electron.
- **מובנה**: תלוי ב-Local Mode מופעל ובהרשאת התקנה על המסוף; זיהוי לפי חבילה — מכשיר בלי `com.synqpay.pos`
  נשאר F20/Agamento כרגיל. אין הדפסת קבלות קופה על המסוף עד ה-SDK.
- **שובר אשראי**: נתוני הקבלה נשמרים במטא של התשלום (`result.customerReceipt`), כמו Z-Credit; הדפסת שובר
  ממסוף חיצוני בקופה עדיין לא קיימת (במובנה SynqPay מדפיסה בעצמה).
- **צימוד** (`pair`/`authenticate`) ממומש בפרוטוקול, בלי מסך בקופה — היום המפתח מוקלד בדשבורד.
