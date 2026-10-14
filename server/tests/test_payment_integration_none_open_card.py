"""
"אי אפשר להעביר קופה ללא אשראי שיש בה עסקאות אשראי" (P:/specs/payment-integration-none.md §6).

A save that moves a till to "ללא אשראי" (`paymentIntegration` = `none`) is refused — 409
`payment_integration_open_card`, with each such till and its counts — while the till has card
sales in a shift no Z took, card transactions not transmitted (its transmission report), or a
card payment "לא הוכרע". On the till itself, or from a level above (only the tills the save
really moves are counted). A till with none moves as usual; there is no force.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import pytest
from fastapi import HTTPException

from app.models.failed_payment import FailedPaymentAttempt
from app.models.pos_machine import POSMachine
from app.models.shift import ShiftStatus
from app.models.z_report import ZReport
from app.routers import settings as settings_router
from app.schemas.pos_settings import PosSettingsV1Patch
from app.services import payment_integration as PI
from app.services import settings_notify
from shift_world import TODAY, accept_str_uuids, make_world

AT = datetime(2026, 10, 14, 9, 0, tzinfo=timezone.utc)
TAIL = "יש לבצע שידור ו-Z לפני המעבר ל'ללא אשראי'"


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    world = make_world()
    for name in ("notify_machine_settings", "notify_machines_for_shop_settings",
                 "notify_machines_for_company_settings", "notify_machines_for_area_settings",
                 "notify_machines_for_tenant_settings"):
        if hasattr(settings_router, name):
            monkeypatch.setattr(settings_router, name, lambda *a, **k: None)
    monkeypatch.setattr(settings_notify, "notify_machine_settings", lambda *a, **k: None)
    return world


def _patch_machine(w, till, **body):
    with patch.object(settings_router, "_machine_for_read", return_value=till):
        return settings_router.patch_machine_settings(
            machine_id=str(till.id), data=PosSettingsV1Patch(**body), current_user=w.admin,
            active_tenant_id=w.tenant.id, db=w.db,
        )


def _patch_shop(w, **body):
    with patch.object(settings_router, "_check_shop_settings_write", lambda *a: None):
        return settings_router.patch_shop_settings(
            shop_id=str(w.shop.id), data=PosSettingsV1Patch(**body), current_user=w.admin,
            active_tenant_id=w.tenant.id, db=w.db,
        )


def _patch_company(w, **body):
    return settings_router.patch_company_settings(
        company_id=str(w.company.id), data=PosSettingsV1Patch(**body), current_user=w.admin,
        active_tenant_id=w.tenant.id, db=w.db,
    )


def _refused(fn, *args, **kwargs) -> dict:
    with pytest.raises(HTTPException) as caught:
        fn(*args, **kwargs)
    assert caught.value.status_code == 409
    assert caught.value.detail["code"] == "payment_integration_open_card"
    return caught.value.detail


def _card_sales(w, till, n, *, z=False):
    """[n] card sales in an open shift of [till] (or in a closed shift a Z took)."""
    shift = w.shift(till, 1, status=ShiftStatus.CLOSED if z else ShiftStatus.OPEN)
    for _ in range(n):
        w.doc(till, shift, "50.00", method="card")
    if z:
        report = ZReport(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=till.shop_id, machine_id=till.id,
                         origin="till", business_date=TODAY, closed_at=AT)
        w.db.add(report)
        w.db.flush()
        shift.z_report_id = report.id
    w.db.commit()
    return shift


def _unresolved(w, till):
    w.db.add(FailedPaymentAttempt(
        id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=till.shop_id, machine_id=till.id,
        occurred_at=AT, amount_agorot=5000, outcome="unresolved",
    ))
    w.db.commit()


def _untransmitted(w, till, n):
    """The till's transmission report: [n] card transactions waiting for the batch."""
    till.transmission_reported_at = AT
    till.transmission_pending_count = n
    w.db.commit()


