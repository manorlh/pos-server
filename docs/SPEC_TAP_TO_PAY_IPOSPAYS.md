# מחקר: Tap to Pay על Android של iPOSpays / Dejavoo, בקופת R2M

**תאריך:** 2026-10-05
**מצב:** מחקר בלבד. לא שונה קוד באף repo, לא נפתח חשבון, לא הוזנו פרטי גישה, ה-SDK לא הורד.
**נקודת המוצא:** https://docs.ipospays.com/tap-to-pay-on-android/dv-android-sdk והדפים שמקושרים אליו.

**מקרא:**
- **[מאומת]**: ראיתי את זה במקור שמצוטט ליד.
- **[מכשיר]**: נקרא ישירות מה-P18 המחובר ב-adb (פקודות קריאה בלבד: `getprop`, `settings get`, `pm list`, `dumpsys`). לא הותקן ולא שונה דבר.
- **[הסקה]**: מסקנה שלי מכמה סימנים. לא כתוב כך באף מקור.
- **[פתוח]**: צריך לברר מול הספק.

---

## 0. תקציר

1. **הדף שנתת (`dv-android-sdk`) הוא לא ה-SDK של Tap to Pay.** למרות שהכתובת שלו תחת `/tap-to-pay-on-android/`, הוא מתאר ספרייה (`com.dvmms:dejapay`) שמדברת ב-AIDL עם **אפליקציית תשלום של Dejavoo שמותקנת על אותו מכשיר** (`com.dejavoo.dvpay`, `com.dejavoo.dvpay.kozen`, `com.denovo.app.denovopay`), ושעובדת מול ספק `zcredit` במטבע `NIS`. הכרטיס נקרא שם על ידי הקורא המוסמך של המסוף, לא על ידי ה-NFC של Android. זה "מסוף משולב על אותו מכשיר", לא SoftPOS. [מאומת, S6]
2. **ה-SoftPOS האמיתי (CPoC, בנגיעה בטלפון) קיים בגרסה ישראלית נפרדת**, בשני דפים שאין אליהם קישור בתפריט הצד ונמצאים רק ב-`sitemap.xml`:
   - `/tap-to-pay-on-android/in-app-sdk-israel`: ה-SDK מציג מסך משלו (מצב "In-App"). [S2]
   - `/tap-to-pay-on-android/skinless-sdk`: ה-SDK בלי UI, את המסך בונים אנחנו. **זה מה שמתאים לקופה שלנו.** [S3]
3. **זמין בישראל: כן.** שקלים, עברית (`TopParams.HEBREW`), שדות תשלומים (`CreditType`, `NumberOfPayments`, `HolderID`), כרטיס "VISA CAL" בדוגמה, ושדות תשובה של Z-Credit. Z-Credit היא חברה ישראלית ש-Dejavoo רכשה ביוני 2024, ו-iPOSpays בישראל יושבת עליה. [מאומת, S2, S3, E1]
4. **כדי להשתמש בזה כל לקוח חייב להיות מוקם אצל Z-Credit/iPOSpays** (TPN + Merchant Code). זה לא מחליף את Nayax/Agamento ללקוחות שסולקים דרכם. מוסיפים ספק Z-Credit לקופה, ולכן כדאי לברר אם אותו חשבון Z-Credit משרת גם TOP. [הסקה]
5. **ה-P18 הוא בפועל ה-Dejavoo P18** (יצרן KOZEN, Android 13, קורא EMV L1/L2 + PCI PTS 5.x לפי מפרט המשווק). הוא ברשימת המסופים הנתמכים של DvPayLite (P1, P3, P5, P8, P12, P17, P18) וגם יש לו SDK למגירת כסף. כלומר, למכשיר הזה יש מסלול טבעי יותר מ-SoftPOS: **מסלול C (DvPay + Z-Credit דרך ה-DV Android SDK)**, עם קורא כרטיסים מוסמך, צ'יפ, פס מגנטי, PIN. [מאומת, S8, E3]
6. **מה שחוסם היום:**
   - אין גישה ל-SDK: ה-Maven פרטי (מפתחות AWS) וה-AAR נמסר רק על ידי `devsupport@dejavoo.io`.
   - ה-AAR ל-production נבנה **לכל מפתח חתימה (SHA-256)** ואחרי הבנייה יש שלב "finalization" עם קובץ `.fin`. זה משנה את תהליך ה-release וה-OTA שלנו.
   - ה-SDK **חוסם מכשיר עם Developer Options פעיל** (קודי שגיאה 27, 28). ל-P18 שלנו יש Developer Options ו-USB debugging פעילים.
   - התיעוד **לא מזכיר** Play Integrity, root, מסך נעילה או רשימת מכשירים מאושרים. אי אפשר לדעת מהתיעוד אם P18 יאושר.
   - אין תיעוד ל: החזר מקושר, ביטול של עסקה ישנה, שידור/סגירת יום, abort, תשלומים בנגיעה, כרטיסי בדיקה, שוברים.
7. **המלצה (פירוט ב-§7):** לא להתחייב ללקוחות ולא להכניס ל-roadmap לפני תשובות הספק. **כן לפתוח ספייק מוגבל** (3-5 ימים) ברגע שיש AAR של UAT ו-TPN בסנדבוקס, ובמקביל לשלוח לספק את רשימת השאלות ב-§6.3. לשאול קודם על מסלול C, כי הוא מיועד ל-P18.

---

## 1. מה ה-SDK, איך מפיצים אותו, ודרישות מכשיר

### 1.1 שלושה מוצרים תחת "Tap to Pay on Android"

| | מוצר | דף | ספק/אזור | מי מציג מסך | איך הכרטיס נקרא |
|---|---|---|---|---|---|
| A | In-App SDK (ישראל) | `/tap-to-pay-on-android/in-app-sdk-israel` | Z-Credit, ישראל | ה-SDK | NFC של Android, SoftPOS |
| B | **Skinless SDK (ישראל)** | `/tap-to-pay-on-android/skinless-sdk` | Z-Credit, ישראל | **אנחנו** | NFC של Android, SoftPOS |
| C | DV Android SDK | `/tap-to-pay-on-android/dv-android-sdk` | `zcredit`, NIS | אפליקציית DvPay (`DvPaymentActivity`) | קורא המסוף המוסמך (או DenovoPay) |
| - | In-App SDK (US) | `/tap-to-pay-on-android/in-app-sdk` | TSYS, ארה"ב | ה-SDK | לא רלוונטי |
| - | Skinless SDK (US) | `/tap-to-pay-on-android/skinless-sdk-us` | ארה"ב, USD | אנחנו | לא רלוונטי |
| - | Deep Linking SDK | `/tap-to-pay-on-android/deep-linking` | SPIn / DvPayLite | DvPayLite | לא רלוונטי (סוג מסוף אחר) |

