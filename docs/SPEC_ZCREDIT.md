# סוג אינטגרציית אשראי ו-Z-Credit — אפיון

## מטרה

1. **סוג אינטגרציית אשראי** (`paymentIntegration`) כהגדרה אחת לחנות:
   - בוחרים אותה כבר בפתיחת החנות, והיא חלה על כל הקופות בה.
   - אחר כך אפשר לקבוע לקופה אחת ערך משלה, למשל לטאבלט.
   - השינוי יורד לקופה בסנכרון ההגדרות הבא.
2. **Z-Credit** כספק חדש: מסופון חיצוני (PinPad) שמופעל דרך השער של Z-Credit.

## חלק א׳ — סוג האינטגרציה

### ההגדרה

| ערך | תווית | משמעות |
|---|---|---|
| `auto` (ברירת מחדל, וגם "לא נשמר") | אוטומטי | ההתנהגות של היום: קופה עם מסוף מובנה עובדת עם Agamento, ואם `nayaxEnabled` מסופון Nayax ברשת. טאבלט בלי מסוף (P18) עובד תמיד עם מסופון Nayax. |
| `agamento` | מובנה — Agamento במכשיר | רק לקופה שיש לה מסוף מובנה. |
| `nayax_lan` | Nayax — מסופון ברשת | הכתובת לפי `nayaxDeviceHost` / `nayaxDevicePort` / `nayaxSpicyPath`. |
| `nayax_usb` | Nayax — מסופון בחיבור USB | מסופון Nayax C4 בכבל USB לקופה (פורט CDC-ACM משלו; אותן מסגרות TweezerComm כמו ברשת, במסגור לקו). אין כתובת. `nayaxUsbDevice` הרשות מזהה את ה-C4. מסוף אחד לקופה (ראו "מסוף USB אחד לקופה"). |
| `zcredit` | Z-Credit — מסופון חיצוני | השדות `zcreditTerminalNumber`, `zcreditPinpadId`, `zcreditMode` והסיסמה (ראו "סודות"). |
| `tap_to_pay` | Tap to Pay במכשיר (iPOSpays) | שמור לעתיד: מוצג "בקרוב", השרת דוחה כתיבה שלו, והקופה קוראת אותו כ-`auto`. |

- **הגדרה מנוהלת על השכבות:**
  - הסדר הוא tenant ← company ← shop ← area ← machine, והקופה גוברת.
  - נבחרה הגדרה מנוהלת ולא "פרמטר לקופות", כי מפתחות `nayax*` הקיימים כבר יושבים על השכבות האלה.
  - כך הדיאלוג של החנות ושל הקופה עובד כמו לכל הגדרה אחרת: ערך בירושה, דריסה, ואיפוס בעזרת `null`.
- **`auto` אינו נשמר:** כתיבה של `auto` מוחקת את הערך של השכבה, והשכבה חוזרת לרשת.
- **תאימות:** `auto` יחד עם `nayaxEnabled=true` מתנהג כמו `nayax_lan`.
- **פתיחת חנות:**
  - `POST /shops` מקבל `paymentIntegration`, וכותב אותו לשכבת החנות.
  - ערך חסר או `auto` לא כותב כלום.
  - טופס "חנות חדשה" בדשבורד מציג את הבחירה, וברירת המחדל היא "אוטומטי".

### קופה בלי מסוף מובנה ("אם מדובר בטאבלט זה בכל אופן חיצוני")

- **בשרת:** `PATCH /machines/{id}/settings` עם `paymentIntegration=agamento` לקופה בלי מסוף מובנה מחזיר 422.
  - פרטי השגיאה: `{"code":"agamento_needs_builtin_terminal","msg":"לקופה הזו אין מסוף מובנה…"}`.
- **בדיאלוג הקופה:** האפשרות "מובנה" מושבתת, עם הסבר. "Tap to Pay" מוצג רק כ"בקרוב", ובמכשיר בלי NFC מופיע "דורש NFC".
- **ירושה:**
  - קופה כזו מדלגת על `agamento` שירשה מהחנות, ולוקחת את הסוג החיצוני שנקבע מעל (למשל Z-Credit בחברה).
  - אם אין סוג חיצוני מעל, היא עוברת לאוטומטי, כלומר Nayax, ומבקשת כתובת.
  - הקופה עצמה מיישמת את אותו כלל (`paymentTerminalConfigOf`).
- **NFC:**
  - נלקח מ-`device_info.nfc` שהקופה מדווחת.
  - בלי דיווח: לדגם P18 ידוע שיש NFC (`android.hardware.nfc` + `nfc.hce`). לכל דגם אחר הערך לא ידוע.

### השדות שכל סוג צריך (ולידציה)

| סוג | שדות חובה | הערות |
|---|---|---|
| Agamento | — | |
| Nayax | כתובת IP או שם מארח (`nayaxDeviceHost`) | פורט ברירת מחדל 8080, נתיב `/SPICy`. "HTTP ללא הצפנה" הוא פרמטר לקופות (`pinpadAllowHttp`). |
| Nayax USB | — | `nayaxUsbDevice` רשות: `VVVV:PPPP` (vendor:product בהקס, 4+4 ספרות; נשמר באותיות גדולות), כמו `synqpayUsbDevice` אבל בלי `COMn`. ריק = התקן ה-CDC-ACM הראשון שמחובר לקופה. ערך אחר — 422. הגדרה מנוהלת (נשלחת לקופה), ו-`null` מחזיר לירושה. בקופה כזו אין "נדרשת כתובת IP למסופון" (`pinpadRequired` = false). |
| Z-Credit | מספר מסוף (ספרות בלבד, עם האפסים המובילים), סיסמה, מזהה PinPad (עם או בלי הקידומת `PINPAD`; נשמר בלעדיה), מצב (בדיקה / ייצור) | השדה Key רשות. הוא שייך ל-WebCheckout, לא נשלח לקופה ולא משמש במסופון. |
| Tap to Pay | — (שמור) | |

- **ברשימת הקופות:**
  - `paymentIntegration`, `paymentIntegrationSource` ו-`paymentIntegrationAutomatic` מזינים את התג.
  - `paymentIntegrationMissing` מזין את "חסר: מספר מסוף, מזהה PinPad".
- **בקופה:** מסך האבחון מציג את אותה רשימת חסרים, וגם התשלום הראשון נעצר עליה לפני שהסל נרשם. אין כישלון באמצע עסקה.
- **הקשר לטופס:** `GET /payment-integration/context?level=&targetId=` מחזיר:
  - האפשרויות, ולכל אחת אם אפשר לבחור אותה ולמה לא;
  - ממה השכבה יורשת;
  - אילו סודות שמורים ובאיזו רמה (אף פעם לא הערך);
  - בקופה גם את הסוג בפועל ואת השדות החסרים.

