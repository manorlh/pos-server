"""
A device's records of another pairing, unpairing and pairing from the cloud
(P:/specs/foreign-records-upload.md §3, §4, §5, §6).

Runs on the in-memory SQLite world in tests/shift_world.py: tills[0] = B (the device's pairing now),
tills[1] = A (the machine it was before, not linked), other_till in another shop of the same tenant.
"""
from __future__ import annotations

import json
import uuid
from datetime import timedelta
from decimal import Decimal

import pytest
from fastapi import HTTPException

from app.models.audit_exception import AuditException
from app.models.device_command import DeviceCommand
from app.models.device_pairing_request import DevicePairingRequest, DevicePairingStatus
from app.models.document_refusal import DocumentRefusal
from app.models.shift import Shift, ShiftStatus
from app.models.tenant import Tenant
from app.models.company import Company
from app.models.shop import Shop
from app.models.pos_machine import POSMachine, PairingStatus
from app.models.transaction import Transaction
from app.routers import sync as sync_router
from app.schemas.foreign_records import ForeignRecordsIn, UnpairedIn
from app.schemas.transaction import TransactionsBatchEnvelope
from app.services import cloud_pairing as CP
from app.services import foreign_records as FR
from app.services.pairing import AdoptionRefused, validate_pairing_code
from app.services.pairing_mobile import poll_device_credentials, register_device_pairing_request
from shift_world import NOW, TODAY, accept_str_uuids, make_world


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    world = make_world()
    from app.services import ably_notify

    monkeypatch.setattr(ably_notify, "publish_close_shift_notify", lambda *a, **k: None)
    monkeypatch.setattr(ably_notify, "publish_notify", lambda *a, **k: None, raising=False)
    from app.services import transactions as T

    monkeypatch.setattr(T, "publish_transactions_synced", lambda *a, **k: None)
    world.b = world.tills[0]
    world.a = world.tills[1]
    world.db.commit()
    return world


def _doc(shift_id=None, total="10.00", number=None, **extra) -> dict:
    body = {
        "id": str(uuid.uuid4()), "transactionNumber": number or str(uuid.uuid4().int)[:8],
        "status": "completed", "documentType": 320, "totalAmount": total, "paymentMethod": "cash",
        "createdAt": NOW.isoformat(), "updatedAt": NOW.isoformat(), "businessDate": str(TODAY),
    }
    if shift_id is not None:
        body["shiftId"] = str(shift_id)
    body.update(extra)
    return body


def _push(w, till, docs):
    return sync_router.post_transactions(
        machine_id=str(till.id), body=TransactionsBatchEnvelope(transactions=docs), machine=till, db=w.db,
    )


def _exceptions(w, kind):
    return w.db.query(AuditException).filter(AuditException.exception_type == kind).all()


# ── §3: the ordinary sync ────────────────────────────────────────────────────


