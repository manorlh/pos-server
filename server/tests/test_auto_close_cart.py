"""
"סגירת משמרת אוטומטית גם עם עגלה פתוחה" (P:/specs/auto-close-open-cart.md, app/services/auto_close_cart.py):
the four till parameters beside `autoCloseShiftAt`, their values, the till's events taken, the exceptions
they make (a basket held or discarded, held sales cancelled) with their summary line, the phone alert's
routing to the manager, and the journal line that makes none.

Runs on the world of tests/test_shop_areas.py (in-memory SQLite).
"""
from __future__ import annotations

import uuid
from decimal import Decimal

import pytest

from app.models.audit_exception import TillEvent
from app.schemas.audit_exception import TillEventIn
from app.services import auto_close_cart as A
from app.services import exceptions as svc
from app.services import till_parameters as TP
from app.services.exception_alerts import catalog
from app.services.exception_alerts import push
from shift_world import NOW
from test_exceptions import event, found, rule
from test_shop_areas import w  # noqa: F401

CART = {
    "action": "discarded", "at": "23:30", "shiftSequence": 41, "itemCount": 3,
    "items": [{"name": "קפה", "quantity": 2}, {"name": "מאפה", "quantity": 1}],
    "total": "87.00", "paymentAbandoned": False,
}


# ── The parameters ───────────────────────────────────────────────────────────


def test_the_four_parameters_sit_next_to_autoCloseShiftAt_with_their_Hebrew():
    keys = [p.key for p in TP.BUILTIN_PARAMETERS]
    at = keys.index("autoCloseShiftAt")
    assert keys[at + 1:at + 5] == [A.OPEN_CART_KEY, A.HELD_SALES_KEY, A.MAX_WAIT_KEY, A.IGNORE_TABLES_KEY]
    by_key = {p.key: p for p in TP.BUILTIN_PARAMETERS}
    cart = by_key[A.OPEN_CART_KEY]
    assert (cart.value_type, cart.default_value, cart.enum_options) == ("enum", "wait", ("wait", "hold", "discard"))
    assert cart.enum_labels == {"wait": "לחכות (ברירת מחדל)", "hold": "להשהות את העגלה ולסגור", "discard": "לבטל את העגלה ולסגור"}
    assert "הושהתה בסגירה אוטומטית" in cart.description and "החזר הזמנה" in cart.description
    held = by_key[A.HELD_SALES_KEY]
    assert (held.value_type, held.default_value, held.enum_options) == ("enum", "keep", ("keep", "cancel"))
    wait = by_key[A.MAX_WAIT_KEY]
    assert (wait.value_type, wait.default_value) == ("integer", 10)
    assert "לא מוכרע" in wait.description
    tables = by_key[A.IGNORE_TABLES_KEY]
    assert (tables.value_type, tables.default_value) == ("boolean", False)
    assert "חסימת סגירת יום עם שולחנות פתוחים" in tables.description
    for p in (cart, held, wait, tables):
        assert p.label.startswith("סגירת משמרת אוטומטית — ")
        assert "ניתן לקבוע לפי חברה, סניף, נקודת מכירה או קופה" in p.description
    # The time's own words point at them.
    assert "סגירת משמרת אוטומטית — …" in by_key["autoCloseShiftAt"].description


def test_only_the_codes_the_till_knows_and_the_minutes_0_to_240():
    assert TP.validate_keyed_value(A.OPEN_CART_KEY, "hold") == "hold"
    assert TP.validate_keyed_value(A.HELD_SALES_KEY, "cancel") == "cancel"
    assert TP.validate_keyed_value(A.MAX_WAIT_KEY, 0) == 0
    assert TP.validate_keyed_value(A.MAX_WAIT_KEY, 240) == 240
    for key, bad in ((A.OPEN_CART_KEY, "drop"), (A.HELD_SALES_KEY, "keep_all"), (A.MAX_WAIT_KEY, 241),
                     (A.MAX_WAIT_KEY, -1), (A.MAX_WAIT_KEY, True)):
        with pytest.raises(TP.TillParameterValueError):
            TP.validate_keyed_value(key, bad)
    assert TP.validate_keyed_value(A.OPEN_CART_KEY, None) is None


# ── The till's events and their exceptions ───────────────────────────────────


def test_the_tills_events_are_taken():
    for kind in A.TILL_EVENTS:
        assert kind in svc.TILL_EVENT_TYPES
        body = TillEventIn.model_validate({"id": str(uuid.uuid4()), "type": kind, "occurredAt": NOW.isoformat()})
        assert body.type == kind
        assert len(kind) <= 32


