"""
Phone numbers: E.164 inside the system, the provider's own format only at its edge.

* `normalize_phone` turns what a person typed into E.164 (`+972501234567`) or raises
  `PhoneError`. Israeli input in every usual shape is understood ("050-123-4567",
  "0501234567", "501234567", "972501234567", "+972 50 123 4567", "00972…", and the
  common mistake "+972 050…" whose trunk 0 must go — not a blind "strip +972").
* `is_israeli_mobile` — +9725XXXXXXXX (9 national digits starting with 5).
* `to_019_destination` — 019's documented destination format is `5xxxxxxxx` or
  `05xxxxxxxx` (docs.019sms.co.il/sms/send-sms.html); we send `05xxxxxxxx`. Anything
  else (a landline, a foreign number) is refused here: 019 documents an
  `includes_international` flag, but foreign pricing and support are open questions
  (docs/SPEC_NOTIFICATIONS_CLUB.md), so P0 does not send abroad.
* `mask_phone` — what screens show by default ("050-•••-4567").
* `phone_hash` — the keyed hash used for dedupe, suppression and member lookup.
"""
from __future__ import annotations

import re
from typing import Optional

from app.services.notifications.crypto import keyed_hash

_SEPARATORS = re.compile(r"[\s\-\.\(\)‎‏‪-‮]")
_E164 = re.compile(r"^\+[1-9]\d{7,14}$")


class PhoneError(ValueError):
    """[code]: phone_empty | phone_invalid | phone_not_mobile | phone_foreign_unsupported."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def normalize_phone(raw: Optional[str], *, default_country: str = "972") -> str:
    if raw is None:
        raise PhoneError("phone_empty")
    text = _SEPARATORS.sub("", str(raw).strip())
    if not text:
        raise PhoneError("phone_empty")
    if text.startswith("00"):
        text = "+" + text[2:]
    if text.startswith("+"):
        digits = text[1:]
        if not digits.isdigit():
            raise PhoneError("phone_invalid")
        if digits.startswith("972"):
            national = digits[3:]
            if national.startswith("0"):
                # "+972 050…": the trunk 0 does not belong after the country code.
                national = national[1:]
            return _israeli(national)
        e164 = "+" + digits
        if not _E164.match(e164):
            raise PhoneError("phone_invalid")
        return e164
    if not text.isdigit():
        raise PhoneError("phone_invalid")
    if text.startswith("972") and len(text) in (11, 12, 13):
        national = text[3:]
        if national.startswith("0"):
            national = national[1:]
        return _israeli(national)
    if text.startswith("0"):
        return _israeli(text[1:])
    if default_country == "972" and len(text) == 9 and text.startswith("5"):
        return _israeli(text)
    raise PhoneError("phone_invalid")


def _israeli(national: str) -> str:
    """+972 + the national number without its trunk 0 (8 digits landline, 9 mobile)."""
    if not national.isdigit() or len(national) not in (8, 9) or national.startswith("0"):
        raise PhoneError("phone_invalid")
    return "+972" + national


def is_israeli_mobile(e164: str) -> bool:
    return bool(re.match(r"^\+9725\d{8}$", e164 or ""))


def to_019_destination(e164: str) -> str:
    """`05xxxxxxxx` for an Israeli mobile; PhoneError otherwise (see the module doc)."""
    if not e164 or not _E164.match(e164):
        raise PhoneError("phone_invalid")
    if not e164.startswith("+972"):
        raise PhoneError("phone_foreign_unsupported")
    if not is_israeli_mobile(e164):
        raise PhoneError("phone_not_mobile")
    return "0" + e164[4:]


def normalize_mobile(raw: Optional[str]) -> str:
    """Normalise and require an SMS-capable (Israeli mobile) number."""
    e164 = normalize_phone(raw)
    to_019_destination(e164)
    return e164


def mask_phone(e164: Optional[str]) -> str:
    if not e164:
        return ""
    if e164.startswith("+972") and len(e164) >= 12:
        local = "0" + e164[4:]
        return f"{local[:3]}-•••-{local[-4:]}"
    return f"{e164[:4]}•••{e164[-3:]}"


def phone_hash(e164: str) -> str:
    return keyed_hash(e164, label="phone")
