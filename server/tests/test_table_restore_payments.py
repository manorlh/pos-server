"""
"שחזור שולחן עם התשלומים שלו, וזיכוי או ביטול תשלומים בתוך השולחן" — the cloud's part
(P:/specs/table-restore-payments.md, app/services/table_restore.py).

What each class pins, and how it could look fine while doing damage:

* **Parameters** — the eight till parameters exist with the owner's defaults, resolve till → area →
  shop → company like every till parameter, refuse a value the till cannot parse (whatever route
  writes it), and are edited per level on the tables page by the same people as the drawer's.
* **Permissions** — the three reversal permissions in the till roles' catalogue: a manager alone, a
  shift supervisor alone up to ₪500, a cashier with approval, a waiter never; a legacy cashier asks.
* **Exceptions** — `payment_reversed` and `table_restored` logged from the till's events with who
  asked, who approved / performed, the tender, the amount, the table and the documents; once per
  credit note / per restored order (the cloud's claim and the till's event are one); in their own
  phone-alert type, opt in.
* **The Z** — a table's card payment credited and paid again in cash nets per tender (card 0, cash
  180) with the totals untouched by the new line, which counts the reversals of the Z's documents.
* **Credit inside an open table** — a credit note linked to a payment's invoice of a table still open
  is stored, settles its original and is recorded with the table like any part payment.

Runs on the in-memory SQLite world of tests/shift_world.py (the tables world of tests/test_tables.py).
"""
from __future__ import annotations

import json
import uuid
from datetime import timedelta
from decimal import Decimal

import pytest
from fastapi import BackgroundTasks, HTTPException, Response

from app.models.audit_exception import AuditException, TillEvent
from app.models.shift import ShiftStatus
from app.models.shop_area import ShopArea
from app.models.tables import TableOrder
from app.models.transaction import Transaction, TransactionStatus
from app.models.user import User, UserRole
from app.routers import exceptions as EXR
from app.routers import table_restore as RR
from app.routers import tables as R
from app.routers import z_reports as ZRR
from app.schemas.audit_exception import TillEventIn
from app.schemas.tables import TablePartPayIn, TableRestoreIn
from app.services import table_restore as TR
from app.services import tables as T
from app.services import till_parameters as TPAR
from app.services import till_permissions as TP
from app.services.exception_alerts import catalog as CAT
from app.services.exception_alerts import push as PUSH
from app.services.z_builder import build_z
from app.services.z_print import build_print_document
from shift_world import NOW
from test_tables import cart, enter, pay, save, w  # noqa: F401

A, P, D = TP.ALLOW, TP.APPROVAL, TP.DENY

DEFAULTS = {
    "restoredTablePrefix": "ש-",
    "restoreWindow": "same_z",
    "printCreditNote": "ask",
    "reverseMethods": "cash,card,voucher,external",
    "cardVoidWhenUntransmitted": True,
    "reverseAllButton": True,
    "billTipBase": "balance",
    "billShowPaidItems": False,
}


def _user(w, name, role, shop=None):
    u = User(
        id=uuid.uuid4(), role=role, tenant_id=w.tenant.id, company_id=w.company.id,
        shop_id=shop.id if shop is not None else None, email=f"{name}@x", username=name,
    )
    w.db.add(u)
    w.db.flush()
    return u


def ctx(w, user=None):
    return dict(current_user=user or w.admin, active_tenant_id=w.tenant.id, db=w.db)


def refused(fn, *args, **kwargs) -> HTTPException:
    with pytest.raises(HTTPException) as e:
        fn(*args, **kwargs)
    return e.value


def put(w, scope_type, scope_id, values, user=None):
    body = RR.TableRestoreParamsIn(scopeType=scope_type, scopeId=scope_id, values=values)
    return RR.put_table_restore_params(str(w.company.id), body, **ctx(w, user))


def params_of(w, till):
    return TPAR.till_parameters_for_machine(w.db, till).parameters


# ── Parameters (§3, §5) ───────────────────────────────────────────────────────


