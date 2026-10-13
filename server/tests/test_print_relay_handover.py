"""
Relayed kitchen tickets when the print host moves (app/services/print_relay_handover.py; the
reliability audit of tables and kitchen tickets, 13.10.2026).

The three properties, for a ticket relayed through the cloud while the shop's print server moves:

* **No lost ticket** — a job the old host never took goes to the new one at once, not after it
  expired; one the old host took and never answered for goes too, instead of hanging for hours.
* **No silent duplicate** — a job the old host took may be on paper there: it reaches the new host
  marked "הדפסה חוזרת — ייתכן שכבר הודפס" (once, however often it moves). A host that is alive keeps
  what it holds. An expired job (its sender saw "failed") is never revived elsewhere.
* **The old host's word no longer counts** for a job moved away from it (404), so it cannot end it.

Also: "מצב הדרכה" survives the relay (a training ticket is never printed as a real order).

Runs on the world of tests/test_kitchen_printers.py.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from app.models.printers import KitchenPrintJob
from app.services import print_relay_handover as H
from app.services import printers as K
from test_kitchen_printers import (  # noqa: F401 - fixtures
    ack,
    create,
    k,
    make_print_host,
    pending,
    refused,
    send_job,
    statuses,
    w,
)


def heard(till, ago):
    till.last_heartbeat_at = datetime.now(timezone.utc) - ago


def served(k):
    """A network kitchen printer printed for everyone by the print server, till 2 — alive."""
    t1, t2 = k.tills
    printer = create(k, name="Kitchen")["id"]
    make_print_host(k, t2)
    heard(t1, timedelta(seconds=10))
    heard(t2, timedelta(seconds=10))
    k.db.commit()
    return printer


def move_server_to_till_1(k, *, old_silent=True):
    """The server moves to till 1 (its parameter; the lowest register number wins); till 2 goes quiet."""
    t1, t2 = k.tills
    make_print_host(k, t1)
    if old_silent:
        heard(t2, timedelta(minutes=10))
    k.db.commit()
    assert K.print_host_of_shop(k.db, k.shop.id).id == t1.id


def job(k, job_id):
    return k.db.get(KitchenPrintJob, uuid.UUID(job_id))


def test_a_job_the_old_server_never_took_moves_to_the_new_one_unmarked(k):
    printer = served(k)
    t1, t2 = k.tills
    job_id = send_job(k, t1, printer)["id"]
    assert job(k, job_id).target_machine_id == t2.id
    move_server_to_till_1(k)
    handed = pending(k, t1)
    assert [j["id"] for j in handed] == [job_id]
    # Nothing of it was printed anywhere: it goes as it is.
    assert handed[0]["resent"] is False
    assert not handed[0]["ticket"].get("notice")
    row = job(k, job_id)
    assert row.target_machine_id == t1.id and row.status == "printing" and row.deliveries == 1
    # The old server, back, cannot end it any more; the new one does.
    assert refused(ack, k, t2, job_id).status_code == 404
    assert ack(k, t1, job_id)["status"] == "done"
    assert statuses(k, t1, job_id)[job_id]["status"] == "done"


def test_a_job_the_silent_server_took_moves_marked_as_a_possible_reprint(k):
    printer = served(k)
    t1, t2 = k.tills
    job_id = send_job(k, t1, printer)["id"]
    # The old server took it — and fell before answering ("no paper" was its last word).
    assert [j["id"] for j in pending(k, t2)] == [job_id]
    ack(k, t2, job_id, "printing", "no paper")
    move_server_to_till_1(k)
    handed = pending(k, t1)
    assert [j["id"] for j in handed] == [job_id]
    assert handed[0]["resent"] is True
    assert handed[0]["ticket"]["notice"] == H.RESEND_LINE
    row = job(k, job_id)
    # Still "taken": it never expires by the minutes' clock; the old host's note is gone.
    assert row.deliveries == 2 and row.error is None and K.was_taken(row)
    row.expires_at = datetime.now(timezone.utc) - timedelta(hours=1)
    k.db.commit()
    assert statuses(k, t1, job_id)[job_id]["status"] == "printing"
    assert ack(k, t1, job_id)["status"] == "done"


def test_the_resend_band_is_added_once_after_the_ticket_s_own(k):
    assert H.resend_notice(None) == H.RESEND_LINE
    assert H.resend_notice("  ") == H.RESEND_LINE
    assert H.resend_notice("זרז") == f"זרז · {H.RESEND_LINE}"
    assert H.resend_notice(H.resend_notice("זרז")) == f"זרז · {H.RESEND_LINE}"
    # The till's own words, the same on both sides.
    assert H.RESEND_LINE == "הדפסה חוזרת — ייתכן שכבר הודפס"


def test_moved_twice_the_band_is_there_once(k):
    printer = served(k)
    t1, t2 = k.tills
    job_id = send_job(k, t1, printer)["id"]
    pending(k, t2)
    move_server_to_till_1(k)
    pending(k, t1)
    # Till 1 falls too; the server goes back to till 2, alive again.
    from app.models.till_parameter import TillParameter, TillParameterValue

    parameter = k.db.query(TillParameter).filter(TillParameter.key == "printHostTill").one()
    k.db.query(TillParameterValue).filter(
        TillParameterValue.parameter_id == parameter.id, TillParameterValue.scope_id == t1.id,
    ).delete(synchronize_session=False)
    heard(t1, timedelta(minutes=10))
    heard(t2, timedelta(seconds=5))
    k.db.commit()
    handed = pending(k, t2)
    assert [j["id"] for j in handed] == [job_id]
    assert handed[0]["ticket"]["notice"] == H.RESEND_LINE


def test_a_server_that_is_alive_keeps_what_it_holds(k):
    printer = served(k)
    t1, t2 = k.tills
    taken = send_job(k, t1, printer)["id"]
    pending(k, t2)
    waiting = send_job(k, t1, printer)["id"]
    move_server_to_till_1(k, old_silent=False)
    # Heard a moment ago: it prints them and answers for them, as always.
    assert pending(k, t1) == []
    assert job(k, taken).target_machine_id == t2.id and job(k, waiting).target_machine_id == t2.id
    assert ack(k, t2, taken)["status"] == "done"
    assert [j["id"] for j in pending(k, t2)] == [waiting]


def test_an_expired_job_is_never_revived_on_the_new_server(k):
    printer = served(k)
    t1, t2 = k.tills
    job_id = send_job(k, t1, printer)["id"]
    job(k, job_id).expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
    k.db.commit()
    move_server_to_till_1(k)
    # Its sender is told "expired" (and may send it again): one ticket at most.
    assert pending(k, t1) == []
    assert job(k, job_id).status == "expired" and job(k, job_id).target_machine_id == t2.id
    assert statuses(k, t1, job_id)[job_id]["status"] == "expired"


def test_only_the_jobs_of_printers_the_asking_till_prints_now_move(k):
    t1, t2 = k.tills
    # A cloud printer hosted by till 2 itself — not the server's to take.
    bar = create(k, name="Bar", connectionType="cloud", hostMachineId=str(t2.id), hostConnection="network", host="10.0.0.5")
    heard(t2, timedelta(minutes=10))
    k.db.commit()
    job_id = send_job(k, t1, bar["id"])["id"]
    make_print_host(k, t1)
    assert pending(k, t1) == []
    assert job(k, job_id).target_machine_id == t2.id
    # Another shop's till takes nothing of this one.
    assert pending(k, k.other_till) == []


def test_the_handover_counts_and_is_quiet_with_nothing_to_move(k):
    printer = served(k)
    t1, t2 = k.tills
    now = datetime.now(timezone.utc)
    assert H.take_over_stale_jobs(k.db, t1, now) == 0
    send_job(k, t1, printer)
    send_job(k, t1, printer)
    move_server_to_till_1(k)
    assert H.take_over_stale_jobs(k.db, t1, now) == 2
    assert H.take_over_stale_jobs(k.db, t1, now) == 0


def test_a_training_ticket_stays_a_training_ticket_through_the_relay(k):
    from fastapi import BackgroundTasks

    from app.routers import printers as R
    from app.schemas.kitchen_printers import PrintJobIn
    from test_kitchen_printers import ticket

    printer = served(k)
    t1, t2 = k.tills
    body = PrintJobIn.model_validate({"id": str(uuid.uuid4()), "printerId": printer, "ticket": ticket(training=True)})
    R.post_print_job(str(t1.id), body, BackgroundTasks(), machine=t1, db=k.db)
    [handed] = pending(k, t2)
    assert handed["ticket"]["training"] is True
    # A plain ticket says nothing of it.
    send_job(k, t1, printer)
    later = [j for j in pending(k, t2) if j["id"] != handed["id"]]
    assert later and not later[0]["ticket"].get("training")