# ── On the till ──────────────────────────────────────────────────────────────


def test_a_till_with_open_card_sales_cannot_be_set_to_none(w):
    till = w.tills[0]
    shift = _card_sales(w, till, 3)
    w.doc(till, shift, "20.00", method="cash")  # cash never counts
    _untransmitted(w, till, 2)
    _unresolved(w, till)
    detail = _refused(_patch_machine, w, till, paymentIntegration="none")
    assert detail["tills"] == [{
        "machineId": str(till.id), "name": "Till 1", "posNumber": "1",
        "cardSales": 3, "untransmitted": 2, "unresolved": 1,
    }]
    assert detail["msg"] == f"בקופה 1 יש 3 עסקאות אשראי שלא נסגרו ב-Z (2 לא שודרו, 1 לא מוכרעת). {TAIL}"
    # Nothing was written.
    assert not (till.settings or {}).get("paymentIntegration")


@pytest.mark.parametrize("what", ["sales", "untransmitted", "unresolved"])
def test_each_kind_of_open_card_alone_holds_it_back(w, what):
    till = w.tills[0]
    if what == "sales":
        _card_sales(w, till, 1)
        line = "בקופה 1 יש עסקת אשראי אחת שלא נסגרה ב-Z"
    elif what == "untransmitted":
        _untransmitted(w, till, 1)
        line = "בקופה 1 יש עסקת אשראי אחת שלא שודרה"
    else:
        _unresolved(w, till)
        line = "בקופה 1 יש תשלום אשראי אחד לא מוכרע"
    assert _refused(_patch_machine, w, till, paymentIntegration="none")["msg"] == f"{line}. {TAIL}"


def test_after_transmission_and_z_the_till_moves(w):
    till = w.tills[0]
    shift = _card_sales(w, till, 2)
    _untransmitted(w, till, 2)
    _refused(_patch_machine, w, till, paymentIntegration="none")
    # Transmitted, closed and taken by a Z: nothing open.
    _untransmitted(w, till, 0)
    shift.status = ShiftStatus.CLOSED
    shift.closed_at = AT
    report = ZReport(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=till.shop_id, machine_id=till.id,
                     origin="till", business_date=TODAY, closed_at=AT)
    w.db.add(report)
    w.db.flush()
    shift.z_report_id = report.id
    w.db.commit()
    _patch_machine(w, till, paymentIntegration="none")
    assert till.settings["paymentIntegration"] == "none"


# ── The clean case ───────────────────────────────────────────────────────────


def test_a_till_with_nothing_open_moves_as_usual(w):
    till, other = w.tills
    # Cash only, and card sales already in a Z: nothing open.
    cash = w.shift(till, 1, status=ShiftStatus.OPEN)
    w.doc(till, cash, "30.00", method="cash")
    w.db.commit()
    _card_sales(w, other, 4, z=True)
    _patch_machine(w, till, paymentIntegration="none")
    _patch_machine(w, other, paymentIntegration="none")
    assert till.settings["paymentIntegration"] == other.settings["paymentIntegration"] == "none"
    # And back, whatever is open: only the move TO "ללא אשראי" is guarded.
    w.doc(till, cash, "50.00", method="card")
    w.db.commit()
    _patch_machine(w, till, paymentIntegration="auto")
    assert "paymentIntegration" not in till.settings


def test_a_till_already_on_none_saves_its_form_again(w):
    till = w.tills[0]
    till.settings = {"paymentIntegration": "none"}
    w.db.commit()
    _card_sales(w, till, 2)  # from before the rule, or a race
    out = _patch_machine(w, till, paymentIntegration="none", payCashEnabled=True)
    assert out.settings["paymentIntegration"] == "none"


def test_other_settings_are_never_held_back(w):
    till = w.tills[0]
    _card_sales(w, till, 2)
    _patch_machine(w, till, payCashEnabled=True)
    _patch_machine(w, till, paymentIntegration="zcredit")
    assert till.settings["paymentIntegration"] == "zcredit"


