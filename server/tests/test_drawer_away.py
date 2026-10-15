"""
"מגירה כשהעובד לא ליד המגירה" — the cloud side of P:/specs/drawer-away.md §5 (the owner, 15.10.2026: "שישאל,
ואם העובד לא נמצא ליד המגירה? דינמי"):

* the four till parameters (§5.1) and the permission CASH_DRAWER.WALLET_DEPOSIT (§5.7);
* the wallets' movements (`wallet_in`, `wallet_deposit`) in the cash movements model, the exception of a
  deposit's gap, the ledger (§5.4) and what the till asks for (§5.5);
* the expected drawer, the Z's lines and "מזומן אצל עובדים (טרם הופקד)" (§5.6), and the dashboard report.

Runs on the in-memory SQLite world of tests/shift_world.py.
"""
from __future__ import annotations

import json
import uuid
from datetime import timedelta
from decimal import Decimal
from pathlib import Path

import pytest
from fastapi import HTTPException, Response

from app.models.audit_exception import AuditException
from app.models.cash_drawer import CashMovement
from app.models.shift import ShiftStatus
from app.models.till_parameter import TillParameter
from app.models.user import User, UserRole
from app.routers import cash_drawer as R
from app.routers import z_reports as zr_router
from app.schemas.cash_drawer import CashMovementIn, DrawerEventIn
from app.schemas.shift import ShiftCloseIn
from app.services import cash_drawer as S
from app.services import cash_wallets as CW
from app.services import till_permissions as TPERM
from app.services import z_print, z_sections
from app.services.cash_drawer_exceptions import KINDS_BY_KEY
from app.services.exception_alerts import push
from app.services.exceptions import RULES_BY_TYPE
from app.services.shifts import apply_shift_close
from app.services.till_parameters import BUILTIN_PARAMETERS, ensure_builtin_parameters
from app.services.z_builder import build_z, till_cash_summary
from shift_world import NOW, accept_str_uuids, make_world
from test_z_print_document import _tz

MATRIX = Path(__file__).parent / "fixtures" / "till_permissions_matrix.json"


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    world = make_world()
    ensure_builtin_parameters(world.db)
    world.drawer_till, world.handheld = world.tills
    world.manager = User(id=uuid.uuid4(), role=UserRole.SHOP_MANAGER, tenant_id=world.tenant.id,
                         shop_id=world.shop.id, company_id=world.company.id, email="m@x", username="m")
    world.cashier_user = User(id=uuid.uuid4(), role=UserRole.CASHIER, tenant_id=world.tenant.id,
                              shop_id=world.shop.id, email="c@x", username="c")
    world.db.add_all([world.manager, world.cashier_user])
    world.db.commit()
    return world


def ctx(w, user=None):
    return dict(current_user=user or w.admin, active_tenant_id=w.tenant.id, db=w.db)


def wallet_in(w, employee="dana", amount="100", *, till=None, minutes=30, **kw):
    till = till or w.handheld
    body = CashMovementIn(
        id=kw.pop("id", uuid.uuid4()), type="wallet_in", amount=Decimal(amount), occurredAt=NOW - timedelta(minutes=minutes),
        employeeId=employee, employeeName=employee.title(), reason="WALLET", source=f"sale:{uuid.uuid4()}",
        note="320 1001", **kw,
    )
    response = Response()
    out = R.post_cash_movement(str(till.id), body, response, machine=till, db=w.db)
    return out, response.status_code


def deposit(w, employee="dana", counted="100", expected="100", *, receiver="rina", minutes=10, till=None, **kw):
    till = till or w.drawer_till
    body = CashMovementIn(
        id=kw.pop("id", uuid.uuid4()), type="wallet_deposit", amount=Decimal(counted),
        expectedBefore=Decimal(expected) if expected is not None else None, expectedAfter=Decimal("0"),
        variance=(Decimal(counted) - Decimal(expected)) if expected is not None else None,
        occurredAt=NOW - timedelta(minutes=minutes), employeeId=employee, employeeName=employee.title(),
        approverId=receiver, approverName=receiver.title(), reason="WALLET_DEPOSIT", **kw,
    )
    response = Response()
    out = R.post_cash_movement(str(till.id), body, response, machine=till, db=w.db)
    return out, response.status_code


# ── §5.1 the parameters ──────────────────────────────────────────────────────