### מסוף USB אחד לקופה (`nayax_usb`, 8.10.2026)

- **ה-C4 בכבל הוא מסוף הקופה עצמה, ולא מכשיר תשלום.**
  - "מכשירי תשלום" (קבוצה / מכשיר קבוע) נשארים רשת (Agamento ברשת), Z-Credit ו-SynqPay בלבד.
  - סוג מכשיר `nayax_usb` (או דומה לו), או `agamento_lan` עם `connection: "usb"`, נדחים ב-422 `kind_usb_terminal`.
- **אין מסוף USB שני ליד ה-C4.**
  - קופה שהסוג שלה בפועל הוא `nayax_usb` (מכל רמה) לא יכולה לסלוק גם במכשיר SynqPay שמחובר ב-USB.
  - "לסלוק במכשיר" פירושו: `multiPaymentDevices` פעיל, והמכשיר הוא המכשיר הקבוע שלה (במצב "fixed"), או שהוא בקבוצה שלה (קבוצה ריקה או חסרה = כל מכשירי החנות).
  - מכשיר ברשת או Z-Credit ליד ה-C4 מותר. קיוסק לא מקבל מכשירי תשלום, ולכן לא נבדק.
- **איפה נבדק** (422 `usb_terminal_second`, ההודעה "בקופה מוגדר מסופון בחיבור USB — מסוף USB נוסף אינו נתמך (מסוף USB אחד לקופה)", ואחריה שם המכשיר והקופה; גם `machineId` ו-`deviceId`):
  - ב-PATCH של הגדרות בכל רמה (tenant עד machine), כשמשתנה `paymentIntegration`, `multiPaymentDevices`, `paymentDeviceMode`, `fixedPaymentDeviceId` או `paymentDeviceGroup`. נבדקות כל הקופות הפעילות שהשכבה מגיעה אליהן. ערך שנשלח שוב בלי שינוי לא נבדק.
  - ביצירת מכשיר SynqPay ב-USB, ובעדכון שהופך מכשיר למכשיר USB (`field: "config.connection"`).
  - ב-"חיבור USB" מהקופה (`PUT /sync/{m}/payment-terminal`, ראו למטה). שם ה-`detail` הוא ההודעה עצמה (מחרוזת), כי הקופה מציגה אותו.
- **הקופה אוכפת את אותו כלל בעצמה** (`UsbTerminalRule.kt`): היא לא סולקת במכשיר USB ליד C4 ב-USB.
- **SynqPay ב-USB של הקופה עצמה (`paymentIntegration = synqpay`, `synqpayConnection = usb`) יחד עם `nayax_usb`** לא אפשרי: לקופה יש ערך אינטגרציה אחד.
- **מה לא נבדק:** העברת קופה לנקודת מכירה או לחנות אחרת. כאן הכלל של הקופה הוא הגיבוי.

### הגדרת המסופון מהקופה (`PUT /sync/{m}/payment-terminal`)

- אותה הרשאה כמו קודם: מנהל מחובר או הרשאת מנהל. נכתב לשכבת הקופה.
- **`connection`:** `"lan"` (או חסר, כמו קודם) או `"usb"`. ערך אחר — 422 `connection_invalid`.
- **`lan`:** הכתובת (`host` חובה, `port`, `path`) נכתבת כמו קודם, והתשובה לא השתנתה. אם בלי זה הקופה הייתה נשארת על `nayax_usb` (בשכבה שלה או בירושה), השכבה שלה עוברת ל-`paymentIntegration = nayax_lan`.
- **`usb`:** נכתב `paymentIntegration = nayax_usb`, בלי כתובת (`host` ריק או חסר). כתובת רשת שכבר שמורה נשארת לשימוש אחר כך.
  - `usbDevice` רשות: `VVVV:PPPP` נכתב ל-`nayaxUsbDevice`; `""` מוחק את הערך של הקופה; חסר משאיר אותו. ערך לא תקין — 422 `usb_device_invalid`.
  - תשובה: `{"connection": "usb", "paymentIntegration": "nayax_usb", "usbDevice": "0B00:0080" | null}`.

### סודות (הסיסמה)

- **כתיבה בלבד:**
  - הסיסמה (`zcreditPassword`) וה-Key (`zcreditKey`) נשלחים ב-PATCH הרגיל של השכבה.
  - הם לא נכתבים ל-JSON של השכבה (`exclude=True` בסכמה), ולא מוחזרים באף GET.
  - הדשבורד מציג "••••". אם הוא שולח בחזרה את ה-"••••" כמו שהוא, הערך השמור נשמר. `null` או `""` מוחקים.
- **במנוחה:**
  - טבלת `payment_integration_secrets` (level, entity_id, key, ciphertext), מוצפנת ב-Fernet.
  - המפתח הוא `PAYMENT_SECRETS_KEY`. אם הוא לא מוגדר, נגזר מ-`JWT_SECRET_KEY`, וכדאי להגדיר אותו בייצור לפני כל החלפה של מפתח ה-JWT.
- **לקופה:**
  - רק `GET /sync/{m}/settings`, המאומת בטוקן של הקופה, מוסיף `zcreditPassword`, ורק לקופה שהסוג שלה בפועל הוא `zcredit`.
  - ה-Key לא יוצא לקופה לעולם.
  - הקופה מעבירה את הסיסמה ל-EncryptedSharedPreferences (`PaymentSecretStore`), ולא לטבלת ההגדרות.
  - בסנכרון מלא שלא כולל אותה, הקופה מוחקת אותה.
- **השכבה הספציפית ביותר שיש לה סוד גוברת,** כמו בהגדרות.

### החלפה בקופה

- **`SwitchingEmvDevice`:**
  - הוא שכבת הספקים, והיעדים שלו: מובנה, Nayax בכתובת, Z-Credit בהגדרות שלו, או "לא מוגדר".
  - ההגדרות נקראות בכל קריאה.
  - יעד חדש נבנה רק כשאין מסגרת באוויר. בזמן מכירה, כל הקריאות, כולל הביטול שלה, הולכות לאותו מסוף.
  - שינוי שמגיע בסנכרון חל על הכרטיס הבא.
