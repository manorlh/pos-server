"""
"עקיפת בדיקת מספר מסוף" — the till parameter `terminalNumberCheckBypass` (docs/SPEC_KIOSK.md §20.1).

The owner: "תאפשר בפרמטרים לקופות לעקוף את מנגנון בדיקת מספר מסוף כדי שיוכל לעבוד פר חברה, סניף,
נקודות מכירה וקופה". The terminal-number check is the card lock (docs/SPEC_KIOSK.md §20; the till's
domain/CardLock.kt, the cloud's `terminal_status.card_lock_of`, the Windows kiosk's SynqPay
`cardLockOf`): a till never charges a card on a terminal that is not the one set for it — another
number, a network pinpad with no number set on the machine itself, or a pinpad whose identity was
not read. With this parameter on (effective for that till), that check never locks or blocks card
payment, on the till, the kiosk, the Windows kiosk or in the cloud's own view of the lock.

What it does NOT touch: a terminal that does not answer is still "not available", a pinpad that
says it is not established with Shva still cannot charge, one card operation at a time, the wait
after a card, card recovery, the forced establishment (`forceTerminalNumber`) and the guard that
never writes an inherited number onto an external pinpad (`terminal_config_guard`).

* **The parameter** — a built-in boolean, off by default, set per company / shop / point of sale /
  till like every parameter (`till_parameters.resolve_till_parameters`); [`effective`] says which
  level it comes from. Only the owner and managers may change it ([`may_change`]), and every
  change of every parameter is recorded (app/services/till_parameter_audit.py).
* **Shown** — the till and the kiosk technician screen say "בדיקת מספר מסוף מושבתת"; the till
  reports what it applies on its heartbeat (`terminalNumberCheckBypass` →
  `pos_machines.terminal_number_check_bypass_reported`); the dashboard's machine page and device health
  show the cloud's effective value, its level, the till's report and the lock it would have been.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Any, Dict, Iterable, Optional, Sequence

from sqlalchemy.orm import Session

KEY = "terminalNumberCheckBypass"
LABEL = "עקיפת בדיקת מספר מסוף"
#: What the till, the technician screen and the dashboard say while it is on.
WARNING = "בדיקת מספר מסוף מושבתת"

DESCRIPTION = (
    "כשמופעל: בדיקת מספר המסוף לא נועלת את האשראי — לא כשהמסוף המחובר מדווח מספר אחר מהמספר "
    "שהוגדר, לא כשלמסופון רשת לא הוגדר מספר מסוף על הקופה עצמה, ולא כשזהות המסופון לא נקראה; "
    "מסך \"המסוף אינו תואם\" לא נפתח והקיוסק לא חוסם תשלום מהסיבה הזו. "
    "אזהרה: חיובים עלולים להגיע למסוף שאינו של העסק או של הקופה הזו — הכסף ייכנס לחשבון אחר. "
    "להפעיל רק לבדיקות, או כשידוע בוודאות שמספר המסוף נכון. "
    "כל השאר נשאר: מסוף שלא עונה עדיין \"לא זמין\", מסוף שלא הוקם בשב\"א עדיין לא מחייב, "
    "עסקה אחת בכל פעם, ההמתנה אחרי כרטיס ובירור עסקאות לא מוכרעות. "
    "כשמופעל — בקופה ובמסך הטכנאי מוצג \"בדיקת מספר מסוף מושבתת\", ובדשבורד — בעמוד הקופה ובתקינות "
    "המכשירים. רק בעלים ומנהלים רשאים לשנות, וכל שינוי נרשם (מי, מתי, באיזו רמה ואיזה ערך). "
    "ניתן לקבוע לפי חברה, סניף, נקודת מכירה או קופה."
)

BYPASS_PARAMETER_SPECS = (
    dict(
        key=KEY,
        label=LABEL,
        value_type="boolean",
        default_value=False,
        description=DESCRIPTION,
    ),
)

#: "רק בעלים ומנהלים": the owner (super admin) and the business's managers. The parameters page is
#: the super admin's today; this keeps the key to these roles whatever page edits parameters later.
CHANGE_ROLES = ("super_admin", "company_manager", "shop_manager")

#: Parameters only [CHANGE_ROLES] may change (value, default, activation, deletion).
RESTRICTED_KEYS = frozenset({KEY})

#: Where the effective value comes from beyond the four levels: the definition's default.
SOURCE_DEFAULT = "default"


def _role(user: Any) -> Optional[str]:
    role = getattr(user, "role", None)
    return getattr(role, "value", role)


def may_change(key: str, user: Any) -> bool:
    """Whether `user` may change parameter `key` — always, but for [RESTRICTED_KEYS]."""
    if key not in RESTRICTED_KEYS:
        return True
    return _role(user) in CHANGE_ROLES


@dataclass(frozen=True)
class Bypass:
    """The effective value for one till, and the level it comes from."""

    on: bool = False
    #: "machine" | "area" | "shop" | "company" | "default"; None: no active definition.
    source: Optional[str] = None


def effective(parameter: Any, values: Iterable[Any], chain: Any) -> Bypass:
    """
    The value the till gets, as `till_parameters.resolve_till_parameters` chooses it — the most
    specific level on `chain` with a valid (boolean) value, else the default — and its level.
    No definition, or an inactive one: the till gets no key, which is off.
    """
    if parameter is None or not getattr(parameter, "is_active", True):
        return Bypass()
    from app.services.till_parameters import as_uuid

    pid = as_uuid(parameter.id)
    by_scope = {
        (row.scope_type, as_uuid(row.scope_id)): row.value
        for row in values
        if as_uuid(row.parameter_id) == pid
    }
    for scope in chain.scopes():
        if scope in by_scope and isinstance(by_scope[scope], bool):
            return Bypass(by_scope[scope], scope[0])
    default = parameter.default_value
    if isinstance(default, bool):
        return Bypass(default, SOURCE_DEFAULT)
    return Bypass()


def _definition(db: Session):
    from app.models.till_parameter import TillParameter

    return db.query(TillParameter).filter(TillParameter.key == KEY).first()


def bypass_for_machines(db: Session, machines: Sequence[Any]) -> Dict[Any, Bypass]:
    """
    Per till, its effective value — three queries however many tills (the definition, the
    shops' companies, the values of this one parameter). Never raises: a failure is off for
    all, the safe side (the lock stays).
    """
    machines = [m for m in machines if m is not None]
    if not machines:
        return {}
    try:
        from app.models.shop import Shop
        from app.models.till_parameter import TillParameterValue
        from app.services.till_parameters import TillScopeChain

        # A savepoint: a failed read never poisons the request it serves.
        with db.begin_nested():
            parameter = _definition(db)
            if parameter is None or not parameter.is_active:
                return {m.id: Bypass() for m in machines}
            shop_ids = {m.shop_id for m in machines if getattr(m, "shop_id", None) is not None}
            companies: Dict[Any, Any] = {}
            if shop_ids:
                companies = {
                    row[0]: row[1]
                    for row in db.query(Shop.id, Shop.company_id).filter(Shop.id.in_(list(shop_ids))).all()
                }
            values = (
                db.query(TillParameterValue).filter(TillParameterValue.parameter_id == parameter.id).all()
            )
        out: Dict[Any, Bypass] = {}
        for m in machines:
            chain = TillScopeChain(
                machine_id=m.id,
                area_id=getattr(m, "area_id", None),
                shop_id=getattr(m, "shop_id", None),
                company_id=companies.get(getattr(m, "shop_id", None)),
            )
            out[m.id] = effective(parameter, values, chain)
        return out
    except Exception:  # noqa: BLE001 - a view never fails for this; off keeps the lock
        import logging

        logging.getLogger(__name__).exception("terminal number check bypass: not resolved")
        return {m.id: Bypass() for m in machines}


def bypass_for_machine(db: Session, machine: Any) -> Bypass:
    return bypass_for_machines(db, [machine]).get(getattr(machine, "id", None), Bypass())


def change_of(db: Session, machine: Any, bypass: Bypass) -> Optional[Dict[str, Any]]:
    """
    Who set the value this till runs on, when, at which level — the newest audit row of that
    level (app/services/till_parameter_audit.py). None when off, from the default, or unrecorded.
    """
    if not bypass.on or bypass.source in (None, SOURCE_DEFAULT):
        return None
    scope_id = _scope_id(db, machine, bypass.source)
    if scope_id is None:
        return None
    from app.services.till_parameter_audit import latest_change

    return latest_change(db, KEY, bypass.source, scope_id)


def _scope_id(db: Session, machine: Any, source: str) -> Optional[uuid.UUID]:
    if source == "machine":
        return getattr(machine, "id", None)
    if source == "area":
        return getattr(machine, "area_id", None)
    if source == "shop":
        return getattr(machine, "shop_id", None)
    if source == "company" and getattr(machine, "shop_id", None) is not None:
        from app.models.shop import Shop

        row = db.query(Shop.company_id).filter(Shop.id == machine.shop_id).first()
        return row[0] if row else None
    return None


def machine_fields(
    machine: Any, bypass: Bypass, would_lock: Optional[str], change: Optional[Dict[str, Any]] = None
) -> Dict[str, Any]:
    """The machine response's fields: the cloud's value, its level, the till's report, the lock it lifts."""
    return {
        "terminalNumberCheckBypass": bypass.on,
        "terminalNumberCheckBypassSource": bypass.source if bypass.on else None,
        # What the till itself said it applies on its last heartbeat (null: an older build).
        "terminalNumberCheckBypassReported": getattr(machine, "terminal_number_check_bypass_reported", None),
        # The card lock the check would have put on now — shown beside the warning.
        "cardLockBypassed": would_lock if bypass.on else None,
        "terminalNumberCheckBypassChange": change,
    }


def apply_heartbeat(machine: Any, reported: Optional[bool]) -> None:
    """The till's own account of what it applies; absent (an older build) leaves it as it was."""
    if isinstance(reported, bool):
        machine.terminal_number_check_bypass_reported = reported
