"""
"הנפקנו 50 שוברים וזה הראה שגיאה, ניסינו שוב והסתדר" — POST /prepaid-vouchers/batches exactly once
(app/services/prepaid_batch_create.py).

What each test pins:

* **Atomic** — a failure anywhere on the way (while the vouchers are issued, while the answer is
  built, while the duplicate check runs) leaves nothing: no batch, no vouchers, no one-off type, no
  audit line, no idempotency key. The answer is built BEFORE the one commit.
* **Idempotent** — a retry with the same `Idempotency-Key` returns the SAME batch with the same
  codes (200 + `Idempotent-Replayed`), never a second one; a retry racing the first one (its key
  row committed meanwhile) too; the same key with another body → 422; another user's key → 409.
* **Safety net** — an identical batch by the same user within two minutes, made without the
  first one's key, answers with `possibleDuplicate`; not for another count / customer / user, a
  cancelled one, or one older than the window. The dashboard cancels it with the existing cancel
  and its reason.
* **"הוסף שוברים"** — the same for more vouchers on an existing batch (kind `prepaid_batch_add`):
  a retry with the same key adds once (same serials and codes), another body or batch with the
  same key → 422, a forced failure adds nothing (no vouchers, no serials, no key).
* **Performance** — the statements of a creation do not grow with the count (bulk insert, one
  batched uniqueness check), and 500 vouchers take well under the 2 s budget.

Runs on the in-memory SQLite world of tests/shift_world.py.
"""
from __future__ import annotations

import time
import uuid
from datetime import timedelta

import pytest
from fastapi import FastAPI, HTTPException, Response
from sqlalchemy import event

from app.models.command_request_key import CommandRequestKey
from app.models.prepaid_voucher import (
    PrepaidVoucher,
    PrepaidVoucherBatch,
    PrepaidVoucherEvent,
    PrepaidVoucherType,
)
from app.models.user import User, UserRole
from app.routers import prepaid_vouchers as R
from app.schemas.prepaid_voucher import PrepaidVoucherAddIn, PrepaidVoucherBatchCreate, PrepaidVoucherCancelIn
from app.services import command_idempotency as idem
from app.services import prepaid_batch_create as PBC
from app.services import prepaid_vouchers as PV
from test_prepaid_vouchers import w  # noqa: F401 - the shared world fixture


def _body(w, *, count=50, name="הפקה — פסטיבל", customer="לקוח א", group_size=None, items=None, **extra):
    return PrepaidVoucherBatchCreate(
        name=name,
        companyId=w.company.id,
        redemptionAccounting="payment",
        customerName=customer,
        eventName="פסטיבל הקיץ",
        items=items or [{"productId": w.hotdog.id, "quantity": 1}, {"productId": w.drink.id, "quantity": 2}],
        count=count,
        groupSize=group_size,
        **extra,
    )


def _create(w, body, *, key=None, user=None):
    # As FastAPI injects it: no status of its own unless the endpoint sets one (201 stays).
    response = Response()
    response.status_code = None
    out = R.create_prepaid_voucher_batch(
        body, current_user=user or w.admin, active_tenant_id=w.tenant.id, db=w.db,
        response=response, idempotency_key=key,
    )
    return out, response


def _codes(w, batch_id):
    rows = w.db.query(PrepaidVoucher).filter(PrepaidVoucher.batch_id == uuid.UUID(str(batch_id)))
    return sorted((v.serial, v.code, v.group_no) for v in rows)


def _nothing_written(w):
    assert w.db.query(PrepaidVoucherBatch).count() == 0
    assert w.db.query(PrepaidVoucher).count() == 0
    assert w.db.query(PrepaidVoucherEvent).count() == 0
    assert w.db.query(PrepaidVoucherType).count() == 0
    assert w.db.query(CommandRequestKey).count() == 0


# ── Atomic ────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("key", [None, "batch-key-atomic-1"])
def test_a_failure_while_issuing_leaves_nothing(w, monkeypatch, key):
    """The vouchers are flushed, then the audit line fails: no batch, no vouchers, no key."""

    def boom(*_a, **_k):
        raise RuntimeError("forced failure after the vouchers were flushed")

    monkeypatch.setattr(PV, "_event", boom)
    with pytest.raises(RuntimeError):
        _create(w, _body(w, count=50, group_size=10), key=key)
    _nothing_written(w)


