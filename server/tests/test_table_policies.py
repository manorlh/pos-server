"""
Table policies ("סוגי שולחנות", app/services/table_policies.py) and the meals report.

What each class pins, and how it could look fine while doing damage:

* **The table's policy** — a table carries a kind (regular / staff / managers) and a
  discount %, or names a type that decides both; the till gets the *resolved* policy on
  every table (a type's wins; a managers' table always asks for a manager and a reason),
  so a type changed in the cloud reaches every till on its next poll.
* **Validation** — a discount outside 0–100, an unknown kind, a type of another shop: all
  refused, nothing half-written.
* **Types** — reusable, archived without stranding a table (it falls back to its own).
* **The sale** — `basketDiscountKind` keeps the table kinds; `mealKind` / employee / reason
  are stored (cut, never refused); an unknown meal kind is no meal.
* **The meals report** — staff and managers' meals: count, before, discount, paid, by
  employee and filtered by one; credit notes, ordinary sales and other shops left out.
* **The parameters** — "הצג כסאות" (on by default) and "גודל שם שולחן במפה".
"""
from __future__ import annotations

import uuid
from datetime import timedelta
from decimal import Decimal

import pytest
from fastapi import BackgroundTasks, HTTPException
from pydantic import ValidationError

from app.models.shift import ShiftStatus
from app.models.tables import DiningTable, TableType
from app.models.transaction import Transaction
from app.routers import tables as R
from app.schemas.tables import BulkTablesIn, TableCreate, TableTypeIn, TableTypeUpdate, TableUpdate
from app.schemas.transaction import TransactionIn
from app.services import table_policies as P
from app.services import tables as T
from app.services import till_parameters as TP
from app.services.transactions import upsert_transactions
from shift_world import NOW, TODAY
from test_tables import ctx, refused, w  # noqa: F401  (the tables world)


def _type(w, name="עובדים", **over) -> dict:
    body = TableTypeIn(shopId=w.shop.id, name=name, **over)
    return R.create_table_type(body, BackgroundTasks(), **ctx(w))


def _table(w, number, **over) -> dict:
    return R.create_table(TableCreate(zoneId=w.hall.id, number=number, **over), BackgroundTasks(), **ctx(w))


def _till_row(w, till, number) -> dict:
    return next(t for t in T.till_state(w.db, till)["tables"] if t["number"] == number)


# ── The table's policy ───────────────────────────────────────────────────────