- **`TerminalFrameBridge` (קובץ חדש):**
  - מחבר כל `PaymentTerminal` שאינו TweezerComm לתפר `EmvDevice`.
  - הוא קורא את מסגרות ה-ashrait של הקופה (מכירה, זיכוי, ביטול, abort, getStatus, doPeriodic) ומחזיר תשובה בצורת ashrait.
  - לכן checkout, זיכויים, ביטולים והשידור לא השתנו.
- **מה שאין ל-Z-Credit תשובה עליו** (getConfig, setConfig, offline, getReport) חוזר כשגיאת JSON-RPC. כל הקוראים כבר מטפלים בזה.

## חלק ב׳ — Z-Credit

### מקורות

- התיעוד: https://docs.zcredit.co.il/docs/webservice/overview ועמודי המתודות.
- המפרט המלא (OpenAPI): https://docs.zcredit.co.il/specs/webservice.
- `llms-full.txt` באתר התיעוד.

### ממצאים

- **כתובת:** `https://pci.zcredit.co.il/ZCreditWS/api` (POST, JSON, TLS 1.2 ומעלה, `Content-Type: application/json`).
  - **אין כתובת נפרדת לבדיקות.** התיעוד מציג רק את השרת הזה, תחת התווית "Production server".
  - מסוף בדיקה עונה מאותו שרת. זה נבדק בקריאה לקריאה בלבד, ראו "בדיקת sandbox".
  - שדה המצב (`zcreditMode`) נשמר ומוצג, אבל כרגע אינו משנה כתובת (`ZCreditApi.baseUrl`).
- **אימות:** `TerminalNumber` + `Password` בגוף כל בקשה. בתיעוד מופיע גם `PINPAD_ID` כשדה אימות אופציונלי למסופונים, ובפועל מזהה המסופון עובר ב-`Track2`.
- **הפעלת מסופון: מהענן אל המכשיר.**
  - הקופה שולחת `CommitFullTransaction` עם `Track2 = "PINPAD<id>"`.
  - השער מעביר את העסקה למסופון, המסופון מציג את הסכום, הלקוח מעביר כרטיס, והתשובה חוזרת לקריאה המקורית.
  - הקופה לא מדברת עם המסופון ישירות, ולכן צריכה אינטרנט.
  - `ReleasePinpad` מוריד עסקה שעדיין מחכה לכרטיס.
- **מתודות:**
  - `CommitFullTransaction`: מכירה, תשלומים, וזיכוי בלי מקור (`TransactionType 53`).
  - `RefundTransaction`: לפי `ReferenceNumber`. לפני הפקדה הקריאה מבטלת, ואחרי הפקדה היא מזכה. סכום חלקי אפשרי.
  - `GetTransactionStatusByReferenceId` ו-`GetTransactionStatusByTransactionUniqueIdForQuery`: שאילתות סטטוס.
  - `ReleasePinpad`, `DepositTerminal`, `GetDepositReport`, `GetTransactionsReport`.
  - עוד מתודות שלא נכנסו לשימוש: `CompleteJ5Transaction`, `ShowQRCode`, `GetTrack2Data`, `CreateInvoiceReceipt`.
- **סוגי אשראי:** `CreditType` 1 רגיל, 2 ישראקרדיט/30+, 3 חיוב מיידי, 6 קרדיט, 8 תשלומים. `J`: 0 חיוב, 2 בדיקה, 5 תפיסת מסגרת.
- **תשלומים:** `CreditType=8` עם `NumberOfPayments`. בלי `FirstPaymentSum` / `OtherPaymentsSum` השער מחלק שווה בשווה.
- **מניעת כפילות:** `TransactionUniqueID`. עסקה עם מזהה זהה נדחית עם `-88001`, או `-88002` במצב המתקדם.
- **שאילתה:** `TransactionUniqueIdForQuery` נשלח במכירה, ואפשר לשאול עליו אחר כך.
- **שובר:** `ClientReciept` / `SellerReciept` כטקסט ל-80 מ"מ. בתשובה האמיתית הופיעו גם `ClientRecieptPP` / `SellerRecieptPP`, כנראה גרסת המסופון.
- **נתוני כרטיס:**
  - `CardNumber` עשוי להיות המספר המלא, לפי הגדרה במסוף.
  - **הקופה שומרת רק 4 ספרות אחרונות.**
  - `Token`, `CardBIN`, תוקף, `HolderID`, `IntOt*` ו-`ResultRecord` לא נשמרים ולא עוברים הלאה.
- **מותג וחברה:** הקודים של Z-Credit למותג שונים משל שב"א ב-3 וב-8 (דיינרס ומאסטרו). הקופה ממירה ל-`mutag` של שב"א, וחברות 1/2/3/4/6 זהות.
- **קודי שגיאה:** `-1…-20` פרטי התחברות, `-80` "Transaction was not found" (לא מתועד; נראה בפועל), `-844` לא ניתן לזיכוי, `-9xxx` מסופון, קודי שב"א 1–998, `-88001` / `-88002` כפילות.
  - **אישור טלפוני:** `IsTelApprovalNeeded` יחד עם קוד 3. ב-`ReturnMessage` מופיע המספר להתקשר אליו, ומציגים אותו בדיוק כפי שהגיע.
- **סטטוס עסקה (שאילתה):** 1 מאושרת ולא הופקדה, 2 הופקדה, 3 בוטלה, 4 זוכתה, 6 זוכתה חלקית, 900–904 J5.
- **הפקדה (מקביל לשידור / Z):** `DepositTerminal` מפקיד את כל העסקאות המאושרות שלא הופקדו במסוף, ומחזיר:
  - `ReferenceNumber` של ההפקדה;
  - `TotalDebit` / `TotalCredit` באגורות;
  - `TotalNumber`;
  - `Report`.

### המיפוי לתהליכים שלנו

