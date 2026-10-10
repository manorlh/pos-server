"""
OTH ("על חשבון הבית") and the club discount ("הנחת מועדון"): till parameters, storage on
the documents, the "oth" exception, and the dashboard's report.

What each class pins:

* **Parameters** — the six built-ins exist, off by default (nothing changes for a shop
  that sets nothing), and a till gets their values like any other parameter.
* **Storage** — an OTH line's reason, giver and approver, and a document's basket
  discount with its rate and kind, are stored as sent; a re-push replaces them; an
  unknown kind is stored as `manual`, and over-long text is cut, never refused.
* **Exceptions** — one "oth" per OTH line, at its list price, with the reason, who gave
  it and who approved it (named); neither an OTH line nor the club rate is a cashier's
  "discount" exception, while a manual discount beside them still is; detecting again
  adds nothing.
* **Report** — OTH by item, employee, reason, till and day; the club discount by till and
  day, beside the manual basket discounts; credit notes and other shops left out.

Runs on the world of tests/test_shop_areas.py.
"""
from __future__ import annotations

import uuid
from datetime import timedelta
from decimal import Decimal

from app.models.audit_exception import AuditException
from app.models.pos_user import PosUser
from app.models.shift import ShiftStatus
from app.models.transaction import Transaction
from app.models.transaction_item import TransactionItem
from app.schemas.transaction import TransactionIn
from app.services import exceptions as E
from app.services.discounts_report import build_discounts_report
from app.services.reports import resolve_report_window
from app.services.till_parameters import ensure_builtin_parameters, till_parameters_for_machine
from app.services.transactions import upsert_transactions
from shift_world import NOW, TODAY
from test_shop_areas import w  # noqa: F401

OTH_KEYS = {
    "othEnabled": False,
    "othRequiresManager": True,
    "othReasons": "לקוח קבוע,פיצוי,טעימה,עובד,אחר",
    "clubButtonEnabled": False,
    "clubDiscountPercent": 10,
    "clubRequiresCustomer": False,
}


def _people(w):
    waiter = PosUser(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, username="dana",
                     first_name="דנה", last_name="כהן", pin_hash="x")
    manager = PosUser(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, username="avi",
                      first_name="אבי", last_name="לוי", pin_hash="x")
    w.db.add_all([waiter, manager])
    w.db.commit()
    return waiter, manager


def _line(name, qty, price, **over):
    gross = Decimal(price) * Decimal(qty)
    line = {
        "id": str(uuid.uuid4()), "productName": name, "quantity": qty, "unitPrice": price,
        "totalPrice": str(gross),
    }
    line.update(over)
    return line


def _oth_line(name, qty, price, reason, by=None, approved=None, **over):
    gross = str(Decimal(price) * Decimal(qty))
    return _line(name, qty, price, discount=gross, discountType="fixed", lineDiscount=f"-{gross}",
                 othReason=reason, othBy=by, othApprovedBy=approved, **over)


def _sale(shift, lines, *, number, discount="0", collected=None, cashier=None, created=None, **over):
    total = sum(Decimal(l["totalPrice"]) for l in lines)
    paid = collected if collected is not None else str(total - Decimal(discount))
    body = {
        "id": str(uuid.uuid4()), "transactionNumber": number, "status": "completed", "documentType": 320,
        "totalAmount": str(total), "documentDiscount": discount if Decimal(discount) else None,
        "paymentMethod": "cash", "cashierId": cashier,
        "payments": [{"id": str(uuid.uuid4()), "method": "cash", "amount": paid}],
        "createdAt": (created or NOW).isoformat(), "updatedAt": (created or NOW).isoformat(),
        "shiftId": str(shift.id), "businessDate": str(TODAY),
        "items": lines,
    }
    body.update(over)
    return TransactionIn.model_validate(body)


def _push(w, till, *docs):
    out = upsert_transactions(w.db, till, list(docs))
    w.db.commit()
    return [r.status for r in out]


