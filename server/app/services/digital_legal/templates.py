"""
The four legal pages of the public digital channels: their structured fields, the Hebrew starting
templates, `{{placeholder}}` rendering and the checks a version must pass before publication.

Pure (no database). The templates are a starting point for the business and its lawyer — plain
Hebrew, without legal conclusions; the editor shows "טיוטה — יש לבדוק עם עורך דין" on every one and
publication needs the business's "נבדק".

Body format: limited markdown (`#`/`##` headings, paragraphs, `-` lists, `**bold**`) — rendered as
text by the public page, never as HTML. A placeholder is `{{key}}`; a line whose optional field is
empty is left out of the published page.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date
from typing import Any, Dict, Iterable, List, Mapping, Optional, Tuple

from app.models.digital_legal import KIND_ACCESSIBILITY, KIND_COOKIES, KIND_PRIVACY, KIND_TERMS, LEGAL_KINDS

#: Bumped when a template's text changes (stored on a draft as `template_version`).
TEMPLATE_VERSION = 1
LANGS = ("he",)
MAX_TITLE = 200
MAX_BODY = 50_000
MAX_TEXT = 300
MAX_TEXTAREA = 4_000

DRAFT_BANNER = "טיוטה — יש לבדוק עם עורך דין"
DISCLAIMER = (
    "התבניות הן נקודת התחלה בלבד ואינן ייעוץ משפטי. יש לבדוק אותן עם עורך הדין של העסק "
    "(ואת הצהרת הנגישות גם עם יועץ/ת נגישות) לפני פרסום."
)

PLACEHOLDER = re.compile(r"\{\{\s*([A-Za-z][A-Za-z0-9_.]*)\s*\}\}")
EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
PHONE = re.compile(r"^\+?[0-9][0-9\- ]{6,18}[0-9]$")
ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

FIELD_TYPES = ("text", "textarea", "email", "phone", "date", "number", "select")


@dataclass(frozen=True)
class FieldDef:
    key: str
    label: str
    type: str = "text"
    required: bool = True
    hint: str = ""
    options: Tuple[str, ...] = ()
    #: A suggested starting value (the business edits it).
    default: Optional[str] = None
    #: number bounds
    min: Optional[int] = None
    max: Optional[int] = None
    #: A date that may not be in the future (a check that already happened).
    past: bool = False

    def as_dict(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {"key": self.key, "label": self.label, "type": self.type, "required": self.required}
        if self.hint:
            out["hint"] = self.hint
        if self.options:
            out["options"] = list(self.options)
        if self.min is not None:
            out["min"] = self.min
        if self.max is not None:
            out["max"] = self.max
        return out


@dataclass(frozen=True)
class KindDef:
    kind: str
    title: str
    #: The public path segment (/legal/{company}/{slug}).
    slug: str
    summary: str
    fields: Tuple[FieldDef, ...]
    body: str
    #: Placeholders the body must keep (the content the law asks for).
    must_appear: Tuple[str, ...] = ()
    #: Of these, at least one must be filled (e.g. a phone or an e-mail to reach the business).
    any_of: Tuple[Tuple[str, ...], ...] = ()
    field_by_key: Dict[str, FieldDef] = field(default_factory=dict, compare=False, repr=False)

    def __post_init__(self) -> None:
        self.field_by_key.update({f.key: f for f in self.fields})


def _business(required_id: bool = True, required_address: bool = True) -> Tuple[FieldDef, ...]:
    return (
        FieldDef("business.name", "שם העסק"),
        FieldDef("business.id", 'ח.פ. / ע.מ.', required=required_id, hint="מספר החברה או העוסק"),
        FieldDef("business.address", "כתובת העסק", required=required_address),
    )


def _contact(phone_required: bool, email_required: bool) -> Tuple[FieldDef, ...]:
    return (
        FieldDef("contact.phone", "טלפון ליצירת קשר", "phone", required=phone_required),
        FieldDef("contact.email", 'דוא"ל ליצירת קשר', "email", required=email_required),
    )


ACCESSIBILITY_ADJUSTMENTS = "\n".join(
    (
        "- ניווט מלא במקלדת, עם מיקוד שנראה לעין",
        "- כותרות, תוויות לשדות וטקסט חלופי לתמונות, לשימוש עם קוראי מסך",
        "- ניגודיות צבעים לפי רמה AA",
        "- התאמה לטלפון, לטאבלט ולמחשב, והגדלת טקסט עד 200%",
        '- כיבוד הגדרת "הפחתת תנועה" של המכשיר',
        "- מנה שאזלה ומידע חשוב מוצגים גם בטקסט, לא רק בצבע",
    )
)

ACCESSIBILITY_BODY = """# הצהרת נגישות

