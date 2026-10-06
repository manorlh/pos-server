"""
"מצב הדרכה" — a shop's training mode (app/services/training_mode.py,
docs/SPEC_TRAINING_MODE.md, phase 1).

* A normal sale goes through exactly as before — in a shop that is not in training, and
  in a training shop when the till has not switched yet (no flag, a real number).
* A training document (flagged `training`, or a "ה-" number in a training shop) lands in
  `training_documents` and never in the real tables; the till is answered as for a real
  one (`accepted`, then `duplicate`), in batch order, so its outbox clears. No exception
  detection and no "transactions synced" signal for it.
* A training document after the shop left training mode is dropped and logged.
* Shifts (open and close — no 409 for documents the real table does not hold), the
  till's Z, its events and its own training documents are quarantined the same way.
* Turning it on is refused while a real shift is open; turning it off checks the name,
  reports blockers, purges the quarantine and the training table orders, and logs.
* The flag reaches the till: `GET /machines/me`, the heartbeat and the settings sync.

Runs on the in-memory SQLite world of tests/shift_world.py.
"""
from __future__ import annotations

import uuid
from datetime import timedelta
from decimal import Decimal

import pytest
from fastapi import BackgroundTasks, HTTPException, Response

from app.models.audit_exception import TillEvent
from app.models.shift import Shift, ShiftStatus
from app.models.sync_log import SyncLog
from app.models.tables import DiningTable, TableOrder, TableZone
from app.models.training import TrainingAuditLog, TrainingDocument
from app.models.transaction import Transaction
from app.models.user import User, UserRole
from app.models.z_report import ZReport
from app.routers import exceptions as exceptions_router
from app.routers import machines as machines_router
from app.routers import shops as shops_router
from app.routers import sync as sync_router
from app.routers import training_mode as R
from app.schemas.audit_exception import TillEventIn
from app.schemas.shift import ShiftCloseIn, ShiftOpenIn
from app.schemas.shop import ShopCreate
from app.schemas.till_z import TillZIn
from app.schemas.transaction import TransactionsBatchEnvelope
from app.services import ably_notify
from app.services import exceptions as exceptions_service
from app.services import training_mode as TM
from shift_world import NOW, TODAY, accept_str_uuids, make_world


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    world = make_world()
    monkeypatch.setattr(ably_notify, "publish_close_shift_notify", lambda *a, **k: None)
    monkeypatch.setattr(ably_notify, "publish_settings_notify", lambda *a, **k: None)
    world.synced = []
    monkeypatch.setattr(sync_router, "publish_transactions_synced", lambda *a, **k: world.synced.append(a))
    world.detected = []

    def _detect(_db, fn, *args):
        if fn is exceptions_service.detect_transactions:
            world.detected.extend(str(i) for i in args[0])

    monkeypatch.setattr(exceptions_service, "detect_safely", _detect)
    return world


# ── builders ──────────────────────────────────────────────────────────────────

_numbers = iter(range(7000, 10**6))


def _doc(total="10.00", *, number=None, training=None, shift_id=None, method="cash", items=None, doc_type=320):
    at = NOW.isoformat()
    body = {
        "id": str(uuid.uuid4()),
        "transactionNumber": number or str(next(_numbers)),
        "status": "completed", "documentType": doc_type, "totalAmount": total,
        "createdAt": at, "updatedAt": at, "businessDate": str(TODAY),
        "paymentMethod": method,
        "items": items if items is not None else [{
            "id": str(uuid.uuid4()), "productName": "קפה", "sku": "C-1",
            "quantity": "1", "unitPrice": total, "totalPrice": total,
        }],
    }
    if shift_id is not None:
        body["shiftId"] = str(shift_id)
    if training is not None:
        body["training"] = training
    return body


def _push(w, till, docs):
    return sync_router.post_transactions(
        machine_id=str(till.id), body=TransactionsBatchEnvelope(transactions=docs), machine=till, db=w.db,
    )


def _real(w, doc):
    w.db.expire_all()
    return w.db.get(Transaction, uuid.UUID(doc["id"]))


def _quarantined(w, kind=None):
    q = w.db.query(TrainingDocument).filter(TrainingDocument.shop_id == w.shop.id)
    if kind is not None:
        q = q.filter(TrainingDocument.kind == kind)
    return q.all()


