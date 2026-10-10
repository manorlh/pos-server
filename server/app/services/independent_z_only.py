"""
"קופה עצמאית — Z בלבד, בלי משמרות" — an independent till that shows no shifts to its cashier
(the owner's decision, 10.10.2026, for the release after 10.10).

Two built-in till parameters, read by the Android till only (the cloud keeps every shift and files
every document in one, exactly as before — nothing here changes the data model):

* `independentTillZOnly` (default **on**, "אוטומטי"): on an independent till (`independent_till`,
  `zMode = till`) the cashier works with no shifts. A shift is opened silently (opening cash 0) and the
  menu offers only the X report ("דו״ח X") and "הפק Z". "הפק Z" counts the drawer (a blind count is
  honoured), closes the internal shift, transmits the card batch, sends the documents and produces the
  Z. Every other close of such a till — a remote "close shift", the automatic close at
  `autoCloseShiftAt`, a forced close — becomes a Z as well: the till never closes its shift without
  a Z silently. A Z that cannot be produced is refused exactly as "הפק Z" refuses it. Off: today's
  behaviour (shifts opened and closed by hand, "הפק Z" apart).
* `independentTillAskOpeningCash` (default off): with the first on, the till opens its internal
  shift by itself with ₪0 — unless this is on, when it asks the opening cash once, in the
  existing "קופה סגורה" card.

Both are resolved like every till parameter (till › area › shop › company › default) and only an
independent till reads them: on any other till — "Z בקופה בתוך הסניף" (`own_z`), a shop-Z till, a
kiosk — they have no effect (app/services/independent_till.py `role_of`).
"""
from __future__ import annotations

Z_ONLY_KEY = "independentTillZOnly"
Z_ONLY_LABEL = "קופה עצמאית — Z בלבד, בלי משמרות"
ASK_OPENING_CASH_KEY = "independentTillAskOpeningCash"
ASK_OPENING_CASH_LABEL = "קופה עצמאית — לשאול קופה פותחת"

PARAMETER_SPECS = (
    dict(
        key=Z_ONLY_KEY,
        label=Z_ONLY_LABEL,
        value_type="boolean",
        default_value=True,
        description=(
            "חל רק על קופה עצמאית (Z משלה, מחוץ ל-Z הסניפי). כשמופעל (ברירת המחדל, \"אוטומטי\"): הקופאי "
            "לא רואה משמרות — הקופה פותחת משמרת בעצמה בלי לשאול (קופה פותחת ₪0), בתפריט נשארים \"דו״ח X\" "
            "ו\"הפק Z\" בלבד, ו\"הפק Z\" סופר את המגירה, סוגר את המשמרת, משדר את האשראי, שולח את המסמכים "
            "ומפיק את ה-Z. גם סגירה מרחוק, סגירה אוטומטית (autoCloseShiftAt) וסגירה בכפייה מפיקות Z, ואם אי אפשר "
            "להפיק Z (למשל בלי חיבור וללא \"סגירת Z ללא חיבור\", זיכוי אשראי מהענן שממתין, שולחנות פתוחים) הקופה "
            "מסרבת כמו \"הפק Z\" — לעולם לא נסגרת משמרת בלי Z בשקט. המשמרות נשארות רשומה פנימית: הן נשלחות לענן "
            "וכל מסמך נרשם במשמרת כמו תמיד. כשכבוי — כמו קודם: פותחים וסוגרים משמרת ביד, ו\"הפק Z\" בנפרד. "
            "לא משפיע על קופה שאינה עצמאית, ועל קיוסק. נקבע לחברה, לסניף, לנקודת מכירה או לקופה."
        ),
    ),
    dict(
        key=ASK_OPENING_CASH_KEY,
        label=ASK_OPENING_CASH_LABEL,
        value_type="boolean",
        default_value=False,
        description=(
            "חל רק על קופה עצמאית שבה \"קופה עצמאית — Z בלבד, בלי משמרות\" מופעל. כבוי (ברירת המחדל): הקופה פותחת "
            "את המשמרת הפנימית בעצמה עם קופה פותחת ₪0. כשמופעל: הקופה שואלת את הקופה הפותחת פעם אחת, בכרטיס "
            "הפתיחה הקיים, לפני שהיא מוכנה למכור — ופותחת משמרת פנימית חדשה (ושואלת שוב) אחרי כל Z. "
            "נקבע לחברה, לסניף, לנקודת מכירה או לקופה."
        ),
    ),
)