def _window(w):
    return resolve_report_window(w.db, w.tenant.id, from_date=TODAY - timedelta(days=1), to_date=TODAY + timedelta(days=1))


class TestParameters:
    def test_built_in_and_off_by_default(self, w):
        created = ensure_builtin_parameters(w.db)
        w.db.commit()
        assert set(OTH_KEYS) <= set(created)
        got = till_parameters_for_machine(w.db, w.tills[0]).parameters
        assert {k: got[k] for k in OTH_KEYS} == OTH_KEYS
        # Created once: a second run leaves them as a super admin last saved them.
        assert not set(OTH_KEYS) & set(ensure_builtin_parameters(w.db))


class TestStorage:
    def test_oth_and_club_are_stored_and_replaced(self, w):
        waiter, manager = _people(w)
        till = w.tills[0]
        shift = w.shift(till, 1, status=ShiftStatus.OPEN)
        doc = _sale(
            shift,
            [_line("burger", 1, "60.00"), _oth_line("beer", 1, "28.00", "לקוח קבוע", str(waiter.id), str(manager.id))],
            number="7001", discount="34.00",
            basketDiscount="6.00", basketDiscountPercent="10", basketDiscountKind="club",
        )
        assert _push(w, till, doc) == ["accepted"]
        tx = w.db.query(Transaction).one()
        assert (tx.basket_discount, tx.basket_discount_percent, tx.basket_discount_kind) == (
            Decimal("6.00"), Decimal("10.00"), "club",
        )
        oth = w.db.query(TransactionItem).filter(TransactionItem.oth_reason.isnot(None)).one()
        assert (oth.product_name, oth.discount, oth.oth_reason, oth.oth_by, oth.oth_approved_by) == (
            "beer", Decimal("28.00"), "לקוח קבוע", str(waiter.id), str(manager.id),
        )
        # A re-push is the whole document: the club discount taken off, the OTH undone.
        again = _sale(shift, [_line("burger", 1, "60.00"), _line("beer", 1, "28.00")], number="7001", id=str(doc.id))
        _push(w, till, again)  # answered "duplicate", and replaced all the same
        w.db.expire_all()
        tx = w.db.query(Transaction).one()
        assert tx.basket_discount_kind is None and tx.basket_discount is None
        assert w.db.query(TransactionItem).filter(TransactionItem.oth_reason.isnot(None)).count() == 0

    def test_the_document_copy_names_them(self, w):
        from app.services.print_documents import build_invoice_copy

        till = w.tills[0]
        shift = w.shift(till, 1, status=ShiftStatus.OPEN)
        _push(w, till, _sale(
            shift, [_line("burger", 1, "60.00"), _oth_line("beer", 1, "28.00", "פיצוי")],
            number="7010", discount="34.00",
            basketDiscount="6.00", basketDiscountPercent="10", basketDiscountKind="club",
        ))
        printed = build_invoice_copy(w.db, w.db.query(Transaction).one()).model_dump_json()
        assert "OTH — פיצוי" in printed and "הנחת מועדון 10%" in printed

    def test_an_unknown_kind_is_manual_and_long_text_is_cut(self):
        shift = type("S", (), {"id": uuid.uuid4()})()
        doc = _sale(
            shift, [_oth_line("tea", 1, "9.00", "ר" * 300, by="x" * 300)],
            number="1", basketDiscount="1.00", basketDiscountKind="VIP",
        )
        assert doc.basket_discount_kind == "manual"
        assert len(doc.items[0].oth_reason) == 100 and len(doc.items[0].oth_by) == 100
        assert _sale(shift, [_line("tea", 1, "9.00")], number="2", basketDiscountKind="Club").basket_discount_kind == "club"