class TestParameters:
    def test_the_four_are_built_in_with_their_defaults_and_hebrew(self):
        by_key = {p.key: p for p in BUILTIN_PARAMETERS}
        policy = by_key["drawerAwayPolicy"]
        assert (policy.value_type, policy.default_value, policy.enum_options) == ("enum", "ask", ("ask", "remote", "wallet", "none"))
        assert policy.enum_labels["wallet"] == "הכסף אצל העובד" and policy.label.startswith("מגירה")
        near = by_key["drawerNear"]
        assert (near.default_value, near.enum_options) == ("auto", ("auto", "near", "away"))
        target = by_key["drawerAwayTarget"]
        assert (target.value_type, target.default_value) == ("string", "")
        clock = by_key["walletBlockClockOut"]
        assert (clock.default_value, clock.enum_options) == ("warn", ("warn", "block"))
        assert clock.enum_labels == {"warn": "אזהרה (ברירת מחדל)", "block": "חסימה"}

    def test_they_are_in_the_drawers_level_editor_with_their_labels(self, w):
        for key in ("drawerAwayPolicy", "drawerNear", "drawerAwayTarget", "walletBlockClockOut"):
            assert key in S.LEVEL_KEYS
        view = S.level_view(w.db, "shop", w.shop.id)
        params = {p["key"]: p for p in view["parameters"]}
        assert params["drawerAwayPolicy"]["enumLabels"]["ask"] == "לשאול (ברירת מחדל)"
        assert params["drawerAwayTarget"]["enumLabels"] is None

    def test_a_till_gets_them_resolved_and_a_level_may_set_them(self, w):
        from app.services.till_parameters import till_parameters_for_machine

        resolved = till_parameters_for_machine(w.db, w.handheld).parameters
        assert (resolved["drawerAwayPolicy"], resolved["drawerNear"], resolved["walletBlockClockOut"]) == ("ask", "auto", "warn")
        S.save_values(w.db, "machine", w.handheld.id, {"drawerAwayPolicy": "wallet", "drawerNear": "away"}, user=w.admin)
        resolved = till_parameters_for_machine(w.db, w.handheld).parameters
        assert (resolved["drawerAwayPolicy"], resolved["drawerNear"]) == ("wallet", "away")
        from app.services.till_parameters import TillParameterValueError

        with pytest.raises(TillParameterValueError):
            S.save_values(w.db, "machine", w.handheld.id, {"drawerAwayPolicy": "sometimes"}, user=w.admin)


# ── §5.7 the permission ──────────────────────────────────────────────────────


class TestPermission:
    CODE = "CASH_DRAWER.WALLET_DEPOSIT"

    def test_waiter_denied_everyone_else_allowed(self):
        states = {role: TPERM.DEFAULTS[role][self.CODE] for role in TPERM.SPEC_ROLE_KEYS}
        assert states == {"waiter": "deny", "cashier": "allow", "supervisor": "allow", "manager": "allow"}
        # The legacy roles: as before — nothing that did not need a manager asks for one.
        assert TPERM.DEFAULTS["legacy_cashier"][self.CODE] == "allow"
        assert TPERM.DEFAULTS["legacy_manager"][self.CODE] == "allow"

    def test_in_the_catalogue_and_the_shared_matrix(self):
        spec = {p.code: p for p in TPERM.PERMISSIONS}[self.CODE]
        assert spec.label == "קבלת הפקדת מזומן מעובד" and spec.group == "drawer"
        assert self.CODE in TPERM.CODES
        matrix = json.loads(MATRIX.read_text(encoding="utf-8"))
        assert self.CODE in matrix["codes"]
        assert matrix["roles"]["waiter"]["states"][self.CODE] == "deny"
        assert matrix["roles"]["cashier"]["states"][self.CODE] == "allow"


# ── §5.4 the movements, the exception, the ledger ────────────────────────────


