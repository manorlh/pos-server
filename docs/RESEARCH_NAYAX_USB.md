# מחקר: מסוף Nayax בחיבור USB לקופה גדולה (Android) — Nova C4

**תאריך:** 2026-10-04
**מצב:** מחקר, תכנון ושלד קוד. השלד לא מחובר לאפליקציה, אין שינויי סכמה ואין שינוי בקבצים קיימים.
**היקף:** קופת דלפק Android עם מסך גדול ובלי קורא כרטיסים, ולידה מסוף אשראי של Nayax בכבל.

**מקרא:**
- ✅ מאומת: ראיתי את זה במקור שמצוטט ליד.
- 🔶 הסקה: מסקנה שלי מתוך כמה מקורות. לא כתובה כך באף מקור.
- ❓ פתוח: צריך לברר עם Nayax.

---

## 0. תקציר

1. ✅ **"C4" הוא ה-Nayax Nova C4.** זה פינפד Android עם מסך 4", מוסמך PCI PTS 6.x. Nayax ישראל מוכרת אותו בשם "מסופון אשראי Pin Pad בתקן EMV לקופה רושמת ממוחשבת", ומציינת "חיבור USB" ו"חיבור קווי או אלחוטי" [S1]. לפי מפרט של מפיץ, יש לו USB, RS232, Ethernet, Bluetooth ו-Wi-Fi [S2].
2. ✅ **מאחורי המסוף רצה אותה אפליקציה שכבר עובדת אצלנו.** במסופי Nova רצה Agamento, אפליקציית התשלום של Modularity. Nayax רכשה את Modularity ב-2019/2020 [C1][C2]. הקופה מדברת עם Agamento ב-**TweezerComm**: JSON-RPC 2.0, ובישראל השירות הוא `ashrait` [D2][D3].
   - זה **בדיוק** הפרוטוקול שהאפליקציה כבר מדברת עם Agamento ב-Nova 55F דרך AIDL.
   - זה גם מה שהקופה השולחנית (desktop) שולחת ב-HTTP אל `/SPICy`.
3. ✅ **TweezerComm מתועד בפומבי, כולל שיטות ישראל:** מכירה, תשלומים, החזר, ביטול, abort, שידור (`doPeriodic`), דוחות, סטטוס ושחזור לפי `vuid` [D8–D22].
   - 🔶 **אבל ה-USB לא מתועד.** התיעוד מונה USB כתעבורה אפשרית ("HTTPS (best practice), HTTP, BT or USB") [D2].
   - הכתובת היחידה שמתועדת היא `https://<device_ip>:8080/SPICy` ב-HTTP POST [D3].
   - אין מפרט ל-USB: לא USB class, לא framing ולא VID/PID.
4. ✅ **בהגדרה של Nayax עצמה, ה-C4 מזוהה לפי כתובת IP.** בקיוסק Nova Market בוחרים ל-C4 "Common POS", בוחרים כבל או Wi-Fi, ואז מקלידים את כתובת ה-IP שלו [S4].
   - 🔶 כלומר בפתרון של Nayax עצמה ה-C4 מחובר ב-IP. "כבל" יכול להיות Ethernet, או IP על גבי USB.
5. 🔶 **המשמעות לנו: עיקר העבודה היא החלפת תעבורה, מתחת לממשק `EmvDevice` שכבר קיים.**
   - כל זרימת המכירה, ההחזר, השידור ופענוח התשובות (`Tweezer`, `parseCardResponse`, `CardBrands`, `Periodic`) נשארת כמו שהיא.
   - דבר חדש אחד שחשוב באמת: **ל-C4 אין מדפסת.** הקופה צריכה להדפיס את שובר האשראי בעצמה, מתוך `customerReceipt` שבתשובה [D11].
6. **ההמלצה:**
   - לבקש מ-Nayax את המפרט של TweezerComm על USB (רשימת שאלות ב-§4).
   - במקביל לממש את התעבורה ברשת. היא מתועדת, ההערכה 3–4 ימים.
   - היא תעבוד עם C4 בכבל Ethernet. אם יתברר שה-USB הוא IP על גבי USB, היא תעבוד גם שם כמעט בלי שינוי.

---

## 1. מה Nayax מציעה, ומה זה "C4"

### 1.1 Nova C4: מה ידוע

| נושא | ערך | מקור |
|---|---|---|
| מה זה | פינפד / מסופון אשראי לקופה ממוחשבת, עם הקלדת קוד סודי | ✅ [S1] |
| מערכת הפעלה | Android ("מערכת אנדרואיד"). המפיץ מציין "Android 10 Secure OS" | ✅ [S1][S2] |
| מסך | 4" מגע, ‎480×800 | ✅ [S1][S2] |
| חיבורים | "חיבור USB", "חיבור קווי או אלחוטי". המפיץ: ‎USB, RS232, Ethernet, Bluetooth, Wi-Fi 2.4/5GHz, ‏4G אופציונלי | ✅ [S1][S2] |
| תקנים | EMV, ‏PCI PTS 6.x. המפיץ, והעמוד הגלובלי לפי תקצירי החיפוש, מציינים גם EMV L1 contact/contactless ו-EMV L2 contact | ✅ [S1][S2][S3] |
| אמצעי תשלום | פס מגנטי, שבב, ללא מגע/NFC, ארנקים | ✅ [S1] |
| מדפסת | לא מופיעה באף מפרט | 🔶 אין מדפסת |
| יצרן (OEM) | לא מפורסם. המפרט דומה מאוד ל-PAX A35 [I9]. ב-Nayax Core מכשירי Nova לקמעונאות נרשמים כ-"Fujian LANDI - NOVA ECR" [S6]. ב-manifest של Agamento ב-55F מופיעים שירותי PAX (PLAN.md §2.1) | ❓ |
| שיווק | הושק באירופה בדצמבר 2024, יחד עם Nova 55F ו-Nova 116 Flip | ✅ [S7] |

ייתכן ש-"C4" היה רמז ל-USB-C. סוג מחבר ה-USB של ה-C4 לא מופיע באף מקור פומבי (❓). מה שבטוח: Nayax מוכרת מוצר בשם C4, והוא מיועד בדיוק לתרחיש של פינפד לקופה.

### 1.2 משפחת Nova: המכשירים לקמעונאות עם קופאי (attended)

| מכשיר | מה זה | רלוונטיות |
|---|---|---|
| **Nova 55F** | מסוף נייד עם מדפסת 58 מ"מ. ‏Android ‏[S10] | **זה ה-F20 שלנו.** ב-PLAN.md רשום `ro.ft.product.model = F20`, ו-`machines/me` מחזיר `deviceModel = N55F` |
| **Nova C4** | פינפד Android בגודל 4". ב-Nayax U הוא מופיע בין מכשירי Retail Core כ-"C4 POS" [S5] | המועמד לקופה הגדולה |
| **Nova 156** | קופה Android 13 עם מסך 15.6" ומדפסת 80 מ"מ. לשון העמוד: "הקופה כוללת מסוף סליקה מדגם NOVA 55, מגירת כסף ותושבת למסוף" | ✅ [S8]. 🔶 זו הקופה הגדולה של Nayax עצמה, וגם היא בנויה ממסך גדול ומסוף נפרד, בדיוק כמו התרחיש שלנו. ❓ איך ה-156 מדבר עם ה-Nova 55 (כנראה TweezerComm). שווה לשאול את Nayax |
| Nova C3, ‏Nova 116 Flip, ‏Nova Modu, ‏Retail One | פינפד נוסף, טאבלט, נייד, וקופה קמעונאית | [S7][S9] |

### 1.3 קווי מוצר של Nayax שלא מתאימים לתרחיש

✅ [D1] מסכם את שיטות האינטגרציה. **TweezerComm** היא "Integrate Nayax's attended payment device (Nova line) with your point of sale". כל השאר מיועדות למכונות בלי קופאי, לענן או לניהול:

| שיטה | למה היא | למה לא אנחנו |
|---|---|---|
| **Marshall** | פרוטוקול סריאלי, RS232, ל-VPOS Touch / Onyx / VPOS Media [D29]. יש כבל USB2Com, ובאנדרואיד צריך מימוש serial נמוך משלך [D30] | מיועד למכונות אוטומטיות. שדה המחיר בגודל 2 בתים, כלומר עד 655.35 בשתי ספרות אחרי הנקודה [D29]. אין תשלומים ואין `ashrait` |
| **EMV Core + UNO-8/UNO-mini** | קורא contactless מוטמע. ב-USB הוא מזדהה כ-**CDC virtual serial** (‏`/dev/ttyACMx`), ויש לו SDK לאנדרואיד [D33][D34] | זה ה-USB היחיד של Nayax שמתועד עד הסוף. אבל הוא רק contactless, מיועד לקיוסקים, ועובר דרך שרתי Nayax [D32]. ❓ אין עדות ל-Shva או לתשלומים |
| **Spark** | API מהשרת שלנו לשרת של Nayax: "remote start" של מסוף [D31] | EV, ‏vending וקיוסקים. אין חיבור מקומי |
| **Cortina** | אמצעי תשלום סגורים או מועדון על מסופי Nayax [D1] | לא רלוונטי לאשראי |
| **Lynx** | API לניהול Nayax Core [D1] | ניהול בלבד. זה **לא** מכשיר |

### 1.4 הרכישות של Nayax: מה נכנס להיצע הישראלי

| חברה | שנה | מה היא | קשר לפינפד ישראלי |
|---|---|---|---|
| **Modularity** | הוכרז במרץ 2020 [C1]. לפי תקציר חיפוש, ההשלמה ב-1.9.2019 [C2] | פיתחה סליקת אשראי על מכשירי Android ✅ [C1]. היא היצרנית של **Agamento** ✅: בתיעוד, חבילות `il.co.modularity.*` וקבצים ב-`docs-engine.modularity.co.il` [D4][D27] | **הליבה.** זו אפליקציית התשלום של Nova, והיא משרתת את שירות ה-`ashrait` (🔶 כלומר היא ה-AEA) |
| OTI (On Track Innovations) | 2022 | קוראי contactless, ‏UNO-8 ‏[C3] | ה-UNO ב-EMV Core. לא לקופה מאוישת |
| Weezmo | 2021 | קבלות דיגיטליות וחיבור בין אונליין לחנות ✅ [C4][C6] | לא סליקה |
| Tigapo | 2021 | תשלומים ופרסים לארקיידים ✅ [C6] | לא רלוונטי |
| Retail Pro International | 30.11.2023 | תוכנת POS קמעונאית גלובלית ✅ [C5] | תוכנת קופה, לא מסוף ישראלי |
| Roseman, ‏VMtecnologia, ‏UPPay, ‏Inepro, ‏Lynkwell | 2024–2025 | דלק וצי, ברזיל, EV ✅ [C6][C7] | לא רלוונטי |

🔶 **שורה תחתונה:** ההיצע הישראלי לקמעונאות עם קופאי הוא חומרת Nova עם Agamento (לשעבר Modularity) מעל Shva. אין SDK ישראלי נפרד "אחרי רכישות": האינטגרציה לקופה היא TweezerComm.

---

## 2. איך האינטגרציה עובדת

### 2.1 TweezerComm בקצרה ✅

- **פורמט:**
  - JSON-RPC 2.0 ‏[D3].
  - `params[0]` הוא השירות: `"ashrait"` בישראל, `"engine"` בעולם, `"device"` לשיטות מכשיר.
  - `params[1]` הוא אובייקט הפרמטרים.
- **שרת:** ‏Agamento מריץ שרת בשם "SPICy".
  - בקשות נשלחות ב-`POST https://device_ip:8080/SPICy`.
  - Agamento מאזין על **8080** ל-"TC Lan" ועל **9090** ל-"Bonjour" ‏[D3]. פרוטוקול ה-Bonjour לא מתועד (❓).
- **תעבורות שמוזכרות:** HTTPS (שיטה מומלצת), ‏HTTP, ‏BT, ‏USB [D2]. רק HTTP(S) מתועד בפועל.
- **TC Service:** ‏Agamento כשירות רקע ל"אפליקציה שלך על אותו מכשיר" [D4]. **זה המסלול שלנו היום ב-55F:** ‏`bindService` אל `il.co.modularity.agamento.AgamentoService`, ואז `ITweezerCommCommander.sendCommand(json, listener)`.
- **מצב מסוף:** ב-`getConfig` מופיעים השדות `posType` (בדוגמה: `"TC_HTTP"`), ‏`usePrinter`, ‏`amountDialog`, ‏`ashraitServer` (בדוגמה: `"SHVA"`), ‏`autoPeriodic`, ‏`ecr` ועוד [D23].
  - 🔶 שאר הערכים של `posType` (למשל ל-USB) לא מתועדים (❓).
- **PinPad mode:** ‏`startPinpadTransaction` / `doPinpadTransaction` / `endPinpadTransaction` [D5]. במצב הזה **הקופה** בונה את העסקה מנתוני ה-EMV. 🔶 זה מכניס אותנו להסמכת EMV ו-PCI, ולכן **לא** מתאים לנו. אנחנו נשארים ב-semi-integrated דרך `doTransaction`.

### 2.2 תעבורה: מה מאומת ומה לא

| שאלה | תשובה |
|---|---|
| האם TweezerComm עובד מעל USB? | ✅ ‏Nayax מונה את USB כתעבורה [D2] |
| איך ה-USB עובד (class, ‏framing, ‏VID/PID, מי ה-host)? | ❓ לא מתועד בשום מקור פומבי. בדקתי את כל 74 עמודי TweezerComm באינדקס `llms.txt` [D35] |
| איך Nayax מחברת C4 במוצרים שלה? | ✅ ‏"Cable or WiFi", ואז כתובת IP של ה-C4 [S4]. 🔶 כלומר IP |
| איזה חומרה יש ל-C4? | ✅ ‏USB, ‏RS232, ‏Ethernet, ‏BT, ‏Wi-Fi [S2] |

**ארבע אפשרויות ל-USB.** כולן השערות (🔶) עד שתגיע תשובה מ-Nayax:

| # | מה ה-C4 עושה ב-USB | מה צריך בקופה | קוד USB אצלנו |
|---|---|---|---|
| א | **IP על גבי USB** (‏RNDIS, ‏NCM או ECM, כמו USB tethering) | ממשק רשת שהקופה מזהה (תלוי ב-kernel של הקופה). מעליו אותו HTTPS ל-`/SPICy` | כמעט אין. צריך למצוא את ה-`Network` ב-`ConnectivityManager` ולקשור אליו את ה-socket |
| ב | **CDC-ACM serial**, כמו ה-UNO-mini [D33] | מנהל התקן serial, למשל usb-serial-for-android [A1], ו-framing של JSON-RPC (newline? ‏length prefix? ‏STX/ETX?) | בינוני: הרשאות, attach/detach, ‏codec ובדיקות |
| ג | **Android Open Accessory (AOA)** | handshake של accessory מצד ה-host (‏`controlTransfer` 51/52/53), ואז bulk endpoints | הכי הרבה עבודה |
| ד | **RS232 עם מתאם USB** | ‏usb-serial-for-android עם צ'יפ מתאם (‏FTDI, ‏CP210x וכו') ‏[A1] ו-framing | בינוני |

### 2.3 זרימת עסקה והמיפוי לזרימה הנוכחית שלנו

כל השיטות כאן מתועדות לשירות `ashrait` ✅. העמודה "אצלנו היום" מבוססת על הקוד ב-`P:\pos-android`.