class TestExceptions:
    def _rules(self, **on):
        return {
            kind: E.EffectiveRule(type=kind, enabled=True, params={"minPercent": 0, "minAmount": 0})
            for kind in ("discount", "oth", *on)
        }

    def test_one_per_oth_line_at_list_price_and_not_a_discount(self, w):
        waiter, manager = _people(w)
        till = w.tills[0]
        shift = w.shift(till, 1, status=ShiftStatus.OPEN)
        _push(w, till, _sale(
            shift,
            [
                _line("burger", 1, "60.00"),
                _oth_line("beer", 2, "28.00", "פיצוי", str(waiter.id), str(manager.id)),
                _oth_line("cake", 1, "35.00", "טעימה", str(waiter.id)),
            ],
            number="7002", discount="91.00", cashier="cashier-1",
        ))
        tx = w.db.query(Transaction).one()
        found = E.detect_transaction(tx, self._rules())
        assert not [f for f in found if f.type == "discount"]
        oth = sorted((f for f in found if f.type == "oth"), key=lambda f: -f.amount)
        assert [(f.amount, f.details["productName"], f.details["reason"]) for f in oth] == [
            (Decimal("56.00"), "beer", "פיצוי"), (Decimal("35.00"), "cake", "טעימה"),
        ]
        assert oth[0].pos_user_id == str(waiter.id) and oth[0].details["approvedBy"] == str(manager.id)
        assert oth[1].details["approvedBy"] is None

        # Recorded through the detector: the approver named, and once only.
        E.detect_transactions(w.db, [tx.id])
        w.db.commit()
        E.detect_transactions(w.db, [tx.id])
        w.db.commit()
        rows = w.db.query(AuditException).filter(AuditException.exception_type == "oth").all()
        assert len(rows) == 2
        beer = next(r for r in rows if r.details["productName"] == "beer")
        assert beer.details["approverName"] == "אבי לוי" and beer.pos_user_name == "דנה כהן"
        assert beer.amount == Decimal("56.00") and beer.status == "new"

    def test_the_club_rate_is_not_a_discount_but_a_manual_one_beside_it_is(self, w):
        till = w.tills[0]
        shift = w.shift(till, 1, status=ShiftStatus.OPEN)
        _push(w, till, _sale(
            shift, [_line("burger", 1, "100.00")], number="7003", discount="10.00",
            basketDiscount="10.00", basketDiscountPercent="10", basketDiscountKind="club",
        ))
        tx = w.db.query(Transaction).one()
        assert not [f for f in E.detect_transaction(tx, self._rules()) if f.type == "discount"]
        # A cashier's own line discount on top still is one.
        _push(w, till, _sale(
            shift, [_line("burger", 1, "100.00", discount="5.00", discountType="fixed", lineDiscount="-5.00")],
            number="7003", id=str(tx.id), discount="14.50",
            basketDiscount="9.50", basketDiscountPercent="10", basketDiscountKind="club",
        ))
        w.db.expire_all()
        tx = w.db.query(Transaction).one()
        hits = [f for f in E.detect_transaction(tx, self._rules()) if f.type == "discount"]
        assert [h.amount for h in hits] == [Decimal("5.00")]

    def test_a_manual_basket_discount_still_is_one(self, w):
        till = w.tills[0]
        shift = w.shift(till, 1, status=ShiftStatus.OPEN)
        _push(w, till, _sale(
            shift, [_line("burger", 1, "100.00")], number="7004", discount="10.00",
            basketDiscount="10.00", basketDiscountPercent="10", basketDiscountKind="manual",
        ))
        tx = w.db.query(Transaction).one()
        hits = [f for f in E.detect_transaction(tx, self._rules()) if f.type == "discount"]
        assert [h.amount for h in hits] == [Decimal("10.00")]

    def test_switched_off_and_a_default(self, w):
        rules = E.rules_for_machine(w.db, w.tills[0])
        assert rules["oth"].enabled and rules["oth"].params == {}
        till = w.tills[0]
        shift = w.shift(till, 1, status=ShiftStatus.OPEN)
        _push(w, till, _sale(shift, [_oth_line("beer", 1, "28.00", "עובד")], number="7005", discount="28.00", collected="0.00"))
        tx = w.db.query(Transaction).one()
        off = {"oth": E.EffectiveRule(type="oth", enabled=False, params={})}
        assert E.detect_transaction(tx, off) == []


