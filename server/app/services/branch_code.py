"""
"קוד סניף" — mandatory for every shop (owner: "חייב שלסניף יהיה קוד").

The code is what the open-format export writes in field 1231 (מזהה סניף/ענף) of every
document record, and what tells two shops' documents apart in a company's file: till 1
of each shop can both issue `10000057` (docs/SPEC_DOCUMENT_PREFIX.md), and the branch code
is the rest of the document's identity. So:

* **Required** on create and on update (it can be changed, never cleared).
* **Format.** Digits only, 1–7 characters: field 1231 is X(7) (`pad_right(..., 7)` in
  `open_format.tax_report_generator`).
* **Unique within the company** — the export runs over a company (or one of its shops).
* The shop's own code wins over any `businessInfo.branchId` in the settings layers
  (`settings_merge.build_business_info`): a company-wide override would put one code on
  every shop, which is the ambiguity this rule exists to prevent.

Shops that had none were given one by migration f3a9c2d7e1b4 (lowest free per company,
in creation order) and are flagged `branch_id_auto_assigned` until someone saves the
code on the dashboard ("קוד סניף הוקצה אוטומטית — ודאו מול רו״ח").
"""
from __future__ import annotations

import re
import uuid
from typing import Any, Iterable, Optional

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

#: Field 1231 of the open format is X(7).
BRANCH_CODE_MAX_LEN = 7
BRANCH_CODE_RE = re.compile(rf"^[0-9]{{1,{BRANCH_CODE_MAX_LEN}}}$")

REQUIRED_MESSAGE = "קוד סניף הוא שדה חובה — משמש בקובץ מס הכנסה ובמספור המסמכים."
INVALID_MESSAGE = f"קוד סניף: ספרות בלבד, בין 1 ל-{BRANCH_CODE_MAX_LEN} תווים."


def normalize_branch_code(value: Any) -> Optional[str]:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def is_valid_branch_code(value: Any) -> bool:
    text = normalize_branch_code(value)
    return text is not None and BRANCH_CODE_RE.match(text) is not None


def check_branch_code(
    db: Session, company_id: Any, value: Any, *, shop_id: Optional[uuid.UUID] = None
) -> str:
    """
    The code to store for a shop of [company_id] (the shop itself is [shop_id] on an
    update), or an HTTPException: 400 when it is missing or malformed, 409 when another
    shop of the company already files under it.
    """
    code = normalize_branch_code(value)
    if code is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=REQUIRED_MESSAGE)
    if not BRANCH_CODE_RE.match(code):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=INVALID_MESSAGE)
    from app.models.shop import Shop

    query = db.query(Shop).filter(Shop.company_id == company_id, Shop.branch_id == code)
    if shop_id is not None:
        query = query.filter(Shop.id != shop_id)
    other = query.first()
    if other is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                f"קוד הסניף {code} כבר משמש את הסניף \"{other.name}\" באותה חברה. "
                "לכל סניף קוד משלו — הוא מזהה את מסמכי הסניף בקובץ מס הכנסה."
            ),
        )
    return code


def lowest_free_code(used: Iterable[Any]) -> str:
    """The lowest positive code (as digits) not in [used]."""
    taken = {normalize_branch_code(u) for u in used}
    n = 1
    while str(n) in taken:
        n += 1
    return str(n)


def shops_without_code(shops: Iterable[Any]) -> list:
    """The shops among [shops] with no branch code: the export refuses to run over them."""
    return [s for s in shops if normalize_branch_code(getattr(s, "branch_id", None)) is None]
