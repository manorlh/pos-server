"""
Day summary: several tills' Z reports rolled into one figure per trading day.

The aggregation is plain Python, so these tests call it and check the numbers. What
they mostly pin is the *withholding* rules, because those are the part a well-meaning
change would undo: two figures are returned as null rather than approximated, and both
of those nulls are load-bearing.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Any, List, Optional
from unittest.mock import patch

import pytest
from fastapi import HTTPException

from app.models.user import User, UserRole
from app.services import reports as R


# ── Harness ──────────────────────────────────────────────────────────────────

@dataclass
class _Named:
    name: str


@dataclass
class _Z:
    """Only the attributes the summary reads."""

    day_date: date = date(2026, 9, 7)
    machine_id: uuid.UUID = field(default_factory=uuid.uuid4)
    shop_id: Optional[uuid.UUID] = field(default_factory=uuid.uuid4)
    id: uuid.UUID = field(default_factory=uuid.uuid4)
    closed_at: datetime = datetime(2026, 9, 7, 22, 0, tzinfo=timezone.utc)
    unattended: bool = False
    shop_sequence_number: Optional[int] = 1
    reconstructed: bool = False

    total_sales: Optional[Decimal] = Decimal("100.00")
    total_refunds: Optional[Decimal] = Decimal("0.00")
    total_cash_sales: Optional[Decimal] = Decimal("60.00")
    total_card_sales: Optional[Decimal] = Decimal("40.00")
    total_tips: Optional[Decimal] = Decimal("5.00")
    total_cash_tips: Optional[Decimal] = Decimal("2.00")
    total_card_tips: Optional[Decimal] = Decimal("3.00")
    transactions_count: Optional[int] = 4

    opening_cash: Optional[Decimal] = Decimal("200.00")
    expected_cash: Optional[Decimal] = Decimal("260.00")
    actual_cash: Optional[Decimal] = Decimal("260.00")
    discrepancy: Optional[Decimal] = Decimal("0.00")

    payload: Optional[dict] = field(default_factory=lambda: {"taxCollected": 15.25})
    machine: Any = field(default_factory=lambda: _Named("Till 1"))
    shop: Any = field(default_factory=lambda: _Named("Center"))


class _Query:
    """Chainable no-op that hands back a fixed row list."""

    def __init__(self, rows: List[_Z]):
        self._rows = rows
        self.filters = 0

    def options(self, *_): return self
    def order_by(self, *_): return self
    def limit(self, _): return self
    def join(self, *_, **__): return self

    def filter(self, *criteria):
        self.filters += len(criteria)
        return self

    def all(self): return self._rows


class _Db:
    def __init__(self, rows: List[_Z]):
        self.q = _Query(rows)

    def query(self, *_): return self.q


def _user(role=UserRole.SUPER_ADMIN):
    u = User()
    u.id = uuid.uuid4()
    u.role = role
    return u


def _window(from_date=date(2026, 9, 1), to_date=date(2026, 9, 7)):
    return R.ReportWindow(
        from_date=from_date,
        to_date=to_date,
        tz_name="Asia/Jerusalem",
        start=datetime(2026, 9, 1, tzinfo=timezone.utc),
        end=datetime(2026, 9, 8, tzinfo=timezone.utc),
        from_hour=None,
        to_hour=None,
    )


def _run(rows, *, scoped=True, **kwargs):
    db = _Db(rows)
    with patch.object(R, "scope_query_by_user", side_effect=lambda q, *a, **k: q if scoped else None):
        return R.build_day_summary_report(db, _user(), uuid.uuid4(), _window(), **kwargs)


# ── Rolling up ───────────────────────────────────────────────────────────────

class TestRollUp:
    def test_two_tills_on_one_day_become_one_row(self):
        out = _run([_Z(), _Z()])

        assert len(out.days) == 1
        day = out.days[0]
        assert day.machine_count == 2
        assert day.z_report_count == 2
        assert day.totals.sales == 200.00
        assert day.totals.transactions_count == 8

    def test_two_shifts_on_one_till_count_as_one_till(self):
        """
        A till that ran a morning and an evening shift files two Z reports for the same
        date. "2 tills" would be wrong; the useful figure is how many terminals traded.
        """
        machine = uuid.uuid4()
        out = _run([_Z(machine_id=machine), _Z(machine_id=machine)])

        assert out.days[0].machine_count == 1
        assert out.days[0].z_report_count == 2
        assert out.days[0].totals.sales == 200.00

    def test_net_is_sales_minus_refunds(self):
        out = _run([_Z(total_sales=Decimal("100.00"), total_refunds=Decimal("30.00"))])

        assert out.days[0].totals.net == 70.00

    def test_tips_are_rolled_up_and_split_by_method(self):
        out = _run([_Z(), _Z()])
        t = out.days[0].totals

        assert t.tips == 10.00
        assert t.cash_tips == 4.00
        assert t.card_tips == 6.00

    def test_days_come_back_newest_first(self):
        out = _run([
            _Z(day_date=date(2026, 9, 5)),
            _Z(day_date=date(2026, 9, 7)),
            _Z(day_date=date(2026, 9, 6)),
        ])

        assert [d.day_date for d in out.days] == [
            date(2026, 9, 7), date(2026, 9, 6), date(2026, 9, 5),
        ]

    def test_range_totals_span_every_day(self):
        out = _run([_Z(day_date=date(2026, 9, 5)), _Z(day_date=date(2026, 9, 7))])

        assert len(out.days) == 2
        assert out.totals.sales == 200.00
        assert out.totals.transactions_count == 8

    def test_a_day_nobody_closed_is_absent_not_zero(self):
        """
        The range is a week; only one day has a Z. The other six are not reported as
        zero-takings days — an open day has not declared anything, and inventing a zero
        would show a shop as having taken nothing on a day it may still be trading.
        """
        out = _run([_Z(day_date=date(2026, 9, 3))])

        assert [d.day_date for d in out.days] == [date(2026, 9, 3)]


# ── Variance: withheld unless everything was counted ─────────────────────────

class TestVarianceIsWithheldUnlessCounted:
    def test_variance_is_reported_when_every_till_was_counted(self):
        out = _run([
            _Z(expected_cash=Decimal("260.00"), actual_cash=Decimal("255.00")),
            _Z(expected_cash=Decimal("100.00"), actual_cash=Decimal("100.00")),
        ])
        t = out.days[0].totals

        assert t.uncounted_count == 0
        assert t.actual_cash == 355.00
        assert t.variance == -5.00

    def test_one_uncounted_till_withholds_the_whole_days_variance(self):
        """
        The case this rule exists for. An unattended close leaves `actual_cash` NULL
        because nobody opened the drawer. Counting it as zero would report a £260
        shortfall that did not happen; counting it as *expected* would report a variance
        of zero that nobody verified — the exact lie the `unattended` flag was added to
        stop. Neither is available, so the figure is not offered.
        """
        out = _run([
            _Z(expected_cash=Decimal("260.00"), actual_cash=Decimal("255.00")),
            _Z(expected_cash=Decimal("100.00"), actual_cash=None, unattended=True),
        ])
        t = out.days[0].totals

        assert t.variance is None
        assert t.actual_cash is None
        assert t.uncounted_count == 1
        # The rest of the day is still perfectly usable.
        assert t.sales == 200.00
        assert t.expected_cash == 360.00

    def test_the_uncounted_till_is_identifiable_in_the_drill_down(self):
        """Withholding a total is only acceptable if the reader can see why."""
        out = _run([_Z(actual_cash=None, unattended=True), _Z()])
        flagged = [c for c in out.days[0].contributors if c.uncounted]

        assert len(flagged) == 1
        assert flagged[0].unattended is True
        assert flagged[0].actual_cash is None

    def test_a_counted_but_unattended_close_does_not_poison_the_variance(self):
        """
        `unattended` is not the test — having no count is. The two normally coincide,
        but a Z that carries a real figure is usable whatever flag rode along with it.
        """
        out = _run([_Z(unattended=True, actual_cash=Decimal("260.00"))])

        assert out.days[0].totals.uncounted_count == 0
        assert out.days[0].totals.variance == 0.00

    def test_range_variance_is_withheld_when_any_day_was_uncounted(self):
        out = _run([
            _Z(day_date=date(2026, 9, 6)),
            _Z(day_date=date(2026, 9, 7), actual_cash=None, unattended=True),
        ])

        assert out.days[0].totals.variance is None      # the 7th
        assert out.days[1].totals.variance == 0.00      # the 6th, intact
        assert out.totals.variance is None              # the range as a whole
        assert out.totals.uncounted_count == 1


# ── VAT: withheld unless every Z declared it ─────────────────────────────────

class TestVatIsWithheldUnlessComplete:
    def test_vat_is_summed_from_the_z_payloads(self):
        out = _run([_Z(), _Z()])

        assert out.days[0].totals.vat == 30.50
        assert out.days[0].totals.vat_missing_count == 0

    def test_one_z_without_vat_withholds_the_days_vat(self):
        """
        A partial sum presented as the day's VAT understates it, and the reader has no
        way to tell. Older Z reports predate the field, so this is not hypothetical.
        """
        out = _run([_Z(), _Z(payload={})])
        t = out.days[0].totals

        assert t.vat is None
        assert t.vat_missing_count == 1
        assert t.sales == 200.00

    def test_a_z_with_no_payload_at_all_counts_as_missing(self):
        out = _run([_Z(payload=None)])

        assert out.days[0].totals.vat is None
        assert out.days[0].totals.vat_missing_count == 1

    def test_a_nonnumeric_vat_is_missing_rather_than_zero(self):
        """
        The payload is client-supplied JSON. Coercing junk to 0.00 would silently
        understate a tax figure, which is worse than admitting the gap.
        """
        out = _run([_Z(payload={"taxCollected": "not a number"})])

        assert out.days[0].totals.vat is None
        assert out.days[0].totals.vat_missing_count == 1

    def test_a_boolean_is_not_a_vat_amount(self):
        """`Decimal(str(True))` would throw, but `True == 1` elsewhere; be explicit."""
        out = _run([_Z(payload={"taxCollected": True})])

        assert out.days[0].totals.vat is None

    def test_a_genuine_zero_vat_is_a_real_figure(self):
        """An exempt or empty day declared 0.00; that is data, not a gap."""
        out = _run([_Z(payload={"taxCollected": 0})])

        assert out.days[0].totals.vat == 0.0
        assert out.days[0].totals.vat_missing_count == 0

    def test_vat_survives_a_string_number(self):
        out = _run([_Z(payload={"taxCollected": "15.25"})])

        assert out.days[0].totals.vat == 15.25


# ── Drill-down ───────────────────────────────────────────────────────────────

class TestDrillDown:
    def test_each_contributor_carries_the_shop_z_number(self):
        """
        The number a bookkeeper actually quotes. The UUID is the link; this is the name.
        """
        out = _run([_Z(shop_sequence_number=47)])

        assert out.days[0].contributors[0].shop_sequence_number == 47

    def test_a_shopless_z_reports_no_number_rather_than_zero(self):
        out = _run([_Z(shop_id=None, shop=None, shop_sequence_number=None)])

        assert out.days[0].contributors[0].shop_sequence_number is None

    def test_each_contributor_carries_the_id_the_z_endpoint_takes(self):
        z = _Z()
        out = _run([z])
        c = out.days[0].contributors[0]

        assert c.z_report_id == z.id
        assert c.machine_id == z.machine_id
        assert c.machine_name == "Till 1"
        assert c.shop_name == "Center"

    def test_a_contributor_restates_only_its_own_figures(self):
        out = _run([_Z(total_sales=Decimal("100.00"), total_refunds=Decimal("10.00"))])
        c = out.days[0].contributors[0]

        assert c.sales == 100.00
        assert c.refunds == 10.00
        assert c.net == 90.00

    def test_a_machine_with_no_shop_row_still_appears(self):
        out = _run([_Z(shop_id=None, shop=None, machine=None)])
        c = out.days[0].contributors[0]

        assert c.shop_id is None
        assert c.shop_name is None
        assert c.machine_name is None


# ── Nulls, scope and limits ──────────────────────────────────────────────────

class TestEdges:
    def test_null_snapshot_columns_count_as_zero_not_as_a_crash(self):
        """Z reports from before the snapshot columns were populated."""
        out = _run([_Z(
            total_sales=None, total_refunds=None, total_cash_sales=None,
            total_card_sales=None, total_tips=None, total_cash_tips=None,
            total_card_tips=None, transactions_count=None,
            opening_cash=None, expected_cash=None,
        )])
        t = out.days[0].totals

        assert t.sales == 0.0
        assert t.net == 0.0
        assert t.transactions_count == 0
        assert t.opening_cash == 0.0

    def test_the_role_scoped_query_is_the_one_that_runs(self):
        """
        Not a tautology — this was a real gap.

        `scope_query_by_user` returns a *narrowed* query, and an earlier version of
        these tests patched it to the identity, so replacing `query = scoped` with
        `query = query` (i.e. dropping role scoping entirely and reading every
        tenant's tills) passed every assertion. Here the scoped query hands back
        different rows, so using the unscoped one produces the wrong answer.
        """
        db = _Db([_Z(total_sales=Decimal("999.00"))])  # what an unscoped read sees
        permitted = _Query([_Z(total_sales=Decimal("100.00"))])  # what this user may see

        with patch.object(R, "scope_query_by_user", side_effect=lambda *a, **k: permitted):
            out = R.build_day_summary_report(db, _user(), uuid.uuid4(), _window())

        assert out.totals.sales == 100.00

    def test_narrowing_filters_are_applied_to_the_scoped_query(self):
        """
        `shopIds`/`machineIds` must narrow what the role already allows, rather than
        being applied to an unscoped query alongside it.
        """
        db = _Db([_Z()])
        permitted = _Query([_Z()])

        with patch.object(R, "scope_query_by_user", side_effect=lambda *a, **k: permitted):
            R.build_day_summary_report(
                db,
                _user(),
                uuid.uuid4(),
                _window(),
                shop_ids=[uuid.uuid4()],
                machine_ids=[uuid.uuid4()],
            )

        # Both narrowing filters landed on the scoped query, not on the raw one.
        assert permitted.filters == 2
        # tenant + from + to were applied before scoping.
        assert db.q.filters == 3

    def test_no_access_is_an_empty_report_not_an_error(self):
        out = _run([_Z()], scoped=False)

        assert out.days == []
        assert out.totals.sales == 0.0
        assert out.totals.variance is None

    def test_an_empty_range_reports_zero_and_no_days(self):
        out = _run([])

        assert out.days == []
        assert out.totals.sales == 0.0

    def test_an_empty_selection_declares_no_variance_and_no_vat(self):
        """
        Zero contributors is nothing to reconcile, not a reconciliation that balanced.
        A day nobody closed showing "variance 0.00" and "VAT 0.00" reads as a finding
        rather than as the absence of one.
        """
        out = _run([])

        assert out.totals.variance is None
        assert out.totals.actual_cash is None
        assert out.totals.vat is None

    def test_too_many_z_reports_is_refused_not_truncated(self):
        """
        A silently short list reads as "this is the whole range" and the totals under it
        would be wrong with nothing to indicate it.
        """
        rows = [_Z() for _ in range(R.MAX_DAY_SUMMARY_Z_REPORTS + 1)]

        with pytest.raises(HTTPException) as e:
            _run(rows)

        assert e.value.status_code == 400
        assert "Too many Z reports" in e.value.detail

    def test_the_range_boundary_is_reported_back(self):
        """Echoed with the resolved timezone, so the UI does not have to guess it."""
        out = _run([_Z()])

        assert out.window.from_date == date(2026, 9, 1)
        assert out.window.to_date == date(2026, 9, 7)
        assert out.window.timezone == "Asia/Jerusalem"

    def test_shop_and_machine_filters_both_narrow_the_query(self):
        """Intersection, not union — both filters are applied."""
        db = _Db([_Z()])
        with patch.object(R, "scope_query_by_user", side_effect=lambda q, *a, **k: q):
            R.build_day_summary_report(
                db, _user(), uuid.uuid4(), _window(),
                shop_ids=[uuid.uuid4()], machine_ids=[uuid.uuid4()],
            )

        # tenant + from + to + shopIds + machineIds
        assert db.q.filters == 5
