"""
"מגירת מזומן" — the cloud side of the drawer spec (docs/SPEC_ROLES_PERMISSIONS.md):
the tills' drawer events and cash movements (idempotent), the exceptions of §10–§11
from them, the reports of §16 (filters, KPIs, the shift timeline), the expected balance
of §8, and who may read them.

Runs on the in-memory SQLite world of tests/shift_world.py.
"""
from __future__ import annotations

import uuid
from datetime import date, timedelta
from decimal import Decimal

import pytest
from fastapi import HTTPException, Response

from app.models.audit_exception import AuditException, ExceptionRuleValue
from app.models.cash_drawer import CashDrawerEvent, CashMovement
from app.models.pos_user import PosUser, PosUserRole
from app.models.shift import ShiftStatus
from app.models.till_parameter import TillParameter, TillParameterValue
from app.models.user import User, UserRole
from app.routers import cash_drawer as R
from app.schemas.cash_drawer import CashMovementIn, DrawerEventIn
from app.services import cash_drawer as S
from app.services import till_parameters as TP
from app.services.cash_drawer_exceptions import DRAWER_EXCEPTION_KINDS
from app.services.exceptions import RULES_BY_TYPE
from shift_world import NOW, accept_str_uuids, make_world

FROM, TO = date(2026, 9, 1), date(2026, 9, 30)


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    world = make_world()
    TP.ensure_builtin_parameters(world.db)
    world.dana = PosUser(
        id=uuid.uuid4(), tenant_id=world.tenant.id, shop_id=world.shop.id, username="dana", first_name="Dana",
        pin_hash="x", role=PosUserRole.CASHIER, is_active=True,
    )
    world.db.add(world.dana)
    world.till = world.tills[0]
    world.shift_row = world.shift(world.till, 1, status=ShiftStatus.OPEN, opened_at=NOW - timedelta(hours=3))
    world.manager = User(id=uuid.uuid4(), role=UserRole.SHOP_MANAGER, tenant_id=world.tenant.id,
                         shop_id=world.shop.id, company_id=world.company.id, email="m@x", username="m")
    world.cashier_user = User(id=uuid.uuid4(), role=UserRole.CASHIER, tenant_id=world.tenant.id,
                              shop_id=world.shop.id, email="c@x", username="c")
    world.db.add_all([world.manager, world.cashier_user])
    world.db.commit()
    return world


def ctx(w, user=None):
    return dict(current_user=user or w.admin, active_tenant_id=w.tenant.id, db=w.db)


def event(w, event_type="MANUAL", *, minutes=0, result="approved", till=None, employee=None, **kw):
    body = DrawerEventIn(
        id=kw.pop("id", uuid.uuid4()), eventType=event_type, result=result,
        occurredAt=NOW - timedelta(minutes=minutes), shiftId=w.shift_row.id,
        employeeId=str(employee or w.dana.id), employeeName="Dana", employeeRole="קופאי", **kw,
    )
    response = Response()
    out = R.post_drawer_event(str((till or w.till).id), body, response, machine=till or w.till, db=w.db)
    return out, response.status_code


def movement(w, kind="cash_out", amount="100", *, minutes=0, **kw):
    body = CashMovementIn(
        id=kw.pop("id", uuid.uuid4()), type=kind, amount=Decimal(amount), occurredAt=NOW - timedelta(minutes=minutes),
        shiftId=w.shift_row.id, employeeId=str(w.dana.id), employeeName="Dana", **kw,
    )
    response = Response()
    out = R.post_cash_movement(str(w.till.id), body, response, machine=w.till, db=w.db)
    return out, response.status_code


def found(w, kind=None):
    q = w.db.query(AuditException)
    if kind:
        q = q.filter(AuditException.exception_type == kind)
    return q.all()


def set_param(w, key, value, scope_type="shop", scope_id=None):
    parameter = w.db.query(TillParameter).filter(TillParameter.key == key).one()
    w.db.add(TillParameterValue(
        id=uuid.uuid4(), parameter_id=parameter.id, scope_type=scope_type, scope_id=scope_id or w.shop.id, value=value,
    ))
    w.db.commit()