def _on(w, shop=None):
    TM.start(w.db, shop or w.shop, w.admin)
    w.db.flush()


def _user(w, role, **kw):
    u = User(id=uuid.uuid4(), role=role, tenant_id=w.tenant.id, email=f"{uuid.uuid4().hex[:8]}@x",
             username=uuid.uuid4().hex[:8], **kw)
    w.db.add(u)
    w.db.flush()
    return u


def _enable(w, user=None):
    return R.enable_training_mode(
        w.shop.id, BackgroundTasks(), current_user=user or w.admin, active_tenant_id=w.tenant.id, db=w.db,
    )


def _disable(w, name=None, *, remove_demo=False, force=False, user=None):
    return R.disable_training_mode(
        w.shop.id,
        R.DisableIn(confirmName=w.shop.name if name is None else name, removeDemoMenu=remove_demo, force=force),
        BackgroundTasks(), current_user=user or w.admin, active_tenant_id=w.tenant.id, db=w.db,
    )


def _table_order(w, number, status="open", **kw):
    zone = w.db.query(TableZone).filter(TableZone.shop_id == w.shop.id).first()
    if zone is None:
        zone = TableZone(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, name="אולם")
        w.db.add(zone)
        w.db.flush()
    table = DiningTable(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, zone_id=zone.id, number=number,
                        lock_machine_id=w.tills[0].id if status == "open" else None)
    w.db.add(table)
    w.db.flush()
    order = TableOrder(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, table_id=table.id,
                       table_number=number, status=status, opened_at=NOW, **kw)
    w.db.add(order)
    w.db.flush()
    return order


# ── Normal documents are untouched ────────────────────────────────────────────


def test_a_normal_sale_goes_through_unchanged_in_a_shop_not_in_training(w):
    till = w.tills[0]
    shift = w.shift(till, 1, status=ShiftStatus.OPEN)
    doc = _doc("25.50", shift_id=shift.id)
    out = _push(w, till, [doc])
    assert [(str(r.id), r.status) for r in out.results] == [(doc["id"], "accepted")]
    assert out.unidentified is None
    tx = _real(w, doc)
    assert tx is not None and tx.total_amount == Decimal("25.50") and tx.shift_id == shift.id
    assert tx.transaction_number == doc["transactionNumber"]
    assert _quarantined(w) == []
    # The real path's side effects, as always.
    assert w.synced and w.detected == [doc["id"]]
    assert w.db.query(SyncLog).filter(SyncLog.entity_id == tx.id).count() == 1
    # And a resend is a duplicate, as always.
    again = _push(w, till, [doc])
    assert again.results[0].status == "duplicate"


def test_a_real_sale_in_a_training_shop_from_a_till_that_has_not_switched_is_real(w):
    _on(w)
    till = w.tills[0]
    shift = w.shift(till, 1, status=ShiftStatus.OPEN)
    doc = _doc("12.00", shift_id=shift.id)  # no flag, a real number
    out = _push(w, till, [doc])
    assert out.results[0].status == "accepted"
    assert _real(w, doc) is not None
    assert _quarantined(w) == []
    assert w.detected == [doc["id"]]


def test_a_training_number_without_the_flag_is_real_outside_training_mode(w):
    till = w.tills[0]
    shift = w.shift(till, 1, status=ShiftStatus.OPEN)
    doc = _doc(number="ה-5", shift_id=shift.id)
    _push(w, till, [doc])
    assert _real(w, doc) is not None
    assert _quarantined(w) == []


# ── The quarantine ────────────────────────────────────────────────────────────


def test_a_flagged_sale_is_quarantined_and_answered_like_a_real_one(w):
    _on(w)
    till = w.tills[0]
    doc = _doc("30.00", number="ה-1", training=True, shift_id=uuid.uuid4())
    out = _push(w, till, [doc])
    assert [(str(r.id), r.status) for r in out.results] == [(doc["id"], "accepted")]
    assert out.results[0].server_received_at is not None
    assert _real(w, doc) is None
    assert w.db.query(Transaction).count() == 0
    rows = _quarantined(w, "transaction")
    assert len(rows) == 1
    row = rows[0]
    assert (row.local_id, row.number, row.machine_id, row.tenant_id) == (doc["id"], "ה-1", till.id, w.tenant.id)
    assert row.payload["totalAmount"] == "30.00" and row.payload["training"] is True
    # No signal, no exception detection, no sync log for it.
    assert w.synced == [] and w.detected == []
    assert w.db.query(SyncLog).count() == 0
    # The till resends (a lost answer): a duplicate, still nowhere real.
    again = _push(w, till, [doc])
    assert again.results[0].status == "duplicate"
    assert len(_quarantined(w)) == 1


