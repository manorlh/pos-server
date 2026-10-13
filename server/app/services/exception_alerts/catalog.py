"""
Every exception kind the system detects today, and where it comes from.

`source` names the detection point (app/services/exception_alerts/sources.py):

* `audit_exception` — `audit_exceptions` (app/services/exceptions.py): documents
  (discount, OTH, refund, cancelled document, high tip / amount, after hours), the shift
  close (cash difference), till events (line void, basket cancel, drawer open, reprint,
  long order, forced Z close), tables (table cancelled), sign-in (session release),
  attendance (manual change), the Z flows (offline Z gap / conflict, local shop Z mismatch
  / unsynced till, shop Z producer forced, support Z, till reset / replaced, card
  transmission failed at Z) and the kiosk offline watch. Their on/off and thresholds are
  the exception rules ("הגדרות חריגות") — a type switched off there is never logged.
* `failed_payment` — `failed_payment_attempts`: a card declined / cancelled / not
  answered / terminal error / card locked (till or kiosk).
* `document_refusal` — `document_refusals`: a till document the cloud refused.
* `transaction` — a document stored as a numbering conflict (same number, other content),
  and a credit note that took its original past what it collected ("over credited").
* `z_report` / `shift` — a till Z / a shift whose till figures disagree with the cloud's.
* `kiosk_alert` — `kiosk_alerts`: a card result left undecided ("card_unknown"), a card
  terminal that is not the expected one, a terminal / printer problem. (A customer's
  "help" request is service, not an exception: not logged.)
* `battery` — `device_battery_alerts`: a device's battery crossed a threshold.
* `training` — `training_audit_log`: training mode switched on / off at a shop, and
  training documents from a till of a shop that is not in training (dropped).
* `till_parameter` — `till_parameter_changes`: the terminal-number check bypass turned on.

`amount` — the kind carries a money amount (a "≥ ₪X" threshold applies);
`percent` — its `value` is a percent (a "≥ X%" threshold applies).
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, Optional, Tuple


@dataclass(frozen=True)
class Kind:
    key: str
    label: str
    severity: str
    source: str
    amount: bool = False
    percent: bool = False
    #: Where the log links: document | shift | z | none.
    link: str = "none"


KINDS: Tuple[Kind, ...] = (
    # ── audit_exceptions: documents ──
    Kind("discount", "הנחה", "low", "audit_exception", amount=True, percent=True, link="document"),
    Kind("oth", "OTH — על חשבון הבית", "medium", "audit_exception", amount=True, link="document"),
    Kind("refund", "זיכוי / החזר", "medium", "audit_exception", amount=True, link="document"),
    Kind("basket_cancel", "ביטול עסקה", "medium", "audit_exception", amount=True, link="document"),
    Kind("high_tip", "טיפ גבוה", "medium", "audit_exception", amount=True, percent=True, link="document"),
    Kind("high_amount", "עסקה בסכום גבוה", "low", "audit_exception", amount=True, link="document"),
    Kind("after_hours", "מכירה מחוץ לשעות", "medium", "audit_exception", amount=True, link="document"),
    # ── audit_exceptions: shift close / till events / tables / sign-in / attendance ──
    Kind("cash_difference", "הפרש קופה", "high", "audit_exception", amount=True, link="shift"),
    Kind("line_void", "ביטול שורה", "low", "audit_exception", amount=True, link="document"),
    Kind("drawer_open", "פתיחת מגירה", "medium", "audit_exception", link="shift"),
    Kind("reprint", "הדפסה חוזרת", "medium", "audit_exception", link="document"),
    Kind("long_order", "זמן ממושך על הזמנה", "low", "audit_exception", amount=True, link="document"),
    Kind("table_cancelled", "ביטול שולחן", "high", "audit_exception", amount=True),
    Kind("user_session_release", "שחרור עובד מקופה אחרת", "medium", "audit_exception"),
    Kind("attendance_manual", "שינוי נוכחות ידני", "medium", "audit_exception"),
    Kind("forced_z_close", "סגירת Z כפויה", "high", "audit_exception", link="z"),
    # ── audit_exceptions: Z ──
    Kind("offline_z_gap", "Z שנסגר ללא חיבור — פער מול הענן", "high", "audit_exception", amount=True, link="z"),
    Kind("offline_z_conflict", "התנגשות במספור Z", "high", "audit_exception", link="z"),
    Kind("z_transmission_failed", "שידור אשראי נכשל בסגירת Z", "high", "audit_exception", amount=True, link="z"),
    Kind("local_shop_z_mismatch", "אי-התאמה בין Z מקומי לענן", "high", "audit_exception", link="z"),
    Kind("local_shop_z_till_unsynced", "קופה לא השלימה סנכרון ל-Z סניפי", "medium", "audit_exception", link="z"),
    Kind("shop_z_producer_forced", "הפקת ה-Z הסניפי הועברה בכפייה", "high", "audit_exception"),
    Kind("z_forced_open_shifts", "Z סניפי הופק בכפייה בלי קופות שלא נסגרו", "high", "audit_exception", link="z"),
    Kind("z_forced_pending_cloud_refund", "Z הופק בכפייה לפני שזיכוי אשראי מהענן הופק", "high", "audit_exception", amount=True, link="z"),
    Kind("close_keep_held_sales", "סגירה מרחוק עם מכירות מושהות", "medium", "audit_exception"),
    Kind("support_z_produced", "Z הופק מהענן ע״י התמיכה", "high", "audit_exception", link="z"),
    Kind("till_reset", "איפוס נתוני קופה ע״י התמיכה", "high", "audit_exception"),
    Kind("card_decision_override", "הכרעת אשראי בניגוד לבדיקה במסוף", "high", "audit_exception", amount=True),
    Kind("till_replaced", "הוחלפה קופה", "medium", "audit_exception"),
    Kind("local_server_switched", "השרת המקומי הועבר מהענן", "medium", "audit_exception"),
    Kind("local_server_failover", "גיבוי אוטומטי: השרת המקומי הועבר לבד", "high", "audit_exception"),
    Kind("local_server_failover_changed", "הגדרות הגיבוי האוטומטי לשרת המקומי שונו", "medium", "audit_exception"),
    Kind("shift_closed_from_cloud", "משמרת נסגרה מהענן", "medium", "audit_exception", link="shift"),
    Kind("cloud_closed_shift_late_documents", "מסמכים מאוחרים למשמרת שנסגרה מהענן", "high", "audit_exception", link="shift"),
    Kind("kiosk_offline", "קיוסק לא מחובר", "high", "audit_exception"),
    Kind("till_offline", "קופה לא מחוברת", "high", "audit_exception"),
    Kind("zcredit_recon", "אי-התאמה מול Z-Credit (חיוב בלי מסמך / מסמך בלי חיוב)", "high", "audit_exception", amount=True),
    # The board's lights as alerts (app/services/exception_alerts/status_watch.py, P:/specs/manager-problems.md
    # §2): written as `audit_exceptions`, closed by the watch itself when the light goes out.
    Kind("z_missing", "Z לא בוצע", "high", "audit_exception"),
    Kind("shift_open_overdue", "משמרת פתוחה מעבר לזמן", "medium", "audit_exception", link="shift"),
    Kind("card_transmission_overdue", "שידור אשראי באיחור", "medium", "audit_exception", amount=True),
    Kind("till_printer", "תקלת מדפסת בקופה", "medium", "audit_exception"),
    # Listed by the exception rules as planned; nothing reports them yet.
    Kind("price_override", "שינוי מחיר ידני", "medium", "audit_exception", amount=True, link="document"),
    Kind("card_failures", "כשלי חיוב באשראי", "medium", "audit_exception"),
    # ── other detection points ──
    Kind("failed_payment", "תשלום באשראי שנכשל", "low", "failed_payment", amount=True, link="document"),
    Kind("document_refused", "מסמך שנדחה בענן", "high", "document_refusal", amount=True),
    Kind("document_number_conflict", "התנגשות מספור מסמך", "high", "transaction", amount=True, link="document"),
    Kind("over_credited", "זיכוי מעבר לסכום המקור", "high", "transaction", amount=True, link="document"),
    Kind("z_totals_mismatch", "Z: פער בין נתוני הקופה לענן", "high", "z_report", amount=True, link="z"),
    Kind("shift_totals_mismatch", "משמרת: פער בין נתוני הקופה לענן", "medium", "shift", link="shift"),
    Kind("card_unresolved", "תשלום אשראי לא הוכרע (קיוסק)", "high", "kiosk_alert", amount=True),
    Kind("terminal_mismatch", "מסוף אשראי לא תואם", "high", "kiosk_alert"),
    Kind("kiosk_terminal", "תקלת מסוף אשראי בקיוסק", "medium", "kiosk_alert"),
    Kind("kiosk_printer", "תקלת מדפסת בקיוסק", "low", "kiosk_alert"),
    # "בון לא הודפס" (app/services/bon_alerts.py): a ticket of any till's or kiosk's print queue
    # that needs a person — not printed, cut short, a round in doubt, not taken by the KDS.
    Kind("bon_unprinted", "בון לא הודפס", "high", "kitchen_bon"),
    Kind("device_battery", "סוללה חלשה במכשיר", "low", "battery"),
    Kind("training_mode", "מצב הדרכה הופעל / כובה", "medium", "training"),
    Kind("training_dropped", "מסמכי הדרכה מקופה שלא במצב הדרכה", "high", "training"),
    Kind("terminal_check_bypass", "עקיפת בדיקת מספר מסוף הופעלה", "high", "till_parameter"),
    # "התראות לטלפון" (feat/event-live) — recorded through app/services/exception_alerts/external.py:
    # a till far below its peers (the insights' anomaly rules report it).
    Kind("till_low_sales", "קופה כמעט לא מוכרת", "medium", "insight", link="none"),
    # Stock locations (app/services/stock_alerts.py): a product low or out at a location.
    Kind("stock_low", "מלאי נמוך", "low", "stock_alert", link="none"),
    Kind("stock_out", "אזל מהמלאי", "medium", "stock_alert", link="none"),
    # "יעד מכירות הושג" — one detection point (the coordinator, 09.10.2026): "יעדים ותחרות"
    # (app/services/sales_targets.py, source `sales_target`: once per target and period). An event's
    # target is its shop target there — the live screen writes it there too — so it is never alerted twice.
    Kind("target_reached", "יעד מכירות הושג", "low", "sales_target", amount=True),
    # "זיהויים חדשים" (P:/specs/push-more.md §C, §B2) — the background watches
    # (app/services/exception_alerts/shop_watch.py, service_watch.py, till_activity.py) write them as
    # `audit_exceptions` rows, closed by themselves when the case is over; "סיכום יום" goes straight
    # to the log (daily_summary.py) and is information, not a problem (`INFO_KINDS`).
    Kind("shop_not_opened", "הסניף לא נפתח", "medium", "audit_exception"),
    Kind("sales_pace_low", "קצב מכירות נמוך", "medium", "audit_exception", percent=True),
    Kind("table_open_long", "שולחן פתוח זמן רב", "low", "audit_exception"),
    Kind("kds_ticket_late", "הזמנה במטבח לא מוכנה בזמן", "medium", "audit_exception"),
    Kind("daily_summary", "סיכום יום", "low", "daily_summary", link="z"),
    Kind("till_idle", "קופה לא מוכרת כשהאחרות מוכרות", "medium", "audit_exception"),
)

# "מגירת מזומן" (the drawer spec §10–§11, app/services/cash_drawer_exceptions.py): opening after
# the close, manual opens over the limits, cash out over the threshold, a count variance, an
# opening near one, a missing reason, a refused attempt. Detected from the drawer events and
# cash movements the tills upload and written as `audit_exceptions` — so they reach this log
# through its `audit_exception` source like every till event, and SMS rules can name them.
from app.services.cash_drawer_exceptions import DRAWER_EXCEPTION_KINDS as _DRAWER_KINDS  # noqa: E402

KINDS = KINDS + tuple(
    Kind(k.key, k.label, k.severity, "audit_exception", amount=k.amount, link=k.link) for k in _DRAWER_KINDS
)

KINDS_BY_KEY: Dict[str, Kind] = {k.key: k for k in KINDS}
#: Kinds an SMS rule fires on only when it names them — an "every kind" rule written before they
#: existed does not start texting them (feat/event-live: a till outage, a till barely selling,
#: a target reached; the phone alerts carry them; the board's lights as alerts, manager-problems §2).
OPT_IN_KINDS = frozenset({
    "till_offline", "till_low_sales", "target_reached", "zcredit_recon", "bon_unprinted",
    "z_missing", "shift_open_overdue", "card_transmission_overdue", "till_printer",
})
SEVERITY_RANK = {"low": 0, "medium": 1, "high": 2}
SEVERITY_LABELS = {"low": "נמוכה", "medium": "בינונית", "high": "גבוהה"}
COUNT_SCOPES = ("machine", "employee", "shop")


def label_of(kind: str) -> str:
    spec = KINDS_BY_KEY.get(kind)
    return spec.label if spec is not None else kind


def kind_spec(kind: str) -> Optional[Kind]:
    return KINDS_BY_KEY.get(kind)


def severity_rank(severity: Optional[str]) -> int:
    return SEVERITY_RANK.get(severity or "medium", 1)


def as_json() -> list:
    return [
        {
            "key": k.key, "label": k.label, "severity": k.severity, "source": k.source,
            "amount": k.amount, "percent": k.percent, "link": k.link,
        }
        for k in KINDS
    ]


# ── "זיהויים חדשים" (P:/specs/push-more.md §C, §B2) ──────────────────────────

#: Information, not a problem: never in the problems screen nor in any count of open problems
#: ("סיכום יום" — a shop's day in figures after its Z).
INFO_KINDS = frozenset({"daily_summary"})

#: Not texted by an "every kind" SMS rule written before they existed (they reach the phone
#: through the push categories; an SMS rule that names them sends them).
OPT_IN_KINDS = OPT_IN_KINDS | frozenset({
    "shop_not_opened", "sales_pace_low", "table_open_long", "kds_ticket_late", "daily_summary", "till_idle",
})


def is_info(kind: Optional[str]) -> bool:
    """An entry that informs (a daily summary) rather than reports a problem."""
    return kind in INFO_KINDS