class TestTablePolicy:
    def test_an_ordinary_table_is_regular_with_no_discount(self, w):
        row = _till_row(w, w.a, 1)
        assert (row["kind"], row["discountPercent"], row["typeId"]) == ("regular", None, None)
        assert row["policy"] == {
            "kind": "regular", "discountPercent": 0.0, "typeId": None, "typeName": None,
            "requireEmployee": False, "requireApproval": False, "requireReason": False,
            "staffMode": "percent", "staffAllowance": None,
        }

    def test_a_table_of_its_own_staff_managers_and_vip(self, w):
        staff = _table(w, 20, kind="staff", discountPercent="50")
        assert staff["policy"]["kind"] == "staff" and staff["policy"]["discountPercent"] == 50.0
        assert staff["policy"]["requireEmployee"] and not staff["policy"]["requireApproval"]
        managers = _table(w, 21, kind="managers", discountPercent="100")
        p = managers["policy"]
        assert (p["kind"], p["discountPercent"], p["requireApproval"], p["requireReason"]) == ("managers", 100.0, True, True)
        vip = _table(w, 22, name="VIP", discountPercent="10")
        assert (vip["kind"], vip["discountPercent"], vip["policy"]["discountPercent"]) == ("regular", 10.0, 10.0)
        # The till sees the same on its next poll.
        assert _till_row(w, w.a, 21)["policy"]["requireApproval"] is True
        assert _till_row(w, w.b, 22)["policy"]["discountPercent"] == 10.0

    def test_an_update_sets_and_clears(self, w):
        tid = w.t[1].id
        out = R.update_table(tid, TableUpdate(kind="staff", discountPercent="30"), BackgroundTasks(), **ctx(w))
        assert (out["kind"], out["discountPercent"]) == ("staff", 30.0)
        # Only the name changes: the policy stays.
        out = R.update_table(tid, TableUpdate(name="בר"), BackgroundTasks(), **ctx(w))
        assert (out["kind"], out["discountPercent"], out["name"]) == ("staff", 30.0, "בר")
        # A null discount clears it; back to regular.
        out = R.update_table(
            tid, TableUpdate.model_validate({"discountPercent": None, "kind": "regular"}), BackgroundTasks(), **ctx(w),
        )
        assert (out["kind"], out["discountPercent"]) == ("regular", None)

    def test_a_type_decides_for_its_tables_and_a_change_reaches_the_till(self, w):
        staff = _type(w, "עובדים", kind="staff", discountPercent="40")
        out = R.update_table(w.t[2].id, TableUpdate(typeId=staff["id"], discountPercent="5"), BackgroundTasks(), **ctx(w))
        # The table's own 5% is kept but the type's 40% is what the till applies.
        assert out["typeId"] == staff["id"] and out["discountPercent"] == 5.0
        assert out["policy"]["kind"] == "staff" and out["policy"]["discountPercent"] == 40.0
        assert out["policy"]["typeName"] == "עובדים"
        R.update_table_type(uuid.UUID(staff["id"]), TableTypeUpdate(discountPercent="60"), BackgroundTasks(), **ctx(w))
        assert _till_row(w, w.a, 2)["policy"]["discountPercent"] == 60.0
        # Its type taken off: the table's own policy again.
        out = R.update_table(w.t[2].id, TableUpdate.model_validate({"typeId": None}), BackgroundTasks(), **ctx(w))
        assert out["typeId"] is None and out["policy"]["kind"] == "regular" and out["policy"]["discountPercent"] == 5.0

    def test_bulk_add_with_a_type(self, w):
        vip = _type(w, "VIP", discountPercent="10")
        out = R.bulk_tables(w.hall.id, BulkTablesIn(**{"from": 30, "to": 32, "typeId": vip["id"]}), BackgroundTasks(), **ctx(w))
        assert out["created"] == [30, 31, 32]
        rows = [t for t in R.get_layout(w.shop.id, **ctx(w))["tables"] if t["number"] in (30, 31, 32)]
        assert {r["policy"]["discountPercent"] for r in rows} == {10.0}

    def test_the_layout_lists_the_types_for_the_editor(self, w):
        _type(w, "מנהלים", kind="managers", discountPercent="100")
        layout = R.get_layout(w.shop.id, **ctx(w))
        assert [t["name"] for t in layout["tableTypes"]] == ["מנהלים"]
        assert layout["tableTypes"][0]["requireApproval"] is True


class TestValidation:
    @pytest.mark.parametrize("value", ["-1", "100.01", "250"])
    def test_a_discount_outside_0_to_100_is_refused(self, w, value):
        with pytest.raises(ValidationError):
            TableCreate(zoneId=w.hall.id, number=40, discountPercent=value)
        with pytest.raises(ValidationError):
            TableTypeIn(shopId=w.shop.id, name="x", discountPercent=value)

    def test_an_unknown_kind_is_refused(self, w):
        with pytest.raises(ValidationError):
            TableUpdate(kind="vip")
        # And the service refuses one that slipped past a schema.
        with pytest.raises(HTTPException) as e:
            P.check_policy("vip", None)
        assert e.value.detail == {"code": "table_kind_invalid"}

    def test_a_type_of_another_shop_is_refused_and_nothing_changes(self, w):
        other = TableType(
            id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.other_shop.id, name="אחר", kind="staff",
            discount_percent=Decimal("50"),
        )
        w.db.add(other)
        w.db.commit()
        e = refused(R.update_table, w.t[3].id, TableUpdate(typeId=other.id, name="X"), BackgroundTasks(), **ctx(w))
        assert e.status_code == 404 and e.detail == {"code": "table_type_not_found"}
        w.db.rollback()
        assert w.db.get(DiningTable, w.t[3].id).type_id is None

    def test_a_type_needs_a_name(self, w):
        with pytest.raises(ValidationError):
            TableTypeIn(shopId=w.shop.id, name="  ")