def test_a_training_number_in_a_training_shop_is_quarantined_without_the_flag(w):
    _on(w)
    doc = _doc(number="ה-7")
    _push(w, w.tills[0], [doc])
    assert _real(w, doc) is None
    assert [r.number for r in _quarantined(w)] == ["ה-7"]


def test_a_mixed_batch_answers_in_the_tills_order(w):
    _on(w)
    till = w.tills[0]
    shift = w.shift(till, 1, status=ShiftStatus.OPEN)
    real = _doc(shift_id=shift.id)
    trained = _doc(training=True, number="ה-2")
    bad = {**_doc(shift_id=shift.id), "totalAmount": "not money"}
    nameless = {"transactionNumber": "x"}  # no id at all
    real2 = _doc(shift_id=shift.id)
    out = _push(w, till, [real, trained, bad, nameless, real2])
    assert [str(r.id) for r in out.results] == [real["id"], trained["id"], bad["id"], real2["id"]]
    assert [r.status for r in out.results] == ["accepted", "accepted", "rejected", "accepted"]
    # The unidentified document keeps its position in the till's batch.
    assert [u.index for u in out.unidentified] == [3]
    assert _real(w, real) and _real(w, real2) and not _real(w, trained)
    assert sorted(w.detected) == sorted([real["id"], real2["id"]])


def test_a_training_sale_after_the_shop_left_training_mode_is_dropped_and_logged(w):
    till = w.tills[0]
    doc = _doc(training=True, number="ה-9")
    out = _push(w, till, [doc])
    assert out.results[0].status == "accepted"  # the till's outbox clears
    assert _real(w, doc) is None
    assert _quarantined(w) == []
    log = w.db.query(TrainingAuditLog).filter(TrainingAuditLog.action == "dropped").one()
    assert log.machine_id == till.id and log.details["kind"] == "transaction" and log.details["ids"] == [doc["id"]]


def test_a_training_shift_is_quarantined_open_and_close_without_a_409(w):
    _on(w)
    till = w.tills[0]
    shift_id = uuid.uuid4()
    opened = sync_router.post_shift_open(
        str(till.id),
        ShiftOpenIn.model_validate({"id": str(shift_id), "businessDate": str(TODAY), "openedAt": NOW.isoformat(),
                                    "openingCash": "100", "sequenceNumber": 1, "training": True}),
        machine=till, db=w.db,
    )
    assert opened.status == "open" and opened.id == shift_id and opened.opening_cash == Decimal("100.00")
    assert w.db.query(Shift).count() == 0
    sale = _doc(training=True, number="ה-1", shift_id=shift_id)
    _push(w, till, [sale])
    # The close lists a document the real table does not hold: no 409 for a training shift.
    body = ShiftCloseIn.model_validate({
        "closedAt": (NOW + timedelta(hours=3)).isoformat(), "countedCash": "110",
        "transactionIds": [sale["id"]], "lastTransactionNumber": "ה-1",
    })  # no flag: the shift itself is known as training
    closed = sync_router.post_shift_close(str(till.id), shift_id, body, machine=till, approval=None, db=w.db)
    assert closed.status == "accepted" and closed.shift_id == shift_id and closed.z_report_id is None
    assert w.db.query(Shift).count() == 0
    row = _quarantined(w, "shift")[0]
    assert set(row.payload) == {"open", "close"} and row.payload["close"]["countedCash"] == "110.00"
    again = sync_router.post_shift_close(str(till.id), shift_id, body, machine=till, approval=None, db=w.db)
    assert again.status == "duplicate"