class TestOrdinarySync:
    def test_a_document_stamped_with_another_machine_is_refused_and_not_stored(self, w):
        doc = _doc(machineId=str(w.a.id))
        out = _push(w, w.b, [doc])
        assert [(r.status, r.reason) for r in out.results] == [("rejected", "document_foreign_machine")]
        assert w.db.get(Transaction, uuid.UUID(doc["id"])) is None
        assert w.db.query(DocumentRefusal).count() == 1
        alerts = _exceptions(w, "document_foreign_machine")
        assert len(alerts) == 1 and alerts[0].details["issuerMachineId"] == str(w.a.id)

    def test_an_unstamped_document_naming_another_machines_shift_is_refused(self, w):
        theirs = w.shift(w.a, 7, status=ShiftStatus.OPEN)
        doc = _doc(theirs.id)
        out = _push(w, w.b, [doc])
        assert [(r.status, r.reason) for r in out.results] == [("rejected", "document_foreign_machine")]
        assert w.db.get(Transaction, uuid.UUID(doc["id"])) is None

    def test_unstamped_documents_with_no_foreign_shift_are_filed_as_before(self, w):
        mine = w.shift(w.b, 1, status=ShiftStatus.OPEN)
        docs = [_doc(mine.id), _doc(None), _doc(uuid.uuid4()), _doc(mine.id, machineId=str(w.b.id))]
        out = _push(w, w.b, docs)
        assert [r.status for r in out.results] == ["accepted"] * 4
        assert all(w.db.get(Transaction, uuid.UUID(d["id"])).machine_id == w.b.id for d in docs)
        assert _exceptions(w, "document_foreign_machine") == []

    def test_an_unreadable_stamp_is_no_stamp(self, w):
        out = _push(w, w.b, [_doc(None, machineId="not-a-uuid")])
        assert [r.status for r in out.results] == ["accepted"]

    def test_a_predecessor_stamp_is_this_devices_own_and_filed_under_it(self, w):
        w.b.predecessor_machine_id = w.a.id
        theirs = w.shift(w.a, 7, status=ShiftStatus.OPEN)
        w.db.commit()
        doc = _doc(theirs.id, machineId=str(w.a.id))
        out = _push(w, w.b, [doc])
        assert [r.status for r in out.results] == ["accepted"]
        stored = w.db.get(Transaction, uuid.UUID(doc["id"]))
        assert (stored.machine_id, stored.shift_id) == (w.a.id, theirs.id)

    def test_one_already_filed_under_this_till_is_not_refused_on_a_repush(self, w):
        mine = w.shift(w.b, 1, status=ShiftStatus.OPEN)
        theirs = w.shift(w.a, 7)
        doc = _doc(mine.id)
        _push(w, w.b, [doc])
        again = dict(doc, shiftId=str(theirs.id), updatedAt=(NOW + timedelta(minutes=1)).isoformat())
        out = _push(w, w.b, [again])
        assert [r.status for r in out.results] != ["rejected"]

    def test_the_rest_of_the_batch_lands(self, w):
        mine = w.shift(w.b, 1, status=ShiftStatus.OPEN)
        docs = [_doc(mine.id), _doc(machineId=str(w.a.id)), _doc(mine.id)]
        out = _push(w, w.b, docs)
        assert [r.status for r in out.results] == ["accepted", "rejected", "accepted"]

    def test_a_transmission_or_cash_movement_of_another_machine_is_409(self, w):
        from app.routers import cash_drawer as cash_router
        from app.schemas.cash_drawer import CashMovementIn
        from app.schemas.transmission import TransmissionReportIn

        report = TransmissionReportIn.model_validate({
            "id": str(uuid.uuid4()), "trigger": "manual", "startedAt": NOW.isoformat(), "status": "success",
            "machineId": str(w.a.id),
        })
        with pytest.raises(HTTPException) as caught:
            sync_router.post_transmission_report(machine_id=str(w.b.id), body=report, machine=w.b, db=w.db)
        assert (caught.value.status_code, caught.value.detail) == (409, "document_foreign_machine")
        movement = CashMovementIn.model_validate({
            "id": str(uuid.uuid4()), "type": "cash_in", "amount": "5", "occurredAt": NOW.isoformat(),
            "machineId": str(w.a.id),
        })
        with pytest.raises(HTTPException) as caught:
            cash_router.post_cash_movement(machine_id=str(w.b.id), body=movement, response=None, machine=w.b, db=w.db)
        assert caught.value.detail == "document_foreign_machine"


# ── §4: the upload ───────────────────────────────────────────────────────────


def _upload(w, records, *, machine_id=None, tenant_id=None, pusher=None):
    body = ForeignRecordsIn.model_validate({
        "machineId": str(machine_id or w.a.id), "tenantId": tenant_id, "records": records,
    })
    pusher = pusher or w.b
    return sync_router.post_foreign_records(machine_id=str(pusher.id), body=body, machine=pusher, db=w.db)


def _shift_open(shift_id, seq=7):
    return {"kind": "shift_open", "id": str(shift_id), "body": {
        "id": str(shift_id), "businessDate": str(TODAY), "sequenceNumber": seq,
        "openedAt": (NOW - timedelta(hours=2)).isoformat(), "openingCash": "100.00",
    }}


def _shift_close(shift_id, ids):
    return {"kind": "shift_close", "id": str(shift_id), "body": {
        "closedAt": NOW.isoformat(), "countedCash": "100.00", "expectedCash": "100.00",
        "transactionIds": [str(i) for i in ids], "businessDate": str(TODAY),
        "openedAt": (NOW - timedelta(hours=2)).isoformat(), "sequenceNumber": 7,
    }}