class TestMovements:
    def test_both_wallet_types_and_the_deposits_opening_are_accepted(self, w):
        ident = uuid.uuid4()
        assert wallet_in(w, id=ident) == (R.IngestOut(id=ident, status="accepted"), 201)
        assert wallet_in(w, id=ident)[1] == 200
        out, code = deposit(w)
        assert code == 201
        row = w.db.get(CashMovement, out.id)
        assert (row.movement_type, row.employee_id, row.approver_id, row.expected_before, row.machine_id) == (
            "wallet_deposit", "dana", "rina", Decimal("100.00"), w.drawer_till.id,
        )
        assert row.shop_id == w.shop.id
        body = DrawerEventIn(
            id=uuid.uuid4(), eventType="WALLET_DEPOSIT", result="approved", occurredAt=NOW,
            permission="CASH_DRAWER.WALLET_DEPOSIT", movementId=out.id,
            cashMovementType="wallet_deposit",
        )
        response = Response()
        assert R.post_drawer_event(str(w.drawer_till.id), body, response, machine=w.drawer_till, db=w.db).status == "accepted"
        assert S.movement_sign("wallet_in") == -1 and S.movement_sign("wallet_deposit") == 1

    def test_a_deposits_gap_is_an_exception_short_high_over_medium(self, w):
        deposit(w, counted="90", expected="100")
        deposit(w, employee="yossi", counted="45", expected="40")
        deposit(w, employee="avi", counted="30", expected="30")
        rows = {r.details.get("employeeName"): r for r in w.db.query(AuditException).filter(
            AuditException.exception_type == CW.VARIANCE_KIND).all()}
        assert set(rows) == {"Dana", "Yossi"}
        assert rows["Dana"].severity == "high" and Decimal(str(rows["Dana"].amount)) == Decimal("-10.00")
        assert rows["Yossi"].severity == "medium"
        assert rows["Dana"].details["receivedBy"] == "Rina" and rows["Dana"].details["expected"] == 100.0

    def test_the_exception_is_catalogued_and_in_the_drawer_alert_category(self):
        kind = KINDS_BY_KEY[CW.VARIANCE_KIND]
        assert kind.label == "פער בהפקדת מזומן מעובד" and kind.amount
        assert RULES_BY_TYPE[CW.VARIANCE_KIND].source == "cash_drawer"
        drawer = {c.key: c for c in push.CATEGORIES}["drawer_no_sale"]
        assert CW.VARIANCE_KIND in drawer.kinds

    def test_a_wallet_is_its_accruals_less_what_each_deposit_settled(self, w):
        wallet_in(w, amount="100", minutes=60)
        wallet_in(w, amount="40", minutes=50)
        deposit(w, counted="130", expected="140", minutes=40)
        # Reached the cloud after the deposit (an offline handheld): open for the next one.
        wallet_in(w, amount="25", minutes=45)
        wallet_in(w, employee="yossi", amount="60", minutes=20)
        # A training row never counts.
        wallet_in(w, employee="yossi", amount="999", training=True)
        balances = {b["employeeId"]: b for b in CW.balances(w.db, shop_ids=[w.shop.id])}
        assert balances["dana"]["balance"] == Decimal("25.00") and balances["dana"]["accruals"] == 3
        assert balances["yossi"]["balance"] == Decimal("60.00")
        # Another shop sees none of it.
        assert CW.balances(w.db, shop_ids=[uuid.uuid4()]) == []

    def test_a_deposit_with_no_expected_settles_its_count(self, w):
        wallet_in(w, amount="50")
        deposit(w, counted="50", expected=None)
        assert CW.balances(w.db, shop_ids=[w.shop.id])[0]["balance"] == Decimal("0.00")

    def test_kpis_count_the_wallets(self, w):
        wallet_in(w, amount="100")
        deposit(w, counted="90", expected="100")
        k = S.kpis([], w.db.query(CashMovement).all())
        assert (k["walletInCount"], k["walletIn"], k["walletDepositCount"], k["walletDeposits"], k["walletVarianceTotal"]) == (
            1, 100.0, 1, 90.0, -10.0,
        )


# ── §5.5 what the till asks for ─────────────────────────────────────────────