{{business.name}} רואה חשיבות במתן שירות שוויוני ונגיש לכל הלקוחות, ובהם אנשים עם מוגבלות. הצהרה זו מתארת את נגישות התפריט הדיגיטלי, אתר ההזמנות וכרטיס הביקור של העסק.

## רמת ההתאמה
ההתאמות נעשו לפי תקנות שוויון זכויות לאנשים עם מוגבלות (התאמות נגישות לשירות), התשע"ג-2013, ולפי {{conformance.standard}}.
רמת ההתאמה: {{conformance.level}}.

## מה הונגש
{{accessibility.adjustments}}

## מגבלות ידועות וחלופות
{{accessibility.limitations}}

## הסדרי נגישות בעסק
{{accessibility.arrangements}}

## רכז/ת הנגישות
נתקלתם בקושי? נשמח לשמוע ולתקן.
- שם: {{coordinator.name}}
- טלפון: {{coordinator.phone}}
- דוא"ל: {{coordinator.email}}

## תאריכים
- תאריך הבדיקה האחרונה: {{accessibility.lastCheckDate}}
- תאריך עדכון ההצהרה: {{accessibility.statementDate}}
"""

PRIVACY_BODY = """# מדיניות פרטיות

מדיניות זו מסבירה איזה מידע {{business.name}} (ח.פ. / ע.מ. {{business.id}}) אוסף כשמשתמשים בתפריט הדיגיטלי, באתר ההזמנות ובכרטיס הביקור, למה הוא משמש וכמה זמן הוא נשמר.

## איזה מידע נאסף
- **בהזמנה:** שם וטלפון, לפי מה שהטופס מבקש, ופרטי ההזמנה עצמה (פריטים, סכום, מועד ונקודת איסוף).
- **בפנייה מכרטיס ביקור:** הפרטים שמילאתם בטופס הפנייה.
- **בגלישה:** מידע טכני שנדרש להפעלת האתר. מידע סטטיסטי נאסף רק אם הסכמתם לכך בהגדרות העוגיות.

אין חובה חוקית למסור את המידע. בלי הפרטים שהטופס מסמן כחובה לא נוכל לקבל את ההזמנה או לחזור אליכם.

## למה המידע משמש
- טיפול בהזמנה ומסירתה, כולל הודעות שירות עליה (למשל "ההזמנה מוכנה").
- מענה לפנייה ששלחתם.
- דיוור שיווקי — רק אם אישרתם זאת בנפרד. אפשר לבטל את האישור בכל עת.
- עמידה בחובות לפי דין, למשל שמירת מסמכים חשבונאיים.

## למי המידע מועבר
{{privacy.processors}}
איננו מוכרים מידע אישי.

## כמה זמן המידע נשמר
- פרטי קשר של הזמנה: עד {{privacy.orderRetentionDays}} ימים, ואז נמחקים או מותממים. מסמכים חשבונאיים נשמרים כפי שהדין מחייב.
- פרטי פנייה מכרטיס ביקור: עד {{privacy.enquiryRetentionDays}} ימים.
- תיעוד של הסכמות (עוגיות ודיוור): כל עוד הוא נדרש כדי להראות שניתנה הסכמה.

## אבטחת מידע
מספרי טלפון נשמרים מוצפנים, והגישה למידע מוגבלת לבעלי הרשאה.

## הזכויות שלכם
לפי חוק הגנת הפרטיות, התשמ"א-1981, אפשר לבקש לעיין במידע שנשמר עליכם, לבקש לתקן אותו או למחוק אותו, ולבקש להפסיק לקבל דיוור שיווקי.

