# תצורת עבודה למכשיר — אפיון ומימוש

גרסה 1.0 · 07.10.2026 · ענף `feat/device-work-config` (מעל `feat/r2m-pos-2026-10`)

> משלים את `docs/SPEC_INDEPENDENT_TILL.md` (קופה עצמאית, ה-Z הסניפי ברשת המקומית, משתתף מרוחק §8.14),
> `docs/SPEC_LAN_MODE.md` ("לא משמש כשרת מקומי", המתג "רשת מקומית"), `docs/SHIFTS_API.md` §5 (Z בקופה),
> `docs/SPEC_DEVICE_ROLE_MODEL.md` (תפקיד ודגם בהוספת מכשיר), `docs/SPEC_KDS.md` (תצורת עבודה לעמדה / יעדי KDS)
> ו-`docs/PAIRING.md`. כל מה שלא נאמר כאן — כמו שכתוב שם; **שום כלל קיים לא השתנה**.

## 1. הבקשה

הבעלים, 07.10.2026: "איפה אני מגדיר איך הקופה תעבוד? אני רוצה את כל ההגדרות האלה בתהליך הקמת מכשיר, שזה ידרוס את הסניף.
מה התצורות עבודה שיש לנו? האם מכשיר יכול להיות חלק מזד סניפי כשמוגדר שרת מקומי והוא לבד מסתנכרן עם הענן?"

**התשובות בקצרה:**
- **איפה:** עד היום — בשבעה מקומות (§2). מעכשיו — כרטיס אחד **"תצורת עבודה"** בעמוד המכשיר, ושלב **"תצורת עבודה"** בהוספת
  מכשיר. הערכים נשמרים **ברמת המכשיר** (דורסים את הסניף), דרך אותם שירותים ואותם כללים.
- **התצורות:** עשר (§3) — שש לקופה, שתיים לקיוסק, אחת לכל מסך.
- **האם מכשיר יכול להיות בזד הסניפי כשיש שרת מקומי ולהסתנכרן לבד עם הענן? כן** — "קופה מרוחקת בזד הסניפי" (§4). זה קיים
  מאז §8.14 של SPEC_INDEPENDENT_TILL; עכשיו זו תצורה בשם, גם בהוספת מכשיר.

## 2. המפה — איפה כל הגדרה הייתה (לפני התצורה)