| התהליך בקופה | המסגרת שהקופה שולחת היום | הקריאה ל-Z-Credit |
|---|---|---|
| מכירה | `doTransaction` tranType 1 | `CommitFullTransaction`: `Track2=PINPAD<id>`, `TransactionType "01"`, `CreditType 1`, `IsCustomerPresent=true`, `TransactionUniqueID` = `TransactionUniqueIdForQuery` = `R2M-<קופה>-<vuid>` |
| תשלומים | `creditPayments` > 1 | כמו מכירה, עם `CreditType 8` ו-`NumberOfPayments`. אחרי אישור נשלחת `GetTransactionStatusByReferenceId`, כדי לקרוא את התשלומים כפי שנקבעו בפועל. |
| זיכוי מקושר | tranType 53 + `originalTransactionId` | `RefundTransaction` (`TransactionIdToCancelOrRefund` = `ReferenceNumber` של המכירה, `TransactionSum`) |
| זיכוי לא מקושר | tranType 53 בלי מקור | `CommitFullTransaction` `TransactionType "53"` על המסופון |
| ביטול עסקה | `cancelTransaction(originalUID)` | `RefundTransaction` בלי סכום (מלא). השער מבטל לפני הפקדה ומזכה אחריה. |
| עצירה לפני כרטיס | `abortTransaction` | `ReleasePinpad` |
| בירור אחרי תשובה שאבדה | (בתוך הגשר) | קודם `ReleasePinpad`, ואז `GetTransactionStatusByTransactionUniqueIdForQuery`, עד 3 פעמים |
| כפילות `-88001` | | בירור לפי המזהה, ומחזירים את התשובה של העסקה הראשונה |
| שידור / Z | `doPeriodic` | `DepositTerminal`. אין רשימת עסקאות, ולכן כל הרגליים הממתינות של הקופה נחשבות שודרו. ההתאמה מול Z-Credit (חלק ג׳) בודקת את ההנחה הזו מול דוח ההפקדות. |
| בדיקת חיבור / getStatus | `getStatus` | שאילתה על מזהה שלא קיים. `-80` פירושו "התחברות תקינה", וקוד `-1…-20` פירושו פרטים שגויים. לא משנה כלום. |
| הקלדת כרטיס (MOTO) | tranCode 5 | נדחה בקופה. מספר כרטיס לעולם לא עובר בקופה. |

- **ה-uid וה-transactionId** של העסקה בקופה שניהם `ReferenceNumber`. לכן ביטול וזיכוי מקושר עובדים בלי שינוי.
- **בלי ניסיונות חוזרים אוטומטיים:**
  - מכירה נשלחת פעם אחת. ל-HTTP אין retry (`retryOnConnectionFailure(false)`).
  - אחרי תשובה שאבדה הגשר משחרר את המסופון ושואל לפי המזהה.
  - אם העסקה נמצאה, מחזירים אותה. אם הסכום שונה, מחזירים "לבדוק ידנית".
  - אם לא נמצאה, או שאי אפשר לשאול, מחזירים TRANSPORT_ERROR עם "בדקו בדוח העסקאות לפני חיוב חוזר". אף פעם לא "נדחה".
- **מזהה הקופה במזהה העסקה:** מוני ה-vuid של שתי קופות על אותו מסוף Z-Credit חופפים. בלי מזהה הקופה, בירור של קופה אחת היה מוצא עסקה של השנייה.
- **זמנים:**
  - מכירה: 150 שניות, פחות מזמן המסגרת של checkout (180), כדי שהשחרור והבירור ייכנסו בזמן.
  - זיכוי: 60 שניות. שאילתה: 10 שניות. הפקדה: 120 שניות.
- **לוגים:** רק הנתיב והקוד. הגוף, שמכיל את הסיסמה, לא נרשם. התשובה שנשמרת במטא של העסקה וביומן היא בצורת ashrait, אחרי סינון.

### זיכוי מהענן (8.10.2026)

- הענן מזכה מכירה של Z-Credit בעצמו: `GetTransactionStatusByReferenceId` (האם עוד אפשר) ואז `RefundTransaction` — אותו גוף שהקופה שולחת (`TransactionIdToCancelOrRefund`, `TransactionSum`). מסמך הזיכוי מופק בקופה. ראו [SPEC_REMOTE_CREDIT.md §11](SPEC_REMOTE_CREDIT.md).
- `RefundTransaction` לא נושא מזהה שלנו (אין `TransactionUniqueID` מתועד לקריאה הזו), ולכן תשובה שאבדה מתבררת רק לפי מצב המכירה, ו-6 ← 6 (זיכוי חלקי שני) לא ניתן להכרעה בלי בדיקה ידנית. שאלה ל-Z-Credit: האם `RefundTransaction` מקבל מזהה לבירור / לחסימת כפילות, והאם תשובת הסטטוס מחזירה את הסכום שזוכה.

### בדיקת sandbox (5.10.2026)

- **מה הורשה:** בעל המערכת אישר קריאה לשרת הרגיל, עם מסוף הבדיקה, בקריאות לקריאה בלבד.
- **מה לא רץ:** מכירה, ביטול או הפקדה. אין כרטיסי בדיקה מפורסמים, ומזהה מסופון הבדיקה לא ידוע. אלה נשארים לבעל המערכת, עם מסופון פיזי.
- **סקריפט:** `%TEMP%\zc\sandbox_readonly.py`, מחוץ לריפו. הוא קורא את פרטי המסוף מהקובץ בזמן ריצה וממסך כל פלט.
- **הרצה:**

| קריאה | גוף (בלי פרטי התחברות) | תוצאה |
|---|---|---|
| `GetTransactionStatusByTransactionUniqueIdForQuery` | `UniqueQuery = R2M-SANDBOX-<אקראי>` | HTTP 200, 480ms. `HasError=true`, `ReturnCode=-80`, `"Transaction was not found"`. כלומר פרטי ההתחברות התקבלו. |
| `GetTransactionStatusByReferenceId` | `ReferenceID = "1"` | HTTP 200, 331ms. אותה תשובה (`-80`). |

- **מסוף:** `08******16`, סיסמה `Z0*******16`. ה-Key (64 תווי hex) לא נשלח.
- **ממצאים מהתשובה האמיתית:**
  - HTTP 200, ולא 201 כמו בתיעוד.
  - `ReferenceNumber` הגיע כמספר (`0`), ולא כמחרוזת.
  - `DepositId` הגיע באות d קטנה, לא `DepositID`.
  - שדות שלא בתיעוד: `ClientRecieptPP`, `SellerRecieptPP`, `StarsSum`, `LocationData`, `ApplicationType`, `StatusDescription`, `PinpadId`, `TPN`.
  - המפענח קורא את כל אלה, והתשובה עצמה (בלי סודות) משמשת כ-fixture בבדיקות היחידה.

### קבצים

- **שרת:**
  - `app/services/payment_integration.py`, `app/services/payment_secrets.py`, `app/models/payment_secret.py`.
  - `app/routers/payment_integration.py`.
  - נגיעות ב-`settings_merge.py`, `routers/settings.py`, `routers/sync.py`, `routers/shops.py`, `schemas/{pos_settings,shop,pos_machine}.py`, `services/terminal_status.py`, `config.py`, `main.py`.
  - מיגרציה `5c7e9a1b3d24`.
  - בדיקות: `tests/test_payment_integration.py`.