class TestReport:
    def test_oth_and_club_by_everything(self, w):
        waiter, manager = _people(w)
        t1, t2 = w.tills
        s1 = w.shift(t1, 1, status=ShiftStatus.OPEN)
        s2 = w.shift(t2, 1, status=ShiftStatus.OPEN)
        _push(w, t1, _sale(
            s1,
            [_line("burger", 1, "60.00"), _oth_line("beer", 2, "28.00", "פיצוי", str(waiter.id), str(manager.id))],
            number="8001", discount="62.00",
            basketDiscount="6.00", basketDiscountPercent="10", basketDiscountKind="club",
        ))
        _push(w, t2, _sale(
            s2, [_oth_line("beer", 1, "28.00", "לקוח קבוע", None, None)], number="8002",
            discount="28.00", collected="0.00", cashier=str(manager.id),
        ))
        _push(w, t2, _sale(
            s2, [_line("salad", 1, "50.00")], number="8003", discount="5.00",
            basketDiscount="5.00", basketDiscountKind="manual",
        ))
        # A credit note is left out, OTH line or not.
        _push(w, t2, _sale(
            s2, [_oth_line("beer", 1, "28.00", "פיצוי")], number="8004", documentType=330,
            discount="28.00", collected="0.00",
        ))
        # Another shop's, seen by its own people only.
        north = w.shift(w.other_till, 1, status=ShiftStatus.OPEN)
        _push(w, w.other_till, _sale(
            north, [_line("burger", 1, "60.00")], number="9001", discount="6.00",
            basketDiscount="6.00", basketDiscountKind="club",
        ))

        out = build_discounts_report(w.db, w.admin, w.tenant.id, _window(w), shop_id=w.shop.id)
        oth = out["oth"]
        assert oth["totals"] == {"count": 2, "quantity": 3.0, "value": 84.0, "documents": 2}
        assert [(r["name"], r["count"], r["quantity"], r["value"]) for r in oth["byItem"]] == [("beer", 2, 3.0, 84.0)]
        assert [(r["name"], r["value"]) for r in oth["byEmployee"]] == [("דנה כהן", 56.0), ("אבי לוי", 28.0)]
        assert [(r["reason"], r["count"]) for r in oth["byReason"]] == [("פיצוי", 1), ("לקוח קבוע", 1)]
        assert [(r["name"], r["value"]) for r in oth["byTill"]] == [("Till 1", 56.0), ("Till 2", 28.0)]
        assert [(r["date"], r["count"]) for r in oth["byDay"]] == [(TODAY.isoformat(), 2)]

        club = out["club"]
        assert club["totals"] == {"count": 1, "amount": 6.0}
        assert [(r["name"], r["shopName"], r["amount"]) for r in club["byTill"]] == [("Till 1", "Center", 6.0)]
        assert [r["date"] for r in club["byDay"]] == [TODAY.isoformat()]
        assert out["basketByKind"] == [
            {"kind": "club", "count": 1, "amount": 6.0}, {"kind": "manual", "count": 1, "amount": 5.0},
        ]

        # The whole organization: the other shop's club sale too.
        everything = build_discounts_report(w.db, w.admin, w.tenant.id, _window(w))
        assert everything["club"]["totals"] == {"count": 2, "amount": 12.0}
        # A manager of the other shop sees only it.
        assert build_discounts_report(w.db, w.north_manager, w.tenant.id, _window(w))["oth"]["totals"]["count"] == 0

    def test_through_the_router(self, w):
        from app.routers import promotions as R

        out = R.get_discounts_report(
            from_date=TODAY, to_date=TODAY, from_hour=None, to_hour=None, tz=None, shop_id=None, machine_id=None,
            current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
        )
        assert out["oth"]["totals"]["count"] == 0 and out["club"]["byTill"] == [] and out["basketByKind"] == []
