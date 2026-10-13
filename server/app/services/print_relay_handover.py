"""
Relayed kitchen tickets when the print host moves (reliability audit of tables and kitchen tickets,
13.10.2026 — scenario "print host moves with jobs pending, printing or relayed through the cloud").

A relayed job (`kitchen_print_jobs`, app/services/printers.py) is made for the till that prints its
printer *then* (`relay_target`): the shop's print server, or a cloud printer's host. When the
server moves — a switch from the dashboard, a till's take-over, the automatic failover, the
parameters, the work profile's dedicated server — the jobs already made still name the old one:

* one the old host never took would wait for it until it expires (`JOB_TTL`): a ticket that
  reaches the kitchen only after a person sees "failed" and sends it again;
* one the old host took and never answered for would stay "printing" for `TAKEN_JOB_TTL` (hours):
  the sender cannot send it again (it may still print there), and nothing prints it.

`take_over_stale_jobs` runs when the new host asks for its jobs (`pending_jobs`) and moves to it
the jobs whose printer it prints now — **only while the old host is not heard** (`is_online`): a
host that is alive keeps what it has, prints it and answers for it, as always. Moved:

* never taken — as it is: nothing of it was printed anywhere;
* taken by the silent host — it may be on paper there already: it goes to the new host marked
  "הדפסה חוזרת — ייתכן שכבר הודפס" (`RESEND_LINE`, the till's own words for a ticket sent again
  after its host moved, KitchenTicketLabels.resent) and `resent`, so the kitchen checks before it
  cooks twice. It stays "taken" (`deliveries`), so it never expires by `JOB_TTL`.

The old host, when it comes back, finds the job no longer its own: its answer is refused (404),
and the till drops what it held for the others while it was away (KitchenPrintService on the
till: a former print host prints nothing it took before it went down).
"""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Dict, Optional

from sqlalchemy.orm import Session

from app.models.pos_machine import POSMachine
from app.models.printers import KitchenPrinter, KitchenPrintJob

#: The band of a ticket sent again after its host moved (the till's KitchenTicketLabels.HEBREW.resent).
RESEND_LINE = "הדפסה חוזרת — ייתכן שכבר הודפס"
#: How a band joins the one a ticket already had (the till's KitchenFailover.resendNotice).
NOTICE_JOIN = " · "


def resend_notice(previous: Optional[str]) -> str:
    """`RESEND_LINE` after whatever band the ticket had — once, however often it is moved."""
    before = (previous or "").strip()
    if not before:
        return RESEND_LINE
    return before if RESEND_LINE in before else f"{before}{NOTICE_JOIN}{RESEND_LINE}"


def take_over_stale_jobs(db: Session, machine: POSMachine, now: datetime) -> int:
    """
    The shop's open relayed jobs that wait at another, silent host, whose printer `machine` prints
    now: moved to `machine` (see the module's doc). How many.
    """
    from app.services import printers as K
    from app.services.machine_status import is_online

    if machine.shop_id is None:
        return 0
    others = [
        mid for (mid,) in db.query(POSMachine.id).filter(POSMachine.shop_id == machine.shop_id).all()
        if str(mid) != str(machine.id)
    ]
    if not others:
        return 0
    rows = (
        db.query(KitchenPrintJob)
        .filter(
            KitchenPrintJob.target_machine_id.in_(others),
            KitchenPrintJob.status.in_(("pending", "printing")),
            KitchenPrintJob.kind == "ticket",
        )
        .order_by(KitchenPrintJob.created_at)
        .all()
    )
    if not rows:
        return 0
    # A job past its time is the sender's "expired" already: never revived on another host.
    K.expire_jobs(db, rows, now)
    targets: Dict[uuid.UUID, Optional[uuid.UUID]] = {}
    hosts: Dict[uuid.UUID, Optional[POSMachine]] = {}
    moved = 0
    for job in rows:
        if job.status not in ("pending", "printing") or job.printer_id is None:
            continue
        if job.printer_id not in targets:
            printer = db.get(KitchenPrinter, job.printer_id)
            targets[job.printer_id] = (
                K.relay_target(db, printer) if printer is not None and printer.is_active else None
            )
        if targets[job.printer_id] is None or str(targets[job.printer_id]) != str(machine.id):
            continue
        if job.target_machine_id not in hosts:
            hosts[job.target_machine_id] = db.get(POSMachine, job.target_machine_id)
        old = hosts[job.target_machine_id]
        if old is not None and old.is_active and is_online(old.last_heartbeat_at, now=now):
            continue  # alive: it prints what it has, and answers for it
        if K.was_taken(job):
            payload = dict(job.payload or {})
            payload["notice"] = resend_notice(payload.get("notice"))
            payload["resent"] = True
            job.payload = payload
            job.status = "pending"
            job.delivered_at = None
        else:
            job.expires_at = now + K.JOB_TTL
        job.target_machine_id = machine.id
        # The old host's note ("no paper there") is not this one's.
        job.error = None
        moved += 1
    if moved:
        db.flush()
    return moved
