"""
"הוסף שוברים לסדרה" and "ייצוא כל הסדרה ל-PDF" (the owner's spec of 11.10.2026 §11–§12), and the lookup's
quota numbers (§5).

* **Add** — 100 + 50 = 150 vouchers, 150 unique codes, serials 1..150; the first 100 keep their codes,
  statuses and balances; the answer says what this run made (`added`) and the new total; the run is
  on the batch's audit trail (who, when, how many, serials).
* **Exactly once** — a retry with the same operation id (`Idempotency-Key`, or the body's
  `clientRequestId`) adds nothing and answers with the first run; a run that did not make every voucher
  it was asked for is an error and leaves nothing; a cancelled or expired batch is refused (409).
* **Export the whole batch** — by the batch id: all 150 in one file, the same codes, serial order,
  used ones too, cancelled ones never; no balance moves; the batch's `exportCount` is the file's size.
* **Lookup** — `quota` / `used` / `remaining` (and per item `used`).

Runs on the in-memory SQLite world of tests/shift_world.py.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException, Response

from app.models.command_request_key import CommandRequestKey
from app.models.prepaid_voucher import PrepaidVoucher, PrepaidVoucherBatch, PrepaidVoucherEvent
from app.routers import prepaid_vouchers as R
from app.schemas.prepaid_voucher import PrepaidVoucherAddIn
from app.services import command_idempotency as idem
from app.services import prepaid_batch_create as PBC
from app.services import prepaid_voucher_pdf as PDF
from app.services import prepaid_vouchers as PV
from test_prepaid_vouchers import _ctx, lookup, make_batch, redeem, w  # noqa: F401 - `w` is the fixture


def _add(w, batch_id, count, *, key=None, body_key=None, user=None):
    response = Response()
    response.status_code = None
    out = R.add_prepaid_vouchers(
        str(batch_id), PrepaidVoucherAddIn(count=count, clientRequestId=body_key),
        current_user=user or w.admin, active_tenant_id=w.tenant.id, db=w.db, response=response, idempotency_key=key,
    )
    return out, response


def _rows(w, batch_id):
    return (
        w.db.query(PrepaidVoucher).filter(PrepaidVoucher.batch_id == uuid.UUID(str(batch_id)))
        .order_by(PrepaidVoucher.serial).all()
    )


def _state(w, batch_id):
    """Every voucher's serial, code, status and balance."""
    w.db.expire_all()
    return [(v.serial, v.code, v.status, dict(v.remaining or {})) for v in _rows(w, batch_id)]


def _batch_row(w, batch_id) -> PrepaidVoucherBatch:
    w.db.expire_all()
    return w.db.get(PrepaidVoucherBatch, uuid.UUID(str(batch_id)))


@pytest.fixture
def hundred(w):
    """A batch of 100, one of them redeemed in full and one in part (split allowed)."""
    batch = make_batch(w, count=100, split=True)
    rows = _rows(w, batch["id"])
    redeem(w, rows[0].code, [(w.hotdog, 1), (w.drink, 2)])
    redeem(w, rows[1].code, [(w.drink, 1)])
    return batch


# ── Add ───────────────────────────────────────────────────────────────────────