@pytest.mark.parametrize("stage", ["batch_out", "duplicate_of"])
def test_a_failure_while_answering_leaves_nothing(w, monkeypatch, stage):
    """The answer is built before the commit: a failure there can no longer leave a batch behind."""
    target = PV if stage == "batch_out" else PBC

    def boom(*_a, **_k):
        raise RuntimeError(f"forced failure in {stage}")

    monkeypatch.setattr(target, stage, boom)
    with pytest.raises(RuntimeError):
        _create(w, _body(w), key="batch-key-answer-" + stage)
    _nothing_written(w)


def test_after_a_failure_the_same_key_creates_the_batch_once(w, monkeypatch):
    """A failed first try left no key behind: the retry with the same key makes the batch."""
    real = PV._issue
    calls = {"n": 0}

    def flaky(*a, **k):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("first try fails")
        return real(*a, **k)

    monkeypatch.setattr(PV, "_issue", flaky)
    body = _body(w)
    with pytest.raises(RuntimeError):
        _create(w, body, key="batch-key-flaky-1")
    _nothing_written(w)
    out, resp = _create(w, body, key="batch-key-flaky-1")
    assert resp.status_code is None  # a new batch: 201
    assert out["stats"]["total"] == 50
    assert w.db.query(PrepaidVoucherBatch).count() == 1


def test_one_commit_for_the_whole_batch(w, monkeypatch):
    """Batch, type, vouchers, groups, log and key: written by one commit (the prune is its own)."""
    commits = []
    real_commit = w.db.commit

    def counting_commit():
        commits.append(w.db.query(PrepaidVoucher).count())
        return real_commit()

    monkeypatch.setattr(w.db, "commit", counting_commit)
    _create(w, _body(w, count=30, group_size=10), key="batch-key-one-commit")
    # The first commit already carries every voucher; the only other one is the key prune.
    assert commits and commits[0] == 30
    assert len(commits) <= 2


# ── Idempotent ────────────────────────────────────────────────────────────────


def test_a_retry_with_the_same_key_returns_the_same_batch_and_codes(w):
    body = _body(w, count=50, group_size=10)
    first, r1 = _create(w, body, key="batch-key-retry-0001")
    codes = _codes(w, first["id"])
    assert len(codes) == 50 and r1.status_code is None  # 201
    again, r2 = _create(w, body, key="batch-key-retry-0001")
    assert again["id"] == first["id"]
    assert r2.status_code == 200
    assert r2.headers.get(idem.REPLAY_HEADER) == "true"
    assert _codes(w, again["id"]) == codes
    assert w.db.query(PrepaidVoucherBatch).count() == 1
    assert w.db.query(PrepaidVoucher).count() == 50
    # The replay reads the batch as it is now, with the same shape as the first answer.
    assert again["stats"]["total"] == 50 and again["groupCount"] == 5