# ── From a level above ───────────────────────────────────────────────────────


def test_a_shop_save_lists_only_the_tills_it_would_move_with_open_card(w):
    open_till, clean_till = w.tills
    _card_sales(w, open_till, 12)
    _untransmitted(w, open_till, 2)
    _unresolved(w, open_till)
    # A third till of the shop has card sales but keeps its own type: the save does not move it.
    third = POSMachine(
        id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, distributor_id=w.admin.id, name="Till 3",
        machine_code="M-9", pos_number="3", is_active=True, pairing_status=open_till.pairing_status,
        settings={"paymentIntegration": "agamento"},
    )
    w.db.add(third)
    w.db.commit()
    _card_sales(w, third, 5)
    detail = _refused(_patch_shop, w, paymentIntegration="none")
    assert [t["machineId"] for t in detail["tills"]] == [str(open_till.id)]
    assert detail["msg"] == f"בקופה 1 יש 12 עסקאות אשראי שלא נסגרו ב-Z (2 לא שודרו, 1 לא מוכרעת). {TAIL}"
    assert not (w.shop.settings or {}).get("paymentIntegration")
    assert not (clean_till.settings or {}).get("paymentIntegration")


def test_a_company_save_names_every_till_that_holds_it_back(w):
    till_1 = w.tills[0]
    _card_sales(w, till_1, 1)
    _unresolved(w, w.other_till)  # North 1, in the company's other shop
    detail = _refused(_patch_company, w, paymentIntegration="none")
    assert {t["machineId"]: (t["cardSales"], t["unresolved"]) for t in detail["tills"]} == {
        str(till_1.id): (1, 0), str(w.other_till.id): (0, 1),
    }
    assert detail["msg"].endswith(f". {TAIL}")
    assert "בקופה 1 יש עסקת אשראי אחת שלא נסגרה ב-Z" in detail["msg"]
    assert "בקופה 3 יש תשלום אשראי אחד לא מוכרע" in detail["msg"]


def test_a_shop_save_with_its_open_till_set_apart_goes_through(w):
    open_till, clean_till = w.tills
    _card_sales(w, open_till, 2)
    _patch_machine(w, open_till, paymentIntegration="agamento")
    _patch_shop(w, paymentIntegration="none")
    assert w.shop.settings["paymentIntegration"] == "none"
    # Then the open till itself: refused until its Z.
    _refused(_patch_machine, w, open_till, paymentIntegration="auto")


# ── The words ────────────────────────────────────────────────────────────────


def test_the_lines_read_as_the_spec():
    till = type("M", (), {"pos_number": "3", "name": "Till 3", "id": uuid.uuid4()})()
    assert PI.open_card_line_he(PI.OpenCard(till, card_sales=12, untransmitted=2, unresolved=1)) == (
        "בקופה 3 יש 12 עסקאות אשראי שלא נסגרו ב-Z (2 לא שודרו, 1 לא מוכרעת)"
    )
    assert PI.open_card_line_he(PI.OpenCard(till, card_sales=1, untransmitted=1, unresolved=2)) == (
        "בקופה 3 יש עסקת אשראי אחת שלא נסגרה ב-Z (1 לא שודרה, 2 לא מוכרעות)"
    )
    assert PI.open_card_line_he(PI.OpenCard(till, untransmitted=3, unresolved=1)) == (
        "בקופה 3 יש 3 עסקאות אשראי שלא שודרו, תשלום אשראי אחד לא מוכרע"
    )
    nameless = type("M", (), {"pos_number": None, "name": "טאבלט", "id": uuid.uuid4()})()
    assert PI.open_card_line_he(PI.OpenCard(nameless, card_sales=2)) == "בטאבלט יש 2 עסקאות אשראי שלא נסגרו ב-Z"
    assert not PI.OpenCard(till).any