class TestCatalogue:
    def test_every_drawer_kind_is_an_exceptions_rule(self):
        for k in DRAWER_EXCEPTION_KINDS:
            spec = RULES_BY_TYPE[k.key]
            assert spec.source == "cash_drawer" and spec.default_enabled and len(k.key) <= 32

    def test_the_expected_balance_formula(self):
        # spec §8: opening + cash sales + Cash In − cash refunds − Cash Out − deposits
        assert S.expected_balance(500, 1200, 300, 100, 150, 400) == Decimal("950")
        assert S.movement_sign("cash_in") == 1 and S.movement_sign("deposit") == -1 and S.movement_sign("count") == 0


class TestIngest:
    def test_an_event_is_idempotent_by_its_id(self, w):
        ident = uuid.uuid4()
        out, code = event(w, id=ident, reason="CHANGE")
        assert (out.status, code) == ("accepted", 201)
        out, code = event(w, id=ident, reason="CHANGE")
        assert (out.status, code) == ("duplicate", 200)
        assert w.db.query(CashDrawerEvent).count() == 1
        row = w.db.get(CashDrawerEvent, ident)
        assert row.company_id == w.company.id and row.shop_id == w.shop.id and row.reason == "CHANGE"

    def test_another_tills_id_is_refused(self, w):
        ident = uuid.uuid4()
        event(w, id=ident)
        with pytest.raises(HTTPException) as e:
            event(w, id=ident, till=w.tills[1])
        assert e.value.status_code == 409

    def test_a_movement_is_idempotent_too(self, w):
        ident = uuid.uuid4()
        assert movement(w, id=ident)[1] == 201
        assert movement(w, id=ident)[1] == 200
        assert w.db.query(CashMovement).count() == 1


class TestExceptions:
    def test_a_denied_attempt_is_recorded_and_flagged(self, w):
        event(w, result="denied", resultReason="אין לך הרשאה: פתיחת מגירה ידנית", permission="CASH_DRAWER.OPEN_MANUALLY")
        (row,) = found(w, "drawer_open_denied")
        assert row.details["why"].startswith("אין לך הרשאה")
        assert not found(w, "drawer_open")

    def test_a_manual_opening_is_the_existing_drawer_open_exception(self, w):
        event(w, "MANUAL", reason="CHANGE", approverId="m1", approverName="Moshe")
        (row,) = found(w, "drawer_open")
        assert row.details["approvedBy"] == "Moshe" and row.till_event_id is not None
        event(w, "CASH_SALE")
        assert len(found(w, "drawer_open")) == 1

    def test_after_close_is_always_an_exception(self, w):
        event(w, "AFTER_CLOSE", reason="OTHER", reasonNote="שכחתי עודף")
        assert len(found(w, "drawer_after_close")) == 1

    def test_a_burst_of_manual_openings(self, w):
        for minutes in (9, 5):
            event(w, "MANUAL", minutes=minutes, reason="CHANGE")
        assert not found(w, "drawer_manual_burst")
        event(w, "CHANGE", minutes=0, reason="CHANGE")
        (row,) = found(w, "drawer_manual_burst")
        assert row.value == Decimal("3") and row.threshold == Decimal("3")

    def test_more_than_the_maximum_in_a_shift(self, w):
        set_param(w, "cashDrawer.maxManualOpensPerShift", 2)
        set_param(w, "cashDrawer.alertOpensCount", 0)
        for minutes in (120, 60, 30):
            event(w, "MANUAL", minutes=minutes, reason="CHANGE")
        assert len(found(w, "drawer_manual_over_max")) == 1

    def test_no_reason_when_one_is_required(self, w):
        event(w, "MANUAL", details={"reasonRequired": True, "noteRequired": True}, reason="OTHER")
        event(w, "MANUAL", details={"reasonRequired": True, "noteRequired": True}, reason="OTHER", reasonNote="פריטה ללקוח")
        event(w, "MANUAL", details={"reasonRequired": False})
        assert len(found(w, "drawer_open_no_reason")) == 1

    def test_cash_out_over_the_alert_amount(self, w):
        movement(w, "cash_out", "500")
        assert not found(w, "cash_out_over_threshold")
        movement(w, "cash_out", "500.01")
        (row,) = found(w, "cash_out_over_threshold")
        assert row.amount == Decimal("500.01") and row.threshold == Decimal("500.00")

    def test_a_count_variance_and_the_manual_openings_near_it(self, w):
        event(w, "MANUAL", minutes=200, reason="CHANGE")   # long before: not near
        near = event(w, "MANUAL", minutes=20, reason="CHANGE")[0]
        movement(w, "count", "940", expectedBefore=Decimal("1000"), variance=Decimal("-60"), blind=True)
        (variance,) = found(w, "drawer_count_variance")
        assert variance.amount == Decimal("-60.00") and variance.severity == "high" and variance.details["blind"] is True
        (opened,) = found(w, "drawer_open_near_variance")
        assert opened.till_event_id == near.id

    def test_a_rule_switched_off_records_nothing(self, w):
        w.db.add(ExceptionRuleValue(id=uuid.uuid4(), tenant_id=w.tenant.id, scope_type="shop", scope_id=w.shop.id,
                                    exception_type="drawer_open_denied", enabled=False))
        w.db.commit()
        event(w, result="denied")
        assert not found(w, "drawer_open_denied")

    def test_training_records_and_flags_nothing(self, w):
        event(w, "AFTER_CLOSE", training=True)
        assert not found(w)

    def test_detecting_again_never_doubles(self, w):
        out, _ = event(w, "AFTER_CLOSE")
        row = w.db.get(CashDrawerEvent, out.id)
        S.detect_event(w.db, w.till, row)
        w.db.commit()
        assert len(found(w, "drawer_after_close")) == 1