class TestParameters:
    def test_the_eight_are_built_in_with_the_owners_defaults_and_a_till_gets_them(self, w):
        specs = {p.key: p for p in TPAR.BUILTIN_PARAMETERS}
        for key, default in DEFAULTS.items():
            assert key in specs, key
            assert specs[key].default_value == default, key
            assert specs[key].label and specs[key].description, key
        assert TR.LEVEL_KEYS == tuple(DEFAULTS)
        got = params_of(w, w.a)
        assert {k: got[k] for k in DEFAULTS} == DEFAULTS
        # The codes the till parses, with the Hebrew the dashboard shows.
        assert specs["printCreditNote"].enum_options == ("ask", "always", "never")
        assert specs["billTipBase"].enum_options == ("balance", "total")
        assert TPAR.enum_labels("billTipBase") == {"balance": "לפי היתרה לתשלום", "total": "לפי הסכום הכולל"}
        assert TPAR.enum_labels("printCreditNote")["ask"].startswith("לשאול")

    def test_levels_till_area_shop_company(self, w):
        area = ShopArea(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, name="בר")
        w.db.add(area)
        w.db.flush()
        w.b.area_id = area.id
        w.db.commit()
        put(w, "company", w.company.id, {"restoreWindow": "hours:6", "billTipBase": "total"})
        put(w, "shop", w.shop.id, {"restoreWindow": "same_shift", "restoredTablePrefix": "R-"})
        put(w, "area", area.id, {"reverseMethods": "card,cash"})
        view = put(w, "machine", w.a.id, {"billShowPaidItems": True, "restoreWindow": "any"})
        assert view["own"] == {"billShowPaidItems": True, "restoreWindow": "any"}
        assert view["inherited"]["restoreWindow"] == "same_shift" and view["inherited"]["billTipBase"] == "total"
        a, b, north = params_of(w, w.a), params_of(w, w.b), params_of(w, w.other_till)
        assert (a["restoreWindow"], a["billShowPaidItems"], a["restoredTablePrefix"]) == ("any", True, "R-")
        assert a["reverseMethods"] == "cash,card,voucher,external"
        # The area's till: its point of sale's methods (normalised to the catalogue's order), the shop's window.
        assert (b["reverseMethods"], b["restoreWindow"], b["billShowPaidItems"]) == ("cash,card", "same_shift", False)
        # Another shop of the company: the company's.
        assert (north["restoreWindow"], north["billTipBase"], north["restoredTablePrefix"]) == ("hours:6", "total", "ש-")
        # Cleared: inherits again.
        put(w, "machine", w.a.id, {"restoreWindow": None})
        assert params_of(w, w.a)["restoreWindow"] == "same_shift"

    @pytest.mark.parametrize("key,value,stored", [
        ("restoreWindow", "same_z", "same_z"),
        ("restoreWindow", "hours:720", "hours:720"),
        ("restoreWindow", " hours:6 ", "hours:6"),
        ("reverseMethods", "external, CARD", "card,external"),
        ("reverseMethods", "", ""),
        ("restoredTablePrefix", "שחזור-", "שחזור-"),
        ("printCreditNote", "never", "never"),
    ])
    def test_values_the_till_parses(self, key, value, stored):
        assert TPAR.validate_keyed_value(key, value) == stored

    @pytest.mark.parametrize("key,value", [
        ("restoreWindow", "hours:0"),
        ("restoreWindow", "hours:721"),
        ("restoreWindow", "week"),
        ("reverseMethods", "cash,bitcoin"),
        ("reverseMethods", "cash,cash"),
        ("restoredTablePrefix", "   "),
        ("restoredTablePrefix", "x" * 11),
        ("printCreditNote", "sometimes"),
        ("billTipBase", "items"),
    ])
    def test_a_value_the_till_cannot_parse_is_refused(self, w, key, value):
        with pytest.raises(TPAR.TillParameterValueError):
            TPAR.validate_keyed_value(key, value)
        assert refused(put, w, "company", w.company.id, {key: value}).status_code == 422

    def test_who_may_read_and_set_which_level(self, w):
        company_manager = _user(w, "cm", UserRole.COMPANY_MANAGER)
        shop_manager = _user(w, "sm", UserRole.SHOP_MANAGER, shop=w.shop)
        supervisor = _user(w, "sv", UserRole.SHIFT_SUPERVISOR, shop=w.shop)
        put(w, "company", w.company.id, {"reverseAllButton": False}, company_manager)
        # A shop's manager: their shop and below, never the company or another shop.
        view = put(w, "shop", w.shop.id, {"cardVoidWhenUntransmitted": False}, shop_manager)
        assert view["own"] == {"cardVoidWhenUntransmitted": False}
        assert refused(put, w, "company", w.company.id, {"reverseAllButton": True}, shop_manager).status_code == 403
        assert refused(put, w, "shop", w.other_shop.id, {"reverseAllButton": True}, shop_manager).status_code == 403
        # A supervisor reads, read-only.
        got = RR.get_table_restore_params(
            str(w.company.id), scope_type="shop", scope_id=w.shop.id, **ctx(w, supervisor),
        )
        assert got["canEdit"] is False and got["inherited"]["reverseAllButton"] is False
        # The card's restore group (after the staff tables' `staffTableDiscountCheck`, owner-decisions-1410 §1).
        assert [p["key"] for p in got["parameters"] if p["group"] == "restore"] == list(DEFAULTS)
        # Then the map's legend and display (P:/specs/table-map-decor-v3.md §3), a group of their own, the
        # waiters' assignment and the busy table (P:/specs/table-waiter-assignment.md), and last the courses'
        # auto-fire (P:/specs/courses-fire-v2.md §1), a group of its own.
        assert [p["key"] for p in got["parameters"]] == [
            "staffTableDiscountCheck", *DEFAULTS, "mapDecor", "mapLegend", "mapSymbolLabels", "mapSymbolScale",
            "tableAssignmentMode", "tableAssignmentUnassigned", "tableAssignmentOwner", "tableAssignmentReset",
            "tableAssignmentOnClockOut", "tableAssignmentMulti", "tableAssignmentNotify", "tableBusyEntry",
            "tableBusyShowHolder",
            "autoFire", "autoFireMinutesOverride",
        ]
        assert {m["key"] for m in got["methods"]} == {"cash", "card", "voucher", "external"}
        assert refused(put, w, "shop", w.shop.id, {"reverseAllButton": True}, supervisor).status_code == 403
        assert refused(put, w, "company", w.company.id, {"tablesMode": "x"}).status_code == 422
        # Every write is in the parameters' change log.
        from app.models.till_parameter import TillParameterChange

        assert w.db.query(TillParameterChange).count() == 2