הערות:
- שמות הכתובות מבלבלים: `skinless-sdk` הוא הישראלי ו-`skinless-sdk-us` הוא האמריקאי; `in-app-sdk` הוא האמריקאי ו-`in-app-sdk-israel` הישראלי. [מאומת, S11 + כותרות הדפים]
- דף הנחיתה (`/tap-to-pay-on-android`) מתאר את זה כ"Tap to Pay on Android With iPOSgo", מבוסס NFC במצב EMV, "governed by the PCI-CPOC standard", ומציע "certified libraries, user interfaces, and branding". [מאומת, S1]
- אין בתיעוד אזכור לרישום ב-PCI SSC של המוצר. [פתוח]

### 1.2 הפצה

**מוצרים A ו-B (ישראל):** [מאומת, S2, S3]

| נושא | פרט |
|---|---|
| מאגר Maven | פרטי, מוגדר עם `credentials(AwsCredentials) { accessKey ...; secretKey ... }`. את ה-URL והמפתחות נותן `devsupport@dejavoo.io`. |
| תלויות | `implementation 'com.denovo:topliteapp:2.5.0.37'` ו-`implementation files('libs/SoftPos-v1.3.66.7-Debug_Test.aar')` |
| ספריית עזר | "Paycore library", קובץ בגוגל דרייב שמקושר מהדף |
| דגל Gradle | `android.enableJetifier = true` |
| `Application` | האפליקציה חייבת **לרשת מ-`MyApplication` של ה-SDK** במקום מ-`android.app.Application` |
| מניפסט | `tools:replace="android:allowBackup,android:roundIcon,android:theme"` על `<application>` |
| ProGuard | רשימת `-keep` ארוכה, כולל `-dontshrink`. מכילה גם חבילות `com.cardtek.softpos.**`, `com.cloudpos.**`, `com.wizarpos.**`, וחבילה מעורפלת `vhbgotabuuowoix.**` |
| AAR לבדיקות | `...Debug_Test.aar` ("רק לבדיקות") |
| AAR לייצור | נוצר **לכל SHA-256 של מפתח החתימה** (מקומי, ו-Play Store אם מפרסמים שם), אחרי קבלת המפתחות. בדף האמריקאי: כשבוע. |
| קובץ `.fin` + Finalizer | אחרי בניית ה-APK/AAB חתום, מריצים כלי "finalization" לפי גרסת ה-OS. הכלי והסבר ב-Google Drive. "Completion of the above steps is mandatory before submitting the application to production or app store release." |
| גרסאות | `topliteapp` 2.5.0.37 בישראל, 1.7.6.0 ב-US skinless (היסטוריית גרסאות של ה-US in-app מגיעה ל-1.7.5.5). `sdk_version` בתשובה: 600540, 600591. |

[הסקה] החבילות `com.cardtek.softpos` ו-`orion.acquilalibra`/`orion.acquila.libra` מרמזות שליבת ה-SoftPOS היא של ספק צד שלישי (Cardtek). `-dontshrink` + חבילה מעורפלת + finalizer נראים כמו כלי הגנת אפליקציה (app shielding) שקשור לאישור PCI. לא כתוב כך.

**מוצר C (DV Android SDK):** [מאומת, S6]
- `implementation 'com.dvmms:dejapay:2.0.66'` ו-`implementation files('libs/invoke-dvpay-lite-1.2.1.3.aar')` (ה-AAR בגוגל דרייב). הדף אומר "configured Maven repositories" בלי לציין איזה.
- חייבים `aidl = true` ו-`buildConfig = true`; ה-AIDL כלול ב-SDK.
- `<queries>` ל-`com.dejavoo.dvpay`, `com.dejavoo.dvpay.kozen`, `com.denovo.app.denovopay` ול-action `com.dejavoo.dvpay.InternalTerminalService`; ההרשאה `QUERY_ALL_PACKAGES`.
- **דורש שאפליקציית התשלום תהיה מותקנת על המכשיר.** בלי DvPay אין מה לקרוא לו.

**קישורי הורדה בדפים הם לגוגל דרייב.** אלה מקורות שלא אומתו, ולא הורדתי אותם. כדאי לקבל את הקבצים ישירות מ-`devsupport@dejavoo.io` ולא מקישור בדף.

### 1.3 דרישות מכשיר, לפי התיעוד

| דרישה | ערך | מקור |
|---|---|---|
| גרסת Android | **8.1 ומעלה** (ישראל). בדף ה-US: min SDK 28 (Android 9), compile/target 34 | [מאומת] S2, S3, S5 |
| NFC | חובה. הקוד מחזיר שגיאה 26 `NO_NFC_CODE`. `uses-feature nfc` מוגדר `required=false` | [מאומת] S2 |
| אינטרנט | חובה (רישום, עסקאות, ביטול, סגירת יום) | [מאומת] S5 |
| הרשאות | `NFC`, `INTERNET`, `ACCESS_FINE_LOCATION`, `ACCESS_COARSE_LOCATION`. מיקום חובה בזמן ריצה (שגיאה 21 `LOCATION_PERMISSION_MISSING`). בדף ה-US גם הרשאות אחסון חיצוני. | [מאומת] S2, S5 |
| Developer Options | **חייב להיות כבוי.** קודים 27 `DEVELOPER_OPTION_ENABLED_CODE`, 28 `DEVELOPER_OPTION_DETECT_FAILED_CODE` | [מאומת] S2 |
| יישור 16KB | ה-AAR הנוכחי של US לא מיושר ל-16KB ולכן לא ל-production. רלוונטי רק ל-Android 15+ עם דפי 16KB | [מאומת] S5 |
| Play Integrity, attestation, root, מסך נעילה, GMS מאושר, bootloader | **לא מוזכר בשום דף** | [פתוח] |

**למה זה לא מספיק:** SoftPOS שעובד לפי PCI CPoC/MPoC בדרך כלל דורש הוכחת שלמות מכשיר (attestation) ובדיקות שרת. כדוגמה לסדר גודל, ספק SoftPOS אחר (Nexi) מפרסם: Android מעל 9, NFC, Google Play Services פעיל, Play Integrity נתמך, בלי root, "No developer mode enabled", bootloader נעול, TEE או Hardware-backed Keystore, anti-debugging/anti-tampering, Play Protect פעיל ומאושר, מכשיר GMS Certified ו-stock OS. זו התייחסות לענף, **לא** תיעוד של iPOSpays. [הסקה, E4] בגלל קודי 27/28 וההתאמה ל-SHA-256, סביר מאוד ש-iPOSgo עושה בדיקות דומות, אך אין לדעת איזה verdict של Play Integrity הוא דורש.

### 1.4 האם ה-P18 יעמוד? (בדיקה על המכשיר, קריאה בלבד)