## יצירת קשר בנושא פרטיות
- {{business.name}}, {{business.address}}
- דוא"ל: {{contact.email}}
- טלפון: {{contact.phone}}
- הממונה על הגנת הפרטיות: {{privacy.dpo}}
"""

TERMS_BODY = """# תקנון ותנאי שימוש והזמנה

## פרטי העסק
- שם העסק: {{business.name}}
- ח.פ. / ע.מ.: {{business.id}}
- כתובת: {{business.address}}
- טלפון: {{contact.phone}}
- דוא"ל: {{contact.email}}

## השימוש באתר
התפריט הדיגיטלי ואתר ההזמנות נועדו לצפייה במנות ולהזמנה מהעסק. התמונות להמחשה בלבד.

## מחירים
{{terms.vatNote}}
המחיר הכולל של ההזמנה מוצג לפני שליחתה.

## פרטי העסקה לפני ההזמנה
לפני שליחת ההזמנה מוצגים: המנות והתוספות שבחרתם, המחיר הכולל, אופן קבלת ההזמנה (איסוף או ישיבה במקום), נקודת האיסוף ומועדה המשוער. אישור ההזמנה מוצג לאחר שהעסק קיבל אותה.

## תשלום
{{terms.paymentMethods}}

## ביטול הזמנה
{{terms.cancellationPolicy}}

## איסוף וישיבה במקום
{{terms.pickupTerms}}

## זמינות
מבחר המנות, מצב המלאי ושעות קבלת ההזמנות מוצגים באתר ועשויים להשתנות.

## מגבלת גיל
{{terms.ageRestriction}}

## פרטיות ועוגיות
השימוש במידע אישי מוסבר במדיניות הפרטיות, והשימוש בעוגיות — במדיניות העוגיות.
"""

COOKIES_BODY = """# מדיניות עוגיות

עוגיות (Cookies) ואחסון מקומי בדפדפן הם קבצים קטנים שאתר שומר במכשיר שלכם. כך {{business.name}} משתמש בהם:

## חיוניות — תמיד פעילות
נדרשות להפעלת האתר: שמירת הסל, השפה שבחרתם, הגדרות הנגישות שבחרתם ושמירת הבחירה שלכם לגבי עוגיות. אי אפשר לכבות אותן.

## סטטיסטיקה — רק בהסכמה
מידע על השימוש באתר (למשל צפייה במנות ולחיצות), כדי לשפר את התפריט. לא נאסף אלא אם הפעלתם "סטטיסטיקה".
{{cookies.analyticsTools}}

## שיווק — רק בהסכמה
התאמת תוכן שיווקי. לא נאסף אלא אם הפעלתם "שיווק".

## שינוי הבחירה
אפשר לשנות או לבטל את הבחירה בכל עת, בקישור "הגדרות עוגיות" בתחתית כל עמוד. הבחירה נשמרת עד {{cookies.consentRetentionMonths}} חודשים, ואז נשאל שוב.