- **קופה:**
  - `domain/PaymentIntegration.kt`, `data/PaymentSecretStore.kt`.
  - `hardware/payment/TerminalFrameBridge.kt`, `hardware/payment/zcredit/{ZCreditRequests,ZCreditReplies,ZCreditClient,ZCreditTerminal}.kt`.
  - `ui/settings/ZCreditDiagnosticsSection.kt`.
  - נגיעות ב-`PaymentTerminalConfig.kt`, `SwitchingEmvDevice.kt`, `nayax/PaymentTerminal.kt` (`TerminalKind.ZCREDIT`), `SettingsRepository.kt`, `AppContainer.kt`, `PinpadDiagnosticsSection.kt`, `strings.xml`.
- **דשבורד:**
  - `src/lib/paymentIntegration.ts` (+ `.test.ts`), `src/lib/paymentIntegrationApi.ts`, `src/components/payment-integration-section.tsx`.
  - נגיעות ב-`pos-settings-form.tsx`, `entity-settings-dialog.tsx`, `shop-form-dialog.tsx`, `machine-row.tsx`, `posMachine.ts`, `types.ts`, `package.json`.

### בדיקות

- **שרת:** `tests/test_payment_integration.py`, 33 בדיקות:
  - הרזולוציה בין השכבות, auto ותאימות;
  - ולידציה לפי סוג וכלל הקופה בלי מסוף מובנה;
  - סודות: לא ב-JSON, מוצפנים, המסכה שומרת ו-`null` מוחק, יורדים רק לקופה על Z-Credit, ומוסתרים בלוג הבקשות;
  - רשימת הקופות, ה-context ופתיחת חנות.
- **קופה:** 54 בדיקות.
  - `PaymentIntegrationTest`: 12.
  - `ZCreditRepliesTest`: 16, על הדוגמאות מהתיעוד ועל התשובה האמיתית `-80`.
  - `ZCreditTerminalTest`: 20, עם שער מזויף: מכירה פעם אחת, כפילות, תשובה שאבדה, זיכוי, ביטול, הפקדה, הגשר מול מסגרות checkout, ואין סודות בלוג.
  - `SwitchingIntegrationTest`: 6, החלפה רק כשאין עסקה באוויר.
- **דשבורד:** 49 בדיקות ב-`paymentIntegration.test.ts`.

## חלק ג׳ — התאמת אשראי מול Z-Credit (9.10.2026)

בעל המערכת (9.10): "יש אפשרות ב-Z-Credit לעשות התאמה בין העסקאות אשראי שלנו מול מסוף Z-Credit?"

**כן.** ל-Z-Credit יש שתי קריאות דוח, שתיהן לקריאה בלבד: `GetTransactionsReport` ו-`GetDepositReport`. ההתאמה משווה, עסקה מול עסקה, את רגלי האשראי של Z-Credit אצלנו מול מה שהמסוף עצמו רשם, ואת ההפקדות מול השידורים שלנו.

### מחקר: מה התיעוד אומר

