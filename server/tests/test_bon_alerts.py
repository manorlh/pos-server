"""
"בון לא הודפס" on the dashboard (app/services/bon_alerts.py, `POST /sync/{m}/kitchen/bon-alerts`):

* a till's ticket that needs a person becomes one exceptions-log entry, kind `bon_unprinted`, in
  the push category of the same name — the alerts page and the cockpit's feed show it; a new one
  goes through the alert rules once, a repeated report changes nothing;
* the till's list is complete: what it no longer lists is resolved ("הודפס / טופל בקופה"), and
  comes back open if reported again — never a manager's own "טופל";
* "סמן כטופל" on the till is kept with who, even for a ticket never reported open;
* another till's alerts are never touched; a kiosk's bon alert becomes the same entry, and
  resolves with it.

Runs on the in-memory SQLite world of tests/shift_world.py.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
import uuid

import pytest

from app.models.exception_alerts import ExceptionLogEntry
from app.routers import printers as PR
from app.routers import push_alerts as R
from app.schemas.kitchen_printers import BonAlertsIn
from app.services import bon_alerts as B
from app.services.exception_alerts import engine as E
from app.services.exception_alerts import push as P
from shift_world import accept_str_uuids, make_world

NOW = datetime(2026, 10, 9, 19, 30, tzinfo=timezone.utc)


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    world = make_world()
    world.alerted = []
    monkeypatch.setattr(E, "process_entry", lambda db, entry, now=None, **kw: world.alerted.append(entry.dedupe_key) or [])
    return world


def bon(bon_id="j1", state="failed", reason="no_paper", **over):
    out = {"id": bon_id, "state": state, "reason": reason, "printerName": "בר", "title": "שולחן 12",
           "items": 3, "attempts": 4, "since": "2026-10-09T19:20:00Z", "error": "no_paper: בר (10.0.0.5)"}
    out.update(over)
    return out


def report(w, till, *bons, complete=True, now=NOW):
    body = BonAlertsIn.model_validate({"bons": list(bons), "complete": complete})
    return B.report(w.db, till, body, now=now)


def entries(w, till=None):
    q = w.db.query(ExceptionLogEntry).filter(ExceptionLogEntry.kind == B.KIND)
    if till is not None:
        q = q.filter(ExceptionLogEntry.machine_id == till.id)
    return {e.dedupe_key.rsplit(":", 1)[-1]: e for e in q.all()}


def test_a_ticket_that_did_not_print_is_one_alert_said_in_words(w, monkeypatch):
    monkeypatch.setattr(R, "_now", lambda: NOW + timedelta(hours=1))
    till = w.tills[0]
    out = report(w, till, bon(), bon("j2", state="uncertain", reason="uncertain", printerName="מטבח", title="הזמנה 20000057"))
    assert out == {"open": 2, "recorded": 2, "resolved": 0}
    e = entries(w)
    assert e["j1"].summary == "בון לא הודפס — בר, שולחן 12 (אין נייר)"
    assert e["j2"].summary == "בון לא הודפס — מטבח, הזמנה 20000057 (נקטע באמצע הדפסה)"
    assert e["j1"].severity == "high" and e["j1"].source == B.SOURCE
    assert (e["j1"].shop_id, e["j1"].machine_id, e["j1"].tenant_id) == (w.shop.id, till.id, w.tenant.id)
    assert e["j1"].occurred_at.replace(tzinfo=timezone.utc) == datetime(2026, 10, 9, 19, 20, tzinfo=timezone.utc)
    assert e["j1"].details["attempts"] == 4
    # The alert rules ran once for each new ticket.
    assert sorted(w.alerted) == sorted([B.dedupe_key(till.id, "j1"), B.dedupe_key(till.id, "j2")])
    # The same list again (the heartbeat): nothing new, nothing told twice.
    assert report(w, till, bon(), bon("j2", state="uncertain", reason="uncertain")) == {"open": 2, "recorded": 0, "resolved": 0}
    assert len(w.alerted) == 2
    # The push category and the alerts feed.
    assert P.category_of(e["j1"]) == "bon_unprinted"
    feed = R.list_alerts(company_id=None, shop_id=None, area_id=None, machine_id=None, event_id=None, open_only=True,
                         days=2, limit=50, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
    mine = [a for a in feed["alerts"] if a["kind"] == B.KIND]
    assert len(mine) == 2 and {a["categoryLabel"] for a in mine} == {"בון לא הודפס"}


def test_printed_since_is_resolved_and_failing_again_reopens(w):
    till = w.tills[0]
    report(w, till, bon(), bon("j2"))
    out = report(w, till, bon(), now=NOW + timedelta(minutes=1))
    assert out == {"open": 1, "recorded": 0, "resolved": 1}
    j2 = entries(w)["j2"]
    assert j2.acknowledged_at is not None and j2.note == B.RESOLVED_NOTE and j2.acknowledged_by_user_id is None
    # Not printed after all: open again (no second alert — it is the same ticket).
    report(w, till, bon(), bon("j2", reason="offline"), now=NOW + timedelta(minutes=2))
    j2 = entries(w)["j2"]
    assert j2.acknowledged_at is None and "(המדפסת לא מגיבה)" in j2.summary
    assert len(w.alerted) == 2


def test_a_managers_own_handled_is_never_undone_by_the_till(w):
    till = w.tills[0]
    report(w, till, bon())
    e = entries(w)["j1"]
    e.acknowledged_at = NOW
    e.acknowledged_by_user_id = w.admin.id
    e.note = "דיברתי עם המטבח"
    w.db.flush()
    report(w, till, bon(), now=NOW + timedelta(minutes=1))
    e = entries(w)["j1"]
    assert e.acknowledged_at is not None and e.note == "דיברתי עם המטבח"


def test_handled_on_the_till_is_kept_with_who(w):
    till = w.tills[0]
    report(w, till, bon())
    report(w, till, bon(state="handled", handledBy="דנה", handledNote="handled by דנה"), now=NOW + timedelta(minutes=1))
    e = entries(w)["j1"]
    assert e.acknowledged_at is not None and e.note.startswith("סומן כטופל בקופה — דנה")
    # Handled before it was ever reported: still in the log, closed.
    report(w, till, bon("j9", state="handled", handledBy="יוסי"))
    j9 = entries(w)["j9"]
    assert j9.acknowledged_at is not None and j9.note == "סומן כטופל בקופה — יוסי"


def test_another_tills_alerts_are_never_touched(w):
    a, b = w.tills
    report(w, a, bon("ja"))
    report(w, b, bon("jb"))
    report(w, a)  # a's list is empty now
    assert entries(w, a)["ja"].acknowledged_at is not None
    assert entries(w, b)["jb"].acknowledged_at is None


def test_the_route_validates_and_clamps(w):
    till = w.tills[0]
    long = "x" * 250
    body = BonAlertsIn.model_validate({"bons": [bon(title=long, error=long), {"id": "", "state": "failed"}][:1]})
    out = PR.report_bon_alerts(str(till.id), body, machine=till, db=w.db)
    assert out["recorded"] == 1
    e = entries(w)["j1"]
    assert len(e.details["title"]) == 80 and len(e.details["error"]) == 200
    with pytest.raises(Exception):
        BonAlertsIn.model_validate({"bons": [{"state": "failed"}]})


def test_a_kiosks_bon_alert_is_the_same_kind_and_resolves_with_it(w):
    kiosk = w.tills[1]
    alert = SimpleNamespace(id=uuid.uuid4(), kind="printer", reason="bon_unprinted", key="bon:unprinted",
                            text="קיוסק רויאל — בון של הזמנה A-17 לא הודפס", detail={"orders": "A-17", "count": 1})
    B.kiosk_alert_raised(w.db, kiosk, alert, now=NOW)
    e = w.db.query(ExceptionLogEntry).filter(ExceptionLogEntry.dedupe_key == B.kiosk_alert_key(alert.id)).one()
    assert e.kind == B.KIND and e.summary == alert.text and e.machine_id == kiosk.id and e.acknowledged_at is None
    assert w.alerted == [B.kiosk_alert_key(alert.id)]
    # Not a bon alert: nothing.
    B.kiosk_alert_raised(w.db, kiosk, SimpleNamespace(id=uuid.uuid4(), kind="printer", reason="no_paper", text="x", detail={}), now=NOW)
    assert w.db.query(ExceptionLogEntry).filter(ExceptionLogEntry.kind == B.KIND).count() == 1
    # The kiosk's alert cleared: resolved. A till's own report never resolves it.
    report(w, kiosk)
    assert e.acknowledged_at is None
    B.kiosk_alert_cleared(w.db, alert, now=NOW + timedelta(minutes=3))
    assert e.acknowledged_at is not None and e.note == B.KIOSK_RESOLVED_NOTE