class TestTypes:
    def test_a_managers_type_always_asks_for_a_manager_and_by_default_a_reason(self, w):
        t = _type(w, "מנהלים", kind="managers", discountPercent="100", requireApproval=False)
        assert (t["requireApproval"], t["requireReason"]) == (True, True)
        quiet = _type(w, "הנהלה", kind="managers", discountPercent="50", requireReason=False)
        assert (quiet["requireApproval"], quiet["requireReason"]) == (True, False)
        vip = _type(w, "VIP", discountPercent="10")
        assert (vip["kind"], vip["requireApproval"], vip["requireReason"]) == ("regular", False, False)
        listed = R.list_table_types(w.shop.id, **ctx(w))
        assert {x["name"] for x in listed} == {"מנהלים", "הנהלה", "VIP"}

    def test_a_staff_type_keeps_its_meal_mode_for_later(self, w):
        t = _type(w, "עובדים", kind="staff", discountPercent="30", staffMode="allowance", staffAllowance="45")
        assert (t["staffMode"], t["staffAllowance"]) == ("allowance", 45.0)
        out = R.update_table(w.t[1].id, TableUpdate(typeId=t["id"]), BackgroundTasks(), **ctx(w))
        assert out["policy"]["staffMode"] == "allowance" and out["policy"]["requireEmployee"] is True

    def test_archiving_a_type_leaves_its_tables_on_their_own_policy(self, w):
        t = _type(w, "VIP", discountPercent="15")
        R.update_table(w.t[1].id, TableUpdate(typeId=t["id"]), BackgroundTasks(), **ctx(w))
        R.archive_table_type(uuid.UUID(t["id"]), BackgroundTasks(), **ctx(w))
        row = _till_row(w, w.a, 1)
        assert row["typeId"] is None and row["policy"]["discountPercent"] == 0.0
        assert R.list_table_types(w.shop.id, **ctx(w)) == []
        e = refused(R.update_table_type, uuid.UUID(t["id"]), TableTypeUpdate(name="x"), BackgroundTasks(), **ctx(w))
        assert e.status_code == 404


# ── The sale ─────────────────────────────────────────────────────────────────


def _sale(shift, total, *, number, discount="0", status="completed", document_type=320, **over):
    paid = str(Decimal(total) - Decimal(discount))
    body = {
        "id": str(uuid.uuid4()), "transactionNumber": number, "status": status, "documentType": document_type,
        "totalAmount": total, "documentDiscount": discount if Decimal(discount) else None,
        "paymentMethod": "cash",
        "payments": [{"id": str(uuid.uuid4()), "method": "cash", "amount": paid}],
        "createdAt": NOW.isoformat(), "updatedAt": NOW.isoformat(),
        "shiftId": str(shift.id), "businessDate": str(TODAY),
        "items": [{
            "id": str(uuid.uuid4()), "productName": "ארוחה", "quantity": 1, "unitPrice": total, "totalPrice": total,
        }],
    }
    body.update(over)
    return TransactionIn.model_validate(body)


def _push(w, till, *docs):
    out = upsert_transactions(w.db, till, list(docs))
    w.db.commit()
    return [r.status for r in out]


class TestTheSale:
    def test_a_staff_meal_is_stored_with_its_employee(self, w):
        shift = w.shift(w.a, 1, status=ShiftStatus.OPEN)
        doc = _sale(
            shift, "80.00", number="9001", discount="40.00",
            basketDiscount="40.00", basketDiscountPercent="50", basketDiscountKind="staff",
            mealKind="staff", mealEmployeeId="emp-7", mealEmployeeName="דנה",
        )
        assert _push(w, w.a, doc) == ["accepted"]
        tx = w.db.query(Transaction).one()
        assert (tx.basket_discount_kind, tx.meal_kind, tx.meal_employee_id, tx.meal_employee_name) == (
            "staff", "staff", "emp-7", "דנה",
        )

    @pytest.mark.parametrize("kind", ["table", "staff", "managers"])
    def test_the_table_kinds_of_basket_discount_are_kept(self, kind):
        shift = type("S", (), {"id": uuid.uuid4()})()
        assert _sale(shift, "10.00", number="1", basketDiscountKind=kind.upper()).basket_discount_kind == kind

    def test_an_unknown_meal_kind_is_no_meal_and_long_text_is_cut(self):
        shift = type("S", (), {"id": uuid.uuid4()})()
        doc = _sale(shift, "10.00", number="1", mealKind="vip", mealEmployeeName="ד" * 400, mealReason="ס" * 500)
        assert doc.meal_kind is None
        assert len(doc.meal_employee_name) == 200 and len(doc.meal_reason) == 300
        assert _sale(shift, "10.00", number="2", mealKind="Managers").meal_kind == "managers"