המכשיר: `adb -s P1861GB2592700180`, בדיקה ב-2026-10-05. נתוני ה-NFC נמסרו גם על ידי ה-coordinator, ואימתתי אותם מחדש (`pm list features`, `dumpsys nfc`).

| מה נבדק | ערך במכשיר | מה זה אומר |
|---|---|---|
| יצרן / דגם | `KOZEN` / `Nebullar P18`, Android **13** (SDK 33), `ro.product.first_api_level=33` | עובר את 8.1+ ואת 28+ בנוחות |
| NFC | `android.hardware.nfc`, `nfc.any`, `nfc.hce`, `nfc.hcef`, `nfc.uicc`; `mState=on` | יש בקר NFC של Android. עובר את הדרישה הפורמלית. **ביצועי קריאה בפועל** (טווח, מיקום האנטנה בטאבלט 10.95") לא נבדקו ויש לבדוק בשטח |
| סוג build | `user`, `release-keys`, `ro.debuggable=0`, `ro.secure=1` | נקי, לא build של מפתחים |
| Verified boot | `ro.boot.verifiedbootstate=green`, `flash.locked=1`, `vbmeta.device_state=locked`, `veritymode=enforcing` | bootloader נעול, אין root. עובר |
| Keystore חומרה | `android.hardware.hardware_keystore=100`, `keystore.app_attest_key` | יש Key Attestation בחומרה. טוב ל-attestation |
| Google Play Services | `com.google.android.gms` 26.32.34, `com.android.vending`, `ro.com.google.clientidbase=android-uniscope`, `ro.com.google.gmsversion=13_202401` | GMS ו-Play Store מותקנים. **אם המכשיר מאושר (Play Protect certified) אי אפשר לדעת מ-adb** |
| רמת אבטחה (patch) | `security_patch=2024-07-05`, vendor על Android 12 | ישן ביותר משנה. לפי Google, verdict `MEETS_STRONG_INTEGRITY` דורש עדכוני אבטחה "בשנה האחרונה", ו-`MEETS_DEVICE_INTEGRITY` לא [E5]. אם ה-SDK דורש strong, ה-P18 ייכשל |
| Developer Options | `development_settings_enabled=1`, `adb_enabled=1`, `persist.sys.usb.config=adb`, `install_non_market_apps=1` | **ייפסל עם קוד 27 כל עוד פעיל.** צריך לכבות במכשירי production (ולפתח בלי ה-SDK או על מכשיר נפרד) |
| מסך נעילה | `CredentialType: None`; ה-feature `secure_lock_screen` נתמך | אין נעילה מוגדרת. התיעוד לא דורש, אבל מקובל בענף. לבדוק |
| אפליקציות מפריעות | `com.nulana.android.remotix_lite` (שליטה מרחוק), `com.xcheng.screenrecorder`, `com.xcheng.mdm`, `com.custom.mdm`, `com.pos.mdmservice` | SDK של SoftPOS לעיתים חוסם overlays/הקלטת מסך/גישה מרחוק. לבדוק, ואולי להסיר |
| Dejavoo | אין `com.dejavoo.dvpay*`, `DVStore`, `com.denovo.*` | זה firmware של Kozen (`P1861_V1.0.4`), לא של Dejavoo. **מסלול C לא ירוץ בלי שהספק יתקין DvPay ויפתח מפתחות** |
| Kozen secure | `com.xc.hsm`, `com.pos.service`, `dev.pos.tty_dev=/dev/ttyS1` | הצ'יפ המאובטח של המסוף. אסור לפתוח את ה-`ttyS1` בעצמנו |
| CPU / ABI | MediaTek MT8781V, `abilist=arm64-v8a,armeabi-v7a,armeabi`, דף זיכרון 4096 | **האפליקציה שלנו מוגבלת ל-`armeabi-v7a` בלבד** (`abiFilters`, build.gradle.kts). אם ה-AAR מכיל רק `arm64-v8a`, ה-SDK ייחתך. לברר איזה ABI יש ב-AAR |

**מסקנה על ה-P18:** לא נראה פסול, ועובר את רוב מה שאפשר למדוד (build נקי, verified boot ירוק, bootloader נעול, GMS, keystore בחומרה, NFC). **שלוש נקודות פתוחות:** (א) Developer Options (פתיר), (ב) איזה Play Integrity verdict נדרש ואם ה-patch של 2024-07 מספיק, (ג) האם בצד השרת של iPOSgo קיימת רשימת מכשירים מאושרים (allow-list), שאליה P18 של Kozen אולי לא נכנס. **את (ג) אפשר לברר רק מהספק או בניסוי.**

**מה לבדוק על המכשיר לפני/בזמן הספייק:**
1. לכבות Developer Options ו-USB debugging ולבדוק שהרישום ב-UAT לא נכשל בקוד 27/28.
2. לבדוק Play Protect certification: Play Store, הגדרות, אודות, "Play Protect certification". ולהריץ בדיקת Play Integrity עם אפליקציית בדיקה רשמית מ-Google (דורש התקנה, יש לבקש אישור מהמשתמש).
3. לבדוק קריאת כרטיס בפועל: טווח ומיקום האנטנה של ה-NFC, מצב flip/דוק, וכיסוי/מגן מסך.
4. להסיר או להשבית את `remotix_lite` ו-`screenrecorder` בבדיקה, ולבדוק אם הם גורמים לחסימה.
5. להגדיר מסך נעילה ולבדוק אם משפיע.
6. לבדוק אילו ABI יש ב-AAR מול `abiFilters`.
7. לאשר שה-`ttyS1` לא נפתח על ידינו ושה-SDK לא מתנגש עם `com.pos.service` של Kozen.

**ה-F20 (Nayax Nova 55F):** [הסקה, ממסמכי ה-repo]
- Android 10 (API 29), QCM2150, 32 סיביות בלבד. עובר את Android 8.1+.
- יש לו כבר מסוף משולב מוסמך שבא (Agamento) ומדפסת. ה-SoftPOS לא מוסיף לו כלום, ולקוחות Nayax לא יעברו ל-Z-Credit בשביל זה.
- לא ידוע אם הוא GMS מאושר, ו-firmware של Nayax עלול לנעול התקנה. **לא מועמד.**

---

## 2. Onboarding

| נושא | פרט | מקור |
|---|---|---|
| חשבון סוחר | הסוחר חייב להיות מוקם ב-iPOSpays (סנדבוקס ל-UAT, production לחי) עם **TPN** תקף. אם אין TPN: "contact your ISO or devsupport@dejavoo.io". הקמה נעשית על ידי ISO דרך הפורטל או ה-API של Merchant Onboarding | [מאומת] S2, S10 |
| TPN | מזהה בן 12 ספרות (Terminal Profile Number), ייחודי לסוחר | [מאומת] S2 |
| Merchant Code | "קוד ייחודי בן 12 ספרות" לכל סוחר. מופק בפורטל: Menu, Settings, "Mechant Keys/Ecom Token", בוחרים TPN מסוג Tap on Phone (TOP), Generate | [מאומת] S2, S3, S4 |
| רישום מכשיר | `registerDevice(tpn, merchantCode)` (או `downloadParameter(RegisterData)` ב-skinless). מחזיר `session_key` (תוקף ברירת מחדל 24 שעות) ו-`auth_token`/`ecomAuthToken`. כל אפליקציה שומרת ובודקת תוקף לפני כל עסקה (קוד 990 = פג תוקף, רישום מחדש) | [מאומת] S2, S3 |
| מפתחות API/Secret | לשירותי REST אחרים (Transact, Batch Report, Status Check, Onboarding): מפתחות מהפורטל (Settings, Generate API & Secret Key), טוקן JWT מ-`auth.ipospays.tech` (סנדבוקס) או `auth.ipospays.com`. **לא נדרשים ל-`startTransaction` עצמו**, שם מספיק `session_key` | [מאומת] S9 |
| חתימת האפליקציה | SHA-256 של מפתח החתימה (מקומי, ו-Play Store אם רלוונטי) נרשם ב-backend, ורק אז נוצר AAR | [מאומת] S2 |
| סנדבוקס | יש סביבת UAT ("iPOSpays sandbox"), כולל `https://steam.ipospays.tech/` ו-`payment.ipospays.tech`. לבדיקת SoftPOS נותנים AAR של Debug/Test | [מאומת] S2, S8, S10 |
| **כרטיסי בדיקה** | **לא מתועדים בשום דף** (חיפשתי "test card" בכל הדפים). כרטיסי EMV של בדיקה ל-NFC לא מוזכרים | [פתוח] |
| מסוף סנדבוקס מול production | במסלול DvPayLite (לא C): צריך להחליף את סביבת DvPayLite/DVStore ל-UAT (דורש הסרה והתקנה מחדש). ב-A/B: AAR מסוג Debug/Test לבדיקות, ו-AAR ייעודי ל-production | [מאומת] S2, S8 |

[הסקה] דוגמת ה-JWT בדף (`ecomAuthToken`) מפוענחת ל-`{tpn, email: "7162_TOP@z-credit.com"}`. נראה שלכל סוחר נפתח ב-Z-Credit "מסוף TOP" ייעודי (סיומת `_TOP`). אם נכון, זה מסוף נפרד מזה של ה-gateway הרגיל, וצריך להקים אותו בנפרד.

אנשי קשר: `devsupport@dejavoo.io` (דפי ישראל והכלליים), `devsupport@denovosystem.com` (כותרת דפי US).

---

## 3. אזורים, מטבעות, סולקים

**ישראל: כן, מתועד במפורש.** [מאומת]

| ראיה | איפה |
|---|---|
| דפים ייעודיים בכותרת "(Israel)": "Tap on Phone Android SDK for Israel" | S2, S3 |
| תשובת עסקה לדוגמה: `"amount_paid": "₪3.00"`, `"card_type": "VISA CAL"` | S2, S3 |
| שפת ממשק `TopParams.HEBREW` / `ENGLISH` | S2 |
| `HolderID`, `CreditType`, `NumberOfPayments` בשדות הבקשה (בדף כתוב על `HolderID` רק "מזהה בעל כרטיס"; [הסקה] שב-Z-Credit זו ת.ז., לאמת) | S2, S3 |
| שדות תשובה בשם Z-Credit: `ZCreditInvoiceReceiptResponse`, `ZCreditPinpadReport`, `ZUID`, `VoucherNumber`, `ApprovalNumber` | S2, S3 |
| מוצר C: `ZCreditCurrency.NIS`, `<provider>zcredit</provider>` | S6 |
| Dejavoo רכשה את Z-Credit ו-Z2C ב-18.6.2024; ציטוט מהודעה: "Tap to Pay technology now adopted by major integrators in our market" | E1 |
| מסוף Z3 של Dejavoo אצל Z-Credit: תו EMV של שבא, תומך ביישומי כאל, ישראכרט ומקס, ארנקים (Google Pay, Apple Pay, Bit, Cal Pay, Max Pay, Any Pay) | E2 |

**סולקים:** [הסקה, חזקה]
- בדוגמה של SDK ישראלי: `CardBrandCode=2`, `CardIssuerCode=2`, `CardFinancerCode=1` עבור "VISA CAL". בדוגמה של מוצר C: `4/4/1` (Amex).
- אלה תואמים לטבלאות הקודים של שבא שכבר ממומשות אצלנו ב-`CardBrands.kt` (`mutag` 2 = Visa, `manpik` 2 = כאל, `solek` 1 = ישראכרט).
- כלומר, מאחורי Z-Credit יש סולק ישראלי אמיתי (בדוגמה ישראכרט), והקודים הם קודי שבא.
- **אבל:** אין בתיעוד רשימת סולקים נתמכים, ואין אישור מפורש ש-SoftPOS מוסמך מול שבא. [פתוח]

**ארה"ב:** דפי ה-US רשומים כ-TSYS ("Supported Payment Processors: TSYS"), עם USD, מס/עמלה/טיפ. לא רלוונטי.

---

## 4. מה ה-API חושף

### 4.1 מוצר B, Skinless (ישראל): המועמד

**כניסה (in-process):** ה-SDK רץ בתוך התהליך שלנו, בקריאות Java/Kotlin עם callback. אין intents. [מאומת, S3]

```
ToPService.downloadParameter(RegisterData(tpn, merchantCode), IposgoDelegate)
ToPService.startTransaction(TxnData, sessionKey, IposgoDelegate)
IposgoDelegate { didReceiveSuccessData(message, json), onProcess(message, timeStamp), didReceiveError(json, code) }
```

| יכולת | קיים? | פרט | מקור |
|---|---|---|---|
| אתחול / רישום | כן | `downloadParameter(RegisterData)`. מחזיר `session_key`, `session_expire_time`, `ecomAuthToken` | S3 |
| מכירה | כן | `TxnData.type = TOPParams.SALE`, `amount` כמחרוזת ("10.00"), `customerDetails` | S3 |
| החזר | כן | `TOPParams.REFUND`, `amount`. **אין שדה לעסקה מקורית** | S3 |
| ביטול | כן | `TOPParams.VOID`, `rrn` של העסקה המקורית | S3 |
| תשלומים | חלקי | `customerDetails.creditType` ו-`numberOfPayments` (ברירת מחדל "1"/"1"). **לא מוסבר מה ערכי `creditType`, מה הטווח, ואם זה עובד בנגיעה.** קיים תשלומים מפורש רק ב-Manual Entry: `PaymentType.REGULAR / CREDIT / INSTALLMENT` עם `minQuantity`/`maxQuantity` | S3 |
| טיפ | לא | אין שדה טיפ בבקשה (ב-US יש). אצלנו הטיפ כבר חלק מהסכום | S3, S5 |
| מזהה לשחזור | חלקי | `customerDetails.transactionUniqueIdForQuery` (UUID) "to query the transaction later". **לא מתועד איך שואלים.** ה-API הכללי של Transaction Status Check (`/api/v3/iposTransactStatus`) הוא של ארה"ב ושואל לפי `transactionReferenceId` | S3, S10 |
| ביטול באמצע (abort) | לא מתועד | יש קוד 21 `TRANSACTION_CANCELLED` ו-34 `CARD_PRESENT_TXN_CANCELLED`, אבל אין פעולה | S2 |
| שידור / סגירת יום | לא מתועד בישראל | קודים 992 `BATCH_NO_TRANSACTION_CODE`, 994 `BATCH_UNABLE_TO_FETCH_CODE` קיימים בטבלה. בדף ה-US יש `batchSettlement`. בישראל לא מתועד | S2 |
| דוחות | לא מתועד בישראל | ב-US יש `showReport` | S4 |
| קבלה | חלקי | "You can only send the receipt via SMS or Email" ו-`sendReceipt` בבקשה (הפרטים לא בטקסט). שדות `ClientReciept`/`SellerReciept` קיימים בתשובה ו**ריקים** בדוגמה | S3 |
| הקלדה ידנית / QR | כן | `CardTopService` עם `PaymentMode.KEY_IN` / `QR`. מציג UI של ה-SDK | S3 |

**ממשק משתמש:** במוצר B אנחנו בונים את המסך ("הצמד כרטיס"), וה-SDK מדווח התקדמות ב-`onProcess`. ב-KEY_IN/QR ה-SDK פותח UI משלו (עם `SdkThemeConfig` לצבעים). במוצר A ה-SDK מציג את כל המסך. [מאומת, S2, S3]

**תשובת עסקה (שדות שימושיים):** [מאומת, S3]
`status` ("Approved"), `response_code` ("00" = אושר), `last_4_digits`, `transaction_title`, `transaction_id`, `rrn`, `invoice_no`, `amount_paid` ("₪3.00" עם סימן), `card_type` ("VISA CAL"), `mask_pan`, `approval_code`, `sdk_version`, ואובייקט `transactionResult` עם `kernelResult` (`EMV_ONLINE_ACCEPT`), `applicationLabel`, `withPin`, ו-`customMessage.DE48` עם `CardBIN`, `ExpDate_MMYY`, `CardIssuerCode`, `CardFinancerCode`, `CardBrandCode`, `ReferenceNumber`, `VoucherNumber`, `ApprovalNumber`, `Token`, `TipAmount`, `PanEntryMode` ("05" בדוגמה), `ZUID`, `BAT`, `INV`.

**קודי שגיאה (עיקריים):** [מאומת, S2]

| קוד | משמעות | הערה |
|---|---|---|
| 1-4 | TPN / Merchant Code ריק או לא תקין | |
| 15 | `PARAM_NOT_CONFIGURED` | |
| 16, 17, 18 | שגיאת רישום, אין intent data, סוג לא מוגדר | |
| 19 | `UNABLE_TO_TXN` | |
| 20 | `TRANSACTION_FAILED` **וגם** `NO_INTERNET_CODE` | **התנגשות בטבלה** |
| 21 | `TRANSACTION_CANCELLED` **וגם** `LOCATION_PERMISSION_MISSING` | **התנגשות בטבלה** |
| 22-25 | חסר type / amount / סכום לא תקין / חסר custom object | |
| 26 | `NO_NFC_CODE` | |
| 27, 28 | Developer Options פעיל / לא ניתן לבדוק | חוסם |
| 33, 34 | timeout / ביטול במסך הצמדת הכרטיס | |
| 51 | `HOST_DECLINE_REFUSAL_CODE` | סירוב |
| 96 | `ERROR_REFUSAL_CODE` | |
| 99 | `FEATURE_NOT_SUPPORTED` | |
| 100, 101, 104, 105 | פנימית / חיבור / שרת / בדיקת שירות POS | |
| 980-984, 990, 991 | מפתח session לא תקין או פג תוקף | לרשום מחדש |
| 992, 994 | batch: אין עסקאות / לא ניתן להביא | |

הערה: הדפים עצמם מסומנים באיכות נמוכה (`ClientReciept` ריק, `txnData.rrn = edtTipAmount.text` בדוגמת ה-VOID, "Pre Auth" שמוזכר בדף הישראלי למרות שלא נתמך, כותרת HTML "Deep Linking SDK (israel)" בדף A, טבלת קודים עם כפילויות). **צפו לעבודה צמודה עם התמיכה.**

### 4.2 מוצר A, In-App (ישראל)

אותו ליבה כמו B, אבל `ToPService.registerDevice(...)` ו-`performTransaction(inputObject, sessionKey, customObject, listener)` עם `{type: SALE|REFUND|VOID, amount, lang: ENGLISH|HEBREW}`. ה-SDK מציג את מסך ההצמדה. ב-VOID אין `amount`, וגם לא `rrn` בדוגמה, כך שלא ברור איזו עסקה מתבטלת. פחות מתאים לקופה כי לא שולטים בחוויה. [מאומת, S2]

### 4.3 מוצר C, DV Android SDK (על המסוף)

| נושא | פרט |
|---|---|
| קריאה | `ZCreditInternalTerminal(packageName).commitTransaction(context, ZCreditTransaction, ZCreditTerminalCallback<ZCreditTransactionResponse>)`. תקשורת **ב-AIDL עם אפליקציית DvPay**, לא in-process |
| UI | `DvPaymentActivity` של ה-SDK, מופעל על ידי DvPay. אנחנו לא שולטים במסך |
| פעולות מתועדות | Sale, Pre-Auth (J5), Capture (`Ticket` + `obeligoAction=Capture`), Release (`Ticket` + `obeligoAction=Release`), `hideAmount` ל-Pre-Auth |
| **לא מתועד** | החזר, ביטול של מכירה, תשלומים, סגירת יום (ב-ZCredit) |
| תשובה | שדות כמו `cardNumber`, `expDate`, `referenceNumber`, `voucherNumber`, `approvalNumber`, `token`, **`clientReceipt`, `sellerReceipt`**, `tpn`, `isTelApprovalNeeded` |
| שגיאות | `onError(Throwable)` בלבד. אין רשימת קודים |
| Go-live | "obtain the Production Terminal Number (TPN) and Terminal Password" מנציג הסליקה |
| דורש | DvPay מותקן, מפתחות מוזרקים בצ'יפ המאובטח, חתימה (בדף DvPayLite: `kozen.jks` להרצה על מסוף) |

[מאומת, S6, S8]

---

## 5. מיפוי לתפר התשלום בקופה

### 5.1 איך זה נראה היום (קריאה בלבד מה-repo)

- **`EmvDevice`** (`hardware/payment/EmvDevice.kt`): ממשק **ברמת פריים**. `sendFrame(json)` שולח JSON-RPC של TweezerComm (שירות `ashrait`) ומחזיר JSON. את ה-JSON בונים `Tweezer.*` ו-`parseCardResponse` מפענח. כל הלוגיקה של Agamento וה-Nayax היא פריימים.
- **`SwitchingEmvDevice`**: בוחר בכל קריאה בין `builtIn` (Agamento) ל-pinpad ברשת (`TerminalKind.NAYAX_LAN`). `targetOf()` מכיר רק `NAYAX_LAN` ו-`BUILT_IN`. מה שלא Nayax הוא built-in.
- **`PaymentTerminal`** (`hardware/payment/nayax/PaymentTerminal.kt`): **הצעה, עדיין לא בשימוש.** הממשק הנכון לספקים שלא מדברים פריימים: `sale(CardSale)`, `refund(CardRefund)`, `void(CardVoid)`, `abort(vuid)`, `lookup(vuid)`, `transmit()`, `reportX()`, ו-`TerminalCapabilities` (`printsOwnSlip`, `external`, `instalments`, `deferredMode`). בתיעוד שלו נכתב ש"checkout and refunds speak frames to the `EmvDevice`, as before".
- מודל התוצאה: `CardResult`, `ParsedTransaction`, `SaleOutcome` (APPROVED, DECLINED, CANCELLED, TIMEOUT, DUPLICATE_VUID, TERMINAL_BUSY, TRANSPORT_ERROR...), `Vuid` (מזהה בקשה יציב, שמאפשר ניסיון חוזר בטוח), `CardBrands` (מותג/סולק/מנפיק לפי קודי שבא).
- ה-P18 לא מזוהה כבעל מסוף משולב: לפי הערת `SwitchingEmvDevice`, "on a P18 there is none". סוג המכשיר "P18" מזוהה אוטומטית מ-`device_info.model`.
- סוכן אחר מוסיף את ההגדרה `paymentIntegration` עם ערך שמור `tap_to_pay`, ואת הספק Z-Credit. **לא קראתי את עבודתו, ולא נגעתי.** (ב-repo אין עדיין אזכור של `tap_to_pay` או Z-Credit בקוד.)

### 5.2 הצעה: איפה להתחבר

**ה-SDK לא מדבר TweezerComm.** לכן `EmvDevice` הוא הממשק הלא נכון לו. יש שתי דרכים:

| | דרך | יתרון | חיסרון |
|---|---|---|---|
| 1 | **ממשק `PaymentTerminal` חדש (ממומש כ-`TapToPayTerminal`)**, עם עטיפה `TapSdk` דקה סביב ה-AAR | נקי, בלי תרגום פריימים. מתאים גם ל-Z-Credit וליתר הספקים שאינם TweezerComm. | דורש להעביר את checkout, החזרים ומסך השידור להשתמש ב-`PaymentTerminal`. עבודה משותפת עם הסוכן של Z-Credit |
| 2 | **Shim:** מימוש `EmvDevice` שמתרגם פריימים של `ashrait` (`doTransaction`, `cancelTransaction`...) לקריאות SDK ובחזרה | אפס שינוי ב-checkout | שביר, מתחזה לפרוטוקול, ו-`lookup`/`transmit`/`reportX` ייאלצו להיות פיקטיביים |

**המלצה:** דרך 1, כי `PaymentTerminal` כבר מתוכנן והשם `tap_to_pay` שמור להגדרה. דרך 2 רק אם צריך הדגמה מהירה בספייק.

**מיקום בקוד:**
- ה-AAR ו-`TapToPayTerminal` ב-flavor `device` (כמו `libagamento` היום); ב-`mock` מימוש מזויף.
- `abiFilters` צריך להתאים ל-ABI של ה-AAR. היום הוא `armeabi-v7a` בלבד (בגלל ה-F20/Nova 55F).
- `Application`: להפוך את מחלקת ה-`Application` שלנו (שמאתחלת Sentry וכו') ליורשת `MyApplication`.
- ההרשאה `ACCESS_FINE_LOCATION` בזמן ריצה, והסרת `allowBackup` (`tools:replace`).
- חתימה: ה-SHA-256 של המפתח שבו נחתמות הקופות בשטח (`keystore.properties`) חייב להירשם אצלם. build type `fast` חתום ב-debug key לא יעבוד עם AAR של production.
- תהליך release/OTA: אחרי כל build, שלב finalization לפני העלאה ל-`POST /api/v1/app-releases`.

### 5.3 זרימות והפערים (מוצר B)

| זרימה בקופה | היום (Tweezer) | Tap to Pay (B) | פער |
|---|---|---|---|
| מכירה רגילה | `doTransaction` tranType 1, creditTerms 1, אגורות | `startTransaction` SALE, `amount` מחרוזת ב-שקלים | המרה אגורות ל-"10.00". המטבע לא נשלח, כנראה לפי הגדרת ה-TPN. [פתוח] |
| תשלומים | creditTerms 8 + מספר תשלומים; הטרמינל קובע טווח; קוראים בחזרה `creditPayments` | `creditType` + `numberOfPayments` | ערכי `creditType` לא מתועדים; לא ידוע אם עובד בנגיעה; לא ידוע איך קוראים בחזרה מה שאושר. [פתוח] |
| החזר מקושר | tranType 53 עם `originalTransactionId` | `REFUND` + סכום בלבד | אין קישור לעסקה מקורית. כנראה דורש כרטיס. [פתוח] |
| ביטול | `cancelTransaction(uid)` עד השידור | `VOID` + `rrn` | מתי מותר, והאם בלי כרטיס. [פתוח] |
| abort של עסקה בטיסה | `abortTransaction(vuid)` | אין | הלקוח מבטל במסך (קודים 21/34). צריך מנגנון timeout בצד שלנו |
| lookup אחרי תשובה שאבדה | `getTransactionByVuid` | `transactionUniqueIdForQuery` | **לא ידוע איך שואלים.** בלי זה אי אפשר לממש את כלל "אל תחייב פעמיים". [פתוח] |
| שידור (שידור לשבא, `doPeriodic`) | `transmit()` | לא מתועד | אולי אוטומטי בצד השרת. [פתוח] |
| דוח X | `getReport "x"` | לא מתועד | אולי דרך Batch Report API של iPOSpays. [פתוח] |
| שובר / קבלה | `printsOwnSlip` או `customerReceipt` לשורות להדפסה | SMS / אימייל; שדות שובר ריקים בדוגמה | אין שובר מוכן להדפסה. הקופה תצטרך לבנות שובר מהשדות, **וזה עניין רגולטורי**: מה מותר ב-SoftPOS בישראל. [פתוח] |
| מצב מסוף (`TerminalState`) | `getStatus` | אין `getStatus` | אפשר לגזור: registered, session בתוקף, NFC פעיל, Developer Options כבוי |
| `vuid` | מזהה מספרי יציב | `transactionUniqueIdForQuery` (UUID) | לשמור יחס חד-חד-ערכי, ולשמור לפני השליחה |
| מותג / סולק / מנפיק | `mutag`, `solek`, `manpik` | `CardBrandCode`, `CardFinancerCode`, `CardIssuerCode` | **סביר שתואם לקודי שבא** (ראו §3), לאמת על כמה עסקאות [הסקה] |
| סיווג תוצאה | `TweezerStatus` (0, 126, 993, 995...) | `response_code` "00" ו-`status` | טבלה חדשה: 0/00 אושר; 51 סירוב; 21/34 ביטול; 33 timeout; 100/101/104 תקשורת; 27/28/26/21 הגדרות מכשיר; 980-991 רישום מחדש |

**מה אפשר לשמור:** `CardResult`/`SaleOutcome`/`ParsedTransaction` (אותו מודל תוצאה), `Vuid`, `CardBrands`, חלק מלוגיקת ה-`TerminalHealth`.

**מוצר C (על המסוף) מול הצורך:** חסרים החזר, ביטול ותשלומים בתיעוד, ובגלל שהוא ב-AIDL עם אפליקציה אחרת, כל "פער" תלוי ב-DvPay ולא ב-SDK. נשאל את הספק מה נתמך ב-Z-Credit בפועל.

---

## 6. הערכת מאמץ, חסמים, ומה לבקש

### 6.1 הערכת מאמץ (ימי פיתוח של מפתח אחד שמכיר את הקופה; הערכה גסה)

| שלב | ימים | הערה |
|---|---|---|
| ספייק: שילוב AAR ב-`device`, רישום, מכירה ב-UAT על P18 | 3-5 | **תלוי בגישה ל-SDK** |
| `TapSdk` עטיפה + `TapToPayTerminal` (מכירה, החזר, ביטול, מיפוי תוצאות, vuid) | 5-8 | |
| אימוץ `PaymentTerminal` ב-checkout, החזרים, מסך שידור | 3-6 | **משותף** עם עבודת Z-Credit. תלוי במה שכבר נעשה שם |
| הגדרות ומסכים: `paymentIntegration=tap_to_pay`, הזנת TPN ו-Merchant Code, מסך הצמדה, פג תוקף של session | 3-4 | |
| pipeline: חתימה, finalization, OTA | 2-3 | |
| בדיקות (עטיפה עם fake, כי AAR לא רץ ב-JVM), תיעוד | 3-4 | |
| שטח ו-UAT עם הספק, P18 אמיתי, פיילוט לקוח | 5-10 | חלק מהזמן הוא המתנה |
| **סה"כ** | **24-40 ימי פיתוח** | בנוסף לזמן המתנה לספק (§6.2) |

מוצר C: בערך 5-10 ימי פיתוח **אם** יתברר ש-DvPay ל-Z-Credit זמין ל-P18 ומוקם עם מפתחות. זה הכי מהיר, אבל תלוי לגמרי בספק.

### 6.2 חסמים

| חסם | חומרה | מה נדרש |
|---|---|---|
| אין גישה ל-Maven ול-AAR | חוסם הכל | `devsupport@dejavoo.io` (עם העתק לנציג Dejavoo/Z-Credit שלנו) |
| TPN + Merchant Code בסנדבוקס | חוסם בדיקות | הקמת סוחר בדיקה, בקשה דרך ISO |
| AAR ל-production מחייב SHA-256 (כשבוע) ו-finalization | משפיע על כל release | לקבוע מפתח חתימה יציב לפני ההרשמה |
| Developer Options חוסם (קוד 27/28) | משפיע על פיתוח ועל התמיכה בשטח | מכשירי בדיקה נפרדים או sandbox בלי ה-SDK |
| אישור המכשיר (Play Integrity, allow-list) | לא ידוע | ניסוי על P18 + שאלה לספק |
| סקופ: Z-Credit בלבד | מסחרי | רק לקוחות שסולקים דרך Z-Credit |
| תיעוד חסר: החזר מקושר, lookup, שידור, תשלומים, שוברים | משפיע על כל התכנון | תשובות כתובות |
| אישורים: PCI CPoC/MPoC, שבא, רגולציה על שוברים | משפיע על "האם מותר למכור" | להשיג מסמכים |
| אין כרטיסי בדיקה מתועדים לנגיעה | משפיע על בדיקות | לבקש כרטיסי בדיקה או סימולטור EMV |
| ABI (`armeabi-v7a` בלבד) | טכני | לאשר שיש ב-AAR |
| איכות התיעוד | סיכון | לצפות לשאלות ולגרסאות חדשות |

### 6.3 שאלות לספק (לשלוח כמו שהן, באנגלית, ל-`devsupport@dejavoo.io` ולנציג Z-Credit)

1. Which product do you recommend for an Israeli ISV on a Kozen P18 (Android 13) that is also a full POS: the Israel Skinless SDK (SoftPOS), or DvPay/ZCredit via the DV Android SDK? Is DvPay for Z-Credit available for the P18 and who provisions the keys?
2. Please provide the Maven repository URL and credentials, the UAT AAR, and a sandbox TPN and Merchant Code. What ABIs does the AAR contain (we ship `armeabi-v7a` only)?
3. Is the Israel SoftPOS PCI CPoC/MPoC listed? Which Israeli acquirers and card brands are supported, and is it approved by Shva? Is tap the only entry mode, or is PIN on glass supported?
4. Device approval: what exactly does the SDK check (Play Integrity verdict level, root, bootloader, screen lock, Developer Options, overlays, accessibility, screen recorders, remote-access apps)? Is there a device allow-list? Is the Kozen P18 (`KOZEN/P18/P18:13/TP1A.220624.014/P1861_V1.0.4`, security patch 2024-07-05) approved?
5. Instalments: what are the valid values of `CreditType`, what range of `NumberOfPayments`, does it work with tap, and how do we read back the settled terms?
6. Refund: is a linked refund (by original RRN or transaction id) supported, does it require the card, and what are the limits?
7. Void: until when is `VOID` allowed (before closing the day?), does it need the card, and what is the exact identifier (RRN, `ZUID`, `transactionUniqueIdForQuery`)?
8. Lookup: how do we query a transaction by `TransactionUniqueIdForQuery` after a lost reply (API, auth, rate limits)? Is there an idempotency guarantee if we resend the same id?
9. Settlement/transmission: is the batch transmitted automatically? Is there a manual close-of-day, and an X report API for Israel?
10. Receipts: which receipt does the law require for SoftPOS in Israel, and does the SDK return a printable slip (customer/merchant) or only SMS/email?
11. Cancel in flight: is there an abort call while waiting for the card? What happens on timeout?
12. Test: which test cards or EMV simulators work for contactless in UAT? Is there a test mode for the SoftPOS?
13. Release process: how do we run the finalizer in CI, per OS version, per build? Is the `.fin` file tied to versionCode? Can we use one signing key for both field tills (OTA via PackageInstaller) and Play?
14. Why does the SDK require `ACCESS_FINE_LOCATION`, and must location services be enabled on a tablet without a mobile data plan?
15. Price model: per transaction, per TPN, per device? Contract needed per customer?

### 6.4 מה אנחנו יכולים לעשות עכשיו, בלי הספק

- לכבות Developer Options על P18 נפרד ולבדוק Play Protect/Play Integrity (§1.4).
- לבדוק קריאת NFC של ה-P18 עם אפליקציית קריאת כרטיסים/תגיות חיצונית כדי לקבל תחושה לטווח (לא קריאת PAN).
- לקבוע מפתח חתימה יציב לקופות (נדרש גם ל-OTA).
- לבנות את `TapSdk` כממשק Kotlin עם מימוש fake, כדי שהעבודה על `PaymentTerminal` לא תחכה ל-AAR.

---

## 7. המלצה

**Go מותנה, לא Go מלא.**

1. **הזמינות בישראל אושרה** (שקל, עברית, Z-Credit, סולקים ישראליים לפי קודי הדוגמאות). המוצר המתאים לקופה הוא ה-**Skinless SDK (ישראל)**.
2. **להתחיל בשתי פעולות במקביל:**
   - לשלוח את §6.3 ולבקש AAR ל-UAT ו-TPN סנדבוקס.
   - לבדוק על ה-P18 את הנקודות ב-§1.4 שאינן תלויות בספק.
3. **ספייק של 3-5 ימים** רק אחרי שיש AAR. הקריטריון להמשך: רישום מוצלח + מכירה בנגיעה ב-UAT על ה-P18 עם Developer Options כבוי.
4. **לא להבטיח ללקוחות** עד תשובות על: אישור המכשיר, החזר מקושר, lookup אחרי תשובה שאבדה, תשלומים, שוברים ורגולציה, ואישורי PCI/שבא.
5. **No-go אם:** ה-P18 לא ברשימת המכשירים המאושרים, או אין דרך לשאול עסקה אחרי תשובה שאבדה (כלל "אל תחייב פעמיים" של הקופה לא יתקיים), או הספק לא מאשר SoftPOS מול שבא.
6. **לבדוק קודם את מסלול C** (DvPay + Z-Credit על ה-P18): הוא מיועד לחומרה הזאת, עם קורא מוסמך שעובד גם עם צ'יפ ו-PIN, ויכול להיות הרבה יותר פשוט מ-SoftPOS אם Z-Credit מספקת P18 עם DvPay.
7. **לא רלוונטי ל-F20/Nova 55F** (יש לו מסוף מוסמך של Nayax/Agamento).
8. **תיאום עם הסוכן של Z-Credit:** אותו backend, אותם קודי כרטיס, ואותו `PaymentTerminal`. כדאי שמודל התוצאה, ההגדרות והמיפוי לקודי שבא יהיו משותפים.

---

## 8. מקורות

**תיעוד iPOSpays** (נקראו ב-2026-10-05; התיעוד עצמו מעודכן 29.7.2026 עד 5.10.2026):
- S1 https://docs.ipospays.com/tap-to-pay-on-android
- S2 https://docs.ipospays.com/tap-to-pay-on-android/in-app-sdk-israel
- S3 https://docs.ipospays.com/tap-to-pay-on-android/skinless-sdk
- S4 https://docs.ipospays.com/tap-to-pay-on-android/in-app-sdk (US, TSYS)
- S5 https://docs.ipospays.com/tap-to-pay-on-android/skinless-sdk-us
- S6 https://docs.ipospays.com/tap-to-pay-on-android/dv-android-sdk
- S7 https://docs.ipospays.com/tap-to-pay-on-android/deep-linking
- S8 https://docs.ipospays.com/payment-terminals-integrations , https://docs.ipospays.com/payment-terminals-integrations/dvpaylite/dvpaylite-intent-mode , https://docs.ipospays.com/how-to-change-your-payment-terminal-to-uat-mode , https://docs.ipospays.com/cashdrawer-sdk
- S9 https://docs.ipospays.com/ipos-pays-authentication-token-api
- S10 https://docs.ipospays.com/merchant-onboarding , https://docs.ipospays.com/transaction-status-check/api-docs/standardtransactstatus/post
- S11 https://docs.ipospays.com/sitemap.xml (מראה את כל הדפים, כולל אלה שלא בתפריט)

**מקורות חיצוניים:**
- E1 הודעת הרכישה של Z-Credit על ידי Dejavoo (18.6.2024): https://www.accessnewswire.com/newsroom/en/telecommunications/dejavoo-expands-global-reach-with-acquisition-of-israeli-fintech-z-credit-878734
- E2 דף Z3 של Z-Credit (מסוף Dejavoo, תו שבא, כאל/ישראכרט/מקס): https://www.z-credit.com/site/z3
- E3 מפרט Dejavoo P18 (Android 13, EMV L1/L2, PCI PTS 5.x, NFC, 10.95"): https://hostmerchantservices.com/emv-credit-card-machines/dejavoo-p18/
- E4 דרישות מכשיר של SoftPOS של Nexi (התייחסות לענף, לא של iPOSpays): https://developer.nexigroup.com/softposmobilepos/en-EU/docs/essential-requirements-and-app2app-github-sample/
- E5 דרישות verdicts של Play Integrity ב-Android 13+: https://developer.android.com/google/play/integrity/improvements

**מה לא נקרא / לא נבדק:**
- דפי `apidocs` של iPOSpays מצוירים בצד הלקוח (אין בהם טקסט), ולכן את חוזה ה-REST של lookup/דוחות לא ראיתי.
- לא ראיתי את קובצי ה-AAR, ה-Drive, או את תיעוד ה-WebAPI של Z-Credit עצמה.
- לא בדקתי את רשימת ה-CPoC של PCI SSC (חיפוש לא החזיר תוצאה על iPOSgo).
- בדיקות ה-adb הן קריאה בלבד ונכונות ל-2026-10-05 על המכשיר P1861GB2592700180.