# ── Permissions (§4) ──────────────────────────────────────────────────────────


class TestPermissions:
    CODES = ("PAYMENT_REVERSE_CASH", "PAYMENT_REVERSE_CARD", "PAYMENT_REVERSE_OTHER")

    def test_in_the_catalogue_with_their_limits(self):
        for code in self.CODES + ("TABLE_RESTORE",):
            spec = TP.PERMISSIONS_BY_CODE[code]
            assert spec.group == "tables" and spec.label, code
        assert [lim.key for lim in TP.PERMISSIONS_BY_CODE["PAYMENT_REVERSE_CASH"].limits] == ["maxAmount"]
        assert [lim.key for lim in TP.PERMISSIONS_BY_CODE["PAYMENT_REVERSE_CARD"].limits] == ["maxAmount"]
        assert TP.PERMISSIONS_BY_CODE["PAYMENT_REVERSE_OTHER"].limits == ()
        out = {p["code"]: p for p in TP.catalogue_out()["permissions"]}
        assert out["PAYMENT_REVERSE_CARD"]["limits"][0]["unit"] == "amount"

    @pytest.mark.parametrize("code", CODES + ("TABLE_RESTORE",))
    def test_the_owners_defaults(self, code):
        got = tuple(TP.DEFAULTS[k][code] for k in (TP.MANAGER, TP.SUPERVISOR, TP.CASHIER, TP.WAITER))
        assert got == (A, A, P, D)
        assert TP.DEFAULTS[TP.LEGACY_MANAGER][code] == A
        assert TP.DEFAULTS[TP.LEGACY_CASHIER][code] == P

    def test_a_supervisor_reverses_up_to_500_alone_a_manager_any_amount(self):
        sup = TP.effective_permissions(template=TP.SUPERVISOR)
        mgr = TP.effective_permissions(template=TP.MANAGER)
        for code in ("PAYMENT_REVERSE_CASH", "PAYMENT_REVERSE_CARD"):
            assert TP.limit_covers(sup, code, amount=500)
            assert not TP.limit_covers(sup, code, amount=500.01)
            assert TP.limit_covers(mgr, code, amount=5000)
            assert not TP.limit_covers(TP.effective_permissions(template=TP.CASHIER), code, amount=1)
        assert TP.limit_covers(sup, "PAYMENT_REVERSE_OTHER", amount=10_000)

    def test_editable_per_role_and_older_tills_read_roles_as_before(self):
        eff = TP.effective_permissions(
            template=TP.CASHIER, role_states={"PAYMENT_REVERSE_CASH": A},
            role_limits={"PAYMENT_REVERSE_CASH": {"maxAmount": 100}},
        )
        assert TP.limit_covers(eff, "PAYMENT_REVERSE_CASH", amount=100)
        assert not TP.limit_covers(eff, "PAYMENT_REVERSE_CASH", amount=101)
        # Not a senior code: a role does not read as a cashier on an older till for lacking them.
        assert not (TP.TABLE_PAYMENT_REVERSE_CODES & TP.LEGACY_SENIOR_CODES)
        states = dict(TP.DEFAULTS[TP.MANAGER], **{c: D for c in self.CODES})
        assert TP.legacy_role_for(states) == "shop_manager"


# ── Exceptions (§3) ───────────────────────────────────────────────────────────