# ── The meals report ─────────────────────────────────────────────────────────


class TestMealsReport:
    def _seed(self, w):
        shift = w.shift(w.a, 1, status=ShiftStatus.OPEN)
        docs = [
            _sale(shift, "80.00", number="1", discount="40.00", basketDiscountPercent="50", basketDiscountKind="staff",
                  mealKind="staff", mealEmployeeId="dana", mealEmployeeName="דנה"),
            _sale(shift, "30.00", number="2", discount="15.00", basketDiscountPercent="50", basketDiscountKind="staff",
                  mealKind="staff", mealEmployeeId="dana", mealEmployeeName="דנה"),
            _sale(shift, "60.00", number="3", discount="30.00", basketDiscountPercent="50", basketDiscountKind="staff",
                  mealKind="staff", mealEmployeeId="yossi", mealEmployeeName="יוסי"),
            # A 100% managers' meal: a sale of 0, approved by the manager.
            _sale(shift, "120.00", number="4", discount="120.00", basketDiscountPercent="100",
                  basketDiscountKind="managers", mealKind="managers", mealReason="ספק",
                  approvedByPosUserId=str(w.manager.id)),
            # Not meals: an ordinary sale with a VIP table's discount, and a credit note.
            _sale(shift, "50.00", number="5", discount="5.00", basketDiscountKind="table"),
            _sale(shift, "30.00", number="6", document_type=330, mealKind="staff", mealEmployeeName="דנה"),
        ]
        _push(w, w.a, *docs)

    def _report(self, w, **kw):
        day = NOW.date()
        return R.meals_report(w.shop.id, day - timedelta(days=1), day + timedelta(days=1), **{"employee": None, **kw}, **ctx(w))

    def test_staff_and_managers_meals(self, w):
        self._seed(w)
        out = self._report(w)
        assert out["staff"] == {"count": 3, "before": 170.0, "discount": 85.0, "paid": 85.0}
        assert out["managers"] == {"count": 1, "before": 120.0, "discount": 120.0, "paid": 0.0}
        dana = next(r for r in out["byEmployee"] if r["employeeId"] == "dana")
        assert (dana["kind"], dana["employee"], dana["count"], dana["before"], dana["discount"]) == (
            "staff", "דנה", 2, 110.0, 55.0,
        )
        managers = [m for m in out["meals"] if m["kind"] == "managers"]
        assert managers[0]["reason"] == "ספק" and managers[0]["approvedBy"] == "מנהלת רותי"
        assert managers[0]["percent"] == 100.0
        assert len(out["meals"]) == 4

    def test_filtered_by_employee(self, w):
        self._seed(w)
        out = self._report(w, employee="יוסי")
        assert out["staff"]["count"] == 1 and out["managers"]["count"] == 0
        assert [m["transactionNumber"] for m in out["meals"]] == ["3"]

    def test_another_shops_meals_are_not_counted(self, w):
        shift = w.shift(w.other_till, 1, status=ShiftStatus.OPEN)
        _push(w, w.other_till, _sale(shift, "80.00", number="1", discount="40.00", mealKind="staff", mealEmployeeName="דנה"))
        out = self._report(w)
        assert out["staff"]["count"] == 0 and out["meals"] == []


# ── The parameters ───────────────────────────────────────────────────────────


class TestParameters:
    def test_show_chairs_and_label_size_are_builtins(self, w):
        specs = {p.key: p for p in TP.BUILTIN_PARAMETERS}
        chairs = specs["tablesShowChairs"]
        assert (chairs.label, chairs.value_type, chairs.default_value) == ("הצג כסאות", "boolean", True)
        size = specs["tablesLabelSize"]
        assert (size.value_type, size.enum_options, size.default_value) == ("enum", ("קטן", "רגיל", "גדול"), "רגיל")
        got = TP.till_parameters_for_machine(w.db, w.a).parameters
        assert got["tablesShowChairs"] is True and got["tablesLabelSize"] == "רגיל"
