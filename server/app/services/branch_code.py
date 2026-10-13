"""
"קוד סניף" — mandatory for every shop (owner: "חייב שלסניף יהיה קוד").

An **internal** code that identifies the branch (owner: "קוד סניף אינו למס הכנסה" — it is
not registered with the Tax Authority). It is shown on Zs and reports, and the open-format
export writes it in field 1231 (מזהה סניף/ענף) of every document record, because that is
what tells two shops' documents apart in a company's file: till 1 of each shop can both
issue `10000057` (docs/SPEC_DOCUMENT_PREFIX.md). So:

* **Required** on create and on update (it can be changed, never cleared).
* **Format.** Digits only, 1–7 characters: field 1231 is X(7) (`pad_right(..., 7)` in
  `open_format.tax_report_generator`).
* **Unique within the company** — the export runs over a company (or one of its shops).
* The shop's own code wins over any `businessInfo.branchId` in the settings layers
  (`settings_merge.build_business_info`): a company-wide override would put one code on
  every shop, which is the ambiguity this rule exists to prevent.

Shops that had none were given one by migration f3a9c2d7e1b4 (lowest free per company,
in creation order). `branch_id_auto_assigned` records that, until the code is next saved;
nothing asks for it to be confirmed — the code is internal.

**The next code** (P:/specs/shop-code-and-inactive.md §2, owner: "קוד סניף שיהיה אוטומטי
ברצף, עם אופציה לשנות"): the highest numeric code in the company plus 1, or 1 in a company
with none (decision 3: "הגבוה ועוד 1", not the lowest gap). The create form is pre-filled
with it (`GET /shops/next-branch-code`) and may be changed. The code is drawn in the save
itself, under a lock on the company row (`lock_company`), so two shops created at once
never get the same one:

* **No code sent** (`POST /shops` without `branchId`), or the suggestion left as it was
  (`branchIdAuto: true`): the suggestion while it is still free, else the next one — never
  an error.
* **A code typed by hand** that is taken: 409, as before.
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

REQUIRED_MESSAGE = "קוד סניף הוא שדה חובה — קוד פנימי שמזהה את הסניף בדוחות Z ובדוחות."
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
                "לכל סניף בחברה קוד משלו — הוא מזהה את הסניף בדוחות ובמספור המסמכים."
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


def next_code_after(used: Iterable[Any]) -> str:
    """
    The code after [used]: the highest numeric one plus 1, "1" when there is none. A code
    that is not digits (a row from before the rule) does not count. Past 7 digits — a
    company that typed 9999999 — the lowest free code instead, so it always fits field 1231.
    """
    used = [normalize_branch_code(u) for u in used]
    numbers = [int(code) for code in used if code is not None and BRANCH_CODE_RE.match(code)]
    candidate = str(max(numbers, default=0) + 1)
    if len(candidate) > BRANCH_CODE_MAX_LEN:
        return lowest_free_code(used)
    return candidate


def _company_codes(db: Session, company_id: Any) -> list:
    from app.models.shop import Shop

    return [code for (code,) in db.query(Shop.branch_id).filter(Shop.company_id == company_id).all()]


def next_branch_code(db: Session, company_id: Any) -> str:
    """The code a new shop of [company_id] would get now. A peek: nothing is held."""
    return next_code_after(_company_codes(db, company_id))


def lock_statement(company_id: Any):
    """`SELECT companies.id … FOR NO KEY UPDATE` — the company row `lock_company` takes."""
    from sqlalchemy import select

    from app.models.company import Company

    return select(Company.id).where(Company.id == company_id).with_for_update(key_share=True)


def lock_company(db: Session, company_id: Any) -> None:
    """
    Serialise the branch codes of [company_id] for the rest of the transaction: two shops
    created (or recoded) at once take this row lock in turn, and the second reads the first's
    code once it is committed (READ COMMITTED: each statement sees what was committed before
    it). `FOR NO KEY UPDATE`, so rows that merely point at the company (its products, its
    shops) are not held up by it. SQLite (the tests) ignores it.
    """
    db.execute(lock_statement(company_id)).first()


def assign_on_create(db: Session, company_id: Any, suggested: Any = None) -> str:
    """
    The code of a new shop whose code was not typed by hand: [suggested] — what the form
    showed — while it is still a free, well-formed code of the company; else the next one.
    The caller holds `lock_company`.
    """
    used = _company_codes(db, company_id)
    code = normalize_branch_code(suggested)
    if code is not None and BRANCH_CODE_RE.match(code) and code not in {normalize_branch_code(u) for u in used}:
        return code
    return next_code_after(used)


def shops_without_code(shops: Iterable[Any]) -> list:
    """The shops among [shops] with no branch code: the export refuses to run over them."""
    return [s for s in shops if normalize_branch_code(getattr(s, "branch_id", None)) is None]