## יצירת קשר
- דוא"ל: {{contact.email}}
"""

KINDS: Dict[str, KindDef] = {
    KIND_ACCESSIBILITY: KindDef(
        kind=KIND_ACCESSIBILITY,
        title="הצהרת נגישות",
        slug="accessibility",
        summary="ת\"י 5568 ותקנות שוויון זכויות לאנשים עם מוגבלות (התאמות נגישות לשירות). רכז/ת נגישות, רמת התאמה, "
        "תאריך בדיקה, מגבלות ידועות ותאריך ההצהרה.",
        fields=(
            FieldDef("business.name", "שם העסק"),
            FieldDef("coordinator.name", "רכז/ת הנגישות — שם"),
            FieldDef("coordinator.phone", "רכז/ת הנגישות — טלפון", "phone"),
            FieldDef("coordinator.email", 'רכז/ת הנגישות — דוא"ל', "email"),
            FieldDef(
                "conformance.standard", "התקן", default='תקן ישראלי ת"י 5568, המבוסס על הנחיות WCAG 2.0',
                hint="לבדוק עם יועץ/ת הנגישות איזו גרסה של התקן חלה",
            ),
            FieldDef(
                "conformance.level", "רמת ההתאמה", "select",
                options=("AA", "התאמה חלקית — פירוט במגבלות הידועות"), default="AA",
            ),
            FieldDef("accessibility.adjustments", "מה הונגש", "textarea", default=ACCESSIBILITY_ADJUSTMENTS),
            FieldDef(
                "accessibility.limitations", "מגבלות ידועות וחלופות", "textarea",
                hint="מה עדיין לא נגיש, ואיך אפשר לקבל את השירות בדרך אחרת (למשל בטלפון)",
            ),
            FieldDef(
                "accessibility.arrangements", "הסדרי נגישות בעסק", "textarea",
                hint="למשל: גישה לנכים, שירותים נגישים, עזרה בהזמנה בטלפון",
            ),
            FieldDef("accessibility.lastCheckDate", "תאריך הבדיקה האחרונה", "date", past=True),
            FieldDef("accessibility.statementDate", "תאריך עדכון ההצהרה", "date", past=True),
        ),
        body=ACCESSIBILITY_BODY,
        must_appear=(
            "coordinator.name", "coordinator.phone", "coordinator.email", "conformance.level",
            "accessibility.lastCheckDate", "accessibility.limitations", "accessibility.statementDate",
        ),
    ),
    KIND_PRIVACY: KindDef(
        kind=KIND_PRIVACY,
        title="מדיניות פרטיות",
        slug="privacy",
        summary="חוק הגנת הפרטיות ותיקון 13: מה נאסף בהזמנה (שם, טלפון), למה, כמה זמן נשמר, הזכויות ויצירת קשר.",
        fields=_business()
        + _contact(phone_required=False, email_required=True)
        + (
            FieldDef(
                "privacy.processors", "למי המידע מועבר", "textarea",
                default="- ספקי אחסון ותשתית ענן שמפעילים את האתר עבורנו\n- ספק שירותי SMS, לשליחת הודעות שירות על ההזמנה",
            ),
            FieldDef("privacy.orderRetentionDays", "ימי שמירה — פרטי קשר של הזמנה", "number", default="30", min=1, max=3650),
            FieldDef("privacy.enquiryRetentionDays", "ימי שמירה — פניות מכרטיס ביקור", "number", default="90", min=1, max=3650),
            FieldDef("privacy.dpo", "הממונה על הגנת הפרטיות (אם מונה)", required=False),
        ),
        body=PRIVACY_BODY,
        must_appear=("business.name", "privacy.orderRetentionDays", "contact.email"),
    ),
    KIND_TERMS: KindDef(
        kind=KIND_TERMS,
        title="תקנון ותנאי שימוש והזמנה",
        slug="terms",
        summary="זהות העסק, מחירים כולל מע\"מ, גילוי לעסקת מכר מרחוק (חוק הגנת הצרכן), מדיניות ביטול ותנאי איסוף.",
        fields=_business()
        + _contact(phone_required=True, email_required=True)
        + (
            FieldDef("terms.vatNote", 'מע"מ', "textarea"),
            FieldDef("terms.paymentMethods", "אמצעי תשלום", "textarea", default="התשלום מתבצע בעת האיסוף, בקופת העסק."),
            FieldDef(
                "terms.cancellationPolicy", "מדיניות ביטול", "textarea",
                default=(
                    "אפשר לבטל הזמנה בטלפון לעסק כל עוד לא התחילה הכנתה. בהתאם לחריגים שבחוק הגנת הצרכן, "
                    "התשמ\"א-1981, ובתקנות לפיו לגבי מזון וטובין פסידים, לא ניתן לבטל הזמנה לאחר שהכנתה התחילה."
                ),
                hint="הנוסח והחריגים למזון — לפי קביעת עורך הדין",
            ),
            FieldDef(
                "terms.pickupTerms", "תנאי איסוף וישיבה במקום", "textarea",
                default="את ההזמנה אוספים מנקודת האיסוף שנבחרה, במועד שמוצג באישור ההזמנה. בישיבה במקום — ההזמנה מוגשת לשולחן או נאספת מהדלפק, לפי מה שמוצג בהזמנה.",
            ),
            FieldDef(
                "terms.ageRestriction", "מגבלת גיל (אם יש)", "textarea", required=False,
                hint='למשל: משקאות אלכוהוליים נמסרים רק למי שמלאו לו 18, בהצגת תעודה',
            ),
        ),
        body=TERMS_BODY,
        must_appear=(
            "business.name", "business.id", "business.address", "terms.vatNote", "terms.cancellationPolicy",
            "terms.pickupTerms",
        ),
        any_of=(("contact.phone", "contact.email"),),
    ),
    KIND_COOKIES: KindDef(
        kind=KIND_COOKIES,
        title="מדיניות עוגיות",
        slug="cookies",
        summary="אילו עוגיות משמשות (חיוניות / סטטיסטיקה / שיווק), שהכול כבוי עד הסכמה, ואיך משנים את הבחירה.",
        fields=(
            FieldDef("business.name", "שם העסק"),
            FieldDef('contact.email', 'דוא"ל ליצירת קשר', "email"),
            FieldDef(
                "cookies.analyticsTools", "כלי סטטיסטיקה (אם יש)", "textarea", required=False,
                hint="שם הכלי ומי מפעיל אותו. ריק = השורה לא תוצג",
            ),
            FieldDef("cookies.consentRetentionMonths", "כמה חודשים נשמרת הבחירה", "number", default="12", min=1, max=24),
        ),
        body=COOKIES_BODY,
        must_appear=("cookies.consentRetentionMonths",),
    ),
}

assert set(KINDS) == set(LEGAL_KINDS)

#: The public path segment → kind.
KIND_BY_SLUG: Dict[str, str] = {k.slug: k.kind for k in KINDS.values()}


def kind_def(kind: str) -> KindDef:
    try:
        return KINDS[kind]
    except KeyError:
        raise ValueError(f"unknown legal kind {kind!r}") from None


def vat_note(dealer_type: Optional[str]) -> str:
    if dealer_type == "exempt":
        return 'העסק הוא עוסק פטור, ולכן לא נגבה מע"מ. המחירים באתר הם המחירים הסופיים.'
    return 'כל המחירים באתר כוללים מע"מ.'


def prefill(kind: str, *, company: Any = None, shop: Any = None, today: Optional[date] = None) -> Dict[str, str]:
    """The starting values of a new draft: the template's suggestions and the business's own details."""
    spec = kind_def(kind)
    out: Dict[str, str] = {f.key: f.default for f in spec.fields if f.default is not None}
    if company is not None:
        if "business.name" in spec.field_by_key and getattr(company, "name", None):
            out["business.name"] = str(company.name)
        if "business.id" in spec.field_by_key:
            ident = getattr(company, "vat_number", None) or getattr(company, "company_number", None)
            if ident:
                out["business.id"] = str(ident)
        if "business.address" in spec.field_by_key:
            src = shop if shop is not None and getattr(shop, "address", None) else company
            parts = [p for p in (getattr(src, "address", None), getattr(src, "city", None)) if p]
            if parts:
                out["business.address"] = ", ".join(str(p) for p in parts)
        if "terms.vatNote" in spec.field_by_key:
            out["terms.vatNote"] = vat_note(getattr(company, "dealer_type", None))
    if "accessibility.statementDate" in spec.field_by_key:
        out["accessibility.statementDate"] = (today or date.today()).isoformat()
    return out


def placeholders(body: str) -> List[str]:
    return [m.group(1) for m in PLACEHOLDER.finditer(body or "")]


def _format(spec: KindDef, key: str, value: str) -> str:
    fd = spec.field_by_key.get(key)
    if fd is not None and fd.type == "date" and ISO_DATE.match(value):
        y, m, d = value.split("-")
        return f"{d}.{m}.{y}"
    return value


def clean_fields(kind: str, raw: Any) -> Dict[str, str]:
    """Only the kind's known fields, as trimmed strings (a value that is not text is dropped)."""
    spec = kind_def(kind)
    out: Dict[str, str] = {}
    if not isinstance(raw, Mapping):
        return out
    for key, value in raw.items():
        fd = spec.field_by_key.get(str(key))
        if fd is None or value is None:
            continue
        if isinstance(value, bool) or not isinstance(value, (str, int, float)):
            continue
        text = str(value).replace("\r\n", "\n").strip()
        limit = MAX_TEXTAREA if fd.type == "textarea" else MAX_TEXT
        out[fd.key] = text[:limit]
    return out