class TestUpload:
    @pytest.mark.parametrize("case, code", [
        ("unknown", "foreign_machine_unknown"), ("self", "foreign_machine_is_self"),
        ("tenant", "foreign_machine_other_tenant"), ("other_tenant_machine", "foreign_machine_other_tenant"),
    ])
    def test_whole_request_refusals(self, w, case, code):
        kwargs = {}
        if case == "unknown":
            kwargs["machine_id"] = uuid.uuid4()
        elif case == "self":
            kwargs["machine_id"] = w.b.id
        elif case == "tenant":
            kwargs["tenant_id"] = str(uuid.uuid4())
        else:
            other = Tenant(id=uuid.uuid4(), name="O", slug="o", timezone="Asia/Jerusalem")
            w.db.add(other)
            w.db.flush()
            w.a.tenant_id = other.id
            w.db.commit()
        doc = _doc(machineId=str(w.a.id))
        out = _upload(w, [{"kind": "transaction", "id": doc["id"], "body": doc}], **kwargs)
        assert out.status_code == 409
        assert json.loads(out.body)["detail"] == code
        assert w.db.get(Transaction, uuid.UUID(doc["id"])) is None
        assert len(_exceptions(w, "foreign_records_refused")) == 1

    def test_a_shift_its_documents_and_its_close_are_filed_as_the_machines_own(self, w):
        shift_id = uuid.uuid4()
        docs = [_doc(shift_id, machineId=str(w.a.id)), _doc(shift_id)]
        records = [_shift_open(shift_id)] + [
            {"kind": "transaction", "id": d["id"], "body": d} for d in docs
        ] + [_shift_close(shift_id, [d["id"] for d in docs])]
        out = _upload(w, records)
        assert [r["status"] for r in out["results"]] == ["accepted"] * 4
        assert out["machineId"] == str(w.a.id) and out["posNumber"] == w.a.pos_number and out["shopName"] == "Center"
        w.db.expire_all()
        for d in docs:
            stored = w.db.get(Transaction, uuid.UUID(d["id"]))
            assert (stored.machine_id, stored.shift_id, stored.pushed_by_machine_id) == (w.a.id, shift_id, w.b.id)
            assert stored.shop_id == w.a.shop_id
        shift = w.db.get(Shift, shift_id)
        assert (shift.machine_id, shift.status, shift.transactions_count) == (w.a.id, ShiftStatus.CLOSED, 2)
        uploaded = _exceptions(w, "foreign_records_uploaded")
        assert len(uploaded) == 1 and uploaded[0].details["counts"] == {"shift_open": 1, "transaction": 2, "shift_close": 1}

        again = _upload(w, records)
        assert [r["status"] for r in again["results"]] == ["duplicate"] * 4

    def test_the_machines_open_shift_takes_them_and_stays_open(self, w):
        open_shift = w.shift(w.a, 3, status=ShiftStatus.OPEN)
        w.db.commit()
        doc = _doc(open_shift.id)
        out = _upload(w, [{"kind": "transaction", "id": doc["id"], "body": doc}])
        assert out["results"][0]["status"] == "accepted"
        w.db.expire_all()
        assert w.db.get(Transaction, uuid.UUID(doc["id"])).shift_id == open_shift.id
        assert w.db.get(Shift, open_shift.id).status == ShiftStatus.OPEN

    def test_a_number_the_machine_already_holds_is_refused(self, w):
        theirs = w.shift(w.a, 3, status=ShiftStatus.OPEN)
        held = w.doc(w.a, theirs, "5.00", number="20000057")
        w.db.commit()
        doc = _doc(theirs.id, number="20000057")
        out = _upload(w, [{"kind": "transaction", "id": doc["id"], "body": doc}])
        r = out["results"][0]
        assert (r["status"], r["code"]) == ("refused", "foreign_number_conflict")
        assert w.db.get(Transaction, uuid.UUID(doc["id"])) is None
        assert held.id is not None
        assert len(_exceptions(w, "foreign_records_refused")) == 1

    def test_per_record_refusals_and_retries(self, w):
        stamped_other = _doc(machineId=str(w.other_till.id))
        missing_close = _shift_close(uuid.uuid4(), [uuid.uuid4()])
        theirs = w.shift(w.other_till, 1)
        w.db.commit()
        out = _upload(w, [
            {"kind": "bogus", "id": "x", "body": {}},
            {"kind": "transaction", "id": stamped_other["id"], "body": stamped_other},
            {"kind": "transaction", "id": str(uuid.uuid4()), "body": {"id": "nope"}},
            missing_close,
            _shift_close(theirs.id, []),
        ])
        got = [(r["status"], r["code"]) for r in out["results"]]
        assert got == [
            ("refused", "unsupported_kind"),
            ("refused", "document_foreign_machine"),
            ("refused", "invalid_record"),
            ("retry", "missing_transactions"),
            ("refused", "shift_belongs_to_another_machine"),
        ]

    def test_cash_movements_and_transmissions_are_filed_under_the_machine(self, w):
        from app.models.cash_drawer import CashMovement
        from app.models.card_transmission import CardTransmission as Transmission

        mid, tid = uuid.uuid4(), uuid.uuid4()
        out = _upload(w, [
            {"kind": "cash_movement", "id": str(mid), "body": {
                "id": str(mid), "type": "cash_in", "amount": "5", "occurredAt": NOW.isoformat()}},
            {"kind": "transmission", "id": str(tid), "body": {
                "id": str(tid), "trigger": "manual", "startedAt": NOW.isoformat(), "status": "failed"}},
        ])
        assert [r["status"] for r in out["results"]] == ["accepted", "accepted"]
        assert w.db.get(CashMovement, mid).machine_id == w.a.id
        assert w.db.get(Transmission, tid).machine_id == w.a.id


