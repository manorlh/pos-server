"""
Unnamed card batches — "תוודא שאתה מקבל את השידורים" (docs/SPEC_REPORTS.md §7).

Found on the dev F20 (2026-10-06): its terminal confirmed a batch of 1 sale (₪140,000)
without listing the sale (no `queriedTransactions`). The till assumed its pending sale went
in it and showed nothing waiting; the report it sent named no uid, so the cloud never marked
the leg and showed it "untransmitted" for ever — the dashboard and the till disagreed.

What these pin, and how it could look fine while doing damage:

* the till's `assumedTerminalTransactionIds` mark its legs — kept as `assumed` items, so a
  late document is marked too, and a named sale is never also counted as assumed;
* an older till (no field) gets the till's own rule from the cloud — only when nothing of
  ours was named and the batch was not empty, never a failed batch, never another till's
  sale, never a sale taken after the attempt started;
* an explicit empty list is the till's word: nothing assumed;
* the backfill reads stored batches the same way, once.
"""
from __future__ import annotations

import uuid
from datetime import timedelta

from app.models.card_transmission import CardTransmission, CardTransmissionItem
from app.services import transmissions as T
from test_card_transmission import card_doc, post_report, report_body, track, w  # noqa: F401


def _items(w, transmission_id):
    return {
        (i.terminal_uid, i.assumed)
        for i in w.db.query(CardTransmissionItem).filter(CardTransmissionItem.transmission_id == transmission_id)
    }


class TestTheTillsAssumedIds:
    def test_they_mark_the_legs_as_assumed_items(self, w):
        till = w.tills[0]
        track(w, till)
        _a, leg_a = card_doc(w, till, "A", "140000.00")
        body = report_body(
            batchNumber=None, transactionCount=1, amount="140000.00",
            terminalTransactionIds=[], assumedTerminalTransactionIds=["A"],
        )

        _code, out = post_report(w, till, body)

        assert out["legsMarked"] == 1 and out["legsAssumed"] == 1
        assert leg_a.transmission_id == body.id
        assert _items(w, body.id) == {("A", True)}
        assert T.untransmitted_summary(w.db, [till.id]).get(till.id) is None

    def test_a_named_sale_is_never_also_assumed(self, w):
        till = w.tills[0]
        track(w, till)
        card_doc(w, till, "A")
        card_doc(w, till, "B")
        body = report_body(terminalTransactionIds=["A"], assumedTerminalTransactionIds=["A", "B"])

        _code, out = post_report(w, till, body)

        assert _items(w, body.id) == {("A", False), ("B", True)}
        assert out["legsMarked"] == 2 and out["legsAssumed"] == 1

    def test_an_explicit_empty_list_assumes_nothing(self, w):
        till = w.tills[0]
        track(w, till)
        _tx, leg = card_doc(w, till, "A")
        body = report_body(terminalTransactionIds=[], assumedTerminalTransactionIds=[])

        _code, out = post_report(w, till, body)

        assert out["legsAssumed"] == 0 and leg.transmission_id is None

    def test_a_document_landing_later_is_marked_from_an_assumed_item(self, w):
        till = w.tills[0]
        track(w, till)
        body = report_body(terminalTransactionIds=[], assumedTerminalTransactionIds=["LATE"])
        post_report(w, till, body)

        _tx, leg = card_doc(w, till, "LATE")
        T.mark_legs_on_ingest(w.db, till, [(leg.id, "LATE")])
        w.db.expire_all()

        assert leg.transmission_id == body.id

    def test_a_failed_batch_assumes_nothing(self, w):
        till = w.tills[0]
        track(w, till)
        _tx, leg = card_doc(w, till, "A")
        body = report_body(status="failed", assumedTerminalTransactionIds=["A"])
        _code, out = post_report(w, till, body)
        assert out["legsAssumed"] == 0 and leg.transmission_id is None

    def test_the_list_says_how_many_were_assumed(self, w):
        till = w.tills[0]
        track(w, till)
        card_doc(w, till, "A")
        post_report(w, till, report_body(terminalTransactionIds=[], assumedTerminalTransactionIds=["A"]))
        listed = T.list_for_machine(w.db, till, limit=10, offset=0)["items"][0]
        assert listed["assumedTransactionCount"] == 1 and listed["legsMatched"] == 1

    def test_the_field_is_read_leniently(self):
        assert report_body().assumed_terminal_transaction_ids is None
        assert report_body(assumedTerminalTransactionIds="A,B").assumed_terminal_transaction_ids == []
        assert report_body(assumedTerminalTransactionIds=["A", " ", None, "A", 7]).assumed_terminal_transaction_ids == ["A", "7"]