def till_event(w, till, kind, *, amount=None, details=None, transaction_id=None, user="pu-dana", event_id=None):
    body = TillEventIn(
        id=event_id or uuid.uuid4(), type=kind, occurredAt=NOW, posUserId=user, amount=amount,
        details=details, transactionId=transaction_id,
    )
    return EXR.post_till_event(str(till.id), body, Response(), machine=till, db=w.db)


def found(w, kind):
    return w.db.query(AuditException).filter(AuditException.exception_type == kind).all()


REVERSAL = {
    "orderId": None, "tableNumber": 12, "tableName": "12", "tender": "card", "action": "card_refund",
    "amount": 180, "tip": 10, "originalTransactionNumber": "1001", "creditTransactionNumber": "2001",
    "requestedBy": "דנה", "approvedBy": "מנהלת רותי", "performedBy": "דנה", "approvalStyle": "approve",
}


class TestExceptions:
    def test_both_kinds_are_in_the_catalogue_the_rules_and_the_till_events(self):
        from app.services import exceptions as EX

        for kind in ("payment_reversed", "table_restored"):
            assert kind in EX.RULES_BY_TYPE and kind in CAT.KINDS_BY_KEY and kind in EX.TILL_EVENT_TYPES
            assert EX.RULES_BY_TYPE[kind].source == "till_event" and EX.RULES_BY_TYPE[kind].default_enabled
            # An "every kind" SMS rule written before them does not start texting them.
            assert kind in CAT.OPT_IN_KINDS
        assert [p.key for p in EX.RULES_BY_TYPE["payment_reversed"].params] == ["minAmount"]

    def test_a_reversal_is_logged_with_who_what_and_which_documents_once_per_credit_note(self, w):
        credit = uuid.uuid4()
        details = dict(REVERSAL, creditTransactionId=str(credit))
        till_event(w, w.a, "payment_reversed", amount=Decimal("180"), details=details, transaction_id=credit)
        # The till re-sent it under another id: still one.
        till_event(w, w.a, "payment_reversed", amount=Decimal("180"), details=details, transaction_id=credit)
        rows = found(w, "payment_reversed")
        assert len(rows) == 1
        exc = rows[0]
        assert (exc.machine_id, exc.shop_id, exc.transaction_id) == (w.a.id, w.shop.id, credit)
        assert exc.pos_user_id == "pu-dana" and float(exc.amount) == 180.0 and exc.severity == "medium"
        d = exc.details
        assert (d["requestedBy"], d["approvedBy"], d["tender"], d["tableNumber"]) == ("דנה", "מנהלת רותי", "card", 12)
        assert d["summary"] == (
            "שולחן 12 · זיכוי לכרטיס ₪180.00 (טיפ ₪10.00) · ביקש: דנה · אישר: מנהלת רותי · חשבונית 1001 → זיכוי 2001"
        )
        # Another credit note (a second, partial reversal of the same payment): its own.
        till_event(w, w.a, "payment_reversed", amount=Decimal("50"), transaction_id=uuid.uuid4(),
                   details=dict(REVERSAL, amount=50, partial=True, tender="cash", action="cash_refund"))
        assert len(found(w, "payment_reversed")) == 2

    def test_the_rules_threshold_and_switch_apply(self, w):
        from app.models.audit_exception import ExceptionRuleValue

        w.db.add(ExceptionRuleValue(
            id=uuid.uuid4(), tenant_id=w.tenant.id, scope_type="shop", scope_id=w.shop.id,
            exception_type="payment_reversed", enabled=None, params={"minAmount": 100},
        ))
        w.db.add(ExceptionRuleValue(
            id=uuid.uuid4(), tenant_id=w.tenant.id, scope_type="machine", scope_id=w.b.id,
            exception_type="table_restored", enabled=False, params=None,
        ))
        w.db.commit()
        till_event(w, w.a, "payment_reversed", amount=Decimal("99.99"), transaction_id=uuid.uuid4(), details=REVERSAL)
        assert found(w, "payment_reversed") == []
        till_event(w, w.a, "payment_reversed", amount=Decimal("100"), transaction_id=uuid.uuid4(), details=REVERSAL)
        assert float(found(w, "payment_reversed")[0].threshold) == 100.0
        till_event(w, w.b, "table_restored", amount=Decimal("60"), details={"orderId": str(uuid.uuid4())})
        assert found(w, "table_restored") == []
        # The events themselves are kept either way.
        assert w.db.query(TillEvent).filter(TillEvent.event_type == "payment_reversed").count() == 2

    def test_a_restore_is_logged_once_from_the_clouds_claim_and_the_tills_event(self, w):
        enter(w, w.a, w.t[12])
        oid = uuid.uuid4()
        save(w, w.a, w.t[12], oid, None, total="180")
        pay(w, w.a, w.t[12], oid, 1, tx="tx-180", total="180")
        body = TableRestoreIn(posUserId="pu-dana", posUserName="דנה", approvedBy="מנהלת רותי")
        R.restore_closed_table(str(w.a.id), str(oid), body, BackgroundTasks(), machine=w.a, db=w.db)
        rows = found(w, "table_restored")
        assert len(rows) == 1
        exc = rows[0]
        assert float(exc.amount) == 180.0 and exc.pos_user_id == "pu-dana"
        assert (exc.details["restoredBy"], exc.details["approvedBy"]) == ("דנה", "מנהלת רותי")
        assert exc.details["transactionIds"] == ["tx-180"] and exc.details["tableNumber"] == 12
        # The till opened it as "ש-12" and says so: the same exception, with what it adds.
        till_event(w, w.a, "table_restored", amount=Decimal("180"), user="pu-dana", details={
            "orderId": str(oid), "newOrderId": str(uuid.uuid4()), "tableNumber": 12, "restoredAs": "ש-12",
            "requestedBy": "דנה", "approvedBy": "מנהלת רותי", "approvalStyle": "takeover",
        })
        rows = found(w, "table_restored")
        assert len(rows) == 1
        d = rows[0].details
        assert (d["restoredAs"], d["approvalStyle"], d["restoredBy"], d["transactionIds"]) == (
            "ש-12", "takeover", "דנה", ["tx-180"],
        )
        assert d["summary"] == "שולחן 12 → ש-12 · שולם ₪180.00 · תשלום אחד · שחזר: דנה · אישר: מנהלת רותי"

    def test_a_phone_alert_type_of_their_own(self):
        assert PUSH.CATEGORY_BY_KEY["payment_reversals"].kinds == ("payment_reversed", "table_restored")
        assert PUSH.CATEGORY_BY_KEY["payment_reversals"].amount is False

        class Entry:
            details = {}

            def __init__(self, kind):
                self.kind = kind

        assert PUSH.category_of(Entry("payment_reversed")) == "payment_reversals"
        assert PUSH.category_of(Entry("table_restored")) == "payment_reversals"
        assert "payment_reversals" in PUSH.CATEGORY_KEYS
        # A preference saved before it lists its own types: it does not start receiving these.
        saved = PUSH.clean({"categories": ["large_void"]})
        assert saved["categories"] == ["large_void"]