class TestTillWallets:
    def test_the_shops_holders_largest_first_and_one_by_id(self, w):
        wallet_in(w, amount="100")
        wallet_in(w, employee="yossi", amount="340")
        wallet_in(w, employee="avi", amount="20")
        deposit(w, employee="avi", counted="20", expected="20")
        out = R.get_cash_wallets(str(w.drawer_till.id), employee_id=None, machine=w.drawer_till, db=w.db)
        assert [(x["employeeId"], x["balance"]) for x in out["wallets"]] == [("yossi", 340.0), ("dana", 100.0)]
        assert out["wallets"][0]["accruals"] == 1 and out["wallets"][0]["firstAt"] and out["asOf"]
        one = R.get_cash_wallets(str(w.drawer_till.id), employee_id="avi", machine=w.drawer_till, db=w.db)
        assert [(x["employeeId"], x["balance"]) for x in one["wallets"]] == [("avi", 0.0)]
        nobody = R.get_cash_wallets(str(w.drawer_till.id), employee_id="ghost", machine=w.drawer_till, db=w.db)
        assert nobody["wallets"] == [{"employeeId": "ghost", "employeeName": None, "balance": 0.0, "accruals": 0,
                                      "firstAt": None, "lastAt": None}]

    def test_a_till_with_no_shop_is_refused(self, w):
        w.handheld.shop_id = None
        with pytest.raises(HTTPException) as e:
            R.get_cash_wallets(str(w.handheld.id), employee_id=None, machine=w.handheld, db=w.db)
        assert e.value.status_code == 409


# ── §5.6 the expected drawer, the Z, the report ──────────────────────────────


def _closed(w, till, seq, docs, *, opening, counted, figures):
    shift = w.shift(till, seq, status=ShiftStatus.OPEN, opening_cash=opening)
    for total in docs:
        w.doc(till, shift, total, method="cash")
    body = {"closedAt": NOW.isoformat(), "countedCash": counted}
    if figures is not None:
        body["till"] = figures
    apply_shift_close(w.db, till, shift.id, ShiftCloseIn.model_validate(body))
    return shift


def _day(w):
    """The handheld kept 140 with two waiters; the drawer till took 90 of Dana's 100 (short 10)."""
    wallet_in(w, amount="100", minutes=120)
    wallet_in(w, employee="yossi", amount="40", minutes=110)
    deposit(w, counted="90", expected="100", minutes=60)
    handheld = _closed(w, w.handheld, 1, ["100.00", "40.00"], opening="0.00", counted="0.00", figures={"walletIn": 140.0})
    drawer = _closed(w, w.drawer_till, 1, ["50.00"], opening="200.00", counted="340.00", figures={"walletDeposits": 90.0})
    return handheld, drawer


def _out(z):
    return zr_router.z_to_out(z).model_dump(by_alias=True, mode="json")