| הגדרה | איפה נשמרת | שירות / נקודת קצה | איפה בדשבורד | מי |
|---|---|---|---|---|
| **בזד הסניפי / קופה עצמאית** | `pos_machines.independent_till` (+`z_mode = till`, אילוץ `ck_pos_machines_independent_till_mode`) | `app/services/independent_till.py` (`check_switch`, `set_independent`, `apply_shop`); `PUT /shops/{id}/z-participation` (`participants`, `independent`) — `app/routers/z_participation.py` | עמוד הסניף ← כרטיס **"קופות בזד הסניפי"** (`z-participation-card.tsx`); בקיוסק — "Z עצמאי לקיוסק הזה" (`kiosks/kiosk-z-actions.tsx`, אותה נקודת קצה) | מנהל-על, "שבירה נקייה" |
| **מצב Z: Z סניפי / Z בקופה** (`ROLE_OWN_Z` = `z_mode = till` בלי עצמאית) | `pos_machines.z_mode`, היסטוריה ב-`z_mode_history` | `app/services/till_z.py` `set_z_mode`, `app/services/z_mode_policy.py` (`check_switch`: מנהל-על, `409 till_open`); `PUT /shops/{id}/z-mode` (כל הסניף / נקודת מכירה, `app/routers/z_mode.py`), `PUT /machines/{id}` `zMode` (מכונה אחת) | עמוד הסניף ← **"מצב דו״ח Z"** (`z-scope-card.tsx`); עמוד המכשיר ← שדה מצב ה-Z (`till-z-dialogs.tsx` `ZModeField`) | מנהל-על, משמרת סגורה, בלי משמרות שממתינות ל-Z |
| **הקופה הראשית** (שרת השולחנות, שרת ההדפסות, מאסטר ה-Z הסניפי) | פרמטר `mainTill` ברמת המכונה (`till_parameter_values`) | `app/services/main_till.py` (`main_till_of_shop`, `set_main_till`, `take_over`); `PUT /shops/{id}/main-till` (`app/routers/main_till.py`), `mainTillId` ב-`PUT /shops/{id}/z-participation` | עמוד הסניף ← **"תצורת עבודה — קופה ראשית"** (`main-till-card.tsx`), ובחירה ב"קופות בזד הסניפי"; בקופה — "העבר את השרת לקופה הזו" | מנהל-על; לא בזמן ריצת Z (`z_run_in_progress`); דרך `ProducerGuard` |
| **רשת מקומית** (הקופה הראשית מפיקה את ה-Z הסניפי ברשת) | `shops.local_network` (+`local_network_changed_at`) | `app/services/lan_server.py` `set_local_network`; `PUT /shops/{id}/local-network` (`app/routers/lan_server.py`) | עמוד הסניף ← המתג בכרטיס "תצורת עבודה — קופה ראשית" | מנהל-על; דורש קופה ראשית; `ProducerGuard` |
| **מחובר ברשת / מרוחק (דרך הענן)** | `shops.settings.shopZRemoteTills` (רשימת מזהים); Windows — תמיד מרוחק | `app/services/local_shop_z.py` (`remote_till_ids`, `closes_through_cloud`, `request_remote_parts`…); `remote` ב-`PUT /shops/{id}/z-participation` | "קופות בזד הסניפי" ← לכל משתתף | מנהל-על; רק משתתף, לא הקופה הראשית |
| **לא משמש כשרת מקומי** | `pos_machines.lan_server_excluded` (+`_at`); אוטומטית — קופה שמציגה מסך KDS | `app/services/lan_server.py` (`set_excluded`, `server_candidates`); `PUT /machines/{id}/lan-server`, `lanServerExcluded` ב-`PUT /shops/{id}/z-participation` | עמוד המכשיר ← כרטיס **"שרת מקומי"** (`machine-lan-server-card.tsx`); "קופות בזד הסניפי" | מנהל-על; לא הקופה הראשית |
| **ניהול שולחנות** (`tablesMode`: כבוי / קופה אחת / מסונכרן בין הקופות / רשת מקומית (קופה ראשית)) | פרמטר `tablesMode` — חברה / סניף / נקודת מכירה / מכונה | `app/services/till_parameters.py` (פתרון לפי רמות; עצמאית — רק מרמת המכונה, `independent_parameters`); `PUT /till-parameters/{id}/values` (נרשם ב-`till_parameter_changes`) | **פרמטרים לקופות** (`/dashboard/till-parameters`, כל רמה); עמוד הסניף ← **"סוגי עבודה"** (`work-types-card.tsx`, רמת הסניף) | מנהל-על |
| **מדפסת חשבוניות** (`receiptPrinter` + כתובת / דגם) | פרמטרים — סניף / נקודת מכירה / מכונה | `app/services/printers.py` `set_options` (`SETTING_KEYS`); `PUT /shops/{id}/printer-options` (`app/routers/printers.py`) | **מדפסות** ← "הגדרות הדפסה" (`kitchen-printers/options-card.tsx`) | מנהלי הסניף (`printers.EDIT_ROLES`) |
| **יעדי KDS / תצורת עבודה לעמדה** (`workflowTargets`: printer / kds / kds_view / expo / pickup_screen, ו-`kdsEnabled`, מצב, מדיניות תשלום…) | פרמטרים — חברה / סניף / נקודת מכירה / מכונה | `app/services/kds_workflow.py` (`validate`, `normalize`, `save_values`); `GET/PUT /workflow/config` (`app/routers/kds.py`) | **תצורת עבודה** (`/dashboard/workflow`, `workflow-editor.tsx`) | מנהלי הסניף / החברה |
| **תפקיד המכשיר** (קופה / קיוסק / מסך KDS / מסך מוכן), פלטפורמה, דגם | שורות `kiosk_devices` / `kds_devices`, `pos_machines.is_fiscal`, `platform`, `device_model` | `app/services/device_profile.py`, `app/services/display_devices.py`; `PUT /machines/{id}/device-profile` | עמוד המכשיר ← "שינוי תפקיד / דגם"; עמודי הקיוסקים וה-KDS | לפי SPEC_DEVICE_ROLE_MODEL |
| **הוספת מכשיר (צימוד)** | `pairing_codes` (`device_role`, `kiosk_options`, `kds_options`, `platform`, `device_model`) | `app/services/pairing.py` (`create_pairing_code`, `validate_pairing_code` → `device_profile.apply_on_pairing`, `display_devices.apply_on_pairing`); `POST /pairing/generate`, `POST /pairing/validate` (`app/routers/pairing.py`) | מכשירים ← **"הוספת מכשיר"** (`machines/page.tsx`, `device-role.tsx`) | מפיץ / מנהל-על |