# ── §5.1 unpaired, §5.2 the bound re-pair code ───────────────────────────────


class TestUnpairAndRePair:
    def test_unpaired_marks_the_machine_and_revokes_its_token(self, w):
        before = w.a.token_version or 1
        out = sync_router.post_unpaired(
            machine_id=str(w.a.id),
            body=UnpairedIn.model_validate({"by": "דנה", "reason": "manual", "pending": {"transaction": 3, "x": "?"},
                                            "deviceInfo": {"serial": "S1"}}),
            machine=w.a, db=w.db,
        )
        assert out["ok"] is True
        w.db.refresh(w.a)
        assert w.a.unpaired_by == "דנה" and w.a.unpaired_info["pending"] == {"transaction": 3}
        assert w.a.token_version == before + 1

    def test_the_same_device_re_pairs_over_its_own_open_shift(self, w):
        w.shift(w.a, 3, status=ShiftStatus.OPEN)
        CP.mark_unpaired(w.db, w.a, by="x", reason="manual", pending={}, device_info={})
        w.db.commit()
        code = CP.create_re_pair_code(w.db, w.admin, w.a)
        preview = CP.code_preview(w.db, code.code)
        assert preview["bound"] is True and preview["machineId"] == str(w.a.id) and preview["posNumber"] == w.a.pos_number

        machine = validate_pairing_code(w.db, code.code, {"previousMachineId": str(w.a.id), "serial": "S1"})
        assert machine.id == w.a.id
        assert machine.unpaired_at is None and machine.unpaired_info is None
        assert machine.replacements[-1]["rePair"] is True
        assert machine.replacement_note_pending is None

    def test_another_device_is_a_replacement_and_the_open_shift_blocks_it(self, w):
        w.shift(w.a, 3, status=ShiftStatus.OPEN)
        w.db.commit()
        code = CP.create_re_pair_code(w.db, w.admin, w.a)
        with pytest.raises(AdoptionRefused):
            validate_pairing_code(w.db, code.code, {"previousMachineId": str(w.b.id)})

    def test_code_preview_unbound_and_unknown(self, w):
        from app.services.pairing import create_pairing_code

        code = create_pairing_code(w.db, w.admin.id, tenant_id=w.tenant.id, company_id=w.company.id, shop_id=w.shop.id)
        assert CP.code_preview(w.db, code.code) == {"bound": False, "shopName": "Center", "companyName": "Acme"}
        assert CP.code_preview(w.db, "NOPE1234") is None


# ── §6 pairing from the cloud ────────────────────────────────────────────────