| פעולה | TweezerComm (ישראל) | אצלנו היום (55F, ‏AIDL) | שינוי ל-C4 |
|---|---|---|---|
| מכירה | `doTransaction`: ‏`vuid`, `amount` באגורות, `currency "376"`, ‏`tranCode 1`, ‏`tranType 1`, ‏`creditTerms 1` [D11] | `Tweezer.sale()` | אין |
| **תשלומים** | ‏`creditTerms 8` (תשלומים), ‏`creditPayments` / `payments`, ‏`firstPaymentAmount` (אופציונלי). שלב 1 מחזיר `maxPayments`, ‏`minCreditPayments`, ‏`minCreditAmount` ו-`allowedCreditTerms` [D12] | ‏`creditTerms 8` ו-`creditPayments`. במכוון לא שולחים `firstPaymentAmount` | אין |
| החזר | ‏`tranType 53`, ועם `originalTransactionId` כשהוא מקושר [D11] | `Tweezer.refund()` / `refundUnlinked()` | אין |
| **ביטול (void)** | `cancelTransaction {originalUID}`. אפשרי רק עד `doPeriodic`, כי השידור מנקה את בסיס הנתונים במסוף [D13] | רק בבדיקת Diagnostics. אין זרימה בייצור | אין חדש. כדאי להשלים זרימת ביטול |
| עצירה לפני כרטיס | `abortTransaction {vuid}`. רק לפני הצגת הכרטיס או timeout [D14] | `Tweezer.abort()`, עוקף את ה-gate | אין |
| טיפ | ‏`tipAmount` קיים ב-`doTransactionPhase1` [D12]. לא מופיע ב-`doTransaction` של ישראל | הטיפ נכלל ב-`amount` | אין. אופציונלי בעתיד |
| מותג, מנפיק, סולק | `mutag` / `mutagName` / `cardName`, ‏`manpik`, ‏`solek` [D11] | `CardBrands` | אין |
| נתוני קבלה | ‏`cardNumber` (ממוסך), ‏`issuerAuthNum`, ‏`uid`, ‏`rrn`, ‏`posEntryMode`. וגם **`customerReceipt` / `merchantReceipt`**, מערכים של `fieldName`/`fieldValue` להדפסה [D11] | מדפיסים מותג, 4 ספרות ואישור. Agamento מדפיס שובר בעצמו על המדפסת של ה-55F | **ל-C4 אין מדפסת, כך שהקופה מדפיסה את `customerReceipt`** (§6.7) |
| אופליין / דחוי | `setConfig` לאופליין, ‏`doTransaction` מחזיר "Approved→Pending", ‏`authorizePendingTransactions`, ואז `doPeriodic` [D10][D21] | קיים (`TerminalInfoRepository`) | אין |
| שידור סוף יום | `doPeriodic ["ashrait","wide",{forceUpdateParams}]`. מחזיר דוח Z כטקסט, ‏`ackNumber` ו-`queriedTransactions`. "לפחות פעם ביום" [D15] | `TweezerTerminalBatch.transmit()` ו-`TransmissionRepository` | אין |
| דוחות | `getReport` עם `x` / `z` / `queryTransactions` / `queryPreAuthTransactions` ועוד [D16] | `report(x \| queryReports)` | אין |
| סטטוס | `getStatus`: ‏`ashraitReady` / `ReadyOnline` / `NotEstablished` / `NotReady` / `Error`, "call infrequently" [D17]. ‏`getInternalStatus`: ‏`IDLE` / `BUSY` / `PHASE2_READY` / `AUTH_READY` [D18] | `internalStatus()` לפני שידור | בסיס לנורית (§6.5) |
| שחזור | `getTransactionByVuid`: ‏`isFinalAmount`, ‏`transactionDeposited` [D20]. מנגנון ה-resilience של Nayax מבוסס עליו [D6] | ‏vuid ייחודי. 995 = "VUID ALREADY EXIST" | חשוב יותר בכבל שעלול להתנתק (§6.8) |
| קודי שגיאה | ‏0 אושר, 10 חלקי, 126/998 בוטל, 993 timeout, ‏995 vuid כפול, ‏-1 / -5 לא מוכן, ‏-61 לא נמצא, ‏-64 ביטול לא אפשרי ועוד [D26] | `TweezerStatus` / `classify` | אין. להוסיף -61 ו-64 לטיפול בביטול |

**שלושה ממצאים מהתיעוד שנוגעים לקוד הקיים** (לא שיניתי קוד; לאמת על מכשיר):
- **`getReport`.** לפי [D16], שם הפעולה הוא האיבר השני ב-`params`, כמחרוזת: `["ashrait","x"]`. ‏`Tweezer.report()` שולח היום אובייקט: `["ashrait",{"type":"x"}]`. ההערה בקוד אומרת שזה "לא מאומת". לפי התיעוד, בדוחות `x` / `z` מגיע בתשובה השדה `slip`, דוח להדפסה.
- **`cancelTransaction`.** לפי [D13], הבקשה כוללת גם `vuid` לצד `originalUID`. ‏`Tweezer.cancel()` שולח רק `originalUID`.
- **`getInternalStatus`.** בטבלה של [D18] הערכים באותיות גדולות (`IDLE`, ‏`BUSY`). בדוגמה שם מופיע `"idle"`. כדאי שהפענוח לא יהיה רגיש לאותיות.

### 2.4 ההבדלים המהותיים בין C4 ל-55F

1. **הדפסה.** ב-55F, ‏Agamento מדפיס את שובר האשראי בעצמו. ל-C4 אין מדפסת (🔶), אז הקופה מדפיסה את `customerReceipt`, ואת `merchantReceipt` אם שומרים העתק לבית העסק.
   - ❓ לברר: האם `usePrinter=false` ב-C4 ואילו שדות חובה ב"שובר" לפי Shva.
2. **קישור שיכול להתנתק באמצע עסקה.** ב-AIDL זה כמעט לא קורה. בכבל זה קורה. לכן צריך לחפש את העסקה לפי `vuid` לפני שמנסים שוב (§6.8).
3. **הרשאת USB של Android.** בקשת הרשאה, אירועי attach/detach, והתחברות מחדש.
4. **Agamento רץ על מכשיר אחר.** המסך "פתח את Agamento" בנעילת מספר המסוף (`PosNavigation.kt`, ‏`getLaunchIntentForPackage`) לא יעבוד. צריך להסתיר אותו כשהמסוף חיצוני.
5. **TLS.**
   - ה-release שלנו חוסם cleartext (`network_security_config.xml`: ‏`cleartextTrafficPermitted="false"`).
   - לכן ברשת יש להשתמש ב-HTTPS. ❓ לברר איזו תעודה יש ל-SPICy (self-signed? אפשר pinning?).
6. **מסך Agamento ללקוח.** ב-`getConfig` יש `amountDialog`. ‏Nayax ממליצה לכבות אותו כדי שהלקוח יציג כרטיס מיד [D28].
7. **מספר מסוף (ECR).** ל-`doTransactionPhase1` יש `ecrID`: "Mandatory only if multiple clients use the same Merchant ID" [D12]. ❓ לברר: פינפד אחד לכל קופה, ומספר מסוף Shva נפרד לכל אחד?

---

## 3. ישראל: הסמכה, שב"א, סולקים ו"תנאי עסקה"