def test_a_replay_shows_the_batch_as_it_is_now(w):
    body = _body(w, count=5)
    first, _ = _create(w, body, key="batch-key-now-00001")
    R.cancel_prepaid_voucher_batch(first["id"], PrepaidVoucherCancelIn(reason="בדיקה"),
                                   current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
    again, resp = _create(w, body, key="batch-key-now-00001")
    assert again["id"] == first["id"] and again["status"] == "cancelled" and resp.status_code == 200
    assert w.db.query(PrepaidVoucherBatch).count() == 1


def test_a_retry_racing_the_first_gets_the_first_batch(w, monkeypatch):
    """The first request's key row commits while the retry runs: the retry answers with it."""
    body = _body(w, count=20)
    first, _ = _create(w, body, key="batch-key-race-00001")
    real_find = idem.find
    seen = {"n": 0}

    def late_find(*a, **k):
        seen["n"] += 1
        # The retry's first look happens "before the first request committed".
        return None if seen["n"] == 1 else real_find(*a, **k)

    monkeypatch.setattr(idem, "find", late_find)
    again, resp = _create(w, body, key="batch-key-race-00001")
    assert again["id"] == first["id"] and resp.status_code == 200
    assert w.db.query(PrepaidVoucherBatch).count() == 1
    assert w.db.query(PrepaidVoucher).count() == 20


def test_the_same_key_with_another_body_is_refused(w):
    _create(w, _body(w, count=50), key="batch-key-reuse-0001")
    with pytest.raises(HTTPException) as e:
        _create(w, _body(w, count=51), key="batch-key-reuse-0001")
    assert e.value.status_code == 422
    assert e.value.detail["code"] == "idempotency_key_reused"
    assert w.db.query(PrepaidVoucherBatch).count() == 1
    assert w.db.query(PrepaidVoucher).count() == 50


def test_another_users_key_is_refused(w):
    other = User(id=uuid.uuid4(), role=UserRole.SUPER_ADMIN, tenant_id=w.tenant.id, email="o@x", username="other")
    w.db.add(other)
    w.db.commit()
    _create(w, _body(w, count=3), key="batch-key-user-00001")
    with pytest.raises(HTTPException) as e:
        _create(w, _body(w, count=3), key="batch-key-user-00001", user=other)
    assert e.value.status_code == 409
    assert w.db.query(PrepaidVoucherBatch).count() == 1


def test_a_malformed_key_is_refused_before_anything_is_written(w):
    with pytest.raises(HTTPException) as e:
        _create(w, _body(w, count=3), key="bad key!")
    assert e.value.status_code == 422
    _nothing_written(w)


def test_another_key_is_another_batch(w):
    a, _ = _create(w, _body(w, count=3), key="batch-key-a-0000001")
    b, _ = _create(w, _body(w, count=3), key="batch-key-b-0000001")
    assert a["id"] != b["id"]
    assert not set(c for _, c, _ in _codes(w, a["id"])) & set(c for _, c, _ in _codes(w, b["id"]))


def test_the_endpoint_reads_the_idempotency_key_header():
    app = FastAPI()
    app.include_router(R.router)
    op = app.openapi()["paths"]["/prepaid-vouchers/batches"]["post"]
    headers = {p["name"] for p in op.get("parameters", []) if p["in"] == "header"}
    assert "Idempotency-Key" in headers
    assert "prepaid_batch_create" in idem.KINDS


# ── Safety net: an identical batch a moment ago ─────────────────────────────────


def test_an_identical_batch_without_the_key_is_flagged(w):
    first, _ = _create(w, _body(w, count=50))
    assert first["possibleDuplicate"] is None
    second, _ = _create(w, _body(w, count=50))
    dup = second["possibleDuplicate"]
    assert dup is not None and dup["id"] == first["id"]
    assert dup["count"] == 50 and dup["name"] == first["name"] and dup["customerName"] == "לקוח א"
    assert dup["cancelReason"] == PBC.DUPLICATE_CANCEL_REASON
    # Never blocked: both batches exist.
    assert w.db.query(PrepaidVoucherBatch).count() == 2


def test_an_identical_batch_with_another_key_is_flagged_too(w):
    """A page reloaded between the two clicks (a new key): the key cannot help, the net does."""
    first, _ = _create(w, _body(w, count=50), key="batch-key-net-a-0001")
    second, _ = _create(w, _body(w, count=50), key="batch-key-net-b-0001")
    assert second["possibleDuplicate"]["id"] == first["id"]


@pytest.mark.parametrize("change", ["count", "customer", "name", "items"])
def test_a_different_batch_is_not_flagged(w, change):
    _create(w, _body(w, count=50))
    if change == "count":
        body = _body(w, count=51)
    elif change == "customer":
        body = _body(w, customer="לקוח ב")
    elif change == "name":
        body = _body(w, name="הפקה אחרת")
    else:
        body = _body(w, items=[{"productId": w.hotdog.id, "quantity": 2}])
    second, _ = _create(w, body)
    assert second["possibleDuplicate"] is None


def test_not_flagged_for_another_user_a_cancelled_or_an_old_batch(w):
    other = User(id=uuid.uuid4(), role=UserRole.SUPER_ADMIN, tenant_id=w.tenant.id, email="o2@x", username="other2")
    w.db.add(other)
    w.db.commit()
    first, _ = _create(w, _body(w, count=7), user=other)
    second, _ = _create(w, _body(w, count=7))
    assert second["possibleDuplicate"] is None  # another user's batch

    R.cancel_prepaid_voucher_batch(second["id"], None, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
    third, _ = _create(w, _body(w, count=7))
    assert third["possibleDuplicate"] is None  # the identical one is cancelled

    row = w.db.get(PrepaidVoucherBatch, uuid.UUID(third["id"]))
    row.created_at = PV._now() - PBC.DUPLICATE_WINDOW - timedelta(seconds=5)
    w.db.commit()
    fourth, _ = _create(w, _body(w, count=7))
    assert fourth["possibleDuplicate"] is None  # older than the window


def test_the_replay_keeps_the_first_answers_warning(w):
    first, _ = _create(w, _body(w, count=4))
    second, _ = _create(w, _body(w, count=4), key="batch-key-warn-00001")
    again, resp = _create(w, _body(w, count=4), key="batch-key-warn-00001")
    assert resp.status_code == 200 and again["id"] == second["id"]
    assert again["possibleDuplicate"]["id"] == first["id"]


def test_the_duplicate_is_cancelled_with_its_reason(w):
    first, _ = _create(w, _body(w, count=4))
    second, _ = _create(w, _body(w, count=4))
    dup = second["possibleDuplicate"]
    out = R.cancel_prepaid_voucher_batch(
        dup["id"], PrepaidVoucherCancelIn(reason=dup["cancelReason"]),
        current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
    )
    assert out["status"] == "cancelled" and out["id"] == first["id"]
    ev = w.db.query(PrepaidVoucherEvent).filter(PrepaidVoucherEvent.action == "cancel_batch").one()
    assert ev.reason == PBC.DUPLICATE_CANCEL_REASON and ev.count == 4
    kept = w.db.get(PrepaidVoucherBatch, uuid.UUID(second["id"]))
    assert kept.status == "active"


# ── Performance ───────────────────────────────────────────────────────────────


def _statements(w, count, key=None):
    engine = w.db.get_bind()
    seen = []

    def count_it(conn, cursor, statement, parameters, context, executemany):
        seen.append(statement)

    event.listen(engine, "before_cursor_execute", count_it)
    try:
        t0 = time.perf_counter()
        out, _ = _create(w, _body(w, count=count, name=f"perf {count}", group_size=10), key=key)
        elapsed = time.perf_counter() - t0
    finally:
        event.remove(engine, "before_cursor_execute", count_it)
    assert out["stats"]["total"] == count
    return len(seen), elapsed


def test_statements_do_not_grow_with_the_count(w):
    small, _ = _statements(w, 50, key="batch-key-perf-small1")
    large, elapsed = _statements(w, 500, key="batch-key-perf-large1")
    # Bulk insert and one batched uniqueness check: 500 vouchers cost what 50 do (± a batch).
    assert large <= small + 3, (small, large)
    assert large < 60, large
    assert elapsed < 2.0, elapsed


# ── "הוסף שוברים": more vouchers on an existing batch, exactly once ──────────────


def _add(w, batch_id, body, *, key=None, user=None):
    response = Response()
    response.status_code = None
    out = R.add_prepaid_vouchers(
        str(batch_id), body, current_user=user or w.admin, active_tenant_id=w.tenant.id, db=w.db,
        response=response, idempotency_key=key,
    )
    return out, response


def _keys_of(w, kind):
    return w.db.query(CommandRequestKey).filter(CommandRequestKey.kind == kind).count()


def test_a_retried_add_adds_once_with_the_same_serials_and_codes(w):
    batch, _ = _create(w, _body(w, count=10, group_size=5))
    first, r1 = _add(w, batch["id"], PrepaidVoucherAddIn(count=6), key="batch-add-retry-0001")
    assert r1.status_code is None and first["stats"]["total"] == 16  # 201
    codes = _codes(w, batch["id"])
    again, r2 = _add(w, batch["id"], PrepaidVoucherAddIn(count=6), key="batch-add-retry-0001")
    assert r2.status_code == 200 and r2.headers.get(idem.REPLAY_HEADER) == "true"
    assert again["id"] == batch["id"] and again["stats"]["total"] == 16
    assert _codes(w, batch["id"]) == codes
    assert [s for s, _, _ in codes] == list(range(1, 17))
    row = w.db.get(PrepaidVoucherBatch, uuid.UUID(batch["id"]))
    assert row.next_serial == 17
    adds = w.db.query(PrepaidVoucherEvent).filter(PrepaidVoucherEvent.action == "add").count()
    assert adds == 1


def test_a_retry_racing_the_first_add_adds_once(w, monkeypatch):
    batch, _ = _create(w, _body(w, count=3))
    _add(w, batch["id"], PrepaidVoucherAddIn(count=4), key="batch-add-race-00001")
    real_find = idem.find
    seen = {"n": 0}

    def late_find(*a, **k):
        seen["n"] += 1
        return None if seen["n"] == 1 else real_find(*a, **k)

    monkeypatch.setattr(idem, "find", late_find)
    again, resp = _add(w, batch["id"], PrepaidVoucherAddIn(count=4), key="batch-add-race-00001")
    assert resp.status_code == 200 and again["stats"]["total"] == 7
    assert w.db.query(PrepaidVoucher).count() == 7


def test_the_same_add_key_with_another_body_or_batch_is_refused(w):
    batch, _ = _create(w, _body(w, count=3))
    other, _ = _create(w, _body(w, count=3, name="אצווה שנייה"))
    _add(w, batch["id"], PrepaidVoucherAddIn(count=5), key="batch-add-reuse-0001")
    for target, body in ((batch["id"], PrepaidVoucherAddIn(count=6)),
                         (batch["id"], PrepaidVoucherAddIn(count=5, groupSize=5)),
                         (other["id"], PrepaidVoucherAddIn(count=5))):
        with pytest.raises(HTTPException) as e:
            _add(w, target, body, key="batch-add-reuse-0001")
        assert e.value.status_code == 422 and e.value.detail["code"] == "idempotency_key_reused"
    assert w.db.query(PrepaidVoucher).count() == 3 + 3 + 5


@pytest.mark.parametrize("key", [None, "batch-add-fail-00001"])
@pytest.mark.parametrize("stage", ["event", "answer"])
def test_a_failed_add_adds_nothing(w, monkeypatch, key, stage):
    batch, _ = _create(w, _body(w, count=4, group_size=2))
    before = _codes(w, batch["id"])

    def boom(*_a, **_k):
        raise RuntimeError(f"forced failure ({stage})")

    monkeypatch.setattr(PV, "_event" if stage == "event" else "batch_out", boom)
    with pytest.raises(RuntimeError):
        _add(w, batch["id"], PrepaidVoucherAddIn(count=6), key=key)
    monkeypatch.undo()
    assert _codes(w, batch["id"]) == before
    row = w.db.get(PrepaidVoucherBatch, uuid.UUID(batch["id"]))
    assert row.next_serial == 5
    assert w.db.query(PrepaidVoucherEvent).filter(PrepaidVoucherEvent.action == "add").count() == 0
    assert _keys_of(w, PBC.ADD_KIND) == 0
    # The same key after the failure adds them, once.
    out, _ = _add(w, batch["id"], PrepaidVoucherAddIn(count=6), key=key)
    assert out["stats"]["total"] == 10


def test_another_add_key_adds_again_and_the_endpoint_reads_the_header(w):
    batch, _ = _create(w, _body(w, count=2))
    _add(w, batch["id"], PrepaidVoucherAddIn(count=2), key="batch-add-one-000001")
    out, _ = _add(w, batch["id"], PrepaidVoucherAddIn(count=2), key="batch-add-two-000001")
    assert out["stats"]["total"] == 6  # two deliberate adds are two adds
    assert "prepaid_batch_add" in idem.KINDS
    app = FastAPI()
    app.include_router(R.router)
    op = app.openapi()["paths"]["/prepaid-vouchers/batches/{batch_id}/vouchers"]["post"]
    assert "Idempotency-Key" in {p["name"] for p in op.get("parameters", []) if p["in"] == "header"}