הגדרות הקופה של המכונה עצמה (`pos_machines.settings` — מסופון, Nayax וכו', "הגדרות קופה" בדשבורד) הן מערכת אחרת ונשארות שם.

## 3. התצורות

כל תצורה היא שילוב שיש לו משמעות; היא **כותבת ערכים ברמת המכשיר** — כל ערך דרך השירות שלו. "מה זה אומר" (Z, שולחנות, הדפסה,
בלי אינטרנט) מוצג בעברית לפני השמירה (`client/src/lib/workConfig.ts` `presetMeaning`).

| תצורה (`id`) | תפקיד | Z | בזד הסניפי? | מרוחק | קופה ראשית | לא משמש כשרת מקומי | שולחנות במכשיר (בחירה) | זמינה כש… |
|---|---|---|---|---|---|---|---|---|
| **קופה בזד סניפי — ענן** (`shop_z_cloud`) | קופה | `cloud` | כן | לא | לא | כמו שהוא | לפי הסניף / מסונכרן בין הקופות / קופה אחת | "רשת מקומית" **כבויה** |
| **קופה ראשית (שרת מקומי)** (`main_till`) | קופה | `cloud` | כן | לא | **כן** (מעביר מהקודמת) | **לא** (מנוקה) | לפי הסניף | Android; לא מסך KDS על קופה; "רשת מקומית" פועלת — או שהתצורה מפעילה אותה (`enableLocalNetwork`, סימון מפורש) |
| **קופה ברשת המקומית** (`lan_member`) | קופה | `cloud` | כן | לא | לא | בחירה | לפי הסניף / רשת מקומית / קופה אחת / כבוי | "רשת מקומית" פועלת; Android |
| **קופה מרוחקת בזד הסניפי** (`remote_shop_z`) | קופה | `cloud` | כן | **כן** | לא | **כן** | כבוי (ברירת מחדל) / קופה אחת | "רשת מקומית" פועלת |
| **קופה עצמאית** (`independent`) | קופה | `till` + `independent_till` | לא | — | לא | — (מחוץ לרשת) | כבוי (ברירת מחדל) / קופה אחת | תמיד |
| **Z בקופה, בתוך הסניף** (`own_z`, `ROLE_OWN_Z`) | קופה | `till` | לא | לא | לא | בחירה | לפי הסניף / כל אחד מהארבעה | תמיד |
| **קיוסק בזד סניפי** (`kiosk_shop_z`) | קיוסק | `cloud` | כן | בחירה (מחובר ברשת / מרוחק — רק כש"רשת מקומית" פועלת) | לא | בחירה, **ברירת מחדל: כן** | — | תמיד |
| **קיוסק עם Z משלו** (`kiosk_own_z`) | קיוסק | `till` + `independent_till` | לא | — | לא | — | — | תמיד |
| **מסך KDS** (`kds_screen`) | KDS | — | — | — | — | — | — | מכשיר תצוגה; לא כותבת דבר |
| **מסך מוכן** (`ready_board`) | מסך מוכן / לא מוכן | — | — | — | — | — | — | מכשיר תצוגה; לא כותבת דבר |

- **כלליים לכל התצורות:** הקופה הראשית של הסניף לא מקבלת תצורה אחרת עד שבוחרים קופה ראשית אחרת (`work_config_is_main_till`);
  תצורה של תפקיד אחר — `work_config_wrong_role` (את התפקיד משנים ב"שינוי תפקיד / דגם"); מכשיר בלי סניף — `work_config_requires_shop`.
- **מכשיר Windows / דפדפן** לא שומע את הרשת המקומית: לא "קופה ראשית" ולא "קופה ברשת המקומית" (`work_config_needs_lan_client`);
  בסניף ברשת מקומית הוא תמיד "מרוחק" (קבוע).
- **"מתקדם"** — בכל תצורה, ערכים בודדים ברמת המכשיר: ניהול שולחנות, מדפסת חשבוניות (`receiptPrinter`), יעדי KDS
  (`workflowTargets`), "לא משמש כשרת מקומי"; כל אחד גם "לפי הסניף" (`inherit` — מוחק את הערך של המכשיר).
- **"לפי הסניף"** (`inheritedPreset`) = מה שמכשיר מקבל בלי שום הגדרה משלו: קופה — "קופה ברשת המקומית" כש"רשת מקומית" פועלת
  (Windows — "מרוחקת"), אחרת "קופה בזד סניפי — ענן"; קיוסק — "קיוסק בזד סניפי"; מסך — התצורה שלו. ב"חזרה ללפי הסניף" במכשיר
  חוזר **החלק הפיסקלי** (Z, עצמאות, מרוחק); השולחנות והדגל "לא משמש כשרת מקומי" חוזרים כל אחד ב"חזרה לירושה" שלו.
- הטבלה הקבועה של התצורות נעולה בין השרת לדשבורד בקובץ זהב משותף: `server/tests/fixtures/work_config_presets_golden.json`
  (`work_config.static_table()` ו-`PRESET_RULES`).

## 4. "קופה מרוחקת בזד הסניפי" — חלק מה-Z הסניפי, עם שרת מקומי, ומסתנכרנת לבד מול הענן

**כן, זה אפשרי — וכך זה עובד היום** (נבדק בקוד: `app/services/local_shop_z.py` §8.14, `tests/test_work_config.py::TestRemoteParticipant`):

1. **ההגדרה:** המכשיר ברשימת `shops.settings.shopZRemoteTills` (או מכשיר Windows — תמיד, `closes_through_cloud`). הוא **משתתף** ב-Z
   הסניפי (`participants`: `z_mode = cloud`, לא עצמאי) — לא מדולג ולא "לא מחובר".
2. **המסמכים** שלו עולים לענן ישירות, כמו כל קופה (`POST /sync/{id}/transactions`); הוא לא צריך את הרשת של הסניף בשביל זה.
3. **סגירת ה-Z:** כשהקופה הראשית מתחילה סבב Z, היא לא פונה אליו ברשת — היא מבקשת מהענן: `POST /sync/{main}/shop-z/remote-close`
   (נשמר בטבלה `shop_z_remote_parts`, תוקף 36 שעות) — **תיבת דואר בענן**.
4. **המכשיר המרוחק** מקבל `pendingShopZPart: {requestId, roundId, force}` ב-heartbeat שלו (חוזר עד שיענה), סוגר את המשמרת שלו
   **באותם כללים כמו ברשת** (תשלום בתהליך מסתיים קודם), בונה את **החלק שלו** — הסעיף והמניפסט (מסמכים לפי מזהה, טווחי מספרים,
   סכומים ותקציר, `shop_z_manifest.py`) — ושולח: `POST /sync/{m}/shop-z/remote-part`.
5. **הקופה הראשית** מושכת את החלק (`GET /sync/{main}/shop-z/remote-parts?roundId=`) ומכניסה אותו ל-Z המקומי כמו חלק שהגיע ברשת; עד
   שהוא מגיע ה-Z ממתין ("קיוסק X — ממתין לסגירה דרך הענן"). אחרי ההעלאה הענן מסמן את החלק `taken`, ומאמת את המניפסט כשהמסמכים
   שלו הגיעו (§8.12) — מכשיר שמת אחרי שדיווח: "ממתין למסמכים", ואחר כך לתמיכה; לעולם לא אי-התאמה שקטה.
6. **מה התצורה מוסיפה:** "לא משמש כשרת מקומי" (מכשיר מחוץ לרשת לא יכול לשרת אותה) ושולחנות כבויים או "קופה אחת" (הוא לא מגיע
   לשרת השולחנות של הסניף; "מסונכרן" היה מפצל את השולחנות בין הענן לשרת המקומי). הדפסת בונים למטבח — דרך הענן לשרת ההדפסות.
7. **בסניף בלי "רשת מקומית"** אין צורך בזה: כל קופה בזד הסניפי ממילא מסתנכרנת לבד מול הענן ("קופה בזד סניפי — ענן"), ולכן
   התצורה לא זמינה שם (`work_config_shop_not_lan`).

## 5. בהוספת מכשיר

1. בדיאלוג "הוספת מכשיר", אחרי **סוג מכשיר** ו**סניף** — שלב **"תצורת עבודה"** (`WorkConfigStep`): ברירת המחדל **"לפי הסניף"**
   (עם שם התצורה שהסניף נותן), התצורות של התפקיד (לא זמינה — עם הסיבה), הבחירות בתוך התצורה, "מה זה אומר", ו"מתקדם".
   הנתונים — `GET /shops/{id}/work-config?role=&platform=` (מכשיר חדש באותו סניף).
2. `POST /pairing/generate` עם `workConfig` — **נבדק מיד** כמו למכשיר חדש באותו סניף (`work_config.check_pairing_request`): אותם
   סירובים כמו בעמוד המכשיר, בעברית, כשהדיאלוג פתוח. "לפי הסניף" לא נשמר (מכשיר חדש הוא כבר כך). התוכנית נשמרת ב-`pairing_codes.work_config`.
3. כשהמכשיר מממש את הקוד (`POST /pairing/validate`), **אחרי** שנכנס לסניף ואחרי שנעשה קיוסק / מסך, התוכנית מוחלת
   (`work_config.apply_on_pairing`) — בשם המשתמש שיצר את הקוד, דרך אותם שירותים. **שום כשל לא מכשיל את הצימוד**: המכשיר נשאר
   "לפי הסניף", והתוצאה נשמרת ב-`pairing_codes.work_config_result` (`{applied, changes, detail, message, at}`).
4. הדיאלוג ממשיך לשאול את הקוד עד שיש תוצאה, ומציג "תצורת העבודה X הוחלה" או את הסיבה; עמוד המכשיר מציג אותה עם **"החל עכשיו"**.
5. קוד החלפה (`replacement-code`) — התוכנית לא חלה: המכשיר החדש יורש את תצורת הקופה שהוא מחליף.

## 6. בעמוד המכשיר — הכרטיס "תצורת עבודה"

- **כל ערך עם המקור שלו:** דו״ח Z, סגירה ב-Z הסניפי (ברשת / מרוחק — כשרלוונטי), קופה ראשית, לא משמש כשרת מקומי, ניהול שולחנות,
  מדפסת חשבוניות, יעדי KDS — כל אחד "נקבע במכשיר" / "לפי נקודת המכירה" / "לפי הסניף" / "לפי החברה" / "ברירת מחדל" (ולמכשיר
  Windows "קבוע", למסך KDS על קופה "אוטומטי", לקופה עצמאית "רק מרמת המכשיר").
- **"חזרה לירושה"** ליד כל ערך שנקבע במכשיר, ו**"Z ורשת — חזרה ל'לפי הסניף'"** לחלק הפיסקלי.
- **"שינוי תצורת עבודה"** — אותו עורך כמו בהוספה. מנהל סניף רואה הכול ומשנה רק את ההדפסה (מדפסת חשבוניות, יעדי KDS).
- סירוב — במילים של השירות שסירב (`message`), ואם אין — הטקסט הקיים של הדשבורד לקוד (`zErrors`: `till_open`, `unreported_shifts`,
  `z_in_progress`…). סירוב של מפיק ה-Z הסניפי (`shop_z_producer_busy`) — "העבר בכל זאת (מנהל-על)" עם אישור, כמו בשאר הכרטיסים.

## 7. API

| | |
|---|---|
| `GET /machines/{id}/work-config` | `{machineId, shopId, role, platform, fiscal, canEdit, canEditPrinting, shop: {name, localNetwork, localMode, mainTill}, currentPreset, inheritedPreset, isInherited, values: {zMode, independent, link, mainTill, lanServerExcluded, tablesMode, receiptPrinter, workflowTargets, workflowEnabled}, presets: [{id, label, available, reason, message, turnsOnLocalNetwork, movesMainTillFrom}], staticPresets, pairing}` — לכל ערך `value`, `source`, ולפרמטרים גם `own`, `inherited`, `inheritedSource`, `options` |
| `PUT /machines/{id}/work-config` | `{preset?, tablesMode?, lanServerExcluded?, link?, enableLocalNetwork?, receiptPrinter?, workflowTargets?, forceProducerSwitch?}` — `preset`: מזהה תצורה, `"inherit"` (לפי הסניף) או חסר (רק הערכים). ערך חסר — לא נוגעים (או ברירת המחדל של התצורה); `"inherit"` בערך — חזרה לירושה. **טרנזקציה אחת**, הכול או כלום. עונה כמו ה-GET + `changes` |
| `GET /shops/{id}/work-config?role=&platform=` | אותו מבנה למכשיר שעוד לא צומד (שלב ההוספה) |
| `POST /pairing/generate` | + `workConfig` (אותו מבנה כמו ה-PUT, בלי `forceProducerSwitch`); דורש `shopId` |
| `GET /pairing/codes…` | + `workConfig`, `workConfigResult` |

**סדר ההחלה** (`work_config.apply`): (1) "לא משמש כשרת מקומי" כבוי (`lan_server.set_excluded`) — קודם, כי קופה ראשית חייבת להיות
שרת; (2) הכרטיס "קופות בזד הסניפי" (`independent_till.apply_shop`: בזד / עצמאית, הקופה הראשית, הרשימה "מרוחק" — מסוננת למשתתפים
שבסניף); (3) Z בקופה (`z_mode_policy.check_switch` + `till_z.set_z_mode`); (4) "לא משמש כשרת מקומי" פועל; (5) "רשת מקומית"
(`lan_server.set_local_network`); (6) הפרמטרים ברמת המכשיר — `tablesMode` (כמו `PUT /till-parameters/{id}/values`), `receiptPrinter`
(`printers.set_options`), `workflowTargets` (`kds_workflow.save_values`, עם הבדיקה שלו), מאחורי `ProducerGuard`. כל סירוב — ה-body של
השירות כפי שהוא + `step`; הנתב מגלגל אחורה. אחרי שמירה — התראת `settings` לכל קופות הסניף.

## 8. הכללים נשארים

| כלל | קוד | מקור |
|---|---|---|
| מנהל-על בלבד ל-Z, עצמאות, קופה ראשית, מרוחק, "לא משמש כשרת מקומי", "רשת מקומית", שולחנות | `403 super_admin_only` (+`message`, `changes`) — לפני שנכתב משהו; השירותים מסרבים גם הם | `work_config.check_permission`, השירותים |
| מדפסת / יעדי KDS — מנהלי הסניף | `403 insufficient_permissions` | `printers.can_edit` |
| משמרת פתוחה / משמרות סגורות שממתינות ל-Z / Z בתהליך / Zים שנסגרו ללא חיבור — מעבר לעצמאית או חזרה | `409 independent_switch_open_shift` / `_unreported_shifts` / `_z_in_progress`, `till_offline_zs_unsynced`, `independent_switch_shop_zs_unsynced` | `independent_till.check_switch` |
| מעבר ל-Z בקופה | `409 till_open`, `unreported_shifts`, `z_in_progress` | `z_mode_policy`, `till_z.set_z_mode` |
| קופה ראשית בזמן ריצת Z / מכשיר מוחרג / מסך KDS | `409 z_run_in_progress`, `main_till_not_server` | `independent_till.apply_shop` |
| מפיק ה-Z הסניפי לא יכול למסור נקי | `409 shop_z_producer_busy` (מנהל-על יכול לכפות, נרשם) | `local_shop_z.ProducerGuard` |
| סימון הקופה הראשית "לא משמש כשרת מקומי" | `409 lan_server_excluded_main_till` | `lan_server.set_excluded` |
| תצורה לא זמינה | `409 work_config_shop_is_lan` / `_shop_not_lan` / `_is_main_till` / `_needs_lan_client` / `_wrong_role` / `_requires_shop` / `_local_network_off` / `_main_till_not_server` | `work_config.unavailable` |
| בחירה שהתצורה לא מציעה / ערך לא תקין | `422 work_config_value_not_allowed` (+`field`), `work_config_unknown_preset`, `workflow_invalid` | `work_config.resolve_target`, `kds_workflow.save_values` |
| מכשיר תצוגה | `409 device_not_fiscal` | `display_devices` |

**תיעוד (audit):** כמו נקודות הקצה הקיימות — כל ערך פרמטר שנכתב או נמחק ברמת המכשיר (`tablesMode`, `receiptPrinter`,
`workflowTargets`) נרשם ב-`till_parameter_changes` (מי, מתי, מה היה ומה נהיה), באותה טרנזקציה; שינוי מצב Z נרשם ב-`z_mode_history`;
"לא משמש כשרת מקומי" — `lan_server_excluded_at`; העברה בכוח של מפיק ה-Z — חריגה `shop_z_producer_forced`; וכל החלה — שורת לוג
`work config: machine … preset … by … — changes`.

## 9. בקופה

אין שינוי באפליקציה: כל ערך מגיע אליה בדרך הקיימת — `zMode`, `independentTill`, `lanServerExcluded`, `pendingShopZPart` ב-heartbeat;
`param.tablesMode`, `param.mainTill`, `param.receiptPrinter`, `param.workflowTargets` במשיכת הפרמטרים (אחרי התראת `settings`);
שרת השולחנות / ההדפסות בבלוקים `lanHost` / `printHost`.

## 10. Migration

`e5b9d3f7a1c4_pairing_work_config` (אחרי `c7e2f4a9d1b6`), additive ואידמפוטנטית: `pairing_codes.work_config` (JSON),
`pairing_codes.work_config_result` (JSON). שום מכונה קיימת לא משתנה.

## 11. קבצים ובדיקות

- **שרת:** `app/services/work_config.py` (חדש — התצורות, הזמינות, ההחלה, הקריאה עם המקורות, הצימוד), `app/routers/work_config.py`
  (חדש), `app/schemas/work_config.py` (חדש), `app/schemas/pairing_code.py`, `app/models/pairing_code.py`, `app/services/pairing.py`,
  `app/routers/pairing.py`, `app/main.py`, `alembic/versions/e5b9d3f7a1c4_pairing_work_config.py`.
- **דשבורד:** `src/lib/workConfig.ts` + `.test.ts` (חדשים — הטבלה, הטקסטים, הטיוטה והתוכנית), `src/lib/workConfigApi.ts`,
  `src/components/dashboard/machines/work-config.tsx` (`WorkConfigEditor`, `WorkConfigStep`, `WorkConfigCard`),
  `src/app/dashboard/machines/page.tsx` (השלב בהוספה), `src/app/dashboard/machines/[id]/page.tsx` (הכרטיס), `package.json`.
- **בדיקות:** `tests/test_work_config.py` — הטבלה מול קובץ הזהב; זמינות לפי סניף ברשת / בענן, הקופה הראשית, Windows, קיוסק ומסך;
  המקורות; **כל תצורה** (הערכים שנכתבו, התיעוד, ההתראה); המשתתף המרוחק (חלק מה-Z, הבקשה מגיעה ב-heartbeat שלו, לא לקופה ברשת);
  הסירובים (מנהל-על, משמרת פתוחה, משמרות שממתינות ל-Z, Z בקופה עם משמרת, ריצת Z, מפיק ה-Z + כפייה, תצורה לא זמינה, בחירה לא
  מוצעת, הקופה הראשית, מכשיר מרוחק, בלי סניף) — **ושום דבר לא נכתב**; הצימוד (הקוד נושא את התוכנית, נבדק ביצירה, מוחל בצימוד,
  קופה ראשית חדשה, קיוסק עם Z משלו, סירוב לא מכשיל ונשמר, קוד החלפה). `src/lib/workConfig.test.ts` — הטבלה מול קובץ הזהב, טקסט
  לכל תצורה, הטיוטה, התוכנית, המקורות, התוצאה.

## 12. פתוח — להחלטת הבעלים

1. **שולחנות של מכשיר מרוחק:** ברירת המחדל "כבוי" (אפשר "קופה אחת"). "מסונכרן בין הקופות" לא מוצע — בסניף ברשת מקומית השולחנות
   נמצאים בשרת המקומי, ושולחנות בענן היו מתפצלים ממנו.
2. **"קופה ראשית" בסניף בלי "רשת מקומית"** מפעילה את המתג (שינוי לכל הסניף: ה-Z הסניפי עובר לקופה הזו) — רק בסימון מפורש בתוך
   התצורה. לחלופין אפשר לאפשר קופה ראשית בלי רשת מקומית (שרת שולחנות והדפסות בלבד, Z בענן) — היום זה רק מדף הסניף.
3. **מפיץ בהוספת מכשיר:** יכול "לפי הסניף" ואת ההדפסה; תצורה שמשנה Z / רשת / שולחנות דורשת מנהל-על (הכלל הקיים). למכשיר חדש
   אין היסטוריה פיסקלית — אם הבעלים רוצה, אפשר לאפשר למפיץ לבחור תצורה **רק בהוספה**.
4. **"קיוסק עם Z משלו"** = קיוסק עצמאי (מחוץ לרשת המקומית, כמו היום בעמוד הקיוסקים). קיוסק עם Z בקופה שנשאר ברשת המקומית — אין
   לו תצורה בשם (מוצג "מותאם").
5. **"Z בקופה" מקופה עצמאית** עובר דרך שני השירותים הקיימים (חזרה ל-Z הסניפי ואז Z בקופה) — `z_mode_history` מראה את שניהם, והמספור
   ממשיך את רצף הקופה הקיים (רק מעבר **לעצמאית** פותח רצף חדש מ-Z 1).
6. **התקנה בשטח (QR, `/mobile/pair`)** לא נושאת תצורת עבודה — המכשיר "לפי הסניף", ומשנים בעמוד המכשיר.
