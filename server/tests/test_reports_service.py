"""
Report window resolution, SQL shape, and scoping.

The report aggregation itself is one GROUP BY executed by Postgres, so what these
tests cover is everything around it that can be wrong without the database noticing:
which timezone the hours are measured in, whether DST is honoured, which statuses
are excluded, which direction a credit note pushes the money, and — for the
till-facing endpoint — that the query's scope can only come from the authenticated
machine row.

Queries are compiled against the Postgres dialect rather than executed, so there is
no DB fixture layer here (in keeping with the rest of tests/).
"""
from __future__ import annotations

import uuid
from datetime import date, datetime, timezone
from unittest.mock import MagicMock, patch

import pytest
from fastapi import HTTPException
from sqlalchemy.dialects import postgresql
from sqlalchemy.orm import Query, sessionmaker

from app.models.pos_machine import POSMachine
from app.models.transaction import TransactionStatus
from app.models.user import User, UserRole
from app.services import reports as R


# ── Harness ──────────────────────────────────────────────────────────────────

def _session():
    """An unbound Session: enough to build queries, never to execute one."""
    return sessionmaker()()


class _Capture:
    """Records the SQL of every query the code under test tries to run."""

    def __init__(self, tenant_row=None):
        self.sql: list[str] = []
        self._tenant_row = tenant_row

    def _all(self, query):
        self.sql.append(str(query.statement.compile(dialect=postgresql.dialect())))
        return []

    def _first(self, query):
        return self._tenant_row

    def __enter__(self):
        self._p1 = patch.object(Query, "all", lambda q: self._all(q))
        self._p2 = patch.object(Query, "first", lambda q: self._first(q))
        self._p1.start()
        self._p2.start()
        return self

    def __exit__(self, *exc):
        self._p1.stop()
        self._p2.stop()
        return False

    @property
    def joined(self) -> str:
        return "\n".join(self.sql)


def _super_admin() -> User:
    return User(id=uuid.uuid4(), role=UserRole.SUPER_ADMIN)


def _window(**kwargs) -> R.ReportWindow:
    base = dict(
        from_date=date(2026, 8, 1),
        to_date=date(2026, 8, 27),
        from_hour=None,
        to_hour=None,
        tz_name="Asia/Jerusalem",
        start=datetime(2026, 7, 31, 21, tzinfo=timezone.utc),
        end=datetime(2026, 8, 27, 21, tzinfo=timezone.utc),
    )
    base.update(kwargs)
    return R.ReportWindow(**base)


# ── Timezone resolution ──────────────────────────────────────────────────────

def test_timezone_prefers_explicit_param() -> None:
    with _Capture(tenant_row=("Europe/Berlin",)):
        assert R.resolve_report_timezone(_session(), uuid.uuid4(), "UTC") == "UTC"


def test_timezone_falls_back_to_tenant_setting() -> None:
    with _Capture(tenant_row=("Europe/Berlin",)):
        assert R.resolve_report_timezone(_session(), uuid.uuid4(), None) == "Europe/Berlin"


def test_timezone_treats_unconfigured_utc_tenant_as_israel() -> None:
    """
    `Tenant.timezone` defaults to "UTC" while provisioning writes "Asia/Jerusalem",
    so a stored "UTC" means nobody set it. Honouring it would report an Israeli
    shop's evening trade under the wrong hours with no visible error.
    """
    with _Capture(tenant_row=("UTC",)):
        assert R.resolve_report_timezone(_session(), uuid.uuid4(), None) == "Asia/Jerusalem"


def test_timezone_defaults_to_israel_with_no_tenant() -> None:
    assert R.resolve_report_timezone(_session(), None, None) == "Asia/Jerusalem"


# ── Window resolution ────────────────────────────────────────────────────────

def test_local_day_boundaries_respect_israeli_dst() -> None:
    """
    The merchant's "1 August" is not 00:00 UTC. Israel is UTC+3 in summer and UTC+2
    in winter; a fixed offset would shift a whole report by an hour for part of the
    year, silently.
    """
    with _Capture():
        summer = R.resolve_report_window(
            _session(), None, from_date=date(2026, 8, 15), to_date=date(2026, 8, 15),
            tz="Asia/Jerusalem",
        )
        winter = R.resolve_report_window(
            _session(), None, from_date=date(2026, 1, 15), to_date=date(2026, 1, 15),
            tz="Asia/Jerusalem",
        )
    assert summer.start == datetime(2026, 8, 14, 21, tzinfo=timezone.utc)
    assert winter.start == datetime(2026, 1, 14, 22, tzinfo=timezone.utc)


def test_dst_end_day_is_twenty_five_hours_long() -> None:
    with _Capture():
        w = R.resolve_report_window(
            _session(), None, from_date=date(2026, 10, 25), to_date=date(2026, 10, 25),
            tz="Asia/Jerusalem",
        )
    assert (w.end - w.start).total_seconds() == 25 * 3600