# ── The Z (§3 "דוחות ו-Z") ────────────────────────────────────────────────────


def card_sale(w, till, shift, total, **kw):
    return w.doc(till, shift, total, method="card", **kw)


class TestZ:
    def test_card_credited_then_paid_in_cash_nets_per_tender_with_the_line(self, w):
        till = w.a
        shift = w.shift(till, 1)
        sale = card_sale(w, till, shift, "180.00")
        credit = w.doc(till, shift, "180.00", credit_note=True, method="card")
        credit.refund_of_transaction_id = sale.id
        again = w.doc(till, shift, "180.00", method="cash")
        w.db.flush()
        till_event(w, till, "payment_reversed", amount=Decimal("180"), transaction_id=credit.id,
                   details=dict(REVERSAL, creditTransactionId=str(credit.id)))
        z = build_z(w.db, tenant_id=w.tenant.id, shop_id=w.shop.id, selections=[(till, shift.id)])

        breakdown = {k: Decimal(str(v)) for k, v in (z.payment_breakdown or {}).items()}
        assert breakdown.get("card", Decimal("0")) == Decimal("0")
        assert breakdown["cash"] == Decimal("180")
        assert z.total_card_sales == Decimal("0") and z.total_cash_sales == Decimal("180")
        assert z.total_sales == Decimal("360") and z.total_refunds == Decimal("180")
        assert z.transactions_count == 3
        # The line: one reversal of ₪180 — on the Z and on the till's section.
        assert z.header[TR.Z_KEY] == {"count": 1, "amount": "180.00"}
        assert z.per_machine[0][TR.Z_KEY] == {"count": 1, "amount": "180.00"}
        assert again.id != sale.id

        doc = build_print_document(z, None)
        blocks = {s["title"]: s for s in doc["sections"]}
        assert blocks[TR.Z_LABEL]["rows"] == [{"label": "פעולות · סכום", "value": "1 · ₪180.00", "emphasis": False}]
        detail = ZRR.z_detail_out(w.db, z)
        assert detail.table_payment_reversals == {"count": 1, "amount": "180.00"}

    def test_the_line_changes_no_figure_and_is_absent_without_reversals(self, w):
        till = w.a

        def z_of(with_event: bool):
            shift = w.shift(till, 1 if not with_event else 2, opened_at=NOW - timedelta(hours=9 if with_event else 12))
            sale = card_sale(w, till, shift, "180.00")
            credit = w.doc(till, shift, "180.00", credit_note=True, method="card")
            credit.refund_of_transaction_id = sale.id
            w.doc(till, shift, "180.00", method="cash")
            w.db.flush()
            if with_event:
                till_event(w, till, "payment_reversed", amount=Decimal("180"), transaction_id=credit.id, details=REVERSAL)
            return build_z(w.db, tenant_id=w.tenant.id, shop_id=w.shop.id, selections=[(till, shift.id)])

        plain, marked = z_of(False), z_of(True)
        assert TR.Z_KEY not in plain.header and TR.Z_KEY not in plain.per_machine[0]
        for column in ("total_sales", "total_refunds", "total_cash_sales", "total_card_sales", "vat_total",
                       "transactions_count", "payment_breakdown", "expected_cash"):
            assert getattr(plain, column) == getattr(marked, column), column
        titles = [s["title"] for s in build_print_document(plain, None)["sections"]]
        assert TR.Z_LABEL not in titles
        assert ZRR.z_detail_out(w.db, plain).table_payment_reversals is None

    def test_a_z_built_before_its_events_arrived_reads_them_on_the_detail_only(self, w):
        till = w.a
        shift = w.shift(till, 1)
        credit = w.doc(till, shift, "40.00", credit_note=True, method="cash")
        w.doc(till, shift, "40.00", method="card")
        z = build_z(w.db, tenant_id=w.tenant.id, shop_id=w.shop.id, selections=[(till, shift.id)])
        assert TR.Z_KEY not in z.header
        till_event(w, till, "payment_reversed", amount=Decimal("40"), transaction_id=credit.id, details=REVERSAL)
        # The paper is what the Z froze; the dashboard's detail reads the documents now.
        assert TR.Z_LABEL not in [s["title"] for s in build_print_document(z, None)["sections"]]
        assert ZRR.z_detail_out(w.db, z).table_payment_reversals == {"count": 1, "amount": "40.00"}

    def test_counts_the_zs_own_documents_once_each(self, w):
        till = w.a
        shift = w.shift(till, 1)
        later = w.shift(w.b, 1, status=ShiftStatus.OPEN)
        credits = [w.doc(till, shift, amount, credit_note=True, method=m) for amount, m in (("50.00", "cash"), ("30.00", "card"))]
        w.doc(till, shift, "80.00", method="cash")
        elsewhere = w.doc(w.b, later, "20.00", credit_note=True, method="cash")
        w.db.flush()
        for credit in credits:
            till_event(w, till, "payment_reversed", amount=credit.total_amount, transaction_id=credit.id, details=REVERSAL)
        # Sent twice: counted once.
        till_event(w, till, "payment_reversed", amount=Decimal("30"), transaction_id=credits[1].id, details=REVERSAL)
        # Another till's shift, not in this Z.
        till_event(w, w.b, "payment_reversed", amount=Decimal("20"), transaction_id=elsewhere.id, details=REVERSAL)
        found_ = TR.reversals_by_machine(w.db, [shift.id])
        assert found_ == {till.id: (2, Decimal("80.00"))}
        assert TR.z_line({"count": 2, "amount": "80.00"}) == "2 · ₪80.00"
        assert TR.z_line(None) is None and TR.z_line({"count": 0, "amount": "0"}) is None


