"""
Machine names: the optional name a device is added with, the default it gets, and a till renaming itself.

docs/SPEC_PAIRING_QR.md §4.

* **Cleaning** (`clean_machine_name`): the one rule for a name typed anywhere — the dashboard's add-device
  form (`POST /pairing/generate`) and the till's own settings (`PATCH /sync/{machine_id}/name`). Edges
  trimmed, runs of whitespace collapsed to one space, 1–`MACHINE_NAME_MAX` characters, no control or
  hidden-direction characters (a name is printed on receipts' headers and shown on every list; an invisible
  bidi mark would let one name read as another). The till's `MachineName.clean` pins the same rule.
* **The default** (`settle_default_name`): a device added with no name is created as
  `POS Machine MACHINE-XXXXXXXX` (`create_pos_machine`). The moment it has a register number in a shop the
  server renames **its own generated name** to "קופה N" — the label the dashboard already puts first on every
  row (`useMachineLabel`). A name anybody typed (the dashboard, or an older till's `Nova 55F`) is never
  touched, nor is a kiosk's or a screen's.
* **A till renaming itself** (`rename_from_till`): last write wins; every change is a `till_events` row
  (`machine_renamed`) and a log line.
"""
from __future__ import annotations

import logging
import re
import unicodedata
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

#: A name is at most this many characters (code points). The column is wider (255); the cap is what a
#: list, a receipt header and a menu header can show without wrapping.
MACHINE_NAME_MAX = 100

#: The till event that records each rename (`till_events.event_type`).
RENAME_EVENT = "machine_renamed"

#: The name `create_pos_machine` gives a device that arrived with none.
GENERATED_NAME = re.compile(r"^POS Machine MACHINE-[0-9A-F]{8}$")

_NAME_ERRORS = {
    "name_required": "יש להקליד שם",
    "name_too_long": f"השם ארוך מדי (עד {MACHINE_NAME_MAX} תווים)",
    "name_invalid": "השם מכיל תווים לא חוקיים",
}


class MachineNameRefused(ValueError):
    """A name the cloud does not take. [code] is the API's `detail`; [message] is Hebrew, for the screen."""

    status_code = 422

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code
        self.message = _NAME_ERRORS[code]

    @property
    def body(self) -> Dict[str, str]:
        return {"detail": self.code, "message": self.message}


def clean_machine_name(raw: Any) -> Optional[str]:
    """
    The name as it is stored, or None when [raw] is blank (the caller decides whether that is fine).

    Raises `MachineNameRefused` (`name_too_long` / `name_invalid`) for one the cloud does not take.
    """
    if raw is None:
        return None
    text = unicodedata.normalize("NFC", str(raw))
    for ch in text:
        # Whitespace (tabs and line breaks too) is collapsed below; every other control, format
        # (zero-width and bidi marks), surrogate, private-use or unassigned character is refused.
        if not ch.isspace() and unicodedata.category(ch)[0] == "C":
            raise MachineNameRefused("name_invalid")
    text = " ".join(text.split())
    if not text:
        return None
    if len(text) > MACHINE_NAME_MAX:
        raise MachineNameRefused("name_too_long")
    return text


def require_machine_name(raw: Any) -> str:
    """`clean_machine_name`, refusing a blank one too (`name_required`)."""
    name = clean_machine_name(raw)
    if name is None:
        raise MachineNameRefused("name_required")
    return name


def default_machine_name(pos_number: Any) -> Optional[str]:
    """"קופה N" for a register number, else None."""
    number = str(pos_number).strip() if pos_number is not None else ""
    return f"קופה {number}" if number.isdigit() else None


def is_generated_name(name: Optional[str]) -> bool:
    """Whether [name] is the one `create_pos_machine` made up, never one somebody typed."""
    return bool(name) and GENERATED_NAME.match(name) is not None


def settle_default_name(machine: Any, *, role: Optional[str] = None) -> bool:
    """
    Rename a machine's own generated name to "קופה N" once it has a register number. True when it did.

    Only for a till ([role] None or "till"): a kiosk is not a register, and a screen has no number.
    The caller commits.
    """
    if role not in (None, "till"):
        return False
    if getattr(machine, "is_fiscal", True) is False:
        return False
    if not is_generated_name(getattr(machine, "name", None)):
        return False
    name = default_machine_name(getattr(machine, "pos_number", None))
    if name is None:
        return False
    machine.name = name
    return True


def rename_from_till(
    db: Any,
    machine: Any,
    raw_name: Any,
    *,
    operator_id: Optional[str] = None,
    approved_by_id: Optional[str] = None,
    changed_at: Optional[datetime] = None,
    now: Optional[datetime] = None,
) -> Dict[str, Any]:
    """
    `PATCH /sync/{machine_id}/name` — the till gives itself a new name.

    Answers `{"name", "previousName", "unchanged"}`: the same name again changes nothing and writes no
    event, so the till's outbox may resend after a lost answer. Raises `MachineNameRefused`. The caller
    commits.

    [operator_id] and [approved_by_id] are the till's word for who typed it and who approved it (the same
    word the cloud takes for `cashier_id` on every document); [changed_at] is when the till's own clock
    says it was made, kept as given — `occurred_at` is the cloud's.
    """
    from app.models.audit_exception import TillEvent

    name = require_machine_name(raw_name)
    previous = machine.name
    if previous == name:
        return {"name": name, "previousName": previous, "unchanged": True}
    machine.name = name
    moment = now or datetime.now(timezone.utc)
    db.add(TillEvent(
        id=uuid.uuid4(),
        tenant_id=machine.tenant_id,
        machine_id=machine.id,
        shop_id=machine.shop_id,
        area_id=getattr(machine, "area_id", None),
        event_type=RENAME_EVENT,
        occurred_at=moment,
        pos_user_id=(operator_id or "").strip()[:100] or None,
        details={
            "from": previous,
            "to": name,
            "source": "till",
            "approvedById": (approved_by_id or "").strip()[:100] or None,
            "tillChangedAt": changed_at.isoformat() if changed_at is not None else None,
        },
    ))
    logger.info(
        "machine %s renamed from the till: %r -> %r (operator %s, approver %s)",
        machine.id, previous, name, operator_id, approved_by_id,
    )
    return {"name": name, "previousName": previous, "unchanged": False}