def test_whole_day_hour_window_is_dropped() -> None:
    with _Capture():
        w = R.resolve_report_window(
            _session(), None, from_date=date(2026, 8, 1), to_date=date(2026, 8, 1),
            from_hour=0, to_hour=24, tz="UTC",
        )
    assert w.from_hour is None and w.to_hour is None
    assert R.hour_window_predicate(w) is None


def test_hour_window_wraps_midnight_for_a_late_shift() -> None:
    w = _window(from_hour=22, to_hour=2)
    assert w.wraps_midnight is True
    sql = str(R.hour_window_predicate(w).compile(dialect=postgresql.dialect()))
    assert " OR " in sql


def test_hour_window_uses_postgres_local_time_not_utc() -> None:
    w = _window(from_hour=18, to_hour=22)
    sql = str(R.hour_window_predicate(w).compile(dialect=postgresql.dialect()))
    # timezone(tz, created_at) is what makes 18:00 mean 18:00 on the shop's wall.
    assert "timezone" in sql and "EXTRACT(hour" in sql


@pytest.mark.parametrize(
    "kwargs,message",
    [
        (dict(from_date=date(2026, 8, 27), to_date=date(2026, 8, 1)), "before or equal"),
        (dict(from_date=date(2020, 1, 1), to_date=date(2026, 8, 1)), "Range too wide"),
        (dict(from_date=date(2026, 8, 1), to_date=date(2026, 8, 1), from_hour=5), "together"),
        (
            dict(from_date=date(2026, 8, 1), to_date=date(2026, 8, 1), from_hour=24, to_hour=5),
            "fromHour must be between",
        ),
        (
            dict(from_date=date(2026, 8, 1), to_date=date(2026, 8, 1), from_hour=5, to_hour=25),
            "toHour must be between",
        ),
        (
            dict(from_date=date(2026, 8, 1), to_date=date(2026, 8, 1), from_hour=5, to_hour=5),
            "must differ",
        ),
        (dict(from_date=date(2026, 8, 1), to_date=date(2026, 8, 1), tz="Mars/Olympus"), "Unknown timezone"),
    ],
)
def test_window_rejects_bad_input(kwargs, message) -> None:
    with _Capture():
        with pytest.raises(HTTPException) as exc:
            R.resolve_report_window(_session(), None, **{"from_hour": None, "to_hour": None, **kwargs})
    assert exc.value.status_code == 400
    assert message in exc.value.detail


# ── Which documents count ────────────────────────────────────────────────────

def test_reportable_statuses_match_the_tills_z_report() -> None:
    """
    Exactly `REPORTABLE_STATUSES` from domain/ZReport.kt. Every declined card tap is
    a `cancelled` row in the same table; counting those inflates takings and VAT.
    """
    assert set(R.SALE_STATUSES) == {
        TransactionStatus.COMPLETED,
        TransactionStatus.REFUNDED,
        TransactionStatus.PARTIAL_REFUND,
    }
    assert TransactionStatus.CANCELLED not in R.SALE_STATUSES
    assert TransactionStatus.PENDING not in R.SALE_STATUSES


def test_credit_note_is_detected_by_document_type_or_backlink() -> None:
    sql = str(R._is_refund_condition().compile(dialect=postgresql.dialect()))
    assert "document_type" in sql and "refund_of_transaction_id IS NOT NULL" in sql
    assert R.CREDIT_NOTE_DOCUMENT_TYPE == 330


def test_every_report_filters_status_and_window() -> None:
    with _Capture() as cap:
        w = _window(from_hour=18, to_hour=22)
        R.build_product_sales_report(_session(), _super_admin(), uuid.uuid4(), w)
        R.build_cashier_sales_report(_session(), _super_admin(), uuid.uuid4(), w)
        R.build_tips_range_report(_session(), _super_admin(), uuid.uuid4(), w)
    assert cap.sql, "no queries were built"
    for sql in cap.sql:
        assert "status IN" in sql
        assert "created_at >=" in sql and "created_at <" in sql
        assert "tenant_id" in sql
        assert "EXTRACT(hour" in sql


def test_product_report_sums_refund_lines_separately() -> None:
    """A credit note's lines must land in `refunds`, not in `gross`."""
    with _Capture() as cap:
        R.build_product_sales_report(_session(), _super_admin(), uuid.uuid4(), _window())
    sql = cap.joined
    assert "is_refund IS false" in sql and "is_refund IS true" in sql
    # Grouped on the snapshot triple so a renamed/deleted product stays readable.
    assert "GROUP BY transaction_items.product_id, transaction_items.sku" in sql


