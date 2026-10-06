"""
The local shop Z (docs/SPEC_INDEPENDENT_TILL.md §8) and a till that comes back
(docs/SPEC_OFFLINE_TILL_Z.md §4.6.3):

* **Late documents in the next local shop Z.** A participant support closed comes back with
  documents of that period: the cloud carries them, the shop Z history hands the main till
  their part (`lateDocuments`, with its manifest), and the next local Z that includes it is
  verified like any part — the carry shift linked to it, once.
* **A remote participant ("מרוחק (דרך הענן)") only offline** when the main till's round asks
  for its part: when it powers on, the request is on its heartbeat; it closes its shift,
  uploads what it sold with no connection, reports its part — and the Z completes, verified.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from app.models.shift import Shift, ShiftStatus
from app.models.z_report import ZReport
from app.routers import machines as machines_router
from app.routers import till_shop_z_local as LR
from app.schemas.shift import ShiftCloseIn
from app.services import late_documents as LD
from app.services import support_z as SZ
from app.services.shifts import apply_shift_close, note_documents_after_close
from test_independent_till import (  # noqa: F401 - `w` is the fixture
    _manifest_body,
    _part,
    _put_remote,
    _report_body,
    _verification,
    closed_shift,
    owner_setup,
    upload,
    w,
)


def _states(v):
    return {t["posNumber"]: t["state"] for t in v["tills"]}


class TestLateDocumentsInTheLocalShopZ:
    def test_a_returned_participants_late_documents_are_the_next_local_zs_part(self, w):
        owner_setup(w)
        main, two = w.six[0], w.six[1]
        # Till 2 dies mid-shift; support closes it from the cloud (shop Z mode: no Z here).
        s2 = w.shift(two, 1, status=ShiftStatus.OPEN)
        w.doc(two, s2, "20.00")
        others = {m.id: closed_shift(w, m, 1, "10.00") for m in (w.six[0], w.six[2], w.six[3], w.six[4])}
        two.last_heartbeat_at = datetime.now(timezone.utc) - timedelta(hours=5)
        w.db.commit()
        SZ.produce(w.db, w.admin, two, reason="lost", confirm_data=True)
        w.db.commit()

        # The main till's next Z: till 2 is answered by the cloud's section (§4.6).
        history = LR.till_shop_z_history(str(main.id), days=31, machine=main, db=w.db)
        assert next(p for p in history["participants"] if p["posNumber"] == "2").get("supportClosed")
        parts = [_part(w, m, [others[m.id]]) for m in (w.six[0], w.six[2], w.six[3], w.six[4])]
        parts.insert(1, _part(w, two, [w.db.get(Shift, s2.id)]))
        code, first = upload(w, main, _manifest_body(w, 1, parts))
        assert code == 201 and _verification(w, first)["state"] == "verified"
        assert w.db.get(Shift, s2.id).z_report_id == uuid.UUID(first["zReportId"])

        # Till 2 comes back, with a sale of that period it never sent.
        two.last_heartbeat_at = datetime.now(timezone.utc)
        late = w.doc(two, w.db.get(Shift, s2.id), "5.00")
        late.server_received_at = datetime.now(timezone.utc) + timedelta(seconds=30)
        w.db.commit()
        note_documents_after_close(w.db, {s2.id: 1}, machine_id=two.id)
        w.db.commit()
        carry = next(s for s in w.db.query(Shift).filter(Shift.machine_id == two.id).all() if LD.is_carry(s))

        # The history hands the main till their part: no longer "closed by support".
        history = LR.till_shop_z_history(str(main.id), days=31, machine=main, db=w.db)
        p2 = next(p for p in history["participants"] if p["posNumber"] == "2")
        assert "supportClosed" not in p2
        part = p2["lateDocuments"]
        assert part["late"] is True and part["shiftIds"] == [str(carry.id)]
        assert [str(i).lower() for i in part["manifest"]["documentIds"]] == [str(late.id).lower()]
        assert part["manifest"]["digest"] == _part(w, two, [carry])["manifest"]["digest"]
        assert part["label"].startswith("מסמכים מאוחרים מתקופה קודמת (קופה 2")

        # The next local Z includes the part as handed: verified, the carry shift linked — once.
        late_part = {k: part[k] for k in ("machineId", "shiftIds", "till", "report", "manifest")}
        code, second = upload(w, main, _manifest_body(w, 2, [late_part]))
        assert code == 201
        assert _states(_verification(w, second))["2"] == "verified"
        assert w.db.get(Shift, carry.id).z_report_id == uuid.UUID(second["zReportId"])
        assert w.db.get(ZReport, uuid.UUID(second["zReportId"])).shop_sequence_number == 2


class TestARemoteParticipantOnlyOffline:
    def test_it_closes_when_it_powers_on_and_the_waiting_local_z_completes(self, w):
        owner_setup(w)
        main, five = w.six[0], w.six[4]
        _put_remote(w, [five.id])
        others = {m.id: closed_shift(w, m, 1, "10.00") for m in w.six[:4]}
        s5 = w.shift(five, 1, status=ShiftStatus.OPEN)
        sold = w.doc(five, s5, "12.00")
        five.last_heartbeat_at = datetime.now(timezone.utc) - timedelta(hours=3)  # off
        w.db.commit()

        # The main till's round asks the cloud to close it.
        LR.till_shop_z_remote_close(
            str(main.id),
            LR.RemoteCloseIn.model_validate({"roundId": "r1", "requests": [{"machineId": str(five.id), "requestId": "q1"}]}),
            machine=main, db=w.db,
        )
        # Powered on: the request is on its first heartbeat.
        beat = machines_router.post_my_heartbeat(None, machine=five, db=w.db)
        assert beat["pendingShopZPart"]["requestId"] == "q1"
        # It finishes what it had (a sale made with no connection), closes, uploads, reports.
        offline_sale = w.doc(five, s5, "3.00")
        w.db.commit()
        body = ShiftCloseIn.model_validate({
            "closedAt": datetime.now(timezone.utc).isoformat(),
            "transactionIds": [str(sold.id), str(offline_sale.id)],
        })
        s5, outcome = apply_shift_close(w.db, five, s5.id, body)
        assert outcome == "accepted"
        w.db.commit()
        part = _part(w, five, [s5])
        section = {"posNumber": "5", "machineName": five.name, **{k: part[k] for k in ("machineId", "shiftIds", "till", "report", "manifest")}}
        LR.till_shop_z_remote_part(
            str(five.id), _report_body("q1", "r1", five, "closed", section, str(s5.id)), machine=five, db=w.db,
        )
        assert "pendingShopZPart" not in machines_router.post_my_heartbeat(None, machine=five, db=w.db)

        # The main till pulls it, and its Z completes with every till — verified.
        (got,) = LR.till_shop_z_remote_parts(str(main.id), round_id="r1", machine=main, db=w.db)["parts"]
        assert got["outcome"] == "closed"
        parts = [_part(w, m, [others[m.id]]) for m in w.six[:4]] + [part]
        code, out = upload(w, main, _manifest_body(w, 1, parts))
        assert code == 201
        assert _verification(w, out)["state"] == "verified"
        z = w.db.get(ZReport, uuid.UUID(out["zReportId"]))
        assert w.db.get(Shift, s5.id).z_report_id == z.id