# ── A credit note inside an open table (§3 "מסמך זיכוי") ───────────────────────


def part(w, till, table, oid, version, tx, amount, partials, *, lines=("l1",), total="180"):
    body = TablePartPayIn(
        orderId=oid, expectedVersion=version, requestId=uuid.uuid4().hex, transactionId=tx,
        transactionNumber="9", amount=Decimal(amount), cartJson=cart(*lines),
        extrasJson=json.dumps({"partials": partials}), itemCount=len(lines), total=Decimal(total),
        posUserId="pu-dana", posUserName="דנה",
    )
    return R.pay_part(str(till.id), table.id, body, BackgroundTasks(), machine=till, db=w.db)


class TestCreditInsideAnOpenTable:
    def test_a_credit_linked_to_a_payment_of_an_open_table_is_stored_and_kept_with_the_table(self, w):
        from app.schemas.transaction import TransactionIn
        from app.services.transactions import upsert_transactions

        till = w.a
        shift = w.shift(till, 1, status=ShiftStatus.OPEN)
        enter(w, till, w.t[12])
        oid = uuid.uuid4()
        save(w, till, w.t[12], oid, None, total="180", lines=("l1", "l2"))

        def doc(**fields):
            base = {
                "id": str(uuid.uuid4()), "transactionNumber": str(fields.pop("number")), "status": "completed",
                "shiftId": str(shift.id), "createdAt": NOW.isoformat(), "updatedAt": NOW.isoformat(),
                "items": [],
            }
            base.update(fields)
            return TransactionIn.model_validate(base)

        # A part payment of the open table: an invoice-receipt for 180 by card.
        sale = doc(number=1001, documentType=320, paymentMethod="card", totalAmount="180.00",
                   payments=[{"id": str(uuid.uuid4()), "method": "card", "amount": "180.00"}])
        out = upsert_transactions(w.db, till, [sale])
        w.db.commit()
        assert out[0].status == "accepted"
        first = part(w, till, w.t[12], oid, 1, str(sale.id), "180",
                     [{"tx": str(sale.id), "no": "1001", "amount": 18000}], lines=(), total="0")
        assert first["conflict"] is False

        # The payment reversed inside the table: a credit note linked to that invoice, while the table is open.
        credit = doc(number=2001, documentType=330, paymentMethod="card", totalAmount="180.00",
                     refundOfTransactionId=str(sale.id), payments=[{"id": str(uuid.uuid4()), "method": "card", "amount": "180.00"}])
        out = upsert_transactions(w.db, till, [credit])
        w.db.commit()
        assert out[0].status == "accepted"
        stored = w.db.get(Transaction, credit.id)
        assert stored.refund_of_transaction_id == sale.id and stored.over_credited is False
        assert w.db.get(Transaction, sale.id).status == TransactionStatus.REFUNDED
        # Recorded with the table like a part payment, at minus its amount: the balance is open again.
        second = part(w, till, w.t[12], oid, 2, str(credit.id), "-180", [
            {"tx": str(sale.id), "no": "1001", "amount": 18000},
            {"tx": str(credit.id), "no": "2001", "amount": -18000},
        ], lines=(), total="180")
        assert second["conflict"] is False and second["order"]["status"] == "open"
        order = w.db.get(TableOrder, oid)
        assert order.status == "open" and float(order.total) == 180.0
        assert [p["tx"] for p in json.loads(order.extras_json)["partials"]] == [str(sale.id), str(credit.id)]
        # The same credit again: answered, nothing changes.
        assert part(w, till, w.t[12], oid, 3, str(credit.id), "-180", [], lines=(), total="180")["replayed"] is True