המקור הוא המפרט (https://docs.zcredit.co.il/specs/webservice) ועמודי המתודות (`/docs/webservice/get-transactions-report`, `/docs/webservice/get-deposit-report`), כפי שנקראו ב-9.10.2026. הדוגמאות המתועדות שמורות כ-fixtures בבדיקות (`tests/fixtures/zcredit_reports/`).

#### `GetTransactionsReport`

- **קריאה:** `POST /Reports/GetTransactionsReport`. המפרט מתעד את התשובה כ-HTTP 201, ובפועל השער עונה 200 (ראו "בדיקת sandbox").
- **שדות הבקשה:**

| שדה | סוג | חובה | משמעות |
|---|---|---|---|
| `TerminalNumber`, `Password` | string | כן | פרטי המסוף |
| `FromDate`, `ToDate` | string | כן | `yyyy-MM-dd HH:mm:ss`. אין אזור זמן, ולכן אנחנו שולחים שעון ישראל, כמו `SaveDate` בתשובה. |
| `FromTransactionSum`, `ToTransactionSum` | number | לא | טווח סכומים |
| `Card4Digits` | string | לא | סינון לפי 4 ספרות אחרונות |
| `IncludeJ5` | boolean | לא | לכלול תפיסות מסגרת (J5). אנחנו שולחים `false`. |
| `SearchType` | integer | לא | 0 עסקאות שהצליחו (ברירת מחדל), 1 עסקאות שנכשלו. אנחנו שולחים 0. |

- **אין סינון לפי מסופון (PinPad), ואין סינון לפי `TransactionUniqueID`.** הדוח הוא של כל המסוף.
- **התשובה:** `HasError`, `ReturnCode`, `ReturnMessage` ו-`Transactions[]`. כל איבר במערך הוא באותו מבנה של `GetTransactionStatusByReferenceId`:

| שדה | מה אנחנו עושים איתו |
|---|---|
| `ReferenceNumber` | מפתח ההתאמה (string; ראינו גם מספר) |
| `TransactionSum` | שקלים בפורמט `##.##`, ואנחנו ממירים לאגורות |
| `StatusCode` | 1 אושרה וטרם הופקדה, 2 הופקדה, 3 בוטלה, 4 זוכתה, 6 זוכתה חלקית, 900–904 J5 |
| `DealTypeCode` | `"01"` רגילה, `"51"` זיכוי |
| `J` | 0 חיוב, 2 בדיקה, 5 תפיסת מסגרת. 2 ו-5 לא נספרות. |
| `CardNumber` | "4 ספרות אחרונות", ולפי הגדרת המסוף עלול להגיע מלא. **נשמרות רק 4 אחרונות.** |
| `CardBrandCode`, `CardIssuerCode`, `CardFinancerCode`, `CardName` | מותג, מנפיק, סולק. נשמר רק `CardName`. |
| `NumberOfPayments`, `FirstPaymentSum`, `OtherPaymentsSum`, `CreditTypeCode` | תשלומים |
| `DepositID` | מספר ההפקדה. בתשובה האמיתית הגיע `DepositId`, ושניהם נקראים. `"00000000"` פירושו "אין". |
| `ApprovalNumber`, `VoucherNumber`, `SaveDate`, `PanEntryMode`, `PaymentMethod` | פרטים לתצוגה |
| `Token`, `HolderID`, `Customer*`, `ExpDate_MMYY`, הקבלות | **לא נקראים ולא נשמרים** |

- **אין `TransactionUniqueID` בשורות הדוח.** לכן ההתאמה לפי המזהה שלנו עוברת דרך `GetTransactionStatusByTransactionUniqueIdForQuery`, כרגל בודדת.

#### `GetDepositReport`

- **קריאה:** `POST /Terminal/GetDepositReport`.
- **שדות הבקשה:**
  - `TerminalNumber` ו-`Password`, חובה.
  - `FromDate` / `ToDate` באותו פורמט, רשות.
  - `DepositID` (integer): מספר הפקדה מסוים, או `-1` לחיפוש לפי תאריכים. אנחנו שולחים `-1`.
- **התשובה:** `Data[]`, כל איבר במבנה של `DepositTerminal`:
  - `ReferenceNumber`: מספר ההפקדה. זה ה-`batch_number` שהקופה רושמת בשידור.
  - `TotalDebit` / `TotalCredit`: לפי התיעוד, באגורות. הדוגמה (`1035` מול עסקה של `10.35`) מאשרת.
  - `TotalNumber`, `TotalXML`, `Report`. את `TotalXML` ו-`Report` איננו שומרים.

#### מגבלות ודפדוף

- **התיעוד לא מציין מגבלה** על טווח התאריכים או על מספר השורות, ואין דפדוף.
- לכן כל הרצה מבקשת יום אחד בלבד, עם שוליים של 30 דקות לכל צד, וזמן ההמתנה הוא 60 שניות.
- השאלה נשלחת ל-Z-Credit (ראו "שאלות פתוחות").

### ההתאמה

#### הצדדים

- **מסוף:**
  - כל קופה פעילה שסוג האינטגרציה שלה בפועל הוא `zcredit`.
  - הקופות מקובצות לפי מספר המסוף. פרטי ההתחברות נפתרים על השכבות בדיוק כמו בזיכוי מהענן (`cloud_card_refunds.credentials_for`), והשכבה הספציפית ביותר גוברת.
  - קופות שחולקות מסוף נבדקות בהרצה אחת.
  - מסוף נקרא תמיד שלם, גם כשמנהל עם הרשאה צרה יותר מריץ אותו. אחרת, חיוב של קופה אחרת על אותו מסוף היה נראה כ"חיוב בלי מסמך".
- **שלנו:**
  - רגלי `card` שתשובת המסוף שלהן אומרת `provider: zcredit`, במסמכים בסטטוס completed, refunded, partial_refund או cancelled.
  - אם המטא מציין מסוף אחר, הרגל לא נבדקת.
  - הסכום הוא מה שהמסוף חייב: הרגל, ועוד טיפ האשראי של המסמך.
  - רגל של "ללא החזר כספי" לא נבדקת.
- **יום עסקים:** יום קלנדרי בשעון ישראל, עם שוליים של 30 דקות לכל צד. שוליים אלה משמשים רק לשיוך. פריט שאף צד שלו לא נמצא בתוך היום שייך להרצה של היום הסמוך.

#### שיוך

1. לפי `ReferenceNumber`. הקופה שומרת אותו כ-`zcreditReferenceNumber`, וגם כ-`uid` / `transactionId`.
2. רגל שאין לה אסמכתא, או שהאסמכתא שלה לא בדוח, נשאלת ב-Z-Credit:
   - יש אסמכתא: נשאלת לפי האסמכתא.
   - אין אסמכתא: נשאלת לפי `TransactionUniqueID` שלנו, `R2M-<12 התווים הראשונים של מזהה הקופה>-<vuid>`, כמו שהקופה שולחת.
   - מקסימום 40 שאילתות להרצה, וכל אחת עם זמן המתנה של 10 שניות.
3. סכום, כרטיס או זמן **לא משייכים לעולם.** הם רק מציעים קשר (`related`): מועמדים ל"צור זיכוי", וחשד לחיוב כפול.

#### הקטגוריות

| | קטגוריה | מתי |
|---|---|---|
| ✅ | `matched` (תואם) | אותה אסמכתא, אותו סכום, סטטוס עקבי והפקדה עקבית |
| ⚠️ | `amount_mismatch` (הפרש סכום) | `TransactionSum` שונה ממה שהרגל שלנו חייבה |
| ⚠️ | `status_mismatch` (הפרש סטטוס) | ב-Z-Credit בוטלה / זוכתה / זוכתה חלקית (3/4/6), ואצלנו לא נלקח כלום בחזרה לכרטיס. או ההפך: אצלנו בוטל או זוכה באשראי, וב-Z-Credit העסקה שלמה (1/2). "נלקח בחזרה" = רגלי Z-Credit של מסמכי זיכוי למקור, ועוד זיכויים מהענן שמסמך הזיכוי שלהם עוד לא הגיע. |
| ❌ | `zcredit_only` (חיוב ב-Z-Credit בלי מסמך שלנו) | שורה בדוח שאין לה רגל אצלנו. זיכוי מהענן שמסמך הזיכוי שלו עוד לא הגיע מסווג תואם, עם הערה. |
| ❌ | `ours_only` (מסמך שלנו בלי עסקה ב-Z-Credit) | רגל שאין לה שורה, וגם השאילתה לא מצאה אותה. מסמך שבוטל ואין לו שורה לא נחשב: ביטול לפני הפקדה לא משאיר שורה. |
| ⚠️ | `duplicate` (כפילות) | אסמכתא אחת על שני מסמכים שלנו, או אסמכתא שמופיעה פעמיים בדוח |
| ⚠️ | `deposit_mismatch` (הפקדה מול שידור) | הופקדה ב-Z-Credit (2 / `DepositID`) ואצלנו לא סומנה כמשודרת. או ההפך. או שההפקדה שונה מהמנה שלנו. |

- כשחלות כמה קטגוריות, הראשונה מבין סכום ← סטטוס ← הפקדה קובעת, וכל הסיבות נשמרות.
- **חשד לחיוב כפול:** חיוב ב-Z-Credit בלי מסמך, עם אותו כרטיס ואותו סכום כמו חיוב מתועד בטווח של 10 דקות, מקבל את ההערה "ייתכן חיוב כפול".
- **סיכום:** לכל קטגוריה נשמרים כמות, סכום ב-Z-Credit וסכום אצלנו (זיכויים בשלילה).

#### הפקדות מול שידורים

- נבדקת כל הפקדה שהיום נוגע בה:
  - שורות היום מציינות אותה, או
  - שידור שלנו של היום (עד 12:00 למחרת) נרשם עם המנה שלה.
- נקרא דוח ההפקדות מתחילת היום עד 12:00 למחרת.
- **השוואה:** `TotalDebit − TotalCredit` ו-`TotalNumber` מול הרגליים שהקופה סימנה בשידור של אותה מנה, בנטו ובכמות.
  - זו הבדיקה האמיתית: בהפקדה של Z-Credit הקופה מסמנת **כל** רגל ממתינה כמשודרת.
  - הסכום שהשידור עצמו דיווח מוצג להשוואה.
- **הפקדה בלי שידור שלנו:** חסר.
- **שידור בלי הפקדה ב-Z-Credit:** חסר.

#### קריאה בלבד

- **הקריאות היחידות:**
  - `GetTransactionsReport`;
  - `GetDepositReport`;
  - `GetTransactionStatusByReferenceId`;
  - `GetTransactionStatusByTransactionUniqueIdForQuery`.
- **אין קריאות כתיבה:** `app/services/zcredit_reports.py` מסרב לכל נתיב אחר, ובדיקה נועלת ש-`RefundTransaction`, `CommitFullTransaction`, `DepositTerminal` ו-`ReleasePinpad` לא מופיעים בו.
- **הלקוח האמיתי:**
  - בלי retry ובלי redirect;
  - הגוף, כולל הסיסמה, אף פעם לא נרשם ללוג;
  - מסרב להיבנות בתוך pytest.
- **השער של הזיכוי מהענן (`zcredit_gateway.py`) לא שונה:** המודול החדש רק משתמש בעזרים שלו.

### אוטומציה

- **לילית:**
  - worker ברקע (`app/services/zcredit_reconcile_worker.py`), עם מתג `ZCREDIT_RECONCILE_WORKER_ENABLED` שפעיל כברירת מחדל.
  - הוא בודק כל 5 דקות, תחת advisory lock של Postgres.
  - כל מסוף פעיל נבדק ליום העסקים הקודם, אחרי `zcreditReconcileTime`, פעם אחת ביום.
  - אם Z-Credit לא נקרא, יש עד 3 ניסיונות, בהפרש של 30 דקות לפחות.
  - הרצה שנשארה "רצה" יותר מ-15 דקות נסגרת ככושלת.
- **פרמטרים דינמיים לקופות** (`app/services/zcredit_reconcile.py`, נרשמים ב-`till_parameters`; לחברה, לסניף, לנקודת מכירה או לקופה):
  - `zcreditReconcileEnabled` (boolean, ברירת מחדל **פעיל**): חל רק במקום ש-Z-Credit מוגדר. מסוף נבדק אם הפרמטר פעיל באחת הקופות שלו.
  - `zcreditReconcileTime` (`HH:MM`, ברירת מחדל `06:00`): כשכמה קופות על אותו מסוף, נלקחת השעה המאוחרת מביניהן. ערך לא תקין נדחה.
- **"הרץ התאמה עכשיו":** `POST /zcredit-reconciliation/run` (`{date, terminalKey?, shopId?}`).
  - ברירת המחדל היא אתמול. יום עתידי נדחה.
  - עד 10 מסופים לבקשה.
  - הרצה שכבר רצה לאותו מסוף ויום מוחזרת, ולא מתחילה שוב.
- **שמירה:**
  - `zcredit_recon_runs`: הרצה לכל מסוף ויום, עם הסיכום וההפקדות.
  - `zcredit_recon_items`: שורה לכל עסקה, עם שני הצדדים וה"טופל".
  - מיגרציה `5d2b8f1e7c39`, add-only ואידמפוטנטית.
  - ההרצה האחרונה של מסוף ויום היא התקפה. "טופל" עובר להרצה חוזרת לפי `fingerprint`.
- **חריגות:**
  - כל ❌ שלא טופל הוא חריגה אחת מסוג `zcredit_recon` (חומרה גבוהה) ביומן החריגות.
  - החריגה אידמפוטנטית לפי ה-fingerprint, וכללי החריגות של הקופה יכולים לכבות אותה.
  - "טופל" בדף ההתאמה מסמן את החריגה כנבדקה, עם אותה הערה.
  - בהתראות לטלפון יש קטגוריה חדשה, `card_reconcile` ("אי-התאמה מול Z-Credit"), וההתראה מובילה לדף ההרצה.
  - ב-SMS הקטגוריה opt-in: כלל "כל הסוגים" קיים לא מתחיל לשלוח אותה.
- **תג בקוקפיט:** הספק `zcreditRecon` ב"דורש תשומת לב" (`GET /zcredit-reconciliation/attention`).
  - הוא מציג לכל מסוף ויום כמה ❌ פתוחים, וכן לילה ש-Z-Credit לא נקרא בו.
  - כפתור "להתאמה" פותח את ההרצה.

### הדשבורד — `/dashboard/zcredit-reconciliation`

- **מסופים:** מוצגים לפי 4 הספרות האחרונות בלבד (`••••1234`), יחד עם הסניפים, הקופות, ההתאמה הלילית (שעה או כבוי) וההרצה האחרונה. מוצגות גם קופות של Z-Credit שחסרים להן פרטי מסוף.
- **ימים ומסופים:** טבלה לפי יום ומסוף, עם סינון תאריכים ומסוף. לכל שורה: מצב, כמות לכל קטגוריה, ❌ פתוחים.
- **הרצה:** סיכום לכל קטגוריה (כמות, סכום ב-Z-Credit, סכום אצלנו), הפקדות מול שידורים, ורשימת העסקאות.
  - **סינון:** לפי קטגוריה, "רק פתוחות", וחיפוש לפי אסמכתא, מסמך, כרטיס או קופה.
  - **ייצוא CSV:** המסוף ממוסך, וכרטיס רק ב-4 ספרות.
  - **קישור למסמך שלנו:** `/dashboard/transactions?tx=`.
- **"צור זיכוי"** (רק לחיוב ב-Z-Credit בלי מסמך שלנו):
  - **ההתאמה לא מזכה בעצמה.** הדיאלוג מציג את המסמכים שהחיוב יכול להיות שלהם: אותו כרטיס ואותו סכום, בטווח של 30 דקות. קודם מסמך שלנו בלי עסקה, ואחריו חיוב מתועד (ייתכן כפול).
  - לכל מסמך יש "צור זיכוי" הקיים (זיכוי מרחוק) וקישור למסמך. שם, על רגל ה-Z-Credit, נמצא "זיכוי באשראי (Z-Credit)" מהענן.
  - כשאין מסמך מתאים: החזר בלי מסמך נעשה בבק-אופיס של Z-Credit, ואז "טופל מחוץ למערכת".
- **"סמן כטופל"** עם הערה, ו"בטל טופל".
- **הרשאות:**
  - קריאה דרך "דוחות" או "זדים ומשמרות" ברמת צפייה. התג גם דרך "הניהול שלי".
  - הרצה וטיפול דורשים אותם סעיפים ברמת עריכה.
  - כל משתמש רואה רק הרצות של מסופים שקופה בהרשאות שלו סולקת בהם.

### קבצים

- **שרת:**
  - `app/services/zcredit_reports.py`: הלקוח לקריאה בלבד והמפענחים.
  - `app/services/zcredit_recon_match.py`: השיוך והקטגוריות, טהור.
  - `app/services/zcredit_reconcile.py`: מסופים, הרצה, הפקדות, חריגות, פרמטרים.
  - `app/services/zcredit_reconcile_worker.py`.
  - `app/models/zcredit_reconciliation.py`, `app/routers/zcredit_reconciliation.py`.
  - מיגרציה `5d2b8f1e7c39`.
  - נגיעות תוספתיות בלבד ב-`main.py`, `models/__init__.py`, `exceptions.py`, `exception_alerts/{catalog,push}.py`, `till_parameters.py`, `dashboard_sections.py`.
- **בדיקות:**
  - `tests/test_zcredit_reconcile.py`, עם שער מזויף ו-fixtures מהדוגמאות המתועדות.
  - מפת הנתיבים `tests/fixtures/dashboard_route_sections.txt`.
- **דשבורד:**
  - `src/app/dashboard/zcredit-reconciliation/page.tsx`.
  - `src/components/dashboard/zcredit-recon/{credit-dialog,handle-dialog}.tsx`.
  - `src/components/dashboard/cockpit/zcredit-recon-slot.ts`.
  - `src/lib/zcreditRecon.ts` (עם `.test.ts`), `src/lib/zcreditReconApi.ts`.
  - נגיעות ב-`navigation.ts`, `dashboardAccess.ts`, `exceptionsApi.ts`, `pushAlerts.ts`, `cockpit/registry.ts`, `exceptions/page.tsx`, `he.json`, `package.json`.

## שאלות פתוחות

### ל-Z-Credit

1. **שרת-לשרת:**
   - התיעוד אומר "All calls must be made server-to-server", ושהסיסמה לא תיחשף בצד הלקוח.
   - הקופה היא אפליקציה במכשיר, לא דפדפן, והסיסמה נשמרת בה מוצפנת. האם זה מקובל עליהם?
   - **החלופה:** פרוקסי בענן שלנו (`/sync/{m}/zcredit/...`), שבו הסיסמה לא יורדת לקופה בכלל.
2. **שרת בדיקות:**
   - יש שרת "בטא" למסופי בדיקה? קוד שב"א 298 מדבר על "ניסיון לעבוד עם מסוף ייצור דרך אתר בטא".
   - אם אין, האם בכלל צריך את שדה המצב?
3. **מזהה מסופון וכרטיסים לבדיקה:** מה מזהה המסופון של מסוף הבדיקה, ואילו כרטיסי בדיקה יש? בלי אלה לא הרצנו מכירה.
4. **זמני מסופון:**
   - כמה זמן `CommitFullTransaction` ממתין לכרטיס?
   - מה חוזר כשהלקוח מבטל במסופון, או לא מעביר כרטיס (500? `-9xxx`?)
   - מה חוזר כשהמסופון כבוי?
5. **קוד פרטי התחברות שגויים:** איזה מבין `-1…-20` חוזר על סיסמה שגויה? (לא בדקנו, כדי לא לנעול את מסוף הבדיקה.)
6. **`RefundTransaction` חלקי לפני הפקדה:** זה ביטול מלא או זיכוי חלקי? האם ביטול לפני הפקדה דורש את הסכום המלא?
7. **זיכוי בלי מקור (`TransactionType 53`) על מסופון:** מותר במסוף רגיל, או צריך הרשאה?
8. **אישור טלפוני:** לא ממומש, ומוצג כ"נדרש אישור טלפוני: <ההודעה>". האם צריך את הזרימה של שליחה חוזרת עם `AuthNum`?
9. **הפקדה:**
   - המסוף מפקיד אוטומטית כל לילה?
   - מה `DepositTerminal` מחזיר כשאין מה להפקיד?
   - כשכמה קופות חולקות מסוף, הפקדה של קופה אחת מפקידה גם את של האחרות. ההמלצה: מסוף אחד לכל קופה, או לכבות הפקדה מהקופה.
10. **טיפ במסופון:** האם להשתמש באובייקט `Tip` של Z-Credit במקום "טיפ במסופון" של Nayax?
11. **שובר:**
    - צריך להדפיס בקופה את `ClientReciept`, או ש-Z-Credit שולחים / המסופון מדפיס? אותו פער קיים היום במסופון Nayax ברשת.
    - השובר כבר נשמר במטא של העסקה (`customerReceipt`).
12. **ה-Key (64 hex):** לפי התיעוד הוא של WebCheckout. נשמר כסוד, לא נשלח לקופה. נדרש למשהו במסופון?

### לבעל המערכת

13. **כפתור "הקלדת כרטיס":** בקופה על Z-Credit הוא נדחה עם הודעה. להסתיר אותו מראש?
14. **`expectedTerminalNumber` / `clearingServer` / מצב לא מקוון:** אלה מושגים של Agamento. בחנות על Z-Credit כדאי להשאיר אותם ריקים.
    - מספר מסוף Agamento ישן שנשמר בקופה עלול להציג "מסוף לא תואם", אם מוגדר מספר צפוי.
15. **`PAYMENT_SECRETS_KEY`:** להגדיר בשרת הייצור לפני השקה.

### ל-Z-Credit — ההתאמה (חלק ג׳)

16. **מגבלות `GetTransactionsReport`:** יש מקסימום ימים בטווח, מקסימום שורות או דפדוף? התיעוד לא אומר. בינתיים: יום אחד לכל קריאה.
17. **אזור זמן:** `FromDate` / `ToDate` ו-`SaveDate` הם בשעון ישראל? הנחנו שכן, כי אין בהם אזור.
18. **מה הדוח כולל עם `SearchType 0`:**
    - עסקאות שבוטלו או זוכו מופיעות, בסטטוס 3/4/6?
    - זיכוי (`RefundTransaction`, או `TransactionType 53`) מופיע כשורה נפרדת, עם `DealTypeCode 51` ואסמכתא משלו?
19. **ההפקדה:** `ReferenceNumber` של `GetDepositReport` זהה ל-`DepositID` שבשורות העסקאות, ול-`ReferenceNumber` ש-`DepositTerminal` מחזיר?
20. **`TransactionUniqueID` בשורות הדוח:** אפשר לקבל אותו? היום כל רגל שאין לה אסמכתא נשאלת בנפרד.
