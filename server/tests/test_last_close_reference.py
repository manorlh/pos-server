"""
The cash figure offered to whoever opens a day on a replacement terminal.

Every test here is really about one thing: the response must carry its own uncertainty.
The figure is opening plus the cash sales the cloud *received*, so a terminal that died
holding unsynced sales makes it an understatement — and cash is precisely what cannot be
recovered from the acquirer afterwards. Handing it over as a prefilled float would turn an
unknown shortfall into the next day's opening balance, where it resurfaces as somebody
else's cash variance a day later, on the wrong shift.
"""
from __future__ import annotations

import uuid
from datetime import date, datetime, timezone
from decimal import Decimal
from types import SimpleNamespace

from app.routers.sync import get_last_close_reference

NOW = datetime(2026, 9, 15, 20, 0, tzinfo=timezone.utc)


class _Db:
    def __init__(self, z=None):
        self._z = z

    def query(self, *_): return self
    def filter(self, *_): return self
    def order_by(self, *_): return self
    def first(self): return self._z


def _z(**kw):
    base = dict(
        expected_cash=Decimal("310.00"), closed_at=NOW, day_date=date(2026, 9, 15),
        reconstructed=False, transactions_count=4, reconstruction_basis=None,
    )
    base.update(kw)
    return SimpleNamespace(**base)


def _call(z):
    return get_last_close_reference(
        machine_id="m", machine=SimpleNamespace(id=uuid.uuid4()), db=_Db(z)
    )


class TestATerminalThatHasClosedBefore:
    def test_the_figure_and_its_date_come_back(self):
        out = _call(_z())

        assert out.expected_cash == Decimal("310.00")
        assert out.day_date == date(2026, 9, 15)

    def test_an_ordinary_close_is_not_flagged_as_reconstructed(self):
        assert _call(_z()).reconstructed is False

    def test_the_document_count_behind_the_figure_is_reported(self):
        """So a person counting a drawer can see what the number rests on."""
        assert _call(_z()).documents_counted == 4


class TestAReconstructedClose:
    """The case where the figure is least certain, and must say so."""

    def _reconstructed(self, **basis):
        b = {"documentsOnCloud": 9, "lastReportedPendingDocuments": 3,
             "lastReportedPendingAt": NOW.isoformat()}
        b.update(basis)
        return _z(reconstructed=True, reconstruction_basis=b)

    def test_it_is_flagged(self):
        assert _call(self._reconstructed()).reconstructed is True

    def test_what_the_terminal_last_said_it_still_held_is_carried(self):
        """
        A count, never an amount — three documents could be twelve shekels or twelve
        hundred. It is here so somebody knows there may be more, not so anything can
        compute with it.
        """
        out = _call(self._reconstructed())

        assert out.outstanding_documents == 3
        assert out.outstanding_as_of is not None

    def test_the_basis_count_wins_over_the_snapshot_count(self):
        """
        `documentsOnCloud` is what the reconstruction actually summed; the Z's own
        `transactions_count` is derived from it and would be the same number by
        construction, but the basis is the primary record.
        """
        out = _call(self._reconstructed(documentsOnCloud=9))

        assert out.documents_counted == 9

    def test_a_terminal_that_never_reported_says_so_rather_than_claiming_zero(self):
        """
        Null means "we were never told", which is not "it was holding nothing" — and the
        difference decides whether the person counting should be suspicious.
        """
        out = _call(self._reconstructed(lastReportedPendingDocuments=None))

        assert out.outstanding_documents is None


class TestATerminalThatHasNeverClosed:
    def test_everything_is_null_rather_than_zero(self):
        """
        "Nothing to compare against" is a different statement from "the drawer should be
        empty", and a new terminal must not imply the second.
        """
        out = _call(None)

        assert out.expected_cash is None
        assert out.closed_at is None
        assert out.documents_counted is None
        assert out.reconstructed is False