# ── The restore window, as the cloud knows it (§1) ─────────────────────────────


class TestClosedOrdersCarryTheirPaymentsState:
    def test_in_a_z_or_in_open_shifts(self, w):
        till = w.a
        shift = w.shift(till, 1, status=ShiftStatus.OPEN)
        sale = w.doc(till, shift, "60.00", method="card")
        enter(w, till, w.t[1])
        oid = uuid.uuid4()
        save(w, till, w.t[1], oid, None, total="60")
        pay(w, till, w.t[1], oid, 1, tx=str(sale.id), total="60")
        enter(w, till, w.t[2])
        unknown = uuid.uuid4()
        save(w, till, w.t[2], unknown, None, total="30")
        pay(w, till, w.t[2], unknown, 1, tx="tx-elsewhere", total="30")

        rows = {r["orderId"]: r for r in R.get_closed_tables(str(till.id), machine=till, db=w.db)["orders"]}
        assert rows[str(oid)]["zClosed"] is False and rows[str(oid)]["paymentShiftsOpen"] is True
        assert rows[str(oid)]["paymentShiftIds"] == [str(shift.id)]
        assert rows[str(unknown)]["zClosed"] is False and rows[str(unknown)]["paymentShiftsOpen"] is False

        shift.status = ShiftStatus.CLOSED
        shift.closed_at = shift.close_accepted_at = NOW
        w.db.flush()
        z = build_z(w.db, tenant_id=w.tenant.id, shop_id=w.shop.id, selections=[(till, shift.id)])
        w.db.commit()
        assert shift.z_report_id == z.id
        rows = {r["orderId"]: r for r in R.get_closed_tables(str(till.id), machine=till, db=w.db)["orders"]}
        assert rows[str(oid)]["zClosed"] is True and rows[str(oid)]["paymentShiftsOpen"] is False


# ── The restored table's label: "ש-12", beside the original (§1) ─────────────


def adhoc(w, *, by=None, **fields):
    from app.schemas.tables import TableAdhocIn

    body = TableAdhocIn.model_validate({"posUserName": "דנה", **fields})
    return R.adhoc_table(
        str(w.a.id), body, BackgroundTasks(), machine=w.a,
        operator_id=str(by.id) if by is not None else None, db=w.db,
    )