def test_a_real_shift_close_still_needs_its_documents(w):
    """The real path is untouched: a close listing a document the cloud lacks is a 409."""
    _on(w)
    till = w.tills[0]
    shift = w.shift(till, 1, status=ShiftStatus.OPEN)
    body = ShiftCloseIn.model_validate({"closedAt": NOW.isoformat(), "transactionIds": [str(uuid.uuid4())]})
    out = sync_router.post_shift_close(str(till.id), shift.id, body, machine=till, approval=None, db=w.db)
    assert out.status_code == 409
    assert _quarantined(w) == []


def test_a_training_till_z_is_quarantined_and_no_cloud_z_is_built(w):
    _on(w)
    till = w.tills[0]
    body = TillZIn.model_validate({"clientRequestId": str(uuid.uuid4()), "training": True, "number": "ה-1",
                                   "till": {"totalSales": 30, "transactionsCount": 1}})
    out = sync_router.post_till_z(str(till.id), body, machine=till, db=w.db)
    assert out.status_code == 201
    assert w.db.query(ZReport).count() == 0
    row = _quarantined(w, "z")[0]
    assert row.number == "ה-1" and row.payload["till"]["totalSales"] == 30
    again = sync_router.post_till_z(str(till.id), body, machine=till, db=w.db)
    assert again.status_code == 200


def test_a_training_till_event_is_quarantined_not_an_exception(w):
    _on(w)
    till = w.tills[0]
    body = TillEventIn.model_validate({"id": str(uuid.uuid4()), "type": "drawer_open", "occurredAt": NOW.isoformat(),
                                       "training": True})
    response = Response()
    out = exceptions_router.post_till_event(str(till.id), body, response, machine=till, db=w.db)
    assert out.status == "accepted" and response.status_code == 201
    assert w.db.query(TillEvent).count() == 0
    assert len(_quarantined(w, "other")) == 1


def test_the_tills_own_training_documents_are_quarantined_then_dropped_after(w):
    till = w.tills[0]
    _on(w)
    body = R.TrainingDocumentsIn.model_validate({"documents": [
        {"kind": "z", "id": "z-1", "number": "ה-1", "payload": {"totalSales": 12}},
        {"kind": "x", "id": "x-1", "payload": {"totalSales": 5}},
    ]})
    out = R.post_training_documents(str(till.id), body, machine=till, db=w.db)
    assert [r["status"] for r in out["results"]] == ["accepted", "accepted"]
    again = R.post_training_documents(str(till.id), body, machine=till, db=w.db)
    assert [r["status"] for r in again["results"]] == ["duplicate", "duplicate"]
    w.shop.training_mode = False
    w.db.flush()
    late = R.TrainingDocumentsIn.model_validate({"documents": [{"kind": "z", "id": "z-2", "payload": {}}]})
    assert R.post_training_documents(str(till.id), late, machine=till, db=w.db)["results"][0]["status"] == "dropped"
    assert {r.local_id for r in _quarantined(w)} == {"z-1", "x-1"}


# ── On and off ────────────────────────────────────────────────────────────────


def test_turning_it_on_is_refused_while_a_real_shift_is_open(w):
    w.shift(w.tills[1], 1, status=ShiftStatus.OPEN)
    with pytest.raises(HTTPException) as refused:
        _enable(w)
    assert refused.value.status_code == 409
    assert refused.value.detail["code"] == "real_shift_open"
    assert [t["machineId"] for t in refused.value.detail["tills"]] == [str(w.tills[1].id)]
    assert w.shop.training_mode is False


def test_a_till_reporting_an_open_shift_the_cloud_has_not_seen_also_blocks(w):
    w.tills[0].reported_open_shift_id = uuid.uuid4()
    w.db.flush()
    with pytest.raises(HTTPException) as refused:
        _enable(w)
    assert refused.value.detail["code"] == "real_shift_open"


def test_turning_it_on_flags_the_shop_logs_and_moves_the_settings_watermark(w):
    before = w.shop.settings_updated_at
    out = _enable(w)
    assert out["trainingMode"] is True and out["canManage"] is True
    assert out["startedBy"]["id"] == str(w.admin.id) and out["startedAt"]
    assert w.shop.training_mode is True and w.shop.training_started_by == w.admin.id
    assert before is None or w.shop.settings_updated_at > before
    assert [e["action"] for e in out["log"]] == ["enabled"]
    # Idempotent.
    assert _enable(w)["trainingMode"] is True
    assert w.db.query(TrainingAuditLog).filter(TrainingAuditLog.action == "enabled").count() == 1