class TestAnOlderTill:
    """No `assumedTerminalTransactionIds` at all: the cloud reads the batch as the till did."""

    def test_an_unnamed_non_empty_batch_takes_the_pending_sales_before_it(self, w):
        till = w.tills[0]
        track(w, till)
        _a, leg_a = card_doc(w, till, "A", at=w.now - timedelta(hours=2))
        _b, leg_b = card_doc(w, till, "B", at=w.now + timedelta(minutes=5))  # after the attempt
        body = report_body(
            terminalTransactionIds=[], transactionCount=1, startedAt=w.now.isoformat(),
        )

        _code, out = post_report(w, till, body)

        assert out["legsAssumed"] == 1
        assert leg_a.transmission_id == body.id and leg_b.transmission_id is None

    def test_a_batch_that_named_one_of_ours_assumes_nothing_more(self, w):
        till = w.tills[0]
        track(w, till)
        card_doc(w, till, "A", at=w.now - timedelta(hours=2))
        _b, leg_b = card_doc(w, till, "B", at=w.now - timedelta(hours=1))
        body = report_body(terminalTransactionIds=["A"], startedAt=w.now.isoformat())

        _code, out = post_report(w, till, body)

        assert out["legsAssumed"] == 0 and leg_b.transmission_id is None

    def test_an_empty_batch_assumes_nothing(self, w):
        till = w.tills[0]
        track(w, till)
        _tx, leg = card_doc(w, till, "A", at=w.now - timedelta(hours=1))
        _code, out = post_report(w, till, report_body(transactionCount=0, startedAt=w.now.isoformat()))
        assert out["legsAssumed"] == 0 and leg.transmission_id is None

    def test_another_tills_sale_is_never_taken(self, w):
        track(w, w.tills[0])
        track(w, w.tills[1])
        _tx, theirs = card_doc(w, w.tills[1], "X", at=w.now - timedelta(hours=1))
        post_report(w, w.tills[0], report_body(startedAt=w.now.isoformat()))
        assert theirs.transmission_id is None

    def test_sales_before_the_tracking_start_are_not_taken(self, w):
        till = w.tills[0]
        track(w, till, w.now - timedelta(hours=1))
        _tx, old = card_doc(w, till, "OLD", at=w.now - timedelta(hours=3))
        post_report(w, till, report_body(startedAt=w.now.isoformat()))
        assert old.transmission_id is None


class TestBackfill:
    def _stored_unnamed(self, w, till, *, count=1, at=None):
        row = CardTransmission(
            id=uuid.uuid4(), tenant_id=till.tenant_id, machine_id=till.id, shop_id=till.shop_id,
            trigger="shift_close", started_at=at or w.now, finished_at=at or w.now, status="success",
            transaction_count=count, terminal_transaction_count=0,
        )
        w.db.add(row)
        w.db.flush()
        return row

    def test_a_stored_unnamed_batch_is_read_once(self, w):
        till = w.tills[0]
        track(w, till)
        _tx, leg = card_doc(w, till, "A", at=w.now - timedelta(hours=1))
        row = self._stored_unnamed(w, till)

        assert T.backfill_unnamed(w.db) == {"batches": 1, "legs": 1}
        assert leg.transmission_id == row.id
        assert _items(w, row.id) == {("A", True)}
        assert T.backfill_unnamed(w.db) == {"batches": 0, "legs": 0}

    def test_the_earlier_batch_claims_the_earlier_sale(self, w):
        till = w.tills[0]
        track(w, till)
        _a, leg_a = card_doc(w, till, "A", at=w.now - timedelta(hours=5))
        _b, leg_b = card_doc(w, till, "B", at=w.now - timedelta(hours=1))
        first = self._stored_unnamed(w, till, at=w.now - timedelta(hours=3))
        second = self._stored_unnamed(w, till, at=w.now)

        T.backfill_unnamed(w.db)

        assert leg_a.transmission_id == first.id and leg_b.transmission_id == second.id

    def test_an_empty_stored_batch_is_left(self, w):
        till = w.tills[0]
        track(w, till)
        _tx, leg = card_doc(w, till, "A", at=w.now - timedelta(hours=1))
        self._stored_unnamed(w, till, count=0)
        assert T.backfill_unnamed(w.db) == {"batches": 0, "legs": 0}
        assert leg.transmission_id is None