def render(kind: str, body: str, fields: Mapping[str, Any], *, preview: bool = False) -> str:
    """
    The page as published: every placeholder replaced by its value. A line whose placeholder has no
    value is left out (an optional field — publication refuses an empty required one). In `preview`
    a missing value shows as "[חסר: <label>]" instead, so the editor sees what is still to fill.
    """
    spec = kind_def(kind)
    values = clean_fields(kind, fields)
    out_lines: List[str] = []
    for line in (body or "").replace("\r\n", "\n").split("\n"):
        keys = placeholders(line)
        if not keys:
            out_lines.append(line)
            continue
        missing = [k for k in keys if not values.get(k)]
        if missing and not preview:
            continue

        def sub(m: "re.Match[str]") -> str:
            key = m.group(1)
            value = values.get(key)
            if value:
                return _format(spec, key, value)
            fd = spec.field_by_key.get(key)
            return f"[חסר: {fd.label if fd else key}]"

        out_lines.append(PLACEHOLDER.sub(sub, line))
    text = "\n".join(out_lines)
    return re.sub(r"\n{3,}", "\n\n", text).strip() + "\n"


def problems(kind: str, title: Optional[str], body: Optional[str], fields: Any, *, today: Optional[date] = None) -> List[Dict[str, str]]:
    """
    What stops this version from being published: `{code, field?, label?}` per problem. Empty = it may
    be published (after "נבדק").
    """
    spec = kind_def(kind)
    values = clean_fields(kind, fields)
    out: List[Dict[str, str]] = []
    today = today or date.today()
    if not (title or "").strip():
        out.append({"code": "title_required"})
    elif len(title) > MAX_TITLE:
        out.append({"code": "title_too_long"})
    text = body or ""
    if not text.strip():
        out.append({"code": "body_required"})
    elif len(text) > MAX_BODY:
        out.append({"code": "body_too_long"})
    used = placeholders(text)
    for key in sorted(set(used)):
        if key not in spec.field_by_key:
            out.append({"code": "unknown_placeholder", "field": key})
    for key in spec.must_appear:
        if key not in used:
            out.append({"code": "section_missing", "field": key, "label": spec.field_by_key[key].label})
    for group in spec.any_of:
        if not any(values.get(k) for k in group):
            out.append({"code": "one_of_required", "field": ",".join(group),
                        "label": " / ".join(spec.field_by_key[k].label for k in group)})
    for fd in spec.fields:
        value = values.get(fd.key, "")
        if not value:
            if fd.required:
                out.append({"code": "field_required", "field": fd.key, "label": fd.label})
            continue
        bad = _invalid(fd, value, today)
        if bad:
            out.append({"code": bad, "field": fd.key, "label": fd.label})
    return out