class TestCloudPairing:
    def _register(self, w, last=None):
        info = {"platform": "android", "model": "N55F", "serial": "SER-9"}
        if last is not None:
            info["lastPairing"] = last
        return register_device_pairing_request(w.db, device_info=info)

    def test_register_gives_a_short_code(self, w):
        row = self._register(w)
        assert len(row.device_code) == 6 and set(row.device_code) <= set(CP.DEVICE_CODE_ALPHABET)
        assert row.code_expires_at is not None

    def test_the_list_shows_this_tenants_devices_and_an_exact_code(self, w):
        # Android sends `lastPairing` as a JSON string inside its Map<String, String>.
        mine = self._register(w, json.dumps({"tenantId": str(w.tenant.id), "machineId": str(w.a.id), "shopId": str(w.shop.id)}))
        stranger = self._register(w)
        rows = CP.list_requests(w.db, w.tenant.id)
        assert [r["id"] for r in rows] == [str(mine.id)]
        assert rows[0]["deviceCode"] == f"{mine.device_code[:3]}-{mine.device_code[3:]}"
        rows = CP.list_requests(w.db, w.tenant.id, code=stranger.device_code.lower())
        assert {r["id"] for r in rows} == {str(mine.id), str(stranger.id)}
        assert CP.list_requests(w.db, w.tenant.id, shop_id=w.other_shop.id) == []

    def test_claim_into_an_existing_machine_delivers_credentials_to_the_nonce_only(self, w):
        row = self._register(w, {"tenantId": str(w.tenant.id), "machineId": str(w.a.id)})
        _row, machine, out = CP.claim(
            w.db, w.admin, w.tenant.id, device_code=f"{row.device_code[:3]}-{row.device_code[3:]}", machine_id=w.a.id,
        )
        assert machine.id == w.a.id and out["bound"] is True
        claimed = w.db.get(DevicePairingRequest, row.id)
        assert claimed.status == DevicePairingStatus.CLAIMED and claimed.claimed_by_user_id == w.admin.id
        state, payload = poll_device_credentials(w.db, row.device_nonce)
        assert state == "credentials" and str(w.a.id) in json.dumps(payload, default=str)
        assert poll_device_credentials(w.db, row.device_nonce)[0] == "gone"  # delivered once

    def test_claim_into_a_new_machine_in_a_shop(self, w, monkeypatch):
        from app.services import register_number

        # The register number's regex is Postgres's.
        monkeypatch.setattr(register_number, "assign_register_number", lambda db, m: setattr(m, "pos_number", "9"))
        row = self._register(w)
        _row, machine, out = CP.claim(w.db, w.admin, w.tenant.id, device_code=row.device_code, shop_id=w.other_shop.id)
        assert out["bound"] is False and machine.shop_id == w.other_shop.id and machine.id not in (w.a.id, w.b.id)

    def test_an_unknown_code_is_404(self, w):
        with pytest.raises(HTTPException) as caught:
            CP.claim(w.db, w.admin, w.tenant.id, device_code="ZZZZZZ", machine_id=w.a.id)
        assert caught.value.status_code == 404


class TestMovePairing:
    def test_the_command_carries_a_single_use_code_bound_to_the_target(self, w):
        out = CP.move_pairing(w.db, w.admin, w.tenant.id, w.b, w.a.id)
        w.db.commit()
        params = out["params"] if "params" in out else w.db.get(DeviceCommand, uuid.UUID(out["id"])).params
        assert params["targetMachineId"] == str(w.a.id) and params["forced"] is False
        preview = CP.code_preview(w.db, params["pairingCode"])
        assert preview["bound"] is True and preview["machineId"] == str(w.a.id)

    def test_forced_is_support_only(self, w):
        from app.models.user import User, UserRole

        manager = User(id=uuid.uuid4(), role=UserRole.DISTRIBUTOR, tenant_id=w.tenant.id, email="d@x", username="d")
        w.db.add(manager)
        w.db.flush()
        with pytest.raises(HTTPException) as caught:
            CP.move_pairing(w.db, manager, w.tenant.id, w.b, w.a.id, forced=True)
        assert caught.value.status_code == 403

    def test_a_refusal_is_refused_pending(self, w):
        from app.services import device_commands as DC

        out = CP.move_pairing(w.db, w.admin, w.tenant.id, w.b, w.a.id)
        w.db.commit()
        row = DC.ack(w.db, w.b, out["id"], "refused", None, raw_result={"pending": {"transaction": 2}})
        assert (row.status, row.detail, row.result["outcome"]) == ("refused", "refused_pending", "refused_pending")
        assert row.result["pending"] == {"transaction": 2}