def test_reports_are_empty_when_the_role_grants_nothing() -> None:
    """A cashier with no shop resolves to no access, which is an empty report."""
    user = User(id=uuid.uuid4(), role=UserRole.CASHIER, shop_id=None)
    w = _window()
    with _Capture() as cap:
        p = R.build_product_sales_report(_session(), user, uuid.uuid4(), w)
        c = R.build_cashier_sales_report(_session(), user, uuid.uuid4(), w)
        t = R.build_tips_range_report(_session(), user, uuid.uuid4(), w)
    assert p.rows == [] and p.totals.net == 0.0
    assert c.rows == [] and c.totals.net == 0.0
    assert t.by_cashier == [] and t.tips_total == 0.0
    assert cap.sql == [], "no query should be issued for a role with no access"


def test_tender_normalisation() -> None:
    assert R.normalize_tender("cash") == "cash"
    assert R.normalize_tender("CARD") == "card"
    assert R.normalize_tender("bit") == "other"
    assert R.normalize_tender(None) == "other"


def test_cashier_lookup_ignores_non_uuid_cashier_ids() -> None:
    """
    `transactions.cashier_id` is free text but `pos_users.id` is a UUID column.
    Passing a legacy username into the IN clause would make Postgres reject the
    whole query, taking the report down over one bad row.
    """
    db = MagicMock()
    db.query.return_value.filter.return_value.all.return_value = []
    R._load_cashier_names(db, ["not-a-uuid", "", None])
    db.query.assert_not_called()


# ── 2e. Till-facing shop feed: scope may only come from the machine row ──────

def test_shop_feed_scopes_to_the_machines_own_shop_and_tenant() -> None:
    machine = POSMachine(
        id=uuid.uuid4(), shop_id=uuid.uuid4(), tenant_id=uuid.uuid4(), name="Till 1",
    )
    with _Capture() as cap:
        R.load_shop_transactions_for_machine(_session(), machine, hours=24)
    sql = cap.joined
    assert "transactions.shop_id = " in sql
    assert "transactions.tenant_id = " in sql
    assert "status IN" in sql


def test_shop_feed_returns_empty_for_an_unassigned_machine() -> None:
    """
    `POSMachine.shop_id` is nullable. A null must short-circuit, never become a
    filter: `shop_id IS NULL` would match every unassigned machine in every tenant.
    """
    machine = POSMachine(id=uuid.uuid4(), shop_id=None, tenant_id=uuid.uuid4(), name="Till 2")
    with _Capture() as cap:
        rows, truncated = R.load_shop_transactions_for_machine(_session(), machine, hours=24)
    assert rows == [] and truncated is False
    assert cap.sql == [], "an unassigned machine must not query at all"


def test_shop_feed_recovers_tenant_for_a_legacy_null_tenant_machine() -> None:
    machine = POSMachine(id=uuid.uuid4(), shop_id=uuid.uuid4(), tenant_id=None, name="Till 3")
    with _Capture(tenant_row=(uuid.uuid4(),)) as cap:
        R.load_shop_transactions_for_machine(_session(), machine, hours=24)
    assert "transactions.tenant_id = " in cap.joined


def test_shop_feed_never_emits_a_null_matching_scope_predicate() -> None:
    machine = POSMachine(id=uuid.uuid4(), shop_id=uuid.uuid4(), tenant_id=None, name="Till 4")
    with _Capture(tenant_row=None) as cap:
        R.load_shop_transactions_for_machine(_session(), machine, hours=24)
    sql = cap.joined
    assert "shop_id IS NULL" not in sql
    assert "tenant_id IS NULL" not in sql
    assert "transactions.shop_id = " in sql


def test_shop_feed_search_mirrors_the_tills_local_history_search() -> None:
    """Case-insensitive on the document number, plain-string substring on the amount."""
    machine = POSMachine(
        id=uuid.uuid4(), shop_id=uuid.uuid4(), tenant_id=uuid.uuid4(), name="Till 1",
    )
    with _Capture() as cap:
        R.load_shop_transactions_for_machine(_session(), machine, hours=24, q="21.5")
    sql = cap.joined
    assert "transaction_number ILIKE" in sql
    assert "CAST(transactions.total_amount AS VARCHAR) LIKE" in sql


def test_shop_feed_ignores_a_blank_search_term() -> None:
    machine = POSMachine(
        id=uuid.uuid4(), shop_id=uuid.uuid4(), tenant_id=uuid.uuid4(), name="Till 1",
    )
    with _Capture() as cap:
        R.load_shop_transactions_for_machine(_session(), machine, hours=24, q="   ")
    assert "ILIKE" not in cap.joined


def test_shop_feed_row_cap_is_applied_in_sql() -> None:
    machine = POSMachine(
        id=uuid.uuid4(), shop_id=uuid.uuid4(), tenant_id=uuid.uuid4(), name="Till 1",
    )
    with _Capture() as cap:
        R.load_shop_transactions_for_machine(_session(), machine, hours=24)
    assert "LIMIT" in cap.joined
    assert R.SHOP_TRANSACTIONS_ROW_CAP == 200