class TestAdd:
    def test_100_plus_50_is_150_unique_codes_and_the_first_100_are_untouched(self, w, hundred):
        before = _state(w, hundred["id"])
        assert [s for s, *_ in before] == list(range(1, 101))
        assert before[0][2] == "used" and before[1][2] == "partially_used"

        out, resp = _add(w, hundred["id"], 50, key="vflow-add-150-0001")

        assert resp.status_code is None  # 201
        after = _state(w, hundred["id"])
        assert [s for s, *_ in after] == list(range(1, 151))
        assert len({code for _, code, _, _ in after}) == 150
        assert after[:100] == before  # codes, statuses and balances of the first hundred kept
        assert all(st == "active" and rem == {str(w.hotdog.id): 1, str(w.drink.id): 2} for _, _, st, rem in after[100:])
        assert out["stats"]["total"] == 150 and out["exportCount"] == 150
        added = out["added"]
        assert (added["count"], added["fromSerial"], added["toSerial"], added["total"], added["replayed"]) == (
            50, 101, 150, 150, False)
        assert added["userName"] == "admin" and added["createdAt"]
        ev = w.db.query(PrepaidVoucherEvent).filter(PrepaidVoucherEvent.action == "add").one()
        assert (str(ev.id), ev.count, ev.user_id, ev.details["fromSerial"], ev.details["toSerial"]) == (
            added["eventId"], 50, w.admin.id, 101, 150)
        assert _batch_row(w, hundred["id"]).next_serial == 151

    def test_the_new_vouchers_take_the_batchs_settings(self, w):
        until = datetime.now(timezone.utc) + timedelta(days=30)
        batch = make_batch(w, count=2, valid_until=until, shops=[w.shop.id])
        out, _ = _add(w, batch["id"], 3)
        # One batch, one set of terms: validity, shops, goods and type are the batch's, for every voucher.
        assert (out["validUntil"], out["shopIds"], out["items"], out["type"]) == (
            batch["validUntil"], batch["shopIds"], batch["items"], batch["type"])
        newest = _rows(w, batch["id"])[-1]
        assert lookup(w, newest.code)["redeemable"] is True
        assert lookup(w, newest.code)["validUntil"] == batch["validUntil"]

    def test_a_retry_with_the_same_operation_id_adds_nothing(self, w, hundred):
        first, _ = _add(w, hundred["id"], 50, key="vflow-add-retry-001")
        state = _state(w, hundred["id"])
        again, resp = _add(w, hundred["id"], 50, key="vflow-add-retry-001")
        assert resp.status_code == 200 and resp.headers.get(idem.REPLAY_HEADER) == "true"
        assert _state(w, hundred["id"]) == state and len(state) == 150
        assert again["stats"]["total"] == 150
        assert again["added"] == {**first["added"], "replayed": True}
        assert w.db.query(PrepaidVoucherEvent).filter(PrepaidVoucherEvent.action == "add").count() == 1

    def test_the_operation_id_may_come_in_the_body(self, w, hundred):
        _add(w, hundred["id"], 50, body_key="vflow-add-body-0001")
        again, resp = _add(w, hundred["id"], 50, body_key="vflow-add-body-0001")
        assert resp.status_code == 200 and again["added"]["replayed"] is True
        assert len(_rows(w, hundred["id"])) == 150
        # The header and the body name one operation: the same id either way is one add.
        _, resp = _add(w, hundred["id"], 50, key="vflow-add-body-0001")
        assert resp.status_code == 200 and len(_rows(w, hundred["id"])) == 150

    def test_a_run_short_of_its_count_is_an_error_and_leaves_nothing(self, w, hundred, monkeypatch):
        state = _state(w, hundred["id"])
        real = PV._issue

        def short(db, batch, count, group_size=None):
            return real(db, batch, count - 1, group_size)  # one voucher "lost" on the way

        monkeypatch.setattr(PV, "_issue", short)
        with pytest.raises(HTTPException) as e:
            _add(w, hundred["id"], 50, key="vflow-add-short-001")
        assert e.value.status_code == 500 and e.value.detail == PV.ADD_INCOMPLETE
        monkeypatch.undo()
        assert _state(w, hundred["id"]) == state
        assert _batch_row(w, hundred["id"]).next_serial == 101
        assert w.db.query(PrepaidVoucherEvent).filter(PrepaidVoucherEvent.action == "add").count() == 0
        assert w.db.query(CommandRequestKey).filter(CommandRequestKey.kind == PBC.ADD_KIND).count() == 0
        # The same operation again, now whole: added once.
        out, _ = _add(w, hundred["id"], 50, key="vflow-add-short-001")
        assert out["added"]["count"] == 50 and len(_rows(w, hundred["id"])) == 150

    def test_a_cancelled_batch_is_refused(self, w):
        batch = make_batch(w, count=3)
        R.cancel_prepaid_voucher_batch(batch["id"], None, **_ctx(w))
        with pytest.raises(HTTPException) as e:
            _add(w, batch["id"], 5, key="vflow-add-cancel-01")
        assert (e.value.status_code, e.value.detail) == (409, PV.BATCH_CANCELLED)
        assert len(_rows(w, batch["id"])) == 3

    def test_an_expired_batch_is_refused_until_its_validity_is_extended(self, w):
        batch = make_batch(w, count=3, valid_until=datetime.now(timezone.utc) + timedelta(days=1))
        row = _batch_row(w, batch["id"])
        row.valid_until = datetime.now(timezone.utc) - timedelta(days=1)
        w.db.commit()
        with pytest.raises(HTTPException) as e:
            _add(w, batch["id"], 5, key="vflow-add-expired1")
        assert (e.value.status_code, e.value.detail) == (409, PV.BATCH_EXPIRED)
        assert len(_rows(w, batch["id"])) == 3
        row = _batch_row(w, batch["id"])
        row.valid_until = datetime.now(timezone.utc) + timedelta(days=10)
        w.db.commit()
        out, _ = _add(w, batch["id"], 5, key="vflow-add-expired2")
        assert out["stats"]["total"] == 8

    def test_a_shop_manager_outside_the_batch_may_not_add(self, w):
        from app.models.user import User, UserRole

        batch = make_batch(w, count=3)  # company-wide: the shop manager does not cover the company
        manager = w.db.query(User).filter(User.role == UserRole.SHOP_MANAGER).first()
        with pytest.raises(HTTPException) as e:
            _add(w, batch["id"], 5, user=manager)
        assert e.value.status_code == 403
        assert len(_rows(w, batch["id"])) == 3