def _invalid(fd: FieldDef, value: str, today: date) -> Optional[str]:
    if fd.type == "email" and not EMAIL.match(value):
        return "email_invalid"
    if fd.type == "phone" and (not PHONE.match(value) or sum(c.isdigit() for c in value) < 9):
        return "phone_invalid"
    if fd.type == "date":
        if not ISO_DATE.match(value):
            return "date_invalid"
        try:
            d = date.fromisoformat(value)
        except ValueError:
            return "date_invalid"
        if fd.past and d > today:
            return "date_in_future"
    if fd.type == "number":
        try:
            n = int(value)
        except ValueError:
            return "number_invalid"
        if (fd.min is not None and n < fd.min) or (fd.max is not None and n > fd.max):
            return "number_out_of_range"
    if fd.type == "select" and fd.options and value not in fd.options:
        return "option_invalid"
    return None


def catalogue() -> List[Dict[str, Any]]:
    """What the dashboard editor renders: per kind its fields, template and the rules."""
    return [
        {
            "kind": spec.kind,
            "title": spec.title,
            "slug": spec.slug,
            "summary": spec.summary,
            "fields": [f.as_dict() for f in spec.fields],
            "templateVersion": TEMPLATE_VERSION,
            "template": spec.body,
            "mustAppear": list(spec.must_appear),
        }
        for spec in (KINDS[k] for k in LEGAL_KINDS)
    ]


def kinds_in(items: Iterable[str]) -> List[str]:
    return [k for k in LEGAL_KINDS if k in set(items)]