class TestExceptionsLog:
    """"יומן חריגות" and its SMS rules (app/services/exception_alerts): the drawer's kinds are
    kinds of the log, each exception is logged once from its audit row, and a rule can name one."""

    @pytest.fixture(autouse=True)
    def no_network(self, monkeypatch):
        import httpx

        from app.services.exception_alerts import engine as E
        from app.services.exception_alerts import sms as SMS

        def boom(*_a, **_k):
            raise AssertionError("a real SMS provider / HTTP endpoint was called")

        monkeypatch.setattr(httpx, "post", boom)
        monkeypatch.setattr(httpx.Client, "send", boom)
        monkeypatch.setattr(E, "now_fn", lambda: NOW + timedelta(minutes=1))
        SMS.DRY_RUN.clear()
        SMS.set_provider_override(None)
        yield
        SMS.DRY_RUN.clear()

    @staticmethod
    def entries(w, kind):
        from app.models.exception_alerts import ExceptionLogEntry

        w.db.expire_all()
        return w.db.query(ExceptionLogEntry).filter(ExceptionLogEntry.kind == kind).all()

    def test_every_drawer_kind_is_a_kind_of_the_log(self):
        from app.services.exception_alerts import catalog as CAT

        for k in DRAWER_EXCEPTION_KINDS:
            spec = CAT.KINDS_BY_KEY[k.key]
            assert (spec.label, spec.severity, spec.source, spec.amount, spec.link) == (
                k.label, k.severity, "audit_exception", k.amount, k.link,
            )

    def test_an_opening_after_the_close_is_logged_once(self, w):
        ident = uuid.uuid4()
        event(w, "AFTER_CLOSE", id=ident, reason="OTHER", reasonNote="שכחתי עודף")
        event(w, "AFTER_CLOSE", id=ident, reason="OTHER", reasonNote="שכחתי עודף")  # the till's retry
        (entry,) = self.entries(w, "drawer_after_close")
        assert (entry.source, entry.severity) == ("audit_exception", "high")
        assert entry.shop_id == w.shop.id and entry.machine_id == w.till.id and entry.company_id == w.company.id
        assert entry.audit_exception_id == found(w, "drawer_after_close")[0].id

    def test_an_sms_rule_names_a_drawer_kind_with_its_amount(self, w):
        from app.models.exception_alerts import ExceptionAlertDispatch
        from app.routers import exception_alerts as AR

        AR.create_rule(
            {
                "companyId": str(w.company.id), "shopId": None, "name": "הוצאות מזומן",
                "kinds": ["cash_out_over_threshold"], "minAmount": 700,
                "recipients": [{"phone": "050-123-4567", "label": "דנה"}], "rateLimitMinutes": 0,
            },
            **ctx(w),
        )
        movement(w, "cash_out", "600")  # an exception (over ₪500), under the rule's ₪700
        assert len(self.entries(w, "cash_out_over_threshold")) == 1
        w.db.expire_all()
        assert w.db.query(ExceptionAlertDispatch).count() == 0
        movement(w, "cash_out", "750")
        w.db.expire_all()
        (d,) = w.db.query(ExceptionAlertDispatch).all()
        assert d.status == "dry_run" and d.kind == "alert" and "₪750" in (d.text or "")