# ── Export the whole batch ────────────────────────────────────────────────────


def _export(w, batch_id, monkeypatch, *, include_used=True, fmt="pdf"):
    seen = {}

    def fake_pdf(batch, vouchers, g, *, logo=None, labels=None, opts=None, cover=None, made=None):
        seen["vouchers"] = [(v.serial, v.code) for v in vouchers]
        seen["cover"] = cover
        return b"%PDF-stub"

    monkeypatch.setattr(PDF, "render_pdf", fake_pdf)
    res = R.prepaid_vouchers_file(
        str(batch_id), fmt=fmt, layout="ticket80x50", width=None, height=None, voucher_id=None,
        include_used=include_used, group=None, covers=True, **_ctx(w),
    )
    return res, seen


class TestExportAll:
    def test_the_whole_batch_is_one_file_with_every_run_and_the_same_codes(self, w, hundred, monkeypatch):
        _add(w, hundred["id"], 50, key="vflow-export-add-01")
        before = _state(w, hundred["id"])
        res, seen = _export(w, hundred["id"], monkeypatch)
        assert res.media_type == "application/pdf" and res.body == b"%PDF-stub"
        # All 150 — the first 100 and the 50 added, the redeemed ones too — by serial, with their codes.
        assert seen["vouchers"] == [(s, c) for s, c, _, _ in before]
        assert len(seen["vouchers"]) == 150 and seen["cover"] is None
        assert res.headers[R.VOUCHER_COUNT_HEADER] == "150"
        # Nothing issued, no balance or status moved.
        assert _state(w, hundred["id"]) == before
        # The batch page's counter reads the same rows.
        out = R.get_prepaid_voucher_batch(hundred["id"], **_ctx(w))
        assert out["exportCount"] == 150 == len(seen["vouchers"])
        ev = w.db.query(PrepaidVoucherEvent).filter(PrepaidVoucherEvent.action == "export").one()
        assert (ev.count, ev.details["format"], ev.details["fromSerial"], ev.details["toSerial"]) == (150, "pdf", 1, 150)

    def test_a_second_export_has_the_same_codes_and_includes_a_later_run(self, w, hundred, monkeypatch):
        _, first = _export(w, hundred["id"], monkeypatch)
        _, again = _export(w, hundred["id"], monkeypatch)
        assert again["vouchers"] == first["vouchers"] and len(first["vouchers"]) == 100
        _add(w, hundred["id"], 50, key="vflow-export-add-02")
        _, later = _export(w, hundred["id"], monkeypatch)
        assert later["vouchers"][:100] == first["vouchers"] and len(later["vouchers"]) == 150

    def test_a_cancelled_voucher_is_left_out_and_the_counter_says_so(self, w, hundred, monkeypatch):
        _add(w, hundred["id"], 50, key="vflow-export-add-03")
        victim = _rows(w, hundred["id"])[120]
        R.cancel_prepaid_voucher(str(victim.id), None, **_ctx(w))
        res, seen = _export(w, hundred["id"], monkeypatch)
        assert len(seen["vouchers"]) == 149 and victim.serial not in {s for s, _ in seen["vouchers"]}
        out = R.get_prepaid_voucher_batch(hundred["id"], **_ctx(w))
        assert out["exportCount"] == 149 == int(res.headers[R.VOUCHER_COUNT_HEADER])

    def test_the_other_files_still_work(self, w, hundred, monkeypatch):
        _add(w, hundred["id"], 50, key="vflow-export-add-04")
        # Without the used ones (printing for handing out), as before.
        _, seen = _export(w, hundred["id"], monkeypatch, include_used=False)
        assert len(seen["vouchers"]) == 149  # the fully redeemed one left out; the partly redeemed one kept
        csv = R.prepaid_vouchers_file(
            hundred["id"], fmt="csv", layout="ticket80x50", width=None, height=None, voucher_id=None,
            include_used=True, group=None, covers=True, **_ctx(w),
        )
        assert csv.headers[R.VOUCHER_COUNT_HEADER] == "150" and csv.body.decode("utf-8-sig").count("\n") >= 150


# ── Lookup: the quota numbers ─────────────────────────────────────────────────


class TestLookupQuota:
    def test_a_fixed_list_counts_its_units(self, w):
        batch = make_batch(w, count=1, split=True)  # 1 hotdog + 2 drinks
        code = _rows(w, batch["id"])[0].code
        out = lookup(w, code)
        assert (out["quotaUnit"], out["quota"], out["used"], out["remaining"]) == ("units", 3, 0, 3)
        redeem(w, code, [(w.drink, 1)])
        out = lookup(w, code)
        assert (out["quota"], out["used"], out["remaining"]) == (3, 1, 2)
        drink = next(i for i in out["items"] if i["productId"] == str(w.drink.id))
        assert (drink["quantity"], drink["used"], drink["remaining"]) == (2, 1, 1)