def test_a_discarded_basket_is_an_exception_with_its_items_and_amount(w):
    till = w.tills[0]
    event(w, till, A.CART_DISCARDED, amount=Decimal("87.00"), details=CART)
    rows = found(w, A.CART_DISCARDED)
    assert len(rows) == 1
    row = rows[0]
    assert row.amount == Decimal("87.00")
    assert row.machine_id == till.id
    assert row.details["items"][0]["name"] == "קפה"
    assert row.details["summary"] == "עגלה בוטלה בסגירה אוטומטית ב-23:30 — 3 פריטים, 87 ₪"
    assert w.db.query(TillEvent).filter(TillEvent.event_type == A.CART_DISCARDED).count() == 1


def test_a_held_basket_is_an_exception_too_said_as_held(w):
    details = dict(CART, action="held", heldSaleId="h-1", label=A.PARK_LABEL, paymentAbandoned=True, total="87.50")
    event(w, w.tills[0], A.CART_HELD, amount=Decimal("87.50"), details=details)
    row = found(w, A.CART_HELD)[0]
    assert row.details["summary"] == "עגלה הושהתה בסגירה אוטומטית ב-23:30 — 3 פריטים, 87.50 ₪ · מסך התשלום בוטל (לא נגבה דבר)"
    assert row.severity == "low"


def test_cancelled_held_sales_are_one_exception(w):
    details = {"at": "23:30", "count": 2, "total": "42.00", "heldSales": [
        {"heldSaleId": "h-1", "cashier": "Dana", "itemCount": 1, "total": "12.00", "items": [{"name": "קפה", "quantity": 1}]},
        {"heldSaleId": "h-2", "cashier": "Dana", "itemCount": 2, "total": "30.00", "items": []},
    ]}
    event(w, w.tills[0], A.HELD_CANCELLED, amount=Decimal("42.00"), details=details, user=None)
    row = found(w, A.HELD_CANCELLED)[0]
    assert row.details["summary"] == "בוטלו 2 עסקאות מושהות בסגירה אוטומטית ב-23:30 — 42 ₪"
    assert row.amount == Decimal("42.00")


def test_the_journal_line_is_recorded_and_makes_no_exception(w):
    details = {"at": "23:30", "line": "נסגרה אוטומטית ב-23:30", "cart": None, "lines": ["נסגרה אוטומטית ב-23:30"]}
    event(w, w.tills[0], A.SHIFT_AUTO_CLOSED, details=details, user=None)
    assert w.db.query(TillEvent).filter(TillEvent.event_type == A.SHIFT_AUTO_CLOSED).count() == 1
    assert not [r for r in found(w) if r.exception_type.startswith("auto_close")]


def test_sent_again_is_one_exception(w):
    eid = uuid.uuid4()
    event(w, w.tills[0], A.CART_DISCARDED, amount=Decimal("87.00"), details=CART, event_id=eid)
    event(w, w.tills[0], A.CART_DISCARDED, amount=Decimal("87.00"), details=CART, event_id=eid)
    assert len(found(w, A.CART_DISCARDED)) == 1


def test_switched_off_at_a_level_records_the_event_and_no_exception(w):
    rule(w, "shop", w.shop.id, A.CART_DISCARDED, enabled=False)
    event(w, w.tills[0], A.CART_DISCARDED, amount=Decimal("87.00"), details=CART)
    assert found(w, A.CART_DISCARDED) == []
    assert w.db.query(TillEvent).filter(TillEvent.event_type == A.CART_DISCARDED).count() == 1


# ── The manager's alert ──────────────────────────────────────────────────────


def test_the_manager_is_alerted_by_default():
    for kind in A.EXCEPTION_EVENTS:
        spec = svc.RULES_BY_TYPE[kind]
        assert spec.default_enabled and spec.push_default and not spec.push_only
        assert spec.source == "till_event"
        # The log knows it, and the phone alerts route it to "עובדים ונוכחות".
        assert catalog.label_of(kind) != kind
        assert push.CATEGORY_BY_KEY["staff_actions"].kinds.count(kind) == 1
    assert catalog.label_of(A.CART_DISCARDED) == "עגלה בוטלה בסגירה אוטומטית"
    assert catalog.label_of(A.CART_HELD) == "עגלה הושהתה בסגירה אוטומטית"
    # The journal line alerts nobody.
    assert A.SHIFT_AUTO_CLOSED not in svc.RULES_BY_TYPE


def test_the_summary_reads_well_with_little_to_go_on():
    assert A.summary(A.CART_DISCARDED, {}) == "עגלה בוטלה בסגירה אוטומטית"
    assert A.summary(A.HELD_CANCELLED, {"count": 1}) == "בוטלו 1 עסקאות מושהות בסגירה אוטומטית"
    assert A.summary("other", {}) == ""