def test_who_may_manage_and_who_may_only_look(w):
    manager = _user(w, UserRole.SHOP_MANAGER, shop_id=w.shop.id)
    with pytest.raises(HTTPException) as refused:
        _enable(w, manager)
    assert refused.value.status_code == 403
    status_out = R.get_training_mode(w.shop.id, current_user=manager, active_tenant_id=w.tenant.id, db=w.db)
    assert status_out["canManage"] is False
    cashier = _user(w, UserRole.CASHIER, shop_id=w.shop.id)
    with pytest.raises(HTTPException):
        R.get_training_mode(w.shop.id, current_user=cashier, active_tenant_id=w.tenant.id, db=w.db)
    company_manager = _user(w, UserRole.COMPANY_MANAGER, company_id=w.company.id)
    assert _enable(w, company_manager)["trainingMode"] is True
    with pytest.raises(HTTPException) as refused:
        _disable(w, user=manager)
    assert refused.value.status_code == 403


def test_the_disable_preview_counts_and_reports_blockers(w):
    _on(w)
    till = w.tills[0]
    _push(w, till, [_doc(training=True, number="ה-1"), _doc(training=True, number="ה-2")])
    TM.store(w.db, till, w.shop, "shift", uuid.uuid4(), {"open": {}})
    till.pending_documents = 3
    till.pending_count = 4
    till.pending_count_at = NOW
    _table_order(w, 5)
    w.db.flush()
    out = R.get_disable_preview(w.shop.id, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
    assert out["counts"] == {"transactions": 2, "shifts": 1, "zReports": 0, "xReports": 0, "other": 0,
                             "tableOrders": 1, "openTables": 1}
    codes = [b["code"] for b in out["blockers"]]
    assert codes == ["unsynced_till", "open_tables"]
    assert out["blockers"][0]["machineId"] == str(till.id) and out["blockers"][0]["pendingDocuments"] == 3
    assert out["blockers"][1]["tables"] == [{"number": 5, "name": None}]
    assert out["demoMenu"] == {"loaded": False, "loads": []}


def test_turning_it_off_checks_the_name_and_the_blockers_then_purges_and_logs(w):
    _on(w)
    till = w.tills[0]
    # Something real in the shop that must survive.
    real_shift = w.shift(till, 1, status=ShiftStatus.CLOSED)
    real_tx = w.doc(till, real_shift, "40.00")
    trained = _doc(training=True, number="ה-1")
    _push(w, till, [trained])
    TM.store(w.db, till, w.shop, "shift", uuid.uuid4(), {"open": {}})
    open_order = _table_order(w, 5)
    paid_training = _table_order(w, 6, status="paid", transaction_id=trained["id"], transaction_number="ה-1")
    paid_real = _table_order(w, 7, status="paid", transaction_id=str(real_tx.id), transaction_number="1001")
    other_shop_doc = TM.store(w.db, w.other_till, w.other_shop, "transaction", "o-1", {})[0]
    w.db.flush()
    ids = (open_order.id, open_order.table_id, paid_training.id, paid_real.id)

    with pytest.raises(HTTPException) as wrong:
        _disable(w, "not the name")
    assert wrong.value.status_code == 422 and wrong.value.detail["code"] == "name_mismatch"
    with pytest.raises(HTTPException) as blocked:
        _disable(w)
    assert blocked.value.status_code == 409 and blocked.value.detail["code"] == "blockers"
    assert w.shop.training_mode is True

    out = _disable(w, f"  {w.shop.name} ", force=True)
    assert out["deleted"] == {"transactions": 1, "shifts": 1, "zReports": 0, "xReports": 0, "other": 0,
                              "tableOrders": 2}
    assert out["demoMenu"] is None
    assert out["status"]["trainingMode"] is False and out["status"]["endedBy"]["id"] == str(w.admin.id)
    w.db.expire_all()
    assert _quarantined(w) == []
    assert w.db.get(TrainingDocument, other_shop_doc.id) is not None  # another shop's stays
    assert w.db.get(TableOrder, ids[0]) is None
    assert w.db.get(TableOrder, ids[2]) is None
    assert w.db.get(TableOrder, ids[3]) is not None
    assert w.db.get(DiningTable, ids[1]).lock_machine_id is None
    assert w.db.get(Transaction, real_tx.id) is not None and w.db.get(Shift, real_shift.id) is not None
    log = w.db.query(TrainingAuditLog).filter(TrainingAuditLog.action == "disabled").one()
    assert log.user_id == w.admin.id and log.details["forced"] is True
    assert log.details["deleted"]["transactions"] == 1
    with pytest.raises(HTTPException) as again:
        _disable(w)
    assert again.value.detail["code"] == "not_in_training"


def test_the_training_report_summarises_the_quarantined_sales(w):
    _on(w)
    t1, t2 = w.tills
    _push(w, t1, [
        _doc("20.00", training=True, number="ה-1", method="cash"),
        {**_doc("40.00", training=True, number="ה-2", items=[
            {"id": str(uuid.uuid4()), "productName": "בירה", "quantity": "2", "unitPrice": "20", "totalPrice": "40.00"},
        ]), "payments": [{"id": str(uuid.uuid4()), "sequence": 1, "method": "card", "amount": "40.00"}]},
    ])
    _push(w, t2, [_doc("10.00", training=True, number="ה-1"), _doc("5.00", training=True, number="ה-2", doc_type=330)])
    out = R.get_training_report(w.shop.id, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
    assert out["count"] == 3 and out["total"] == 70.0
    assert out["refunds"] == {"count": 1, "total": 5.0}
    assert [(t["machineId"], t["count"], t["total"]) for t in out["byTill"]] == [
        (str(t1.id), 2, 60.0), (str(t2.id), 1, 10.0),
    ]
    assert out["topItems"] == [{"name": "בירה", "quantity": 2.0, "total": 40.0},
                               {"name": "קפה", "quantity": 2.0, "total": 30.0}]
    assert {p["method"]: p["amount"] for p in out["byPayment"]} == {"cash": 30.0, "card": 40.0}


# ── The flag reaches the till ─────────────────────────────────────────────────


def test_the_till_reads_the_flag_from_machines_me_and_the_settings_sync(w):
    till = w.tills[0]
    assert machines_router.get_my_machine(machine=till)["trainingMode"] is False
    first = sync_router.get_settings_sync(str(till.id), since=None, machine=till, db=w.db)
    assert first.training_mode is False and first.settings["trainingMode"] is False
    since = (first.settings_updated_at + timedelta(seconds=1)).isoformat()
    _enable(w)
    me = machines_router.get_my_machine(machine=till)
    assert me["trainingMode"] is True and me["trainingStartedAt"]
    later = sync_router.get_settings_sync(str(till.id), since=None, machine=till, db=w.db)
    assert later.training_mode is True and later.settings["trainingMode"] is True
    dumped = later.model_dump(by_alias=True)
    assert dumped["trainingMode"] is True
    # An "unchanged" pull carries it as well.
    unchanged = sync_router.get_settings_sync(
        str(till.id), since=(later.settings_updated_at + timedelta(seconds=1)).isoformat(), machine=till, db=w.db,
    )
    assert unchanged.sync_type == "unchanged" and unchanged.training_mode is True
    assert since  # (the watermark moved past the first pull: see the enable test)


def test_a_new_shop_opens_in_training_mode_when_asked(w, monkeypatch):
    import app.routers.shops as shops_module

    monkeypatch.setattr(shops_module, "ensure_default_pos_user", lambda *a, **k: None)
    monkeypatch.setattr(shops_module, "reconcile_shops", lambda *a, **k: set())
    trained = shops_router.create_shop(
        ShopCreate.model_validate({"name": "חדש", "companyId": str(w.company.id), "trainingMode": True, "branchId": "801"}),
        current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
    )
    assert trained.training_mode is True and trained.training_started_by == w.admin.id
    plain = shops_router.create_shop(
        ShopCreate.model_validate({"name": "רגיל", "companyId": str(w.company.id), "branchId": "802"}),
        current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
    )
    assert plain.training_mode is False
    from app.schemas.shop import ShopResponse

    assert ShopResponse.model_validate(trained).model_dump(by_alias=True)["trainingMode"] is True
