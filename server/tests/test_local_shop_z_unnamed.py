"""
A local shop Z (the main till's paper, docs/SPEC_INDEPENDENT_TILL.md §8.12) and the documents
it did or did not name (docs/SHIFTS_API.md §1.2, 2026-10-07):

* a document in a shift the Z took that its part's manifest does not name was never on the
  paper: detected when the shift is linked, carried into the till's next Z (late documents),
  and said on the Z (`offline_report.unnamedDocuments`) — never left uncounted inside it;
* a document the manifest names is that Z's whenever it arrives: no longer counted late on
  the Z or its shift (the bug: `late_documents` went up and nothing was carried).
"""
from __future__ import annotations

import uuid

from app.models.shift import Shift
from app.models.transaction import Transaction
from app.models.z_report import ZReport
from app.services import late_documents as LD
from app.services.shifts import note_documents_after_close
from test_independent_till import _five, _manifest_body, _part, upload, w  # noqa: F401


def test_unnamed_documents_are_carried_and_named_ones_are_never_late(w):
    shifts = _five(w)
    parts = [_part(w, m, [shifts[m.id]]) for m in w.six[:5]]
    till2 = w.six[1]
    # Written into till 2's shift after its part was built: the paper never had it.
    unnamed = w.doc(till2, shifts[till2.id], "7.00")
    w.db.commit()

    code, out = upload(w, w.six[0], _manifest_body(w, 1, parts))
    assert code == 201, out
    z = w.db.get(ZReport, uuid.UUID(out["zReportId"]))

    assert z.offline_report["unnamedDocuments"] == {str(till2.id): 1}
    carried = w.db.get(Transaction, unnamed.id)
    carry = w.db.get(Shift, carried.shift_id)
    assert LD.is_carry(carry) and carry.z_report_id is None  # bound for the till's next Z
    assert z.offline_report["verification"]["unnamedDocuments"] == {str(till2.id): 1}
    assert z.offline_report["verification"]["state"] == "verified"  # the paper is still its parts

    # A named document of till 3 arriving again later is that Z's: never counted late.
    till3 = w.six[2]
    shift3 = shifts[till3.id]
    named_id = uuid.UUID(parts[2]["manifest"]["documentIds"][0])
    before = (int(z.late_documents or 0), int(w.db.get(Shift, shift3.id).late_documents or 0))
    note_documents_after_close(w.db, {shift3.id: 1}, machine_id=till3.id, written={shift3.id: [named_id]})
    w.db.refresh(z)
    assert (int(z.late_documents or 0), int(w.db.get(Shift, shift3.id).late_documents or 0)) == before
    assert w.db.get(Transaction, named_id).shift_id == shift3.id