class TestReports:
    def _seed(self, w):
        sale = uuid.uuid4()
        event(w, "CASH_SALE", minutes=50, saleId=sale)
        event(w, "MANUAL", minutes=40, reason="CHANGE", approverId="m1", approverName="Moshe")
        event(w, "MANUAL", minutes=30, result="denied")
        event(w, "AFTER_CLOSE", minutes=10)
        movement(w, "cash_in", "200", minutes=45)
        movement(w, "cash_out", "80", minutes=35)
        movement(w, "deposit", "300", minutes=25)
        movement(w, "count", "1000", minutes=5, expectedBefore=Decimal("1010"), variance=Decimal("-10"))
        return sale

    def _list(self, w, user=None, **filters):
        args = dict(
            from_date=FROM, to_date=TO, company_id=None, shop_id=None, machine_id=None, employee=None, role=None,
            shift_id=None, event_types=None, reason=None, approved_by_manager=None, with_sale=None, results=None,
            exceptions_only=False, category="drawer", page=1, page_size=100,
        )
        args.update(filters)
        return R.list_drawer_events(**args, **ctx(w, user))

    def test_the_kpis_of_spec_16(self, w):
        self._seed(w)
        kpis = self._list(w)["kpis"]
        assert kpis["openings"] == 3 and kpis["saleOpenings"] == 1 and kpis["manualOpenings"] == 2
        assert kpis["cashIn"] == 200 and kpis["cashOut"] == 80 and kpis["deposits"] == 300
        assert kpis["managerApprovals"] == 1 and kpis["afterCloseOpenings"] == 1 and kpis["blockedAttempts"] == 1
        assert kpis["countVariances"] == 1 and kpis["countVarianceTotal"] == -10

    def test_the_filters(self, w):
        sale = self._seed(w)
        assert [r["eventType"] for r in self._list(w, event_types="MANUAL")["rows"]] == ["MANUAL", "MANUAL"]
        assert [r["approverName"] for r in self._list(w, approved_by_manager=True)["rows"]] == ["Moshe"]
        assert [r["saleId"] for r in self._list(w, with_sale=True)["rows"]] == [str(sale)]
        assert self._list(w, results="denied")["total"] == 1
        assert self._list(w, reason="CHANGE")["total"] == 1
        only = self._list(w, exceptions_only=True)["rows"]
        assert {r["eventType"] for r in only} == {"MANUAL", "AFTER_CLOSE"}
        assert all(r["exceptions"] for r in only)
        assert self._list(w, shop_id=w.other_shop.id)["total"] == 0
        assert self._list(w, role="קופאי")["total"] == 4

    def test_movements_and_their_totals(self, w):
        self._seed(w)
        out = R.list_cash_movements(
            from_date=FROM, to_date=TO, company_id=None, shop_id=None, machine_id=None, employee=None,
            shift_id=None, types=None, page=1, page_size=100, **ctx(w),
        )
        assert out["total"] == 4
        assert out["totals"]["cash_out"] == {"count": 1, "amount": 80.0, "variance": 0.0}
        assert out["totals"]["count"]["variance"] == -10.0

    def test_the_shift_timeline(self, w):
        self._seed(w)
        out = R.shift_drawer_timeline(w.shift_row.id, **ctx(w, w.manager))
        assert out["shift"]["openingCash"] == 100 and out["shift"]["cashOut"] == 80
        kinds = [(i["kind"], i.get("eventType") or i.get("type")) for i in out["items"]]
        assert kinds[0] == ("event", "CASH_SALE") and kinds[-1] == ("movement", "count")
        assert len(out["items"]) == 8
        assert {x["type"] for x in out["exceptions"]} >= {"drawer_open", "drawer_after_close", "drawer_open_denied"}

    def test_a_cashier_reads_nothing(self, w):
        with pytest.raises(HTTPException) as e:
            self._list(w, w.cashier_user)
        assert e.value.status_code == 403
        with pytest.raises(HTTPException):
            R.shift_drawer_timeline(w.shift_row.id, **ctx(w, w.cashier_user))