class TestRestoredTableLabel:
    def test_made_beside_the_original_labelled_and_shown_by_its_label_alone(self, w):
        from app.models.tables import DiningTable

        original = w.t[12]
        out = adhoc(w, by=w.manager, name="ש-12", nearTableId=str(original.id))
        made = out["table"]
        assert out["created"] is True and out["labelled"] is True
        assert (made["name"], made["labelOnly"], made["number"]) == ("ש-12", True, 9012)
        # In the original's zone, beside it — not in "שולחנות מזדמנים".
        assert made["zoneId"] == str(original.zone_id)
        assert made["x"] == original.x + original.width + 12 or made["y"] > original.y
        # Every till sees it so.
        tiles = {t["id"]: t for t in R.get_tables_state(str(w.b.id), machine=w.b, db=w.db)["tables"]}
        assert tiles[made["id"]]["labelOnly"] is True and tiles[made["id"]]["name"] == "ש-12"
        assert tiles[str(original.id)]["labelOnly"] is False
        # Asked again (a lost answer): the same table.
        again = adhoc(w, by=w.manager, name="ש-12", nearTableId=str(original.id))
        assert (again["created"], again["table"]["id"]) == (False, made["id"])
        # 9012 taken now: the next restore of the same original gets 8012.
        enter(w, w.a, w.db.get(DiningTable, uuid.UUID(made["id"])))
        save(w, w.a, w.db.get(DiningTable, uuid.UUID(made["id"])), uuid.uuid4(), None)
        second = adhoc(w, by=w.manager, name="ש-12 (2)", nearTableId=str(original.id))
        assert second["table"]["number"] == 8012 and second["table"]["labelOnly"] is True

    def test_on_table_restore_authority_not_catalog_edit(self, w):
        from app.services import till_roles as S

        assert S.pos_user_allows(w.manager, "TABLE_RESTORE")
        assert not S.pos_user_allows(w.cashier, "TABLE_RESTORE")  # approval, not alone
        e = refused(adhoc, w, by=w.cashier, name="ש-12", nearTableId=str(w.t[12].id))
        assert e.status_code == 401 and e.detail == "elevation_required"
        e = refused(adhoc, w, by=type("U", (), {"id": uuid.uuid4()})(), name="ש-12", nearTableId=str(w.t[12].id))
        assert e.status_code == 401

    def test_a_zone_or_the_adhoc_zone_and_a_number_asked(self, w):
        out = adhoc(w, by=w.manager, name="ש-1", zoneId=str(w.hall.id), number=9001)
        assert (out["table"]["zoneId"], out["table"]["number"], out["table"]["labelOnly"]) == (str(w.hall.id), 9001, True)
        # The asked number held by another table: 409, the till asks the next one.
        e = refused(adhoc, w, by=w.manager, name="ש-2", zoneId=str(w.hall.id), number=12)
        assert e.status_code == 409 and e.detail["code"] == "table_number_taken"
        # A place this till does not see.
        assert refused(adhoc, w, by=w.manager, name="ש-2", zoneId=str(uuid.uuid4())).status_code == 404
        assert refused(adhoc, w, by=w.manager, name="ש-2", nearTableId=str(uuid.uuid4())).status_code == 404
        # A label alone: "שולחנות מזדמנים", labelled.
        out = adhoc(w, by=w.manager, name="ש-3")
        from app.models.tables import TableZone

        assert w.db.get(TableZone, uuid.UUID(out["table"]["zoneId"])).name == T.ADHOC_ZONE_NAME
        assert out["table"]["labelOnly"] is True and out["table"]["number"] == 9999

    def test_a_till_from_before_gets_the_table_by_its_number_as_ever(self, w):
        # No X-Pos-User-Id: the name and the place are not taken; the number is, unlabelled.
        out = adhoc(w, number=9012, name="ש-12", nearTableId=str(w.t[12].id))
        assert out["created"] is True and out["labelled"] is False
        assert (out["table"]["number"], out["table"]["name"], out["table"]["labelOnly"]) == (9012, None, False)
        from app.models.tables import TableZone

        assert w.db.get(TableZone, uuid.UUID(out["table"]["zoneId"])).name == T.ADHOC_ZONE_NAME
        # A plain number: as ever, with `labelled` false.
        assert adhoc(w, number=2)["table"]["id"] == str(w.t[2].id)
        with pytest.raises(ValueError):
            adhoc(w)  # neither a number nor a name

    def test_the_numbers_a_restored_table_may_get(self):
        assert T.restored_table_numbers(12, set(), count=4) == [9012, 8012, 7012, 9999]
        assert T.restored_table_numbers(12, {9012, 9999}, count=3) == [8012, 7012, 9998]
        assert T.restored_table_numbers(None, {9999}, count=2) == [9998, 9997]