class TestZ:
    def test_the_expected_drawer_leaves_the_wallets_out_until_deposited(self, w):
        handheld, drawer = _day(w)
        z = build_z(w.db, tenant_id=w.tenant.id, shop_id=w.shop.id,
                    selections=[(w.drawer_till, drawer.id), (w.handheld, handheld.id)])
        # 200 float + 50 + 90 deposited = 340 counted; the handheld's 140 is with the waiters: 0 in it.
        assert (z.expected_cash, z.actual_cash, z.discrepancy) == (Decimal("340.00"), Decimal("340.00"), Decimal("0.00"))
        sections = {s["machineId"]: s for s in z.per_machine}
        assert sections[str(w.handheld.id)][CW.BLOCK] == {"walletIn": "140.00", "walletDeposits": "0.00"}
        assert sections[str(w.handheld.id)]["expectedCash"] == "0.00"
        assert sections[str(w.drawer_till.id)][CW.BLOCK] == {"walletIn": "0.00", "walletDeposits": "90.00"}
        assert z.header[CW.BLOCK] == {"walletIn": "140.00", "walletDeposits": "90.00"}
        # Nothing fiscal moved: the cash takings are the documents'.
        assert z.total_cash_sales == Decimal("190.00")

    def test_the_cash_with_staff_per_employee_is_frozen_on_the_z(self, w):
        handheld, drawer = _day(w)
        z = build_z(w.db, tenant_id=w.tenant.id, shop_id=w.shop.id,
                    selections=[(w.drawer_till, drawer.id), (w.handheld, handheld.id)])
        # Dana's wallet is settled (her 10 short is an exception, not cash with her); Yossi holds 40.
        assert z.header[CW.STAFF] == {"total": "40.00", "employees": [
            {"employeeId": "yossi", "employeeName": "Yossi", "amount": "40.00"}]}
        assert z.header["reportSections"][CW.STAFF] == z.header[CW.STAFF]
        out = _out(z)
        assert out["cashWithStaff"] == z.header[CW.STAFF]
        assert out["cashWallets"] == {"walletIn": "140.00", "walletDeposits": "90.00"}
        # A deposit after the Z does not change it.
        deposit(w, employee="yossi", counted="40", expected="40", minutes=-10)
        assert _out(z)["cashWithStaff"]["total"] == "40.00"

    def test_the_owners_sections_print_the_lines_and_add_up(self, w):
        handheld, drawer = _day(w)
        z = build_z(w.db, tenant_id=w.tenant.id, shop_id=w.shop.id,
                    selections=[(w.drawer_till, drawer.id), (w.handheld, handheld.id)])
        d = z.header["reportSections"]["drawer"]
        assert (d["walletIn"], d["walletDeposits"], d["expected"]) == ("140.00", "90.00", "340.00")
        assert (
            Decimal(d["opening"]) + Decimal(d["cashReceipts"]) - Decimal(d["walletIn"]) + Decimal(d["walletDeposits"])
            + Decimal(d["betweenShifts"])
        ) == Decimal(d["expected"])
        blocks = dict(z_sections.lines(z.header["reportSections"]))
        drawer_rows = dict((label, value) for label, value, _b in blocks[z_sections.LABELS_HE["drawer"]])
        assert drawer_rows["הכסף אצל עובדים"] == "-140.00" and drawer_rows["הפקדות מעובדים"] == "90.00"
        staff = blocks["מזומן אצל עובדים (טרם הופקד)"]
        assert [(label, value) for label, value, _b in staff] == [("Yossi", "40.00"), ("סה״כ אצל עובדים", "40.00")]
        doc = z_print.build_print_document(z, _tz())
        assert "מזומן אצל עובדים (טרם הופקד)" in [s["title"] for s in doc["sections"]]

    def test_the_older_layout_prints_them_too(self, w):
        handheld, drawer = _day(w)
        z = build_z(w.db, tenant_id=w.tenant.id, shop_id=w.shop.id,
                    selections=[(w.drawer_till, drawer.id), (w.handheld, handheld.id)])
        z.header = {k: v for k, v in z.header.items() if k != "reportSections"}
        z.per_machine = [{k: v for k, v in s.items() if k != "reportSections"} for s in z.per_machine]
        doc = z_print.build_print_document(z, _tz())
        cash = dict((r["label"], r["value"]) for s in doc["sections"] if s["title"] == "קופה" for r in s["rows"])
        assert cash[CW.WALLET_IN_LABEL] == "-₪140.00" and cash[CW.WALLET_DEPOSITS_LABEL] == "+₪90.00"
        staff = [s for s in doc["sections"] if s["title"] == CW.STAFF_LABEL]
        assert [(r["label"], r["value"]) for r in staff[0]["rows"]] == [("Yossi", "₪40.00"), (CW.STAFF_TOTAL_LABEL, "₪40.00")]
        for label in (CW.WALLET_IN_LABEL, CW.WALLET_DEPOSITS_LABEL, CW.STAFF_TOTAL_LABEL):
            assert len(label) <= z_print.LABEL_MAX

    def test_a_till_z_lists_only_its_own_tills_waiters(self, w):
        handheld, drawer = _day(w)
        z = build_z(w.db, tenant_id=w.tenant.id, shop_id=w.shop.id, selections=[(w.drawer_till, drawer.id)])
        # No accrual on the drawer till: nobody listed there.
        assert CW.STAFF not in z.header

    def test_without_wallets_the_z_is_as_before(self, w):
        till = w.tills[0]
        shift = _closed(w, till, 1, ["100.00"], opening="200.00", counted="300.00", figures={"cashIn": 0})
        z = build_z(w.db, tenant_id=w.tenant.id, shop_id=w.shop.id, selections=[(till, shift.id)])
        assert z.expected_cash == Decimal("300.00")
        assert CW.BLOCK not in z.header and CW.STAFF not in z.header and CW.BLOCK not in z.per_machine[0]
        d = z.header["reportSections"]["drawer"]
        assert "walletIn" not in d and "walletDeposits" not in d
        assert _out(z)["cashWallets"] is None and _out(z)["cashWithStaff"] is None
        assert z_print.cash_wallets_of(z) == CW.NONE

    def test_the_summary_rule_reconciles_across_shifts(self, w):
        till = w.tills[0]
        first = _closed(w, till, 1, ["100.00"], opening="100.00", counted="150.00", figures={"walletIn": 50.0})
        second = _closed(w, till, 2, ["20.00"], opening="150.00", counted="200.00", figures={"walletDeposits": 30.0})
        cash = till_cash_summary([first, second])
        assert cash["cash_wallets"] == (Decimal("50.00"), Decimal("30.00"))
        assert cash["expected"] == Decimal("200.00") and cash["over_short"] == Decimal("0.00")
        assert cash["counted"] - cash["expected"] == cash["over_short"]

    def test_the_closes_figures_read_as_amounts_only(self):
        assert CW.wallets_of_till({"walletIn": "12.5", "walletDeposits": -3}) == (Decimal("12.50"), Decimal("0"))
        assert CW.wallets_of_till(None) == CW.NONE
        assert CW.block(CW.NONE) is None
        assert CW.net((Decimal("50"), Decimal("30"))) == Decimal("-20")