- ✅ **אשראית EMV.** אשראית של שב"א שודרגה ל"אשראית EMV" שמשלבת את דרישות השוק הישראלי עם EMV ו-PCI. מאז 1.8.2017 כל מסוף חדש בשב"א נפתח באשראית EMV. שב"א מבצעת הסמכת מסוף מקצה לקצה כשירות לחברות האשראי. (סיכום מנוע חיפוש של [I1]. הדפים עצמם חסומים לגישה אוטומטית.)
- 🔶 **Agamento הוא ה-AEA (AshraitEMV Application).**
  - התיעוד אומר שהקופה מדברת עם Agamento, ושבישראל היא מדברת עם ה-AEA. ‏`getStatus` מתאר את ה-AEA כ-"the payment application" [D2][D17]. מכאן ההסקה.
  - ✅ העסקאות המאושרות נשמרות במסוף, ו-`doPeriodic` משדר אותן ל-ABS (שב"א) [D2][D9].
  - ‏`ashraitServer` קובע לאן מפקידים. בדוגמת `getConfig` הערך הוא `"SHVA"`, ובדוגמת `setConfig` הערך הוא `"NAYAX"` [D23][D24].
  - אצלנו כבר קיים `clearingServer` (‏Shva או Pelecard), ונשלח בדיוק ב-`setConfig`.
- ✅ **הקמה (establishment).** "process done by Nayax's team" [D19][D2]. ‏`getRetailerInfo` מאמת את שם המסוף ומספרו כפי שהגיעו משב"א.
- ✅ **תנאי עסקה נקבעים במסוף, לא אצלנו.** שלב 1 מחזיר `allowedCreditTerms`, ‏`maxPayments`, ‏`minCreditPayments` ו-`minCreditAmount` [D12]. הקוד שלנו כבר מתייחס למסוף כסמכות לטווח התשלומים.
- ✅ **סולקים וכרטיסי בדיקה.**
  - ההסכמים עם ישראכרט, כאל ומקס הם של בית העסק.
  - ‏Nayax לא מנפיקה כרטיסים. כרטיסי בדיקה מוציאים מול מנפיק (מקס, כאל, ישראכרט וכו').
  - במצב בדיקה, המסוף מפנה לשרתי הבדיקה של שב"א, וכרטיס אמיתי ייכשל [D28].
- **ההסמכה שלנו:**
  - ✅ ‏Nayax מעבירה תהליך אינטגרציה: Kickoff, ‏Integration Setup (מהנדס אינטגרציה ו-welcome email עם URL,‏ SDK, תיעוד ו-tokens), פיתוח, Testing & Certification, ‏Production [D7].
  - ✅ ההסמכה היא בדרך כלל 9–15 בדיקות, ובסופה מכתב הסמכה [D7]. יש קבצי Excel להסמכה ו-Postman collection [D27].
  - 🔶 אנחנו **לא** עוברים הסמכת EMV L2. ה-C4 ו-Agamento מוסמכים, ואנחנו semi-integrated.
  - ❓ לברר: האם להחלפת תעבורה באינטגרציה שכבר עובדת מול Agamento (ה-55F) צריך הסמכה חוזרת, ואילו בדיקות.
- 🔶 **PCI.** ‏semi-integrated: ‏PAN מלא לא נכנס לקופה. עד היום רק מסוכה עם 4 ספרות.
  - נשארים כך: ‏MOTO בלי שדות כרטיס, כפי שהוחלט ב-`Tweezer.motoSale`.
  - לא להשתמש ב-PinPad mode.

---

## 4. מה לבקש מ-Nayax (רשימה לפגישה או למייל)

**תיעוד ו-SDK**
1. מפרט **TweezerComm על USB** ל-Nova C4 בישראל:
   - איך ה-C4 מזדהה ב-USB: ‏CDC-ACM, ‏RNDIS/NCM, ‏AOA או אחר.
   - ‏VID/PID.
   - מי ה-host.
   - ה-framing של ה-JSON-RPC.
   - keep-alive.
   - התנהגות בניתוק באמצע עסקה.
2. אילו ערכי `posType` נתמכים ב-C4 (‏TC_HTTP, ‏HTTPS, ‏Bonjour, ‏BT, ‏USB), ומה מומלץ לקופת Android שיושבת ליד הפינפד.
3. האם יש **AAR/SDK לאנדרואיד** לצד ה-host, או קוד לדוגמה. הקישור לדוגמת TC Service ‏(`github.com/ModularityLtd/TcsDemo`) מחזיר 404, ובארגון אין מאגרים ציבוריים.
4. פרוטוקול **Bonjour** בפורט 9090: מה הוא, ומתי עדיף על HTTP.
5. **TLS** של SPICy: ‏self-signed? ‏pinning? החלפת תעודה?
6. ה-**Agamento User Manual**, ‏IP & Ports list ו-Postman collection. הקישור `docs-engine.modularity.co.il` לא נפתר ב-DNS כשבדקנו (4.10.2026), ובקישור ה-IP & Ports בתיעוד אין יעד.

**חומרה ובדיקות**

7. **מסוף C4 לבדיקה** עם Agamento במצב QA2 / test terminal, ואחרי הקמה מול שרת הבדיקה של שב"א.
8. כבל USB מתאים, ספק כוח: האם ה-C4 ניזון מה-USB של הקופה? סוג המחבר.
9. אם USB לא זמין מיד: האם אפשר להעביר Nova 55F קיים שלנו ל-`TC_HTTP` כדי לפתח מולו ברשת?
   - ובאותה הזדמנות לשאול: איך ה-Nova 156 שלכם מדבר עם ה-NOVA 55 שבתושבת שלו? ‏USB? ‏Wi-Fi? ‏posType?

**סליקה והסמכה**

10. רשימת בדיקות ההסמכה (9–15) לאינטגרציה קמעונאית ישראלית (`ashrait`). ‏האם צריך הסמכה חוזרת אחרי החלפת תעבורה?
11. **שובר**: אילו שדות הקופה חייבת להדפיס כשאין מדפסת במסוף. האם `customerReceipt` מספיק כמו שהוא? מתי נדרשת חתימה (למשל `posEntryMode 51`)?
12. מספר מסוף לכל C4, הקמה, ‏`ecrID`, ושיתוף מספר בית עסק בין כמה קופות.
13. עדכוני Agamento והקושחה ב-C4 (‏`com.nayax.update`) ותאימות לאורך זמן.
14. מחיר המכשיר, עמלות, SLA, ואיש קשר טכני (מהנדס אינטגרציה) [D7].

---

## 5. השוואה לחלופות

החלופות שאינן של Nayax נבדקו רק ברמת עמודי מוצר ושיווק (🔶). לא בדקתי את ה-API שלהן.

| חלופה | חיבור לקופה | אינטגרציה | יתרונות | חסרונות | עבודה אצלנו |
|---|---|---|---|---|---|
| **Nayax Nova C4 + TweezerComm** | USB (❓), ‏Ethernet / Wi-Fi (מתועד) | אותו JSON-RPC שכבר עובד אצלנו | הקוד כבר קיים. ‏Agamento, ‏Shva ותשלומים מוכרים לנו | ‏USB לא מתועד. צריך הדפסת שובר מהקופה | **נמוכה** (§7) |
| **Nayax Nova 156** (קופה גדולה של Nayax, עם מסוף NOVA 55 בתושבת) [S8] | ❓ בין ה-156 ל-Nova 55 | 🔶 כנראה אותו TweezerComm: ה-55 הוא מסוף נפרד | ספק אחד לחומרה, מדפסת 80 מ"מ ומגירה. ה-Nova 55 הוא חומרה שכבר מוכרת לנו | נעולים לחומרת Nayax. ❓ איך הם מחוברים | נמוכה, בעיקר UI למסך גדול ותעבורה כמו ב-C4 |
| **Nova 55F קיים כמסוף שולחני ברשת** | Wi-Fi / Ethernet (‏TC Lan, פורט 8080 [D3]) | אותו JSON-RPC ב-HTTP | אפשר לפתח ולבדוק כבר עכשיו עם חומרה שיש לנו | נייד, לא פינפד. צריך להגדיר `posType` | נמוכה |
| **Verifone** (‏P400, ‏VX805) מעל "אשראית PC EMV" של שב"א | USB / RS232 (לפי סיכום חיפוש) [I2][I3] | תוכנת אשראית PC EMV, בעיקר Windows (🔶) | ותיק ונפוץ בקופות PC | ❓ תמיכה ב-Android host. API אחר לגמרי | גבוהה |
| **Pelecard** | USB, ‏RS232, ‏Ethernet (לפי סיכום חיפוש) [I7] | ממשק של Pelecard | נפוץ בקופות. ‏`doMiniSettlement` של Nayax מזכיר את המעבדים "CG, PC" [D22] (🔶 כנראה CreditGuard ו-PeleCard) | API נפרד | גבוהה |
| **Hyp / CreditGuard** | פינפד וענן | ‏CG Gateway EMV XML API, עם pinpad processing [I6] | ענן, בלי driver מקומי | ❓ חומרה ו-Android | גבוהה |
| **Z-Credit** (‏Dejavoo Z3, ‏Q3P) | Ethernet / Wi-Fi, ענן [I4][I5] | ענן של Z-Credit | בלי USB בכלל | ספק סליקה אחר. ‏API אחר | גבוהה |
| **Tranzila** | אפליקציית Android, קורא EMV | [I8] | נייד | הפינפד שלהם "בקרוב" לפי האתר | גבוהה |

🔶 **המלצה:** ‏Nova C4 עם TweezerComm. זה הנתיב היחיד שבו כמעט כל השכבה העסקית כבר כתובה ונבדקה בייצור (desktop ו-55F). כל השאר מחייבים פרוטוקול, הסמכה וספק סליקה חדשים.
- ‏Nova 156 שווה בירור כחלופת "ספק אחד לחומרה".
- אותו קוד (`TcHttpEmvDevice` או `TcUsbEmvDevice`) ישרת גם מסוף NOVA 55 שיושב ליד קופה גדולה.

---

## 6. הארכיטקטורה המוצעת לאפליקציה

### 6.1 המצב היום (מהקוד)

**הממשק:**
- **`EmvDevice`** (`hardware/payment/EmvDevice.kt`). ממשק "raw frame": ‏`connect`, ‏`status`, ‏`enableTweezerComm`, ‏`sendFrame(json, timeoutMs)`, ‏`restartService`, ‏`disconnect`.
- המימוש היחיד הוא **`AgamentoEmvDevice`** (flavor ‏`device`): ‏AIDL ל-`il.co.modularity.agamento.AgamentoService`, ואז `ITweezerCommCommander.sendCommand`.

**השכבות מעליו:**
- **`GatedEmvDevice`** (`TerminalBatch.kt`): ‏Mutex שמונע ששידור יתנגש בכרטיס. ‏abort עוקף אותו. נבנה ב-`AppContainer`: `GatedEmvDevice(hardware.emv(context))`.
- **`Tweezer`** (`TweezerRequests.kt`): בונה את ה-frames של `ashrait`. ‏**`parseCardResponse`** מחזיר **`CardResult`**. גם **`classify`**, ‏**`CardBrands`**, ו-**`Periodic`** / ‏`TweezerTerminalBatch` / ‏`TransmissionRepository`.

**איך בוחרים חומרה:** ‏`HardwareProvider` נבחר **בזמן קומפילציה** לפי flavor (`device` / `mock`). אין בחירה בזמן ריצה לפי קופה.

**מי קורא ל-`EmvDevice` ישירות** (בונים frames ומפענחים בעצמם):
- `CheckoutViewModel.chargeCard()` / `payoutCard()`
- `DetailViewModel.refund()`
- `DiagnosticsScreen`, ‏`SettingsScreen`, ‏`BringUpViewModel`

**קבלה:** ‏`ReceiptService` / `ReceiptRenderer` מדפיסים מותג, `**** 1234`, "אישור" ותשלומים. **מספר שובר לא נקרא ולא מודפס.**

**הגדרות שכבר קיימות בשרת** (`server/app/services/settings_merge.py` → `MANAGED_SETTING_KEYS`, עם שכבות tenant → company → shop → area → till):
- `nayaxEnabled`, ‏`nayaxDeviceHost`, ‏`nayaxDevicePort`, ‏`nayaxSpicyPath`: כתובת ה-SPICy של הקופה השולחנית.
- `clearingServer`, ‏`expectedTerminalNumber`, ‏`forceTerminalNumber`.
- `GET machines/me` מחזיר `deviceModel` (‏`"N55F"` / `"MODO"`) ו-`hasPrinter`. 🔶 קופה גדולה תצטרך ערך משלה ל-`deviceModel`, עם מדפסת 80 מ"מ.

**אין** `PaymentTerminal` / `CardTerminal`. אין קוד USB, אין `device_filter.xml`, ואין `uses-feature usb.host`.

### 6.2 התכנון

```
CheckoutViewModel · DetailViewModel · TransmissionRepository · Diagnostics
            │  (היום: EmvDevice + Tweezer.* ישירות; בהדרגה → PaymentTerminal)
            ▼
   PaymentTerminal  ← חדש: sale / refund / void / abort / lookup / transmit / reportX
            │           + health: StateFlow<TerminalHealth> + capabilities
            │
            ├── TweezerPaymentTerminal  (אחד לכל סוגי Nayax; Tweezer.* + parseCardResponse + Periodic)
            │        │
            │        └── GatedEmvDevice ── EmvDevice (התעבורה בלבד)
            │                 ├── AgamentoEmvDevice   "מובנה"      AIDL — קיים
            │                 ├── TcHttpEmvDevice     "Nayax רשת"  HTTPS POST /SPICy — מתועד
            │                 └── TcUsbEmvDevice      "Nayax USB"  ממתין למפרט; אם USB=IP → TcHttp על רשת ה-USB
            │
            └── (עתידי) מסופים שאינם Nayax — Pelecard / CreditGuard … — מממשים PaymentTerminal ישירות
```

**העיקרון:** כל ההבדלים בין סוגי Nayax הם בתעבורה (`EmvDevice`) וב-`TerminalCapabilities`. הלוגיקה העסקית לא משתנה.

**שלב 1 (מינימלי, מספיק ל-C4):**
- להוסיף `TcHttpEmvDevice` (או `TcUsbEmvDevice`).
- לבחור את המימוש בזמן ריצה.
- לא נוגעים ב-ViewModels.

**שלב 2:** לעבור ל-`PaymentTerminal`, כשיגיע ספק שאינו Nayax.

סקיצה של המימוש לרשת. אינה בשלד, כי הוראת המשימה הייתה לעצור אחרי ממשק ו-fake:

```kotlin
class TcHttpEmvDevice(private val endpoint: HttpUrl, private val client: OkHttpClient) : EmvDevice {
    override suspend fun sendFrame(json: String, timeoutMs: Long) = runCatching {
        withTimeout(timeoutMs) {
            client.newCall(Request.Builder().url(endpoint)            // https://<host>:8080/SPICy
                .post(json.toRequestBody("application/json".toMediaType())).build())
                .await().use { it.body!!.string() }                   // cancel → call.cancel()
        }
    }
    override suspend fun status() = EmvServiceStatus(bound = reachable, agamentoVersion = version,
        libVersion = null, tweezerCommEnabled = reachable)            // אם SPICy עונה — TC פעיל
    override suspend fun enableTweezerComm() = connect()              // אין מה להדליק מרחוק
    …
}
```

### 6.3 בחירת מסוף לכל קופה: הפרמטר "סוג מסוף"

- **מפתח:** ‏`paymentTerminalType`.
- **סוג:** enum. **ערכים:** ‏`מובנה` / `Nayax USB` / `Nayax רשת`. **ברירת מחדל:** ‏`מובנה`.
- **בשרת:** "פרמטרים לקופות" הם שורות (`TillParameter` / `TillParameterValue`), ולכן **אין צורך במיגרציה.**
  - super admin יכול להגדיר את הפרמטר מהדשבורד כבר היום.
  - אפשר גם להפוך אותו ל-built-in בשורה אחת ב-`BUILTIN_PARAMETERS` (`app/services/till_parameters.py`).
  - הערך נפתר לפי השרשרת: קופה → נקודת מכירה → סניף → חברה → ברירת מחדל.
- **בקופה:**
  - ‏`TerminalKind.fromParameter(settings.parameters["paymentTerminalType"])`. ערך לא מוכר מחזיר "מובנה".
  - ב-`AppContainer`, להחליף את `GatedEmvDevice(hardware.emv(context))` ב-`GatedEmvDevice(SwitchableEmvDevice(…))`. הוא יוצר מחדש את התעבורה הפנימית כשהפרמטר משתנה (`SettingsRepository.observe()`).
  - ההחלפה מתבצעת רק דרך `gate.whenIdle {}`, כלומר אף פעם לא באמצע עסקה.
- **כתובת לרשת:** ממחזרים את `nayaxDeviceHost` / `nayaxDevicePort` / `nayaxSpicyPath` שכבר קיימים בשרת ובדשבורד ("כתובת מכשיר", "פורט", "נתיב SPICy"). אין צורך במפתחות חדשים.

### 6.4 USB: גילוי והרשאה (תכנון; הקוד אחרי שיגיע מפרט)

**Manifest:**
```xml
<uses-feature android:name="android.hardware.usb.host" android:required="false"/>
<!-- על MainActivity -->
<intent-filter><action android:name="android.hardware.usb.action.USB_DEVICE_ATTACHED"/></intent-filter>
<meta-data android:name="android.hardware.usb.action.USB_DEVICE_ATTACHED"
           android:resource="@xml/nayax_usb_device_filter"/>
```
- ב-`res/xml/nayax_usb_device_filter.xml` צריך `<usb-device vendor-id="…" product-id="…"/>`. הערכים יגיעו מ-Nayax (❓). את הפורמט מתעד [A2].
- כשהאפליקציה נפתחת דרך ה-intent-filter, ההרשאה ניתנת אוטומטית אם המשתמש אישר [A2]. ה-"Always" נשמר.

**בזמן ריצה:**
- `UsbManager.deviceList` → התאמה לפי VID/PID → `hasPermission`.
- אם אין הרשאה: `requestPermission(device, pi)`.
  - ה-`pi` נבנה מ-**intent מפורש** (`setPackage`) עם `FLAG_MUTABLE`, כמו בדוגמה של usb-serial-for-android [A1]. ה-flag מאפשר למערכת להוסיף `EXTRA_DEVICE` / `EXTRA_PERMISSION_GRANTED`.
  - הדוגמה של Android מראה `FLAG_IMMUTABLE` [A2]. ‏❓ לבדוק על מכשיר היעד, כי targetSdk שלנו 34.
- receivers: ‏`ContextCompat.registerReceiver(…, RECEIVER_NOT_EXPORTED)` לפעולת ההרשאה, ו-`ACTION_USB_DEVICE_DETACHED`.
  - detach → נורית אדומה. attach → התחברות מחדש.

**לפי סוג ה-USB (§2.2):**
- **א (IP):** אין קוד USB. מוצאים את ה-`Network` של הממשק (‏`ConnectivityManager`) וקושרים אליו את `socketFactory` של OkHttp.
- **ב / ד (serial):**
  - מנהל ההתקן: **usb-serial-for-android** (‏MIT, ‏JitPack: ‏`com.github.mik3y:usb-serial-for-android:3.11.0`) [A1].
  - **לא נוסף כתלות.** נדרש גם `maven("https://jitpack.io")` ב-`settings.gradle.kts`.
  - מעליו `TcSerialCodec` ל-framing, עם בדיקות יחידה.
- **ג (AOA):** ‏handshake מצד ה-host (‏`controlTransfer`, ‏`claimInterface`, ‏`bulkTransfer`) [A2]. רק אם Nayax תאשר שזה המנגנון.

### 6.5 נורית חיבור המסוף, כמו של המדפסות

**הדפוס שמעתיקים:**
- המודל: `HealthLevel { OK, WARN, ERROR }` ב-`KitchenPrintService.kt`, עם `StateFlow` ו-`null` = מוסתר.
- הרכיב: `KitchenPrinterStatusChip` ב-`PrintersScreen.kt`, שממוקם ב-`SellScreen` בתוך `ShiftRow(trailing = …)`.

**בשלד:** ‏`TerminalHealth(state, at, detail)`, עם `level: HealthLevel?` שמשתמש **באותו enum**.

| מצב (`TerminalState`) | מקור | צבע |
|---|---|---|
| `NOT_CONFIGURED` | סוג "מובנה" | מוסתר |
| `READY` | `ashraitReady` | ירוק |
| `READY_ONLINE_ONLY` | `ashraitReadyOnline` | כתום |
| `BUSY` | `ashraitNotReady` / כרטיס או שידור בתהליך | כתום |
| `CONNECTING` | פתיחת קישור | כתום |
| `NOT_ESTABLISHED` | `ashraitNotEstablished`: אין הקמה מול שב"א | אדום |
| `NO_PERMISSION` | אין הרשאת USB | אדום |
| `DISCONNECTED` | כבל מנותק / IP לא עונה / detach | אדום |
| `ERROR` | `ashraitError` / תשובה לא מובנת | אדום |

**מדיניות probe:**
- בדיקה מיידית ב-attach, אחרי הרשאה ובהתחברות.
- כל 60 שניות כשהקופה פנויה, רק דרך `gate.whenIdle`. ‏Nayax: ‏"call infrequently" [D17].
- עדכון אחרי כל תוצאת עסקה.

**נגיעה בנורית** פותחת גיליון עם:
- המצב.
- גרסת Agamento והדגם (‏`getVersion` / `getInfo` [D25]).
- מספר המסוף ושם העסק (‏`getRetailerInfo`).
- השידור האחרון.

**בעתיד (שרת):** להוסיף את מצב הפינפד ל-`TerminalHeartbeat`.

### 6.6 טבלת מיפוי (`PaymentTerminal` → TweezerComm → קוד קיים)

| `PaymentTerminal` | שיטה | בנוי היום | חסר |
|---|---|---|---|
| `connect()` / `probe()` | `getStatus` (ו-`getInternalStatus`) | `Tweezer.internalStatus()`, ‏`probe("getStatus")` | מיפוי לנורית (בשלד) |
| `sale(CardSale)` | `doTransaction` ‏(1/1, ‏creditTerms 1/8) | `Tweezer.sale` | — |
| `refund(CardRefund)` | `doTransaction` (‏tranType 53) | `Tweezer.refund` / `refundUnlinked` | — |
| `void(CardVoid)` | `cancelTransaction` | `Tweezer.cancel` | זרימה במסך היסטוריה, וטיפול ב-‎-64 |
| `abort(vuid)` | `abortTransaction` | `Tweezer.abort` | — |
| `lookup(vuid)` | `getTransactionByVuid` | — | frame ופענוח |
| `transmit()` | `doPeriodic` | `Tweezer.periodic`, ‏`parsePeriodicResponse` | — |
| `reportX()` | `getReport x` | `Tweezer.report`, ‏`parseReportX` | — |

### 6.7 שדות הקבלה

| שדה | מקור בתשובה | היום | ל-C4 |
|---|---|---|---|
| מותג | `mutag` / `mutagName` / `cardName` → `CardBrands` | ✓ | ✓ |
| 4 ספרות | `cardNumber` (ממוסך) | ✓ | ✓ |
| מספר אישור | `issuerAuthNum` | ✓ "אישור" | ✓ |
| **מספר שובר** | ❓ ככל הנראה שורה ב-`customerReceipt`, או נגזר מ-`uid` | ✗ | לאמת על תשובה אמיתית. התשובה הגולמית נשמרת ב-`nayaxMeta.result` וביומן `nayax_card_integration` |
| תשלומים | `creditPayments`, ‏`firstPaymentAmount`. ‏`otherPaymentAmount` מופיע בבקשת `doTransactionPhase2` (https://devzone.nayax.com/docs/integrate-pos-device/tweezercomm/israel-payment-methods/dotransactionphase2) | ✓ "n × ₪" | ✓ |
| **שובר מלא** | `customerReceipt` / `merchantReceipt` | Agamento מדפיס בעצמו ב-55F | **הקופה מדפיסה את הטקסט כמו שהוא**, כשה-`capabilities.printsOwnSlip == false`. בשלד: `TerminalSlip` |

### 6.8 שגיאות, ניתוק ואופליין

**תשובה שאבדה** (`TRANSPORT_ERROR` אחרי שליחה, כבל שנשלף):
- **לא** פותחים vuid חדש.
- קודם `lookup(vuid)`. זה מנגנון ה-resilience של Nayax [D6].
- או ניסיון חוזר **באותו vuid**. אם החיוב עבר, המסוף עונה 995 [D26], כך שאין חיוב כפול.
- המסמך נשאר `PENDING`. המנגנון הזה כבר קיים (`openCardSale`, ‏`orphanedCardSales`, דיווח בעלייה).
- בשלד זה מתועד בממשק ונבדק בבדיקת חוזה.

**כבל מנותק:**
- נורית אדומה, וחסימת "אשראי" עם הודעה בעברית ("המסוף מנותק — חברו את כבל ה-USB").
- מזומן ממשיך לעבוד.
- בחיבור מחדש: ‏`lookup` לכל מסמך שתקוע ב-PENDING.

**אופליין / דחוי:** אותם frames (`setOfflineMode`, ‏`authorizePendingTransactions`). אין הבדל בין התעבורות.

**שידור:** `GatedEmvDevice` ו-`TransmissionRepository` עובדים כמו שהם. הם עוברים דרך התעבורה החדשה.

### 6.9 מה נכתב בשלד (קבצים חדשים בלבד)

| קובץ | תוכן |
|---|---|
| `app/src/main/java/il/co/runnersys/pos/hardware/payment/nayax/PaymentTerminal.kt` | הממשק `PaymentTerminal`. ‏`TerminalKind` (הפרמטר "סוג מסוף", עם fallback ל"מובנה"). ‏`TerminalCapabilities` (‏`printsOwnSlip`, ‏`external`, ‏`needsUsbPermission`…). ‏`TerminalState` / `TerminalHealth` (הנורית, ומיפוי ערכי `getStatus` המתועדים). ‏`CardSale` / `CardRefund` / `CardVoid`, ‏`TerminalSlip`, ‏`TerminalReply` |
| `app/src/test/java/il/co/runnersys/pos/hardware/payment/nayax/FakePaymentTerminal.kt` | ספק מזויף שמקיים את כללי `ashrait` המתועדים: ביטול רק עד שידור (‎-64), ‏vuid כפול (995), ‏abort לפני כרטיס (126), ‏lookup אחרי תשובה שאבדה, והרשאת USB. התשובות במבנה המתועד ועוברות ב-`parseCardResponse` האמיתי |
| `app/src/test/java/il/co/runnersys/pos/hardware/payment/nayax/PaymentTerminalContractTest.kt` | ‏16 בדיקות: מיפוי הפרמטר, יכולות, צבעי נורית, ערכי `getStatus`, טיפ חלק מהסכום, מכירה בתשלומים עם שדות קבלה, שובר רק כשאין מדפסת, תשובה שאבדה ו-retry בטוח, ‏lookup בלי קישור ("לא ידוע", לא "לא נמצא"), ‏USB בלי הרשאה, ‏abort, ‏void עד שידור ואחר כך רק החזר, דחייה, ומסוף לא מוקם |

**למה אין קוד USB:**
- הפרוטוקול ברמת USB לא פומבי (§2.2).
- כתיבת framing או VID/PID מנוחשים הייתה מטעה.
- לפי הוראות המשימה: ממשק ו-fake, ועוצרים כאן.
- **לא נוספו:** תלויות, הרשאות ב-manifest, ‏`device_filter.xml` או חיווט ב-`AppContainer`.

**איך נבדק:** בעותק (`%TEMP%\cp_nayax`), בתאריך 4.10.2026.
- `gradlew :app:testDeviceDebugUnitTest --tests "il.co.runnersys.pos.hardware.payment.nayax.*"`: ‏16/16 עברו.
- כל `:app:testDeviceDebugUnitTest`: ‏1,234 בדיקות ב-137 מחלקות, 0 כשלונות.
- `:app:testMockDebugUnitTest` לבדיקות החדשות: ‏16/16 עברו.

---

## 7. הערכת מאמץ וצעדים הבאים

ההערכה היא למפתח אחד שמכיר את הקוד.

| # | עבודה | ימים | תלוי ב |
|---|---|---|---|
| 1 | `TcHttpEmvDevice`: ‏HTTPS POST ל-`/SPICy` (‏OkHttp 4.12 כבר בפרויקט), ‏timeouts, ביטול, TLS ל-C4, ‏status/version, ובדיקות עם `MockWebServer` (תלות בדיקה חדשה, `okhttp3:mockwebserver`) | 3–4 | — (מתועד) |
| 2 | בחירה בזמן ריצה לפי `paymentTerminalType` (`SwitchableEmvDevice`, החלפה רק כשהמסוף פנוי) וקריאת host/port/path מה-settings | 2 | 1 |
| 3 | הדפסת שובר מהקופה למסוף חיצוני (`customerReceipt`, ‏"מספר שובר") | 2–3 | תשובה אמיתית מ-C4 |
| 4 | נורית מסוף וגיליון פרטים, ‏probe דרך `whenIdle` | 1–2 | 1 |
| 5 | שחזור אחרי ניתוק (`getTransactionByVuid`, ‏PENDING בחיבור מחדש) והסתרת "פתח Agamento" כשהמסוף חיצוני | 1–2 | 1 |
| 6 | USB: הרשאות, ‏device filter, ‏attach/detach ותעבורה | **1** אם זה IP · **4–6** אם CDC/serial · **6–8** אם AOA | מפרט מ-Nayax |
| 7 | שרת ודשבורד: הגדרת הפרמטר (בלי מיגרציה), ‏(אופציונלי) מצב פינפד ב-heartbeat | 0.5–1.5 | — |
| 8 | (אופציונלי) מעבר ה-ViewModels ל-`PaymentTerminal` | 3–5 | 2 |
| 9 | הסמכה מול Nayax (9–15 בדיקות), ‏Production setup ופיילוט | 1–2 שבועות לוח שנה | מסוף בדיקה וכרטיסי בדיקה |

**סה"כ פיתוח:**
- ‏**כ-2–3 שבועות** אם ה-USB הוא IP, או אם הולכים ב-Ethernet.
- ‏**3–4 שבועות** אם זה serial או AOA.
- בנוסף, זמן ההסמכה מול Nayax.

**צעדים הבאים, לפי הסדר:**
1. לפנות למנהל הלקוח או למהנדס האינטגרציה ב-Nayax עם הרשימה ב-§4. יש כבר קשר דרך ה-55F ו-Agamento. לבקש C4 לבדיקה, מצב QA2 וכרטיסי בדיקה (מהמנפיקים).
2. בינתיים לממש את סעיפים 1, 2, 4 ו-5 (תעבורת רשת, בחירה לכל קופה, נורית ושחזור).
   - לבדוק מול C4 ב-Ethernet, או מול 55F במצב `TC_HTTP` אם Nayax תאפשר.
   - זה נותן קופה גדולה עובדת גם בלי USB.
3. לאסוף תשובה אמיתית אחת ולסגור את סעיף 3: הדפסת השובר ומספר השובר.
4. כשיגיע מפרט ה-USB: סעיף 6. אם זה IP על USB, נשארת רק קשירת הרשת.
5. בדיקות הסמכה, ואז פיילוט בחנות אחת.

**סיכונים:**
- ‏Nayax לא תתמוך ב-USB לצד host של Android. אז Ethernet הוא הנתיב, והוא מתועד.
- תעודת TLS של SPICy.
- מכשיר הקופה הגדולה לא יזהה RNDIS/NCM. צריך לבדוק את ה-kernel של הדגם.
- דרישות השובר כשאין מדפסת במסוף.

---

## 8. מקורות

**Nayax: מוצרים**
- [S1] Nayax ישראל, מסופון אשראי NOVA C4: https://www.nayax.co.il/il_he/pin-pad-emv-terminal.html
- [S2] Nayax.cz, ‏Nova C4 PinPad (מפרט): https://www.nayax.cz/produkt/nova-c4-pinpad/
- [S3] Nayax, עמוד Nova C4 (חסום לגישה אוטומטית; נקרא דרך תקצירי חיפוש): https://www.nayax.com/solution/nova-c4/
- [S4] Nayax U, ‏How to Activate 156 Nova Market and C4 POS: https://nayax-u.nayax.com/scenario/how-to-activate-156-nova-market-and-c-33153
- [S5] Nayax U, ‏Why & How: Nayax Retail Core: https://nayax-u.nayax.com/article/why-how-nayax-retail-core-onboarding-34017
- [S6] Nayax U, ‏How to Configure a Machine for Nova Device: https://nayax-u.nayax.com/scenario/how-to-configure-a-machine-for-nova-device-18036
- [S7] הודעה לעיתונות, 4.12.2024 (‏Nova 55F, ‏116 Flip, ‏C4 באירופה): https://www.stocktitan.net/news/NYAX/nayax-launches-its-suite-of-attended-retail-payment-solutions-in-601loq3pqimy.html
- [S8] Nayax ישראל, ‏Nova 156: https://www.nayax.co.il/il_he/nova-156.html
- [S9] Nayax ישראל, קופות ממוחשבות EMV: https://www.nayax.co.il/il_he/emv-computerized-cash-register
- [S10] Nayax shop, ‏Nova 55F: https://shop.nayax.com/usa_en/nova-55f.html

**Nayax Developer Portal (devzone)**
- [D1] Nayax Different Integrations: https://devzone.nayax.com/docs/nayax-different-integrations
- [D2] TweezerComm Overview: https://devzone.nayax.com/docs/integrate-pos-device/tweezercomm/overview-tweezer
- [D3] TweezerComm Get Started (‏SPICy, 8080/9090): https://devzone.nayax.com/docs/integrate-pos-device/tweezercomm/tweezercomm-get-started
- [D4] TC Service: https://devzone.nayax.com/docs/integrate-pos-device/tweezercomm/tc-service
- [D5] PinPad Mode: https://devzone.nayax.com/docs/integrate-pos-device/tweezercomm/pinpad-mode
- [D6] Resilience Mechanism: https://devzone.nayax.com/docs/integrate-pos-device/tweezercomm/resilience-mechanism-copy
- [D7] Integration Process: https://devzone.nayax.com/docs/integrate-pos-device/tweezercomm/tweezercomm-integration-process
- [D8] Israel Payment Flows: https://devzone.nayax.com/docs/integrate-pos-device/tweezercomm/israel-payment-flows/tweezercomm-israel-payment-flows
- [D9] Regular Transaction (Israel): https://devzone.nayax.com/docs/integrate-pos-device/tweezercomm/israel-payment-flows/single-phase-transaction
- [D10] Deferred Payment: https://devzone.nayax.com/docs/integrate-pos-device/tweezercomm/israel-payment-flows/tweezercomm-deferred-payment
- [D11] doTransaction (ashrait): https://devzone.nayax.com/docs/integrate-pos-device/tweezercomm/israel-payment-methods/dotransaction-ashrait
- [D12] doTransactionPhase1: https://devzone.nayax.com/docs/integrate-pos-device/tweezercomm/israel-payment-methods/dotransactionphase1
- [D13] cancelTransaction: https://devzone.nayax.com/docs/integrate-pos-device/tweezercomm/israel-payment-methods/canceltransaction-1
- [D14] abortTransaction: https://devzone.nayax.com/docs/integrate-pos-device/tweezercomm/israel-payment-methods/aborttransaction-copy
- [D15] doPeriodic: https://devzone.nayax.com/docs/integrate-pos-device/tweezercomm/israel-payment-methods/doperiodic
- [D16] getReport: https://devzone.nayax.com/docs/integrate-pos-device/tweezercomm/israel-payment-methods/getreport-1
- [D17] getStatus: https://devzone.nayax.com/docs/integrate-pos-device/tweezercomm/israel-payment-methods/getreport-copy
- [D18] getInternalStatus: https://devzone.nayax.com/docs/integrate-pos-device/tweezercomm/israel-payment-methods/getstatus-copy
- [D19] getRetailerInfo: https://devzone.nayax.com/docs/integrate-pos-device/tweezercomm/israel-payment-methods/getreport-copy-1
- [D20] getTransactionByVuid: https://devzone.nayax.com/docs/integrate-pos-device/tweezercomm/israel-payment-methods/gettransactionbyvuid-copy-1
- [D21] authorizePendingTransactions: https://devzone.nayax.com/docs/integrate-pos-device/tweezercomm/israel-payment-methods/authorizependingtransactions
- [D22] doMiniSettlement: https://devzone.nayax.com/docs/integrate-pos-device/tweezercomm/israel-payment-methods/dominisettlement
- [D23] getConfig: https://devzone.nayax.com/docs/integrate-pos-device/tweezercomm/device-methods/getconfig
- [D24] setConfig: https://devzone.nayax.com/docs/integrate-pos-device/tweezercomm/device-methods/setconfig
- [D25] getInfo: https://devzone.nayax.com/docs/integrate-pos-device/tweezercomm/device-methods/getinfo
- [D26] Response Codes: https://devzone.nayax.com/docs/integrate-pos-device/tweezercomm/additional-resources/response-codes
- [D27] Certification & Testing: https://devzone.nayax.com/docs/integrate-pos-device/tweezercomm/additional-resources/certification-files
- [D28] Test Terminal Setup: https://devzone.nayax.com/docs/integrate-pos-device/tweezercomm/additional-resources/using-test-cards-real-cards-during-the-integration
- [D29] Marshall Overview: https://devzone.nayax.com/docs/integrate-pos-device/marshall/marshall-sdk
- [D30] Marshall FAQ, General (‏Android, ‏serial נמוך): https://devzone.nayax.com/docs/integrate-pos-device/marshall/marshall-faqs/faq-general · ‏Marshall Integration Kit (כבל USB2Com): https://devzone.nayax.com/docs/integrate-pos-device/marshall/hw-integration-kit-and-setup/sales-kit
- [D31] Spark Overview: https://devzone.nayax.com/docs/integrate-pos-device/spark/spark
- [D32] EMV Core Overview: https://devzone.nayax.com/docs/integrate-pos-device/emv-core/overview
- [D33] UNO-mini Connection Interfaces (‏USB CDC): https://devzone.nayax.com/docs/integrate-pos-device/emv-core/uno-mini/uno-mini-connections
- [D34] EMV Core Android SDK Installation: https://devzone.nayax.com/docs/integrate-pos-device/emv-core/get-started/emv-core-android-installation
- [D35] אינדקס התיעוד (‏llms.txt): https://devzone.nayax.com/llms.txt. ל-Nayax יש גם שרת MCP לתיעוד: https://devzone.nayax.com/docs/get-started/mcp-setup

**חברה ורכישות**
- [C1] CTech, ‏Nayax רוכשת את Modularity (8.3.2020): https://www.calcalistech.com/ctech/articles/0,7340,L-3799495,00.html
- [C2] MarketScreener, ‏Nayax Ltd. acquired Modularity Technologies (תאריך ההשלמה; דרך תקציר חיפוש): https://www.marketscreener.com/quote/stock/NAYAX-LTD-122751359/news/Nayax-Ltd-acquired-Modularity-Technologies-Ltd--33958025/
- [C3] Nayax, רכישת OTI: https://www.nayax.com/news/nayax-acquires-oti-payment-solution/
- [C4] Vending Market Watch, ‏Weezmo: https://www.vendingmarketwatch.com/technology/news/21230395/nayax-acquires-israeli-tech-startup-weezmo
- [C5] Nayax Completes Acquisition of Retail Pro International: https://finance.yahoo.com/news/nayax-completes-acquisition-retail-pro-213000883.html
- [C6] Ynetnews (9.2025), ‏Weezmo, ‏Tigapo, ‏Roseman, ‏VMtecnologia, ‏UPPay: https://www.ynetnews.com/business/article/b1ghavd5ll
- [C7] Tracxn, רשימת רכישות: https://tracxn.com/d/acquisitions/acquisitions-by-nayax/__5Hifaop2s027CBxI-gMV2BCH_RXAOFGI4lFSbAaSSxg

**ישראל וחלופות**
- [I1] שב"א, אשראית EMV והסמכות (דרך תקצירי מנוע חיפוש; הדפים חסומים לגישה אוטומטית): https://www.shva.co.il/emv/ash-emv/ · https://www.shva.co.il/תקן-emv/
- [I2] Verifone ישראל, חיבור לאשראית PC EMV של שב"א: https://www.verifone.com/he-il/resources/ashrait-pc-emv-shva
- [I3] Verifone ישראל, ‏EMV בישראל: https://www.verifone.com/he-il/resources/emvinisrael
- [I4] Z-Credit, ‏Z3: https://www.z-credit.com/site/z3
- [I5] Z-Credit, ‏Q3P: https://www.z-credit.com/site/q3p
- [I6] CreditGuard (Hyp), ‏CG Gateway EMV XML API: https://www.creditguard.co.il/wp-content/uploads/2022/11/20221024-3_2_45-EMV-XML-API.pdf
- [I7] Pelecard, מכשירי סליקה (סיכום חיפוש): https://pelecard.com/articles/מכשיר-סליקה-אשראי
- [I8] Tranzila, סליקה מאנדרואיד: https://www.tranzila.com/android.html
- [I9] PAX A35 (להשוואת מפרט): https://www.paxtechnology.com/a35

**Android**
- [A1] usb-serial-for-android (‏MIT, ‏JitPack, וגם הדוגמה עם `FLAG_MUTABLE` ו-`setPackage`): https://github.com/mik3y/usb-serial-for-android
- [A2] Android Developers, ‏USB host overview: https://developer.android.com/develop/connectivity/usb/host

**הקוד שלנו** (נקרא, לא שונה)
- `P:\pos-android\app\src\main\java\il\co\runnersys\pos\hardware\payment\`: ‏`EmvDevice.kt`, ‏`TweezerRequests.kt`, ‏`TweezerOutcome.kt`, ‏`TerminalBatch.kt`, ‏`Periodic.kt`, ‏`CardBrands.kt`
- `P:\pos-android\app\src\device\java\il\co\runnersys\pos\hardware\payment\AgamentoEmvDevice.kt`
- `P:\pos-android\app\src\main\java\il\co\runnersys\pos\AppContainer.kt`, ‏`hardware\HardwareProvider.kt`, ‏`hardware\kitchen\KitchenPrintService.kt`, ‏`ui\kitchen\PrintersScreen.kt`
- `P:\pos-android\PLAN.md` (§1–§2: ‏Nova 55F / F20, ‏Agamento, ‏TweezerComm)
- `P:\pos-server\server\app\services\settings_merge.py`, ‏`till_parameters.py`, ‏`schemas\pos_settings.py`