def _render(*args, downgrade=False) -> str:
    import io
    import os
    import pathlib

    from alembic import command
    from alembic.config import Config

    here = pathlib.Path(__file__).resolve().parents[1]
    buf = io.StringIO()
    cfg = Config(os.path.join(here, "alembic.ini"), output_buffer=buf)
    cfg.set_main_option("script_location", os.path.join(here, "alembic"))
    # alembic's env.py runs fileConfig(), which disables every existing logger: put them back,
    # or a later test's caplog sees nothing (tests/test_device_management.py).
    import logging

    root = logging.getLogger()
    saved = {n: lg.disabled for n, lg in logging.Logger.manager.loggerDict.items() if isinstance(lg, logging.Logger)}
    handlers, level = list(root.handlers), root.level
    try:
        (command.downgrade if downgrade else command.upgrade)(cfg, *args, sql=True)
    finally:
        for n, disabled in saved.items():
            logging.getLogger(n).disabled = disabled
        root.handlers[:] = handlers
        root.setLevel(level)
    return " ".join(buf.getvalue().split())


class TestMigration:
    def test_on_the_single_head_after_the_roles(self):
        import pathlib

        from alembic.config import Config
        from alembic.script import ScriptDirectory

        root = pathlib.Path(__file__).resolve().parents[1]
        config = Config(str(root / "alembic.ini"))
        config.set_main_option("script_location", str(root / "alembic"))
        script = ScriptDirectory.from_config(config)
        heads = script.get_heads()
        assert len(heads) == 1
        on_line = {r.revision for r in script.walk_revisions("base", heads[0])}
        assert {"f7c3a9d1b5e8", "a6d2f8c4e0b7", "41b02fa61731"} <= on_line
        assert script.get_revision("f7c3a9d1b5e8").down_revision == "e5b1c3d7f9a2"
        # The merge onto main's head (later ones chain on top).
        assert set(script.get_revision("a6d2f8c4e0b7").down_revision) == {"41b02fa61731", "f7c3a9d1b5e8"}

    def test_upgrade_and_downgrade(self):
        sql = _render("e5b1c3d7f9a2:f7c3a9d1b5e8")
        assert "CREATE TABLE cash_drawer_events" in sql and "CREATE TABLE cash_movements" in sql
        assert "CREATE INDEX ix_cash_drawer_events_shift ON cash_drawer_events (shift_id)" in sql
        down = _render("f7c3a9d1b5e8:e5b1c3d7f9a2", downgrade=True)
        assert "DROP TABLE cash_movements" in down and "DROP TABLE cash_drawer_events" in down