class TestShopX:
    def test_open_shifts_take_their_uploaded_wallets_and_list_the_staff(self, w, monkeypatch):
        from app.services import ably_notify
        from app.services import shop_x as SX

        monkeypatch.setattr(ably_notify, "publish_close_shift_notify", lambda *a, **k: None)
        hand = w.shift(w.handheld, 1, status=ShiftStatus.OPEN, opened_at=NOW - timedelta(hours=4), opening_cash="0.00")
        drawer = w.shift(w.drawer_till, 1, status=ShiftStatus.OPEN, opened_at=NOW - timedelta(hours=4), opening_cash="200.00")
        w.doc(w.handheld, hand, "100.00")
        w.doc(w.handheld, hand, "40.00")
        wallet_in(w, amount="100", shiftId=hand.id)
        wallet_in(w, employee="yossi", amount="40", shiftId=hand.id)
        deposit(w, counted="90", expected="100", shiftId=drawer.id)
        report = SX.build(w.db, w.shop, settings=SX.Settings(), now=NOW)
        d = report["summary"]["drawer"]
        assert (d["walletIn"], d["walletDeposits"]) == ("140.00", "90.00")
        # 0 + 140 − 140 on the handheld; 200 + 90 on the drawer.
        assert d["expected"] == "290.00"
        assert report["summary"]["cashWithStaff"]["employees"] == [
            {"employeeId": "yossi", "employeeName": "Yossi", "amount": "40.00"}]
        doc = SX.print_document(w.db, report, w.shop, tzinfo=_tz(), now=NOW)
        assert CW.STAFF_LABEL in [s["title"] for s in doc["sections"]]
        cash = dict((r["label"], r["value"]) for s in doc["sections"] for r in s["rows"])
        assert cash[CW.WALLET_IN_LABEL] == "-₪140.00" and cash[CW.WALLET_DEPOSITS_LABEL] == "+₪90.00"


class TestDashboardReport:
    def test_the_open_wallets_and_the_movements(self, w):
        wallet_in(w, amount="100")
        wallet_in(w, employee="yossi", amount="40")
        deposit(w, counted="90", expected="100")
        out = R.list_cash_wallets(from_date=NOW.date(), to_date=NOW.date(), company_id=None, shop_id=w.shop.id,
                                  machine_id=None, employee=None, **ctx(w, w.manager))
        assert [(x["employeeId"], x["balance"]) for x in out["wallets"]] == [("yossi", 40.0)]
        assert out["total"] == 40.0
        assert {r["type"] for r in out["rows"]} == {"wallet_in", "wallet_deposit"}
        assert out["totals"]["wallet_deposit"] == {"count": 1, "amount": 90.0, "variance": -10.0}

    def test_a_cashier_may_not_read_it(self, w):
        with pytest.raises(HTTPException) as e:
            R.list_cash_wallets(from_date=None, to_date=None, company_id=None, shop_id=None, machine_id=None,
                                employee=None, **ctx(w, w.cashier_user))
        assert e.value.status_code == 403

    def test_the_movements_report_filters_by_the_wallet_types(self, w):
        wallet_in(w, amount="100")
        out = R.list_cash_movements(from_date=NOW.date(), to_date=NOW.date(), company_id=None, shop_id=None,
                                    machine_id=None, employee=None, shift_id=None, types="wallet_in", page=1,
                                    page_size=100, **ctx(w, w.manager))
        assert [r["type"] for r in out["rows"]] == ["wallet_in"]


def test_the_parameter_rows_are_registered(w):
    keys = {p.key for p in w.db.query(TillParameter).all()}
    assert {"drawerAwayPolicy", "drawerNear", "drawerAwayTarget", "walletBlockClockOut"} <= keys
