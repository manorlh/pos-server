"""
"זיכוי באשראי מהענן — חובה לפני ה-Z הבא" (app/services/cloud_refund_z_gate.py,
docs/SPEC_REMOTE_CREDIT.md §11.10–§11.11).

The owner (09.10.2026): "...אבל חובה שייכנס ל-Z הבא". No Z is produced while a refunded cloud card
refund's credit note is still owed by a till inside it — per scope:

* machine — a till's own Z (`POST /sync/{m}/till-z`, the dashboard's / remote control's request);
* area — an area's Z (its tills in the shop Z);
* shop — the shop Z (the wizard's run, remote control's "סגירת יום סניפית" — remote close v2 —
  its start and its build), never for a till that makes its own Z;
* the main till's local shop Z asks the cloud first (`GET /sync/{m}/shop-z/cloud-refund-guard`).

A till whose open shift the Z closes issues the note into it first (its build says
`card_refund_next_shift`): not a blocker at the start, and the build checks again. Only a super
admin forces, with a typed reason — an exception, the refund released from ONE Z, which then goes
into the next. Off (`cloudCardRefundBlocksNextZ`): no gate, a warning. The server switch off:
nothing changes. A refused Z draws no number: the numbering stays strictly sequential.

Runs on the in-memory SQLite world of tests/test_remote_shop_close.py (REMOTE_TILL_Z_ENABLED on).
"""
from __future__ import annotations

import json
import uuid
from decimal import Decimal

import pytest
from fastapi import HTTPException

from app.models.audit_exception import AuditException
from app.models.cloud_card_refund import CloudCardRefund, CloudCardRefundEvent
from app.models.remote_credit import RemoteCreditRequest
from app.models.shop_area import ShopArea
from app.models.user import User, UserRole
from app.models.z_report import ZReport
from app.models.z_run import ZRun, ZRunStatus
from app.routers import device_commands as R
from app.routers import sync as sync_router
from app.routers import till_shop_z_local as LR
from app.routers import z_runs as z_runs_router
from app.schemas.till_z import TillZIn
from app.schemas.z_run import ZRunCreateIn
from app.services import cloud_card_refunds as ccr
from app.services import cloud_refund_z_gate as G
from app.services import remote_till_z as svc
from app.services import till_z
from app.services.z_sequence import last_machine_z_number, last_shop_z_number
from shift_world import NOW
from test_main_till import set_param
from test_main_till import w  # noqa: F401
from test_remote_shop_close import _ctx, item_of, preview, selling, start, till_closes, z  # noqa: F401


@pytest.fixture
def g(z, monkeypatch):
    """The server switch on; till 1 and till 2 run a build that holds a note for its next shift."""
    monkeypatch.setattr(ccr, "enabled", lambda: True)
    for t in z.tills:
        t.capabilities = ["remote_close_v2", G.NEXT_SHIFT_CAPABILITY]
    z.db.commit()
    return z


def owed(w, till, amount="30.00", document="20000077"):
    """A cloud card refund the gateway confirmed, its credit note asked of `till` and not issued yet."""
    row = CloudCardRefund(
        id=uuid.uuid4(), tenant_id=w.tenant.id, company_id=w.company.id, shop_id=till.shop_id,
        original_machine_id=till.id, original_transaction_id=uuid.uuid4(), original_payment_id=uuid.uuid4(),
        original_document_number=document, original_document_type=320, original_leg_amount=Decimal("50.00"),
        card_last4="4580", provider="zcredit", original_reference="77001234", lines=[], amount=Decimal(amount),
        reason="החזרת מוצר", target_machine_id=till.id, status="refunded", refunded_at=NOW,
        created_by_user_id=w.admin.id, created_at=NOW, updated_at=NOW,
    )
    w.db.add(row)
    w.db.flush()
    req = RemoteCreditRequest(
        id=uuid.uuid4(), tenant_id=w.tenant.id, company_id=w.company.id, machine_id=till.id, shop_id=till.shop_id,
        original_transaction_id=row.original_transaction_id, original_document_number=document, mode="card_refunded",
        card_refund_id=row.id, full_credit=False, lines=[], amount=row.amount, reason=row.reason, status="received",
        expires_at=NOW.replace(year=NOW.year + 1), created_by_user_id=w.admin.id, created_at=NOW, updated_at=NOW,
    )
    w.db.add(req)
    w.db.flush()
    row.remote_credit_request_id = req.id
    w.db.commit()
    return row


def issue(w, row, till, shift):
    """The till issues the note into `shift` and it reaches the cloud (on_documents links it)."""
    note = w.doc(till, shift, str(row.amount), credit_note=True, method="card")
    note.remote_credit_request_id = row.remote_credit_request_id
    row.credit_transaction_id = note.id
    w.db.commit()
    return note


def closed(w, till, seq, *amounts):
    shift = selling(w, till, seq, *amounts)
    till_closes(w, till, shift)
    return shift


MESSAGE = (
    "זיכוי אשראי מהענן ₪30.00 (מסמך מקור 20000077) ממתין להפקה בקופה Till 1 — "
    "פתחו משמרת בקופה Till 1 או שלחו את הזיכוי לקופה אחרת"
)


def wizard(w, user=None, *, area=None, tills=None, **extra):
    body = {
        "shopId": str(w.shop.id), "confirmCloudData": True,
        "machines": [{"machineId": str(t.id)} for t in (tills or w.tills)], **extra,
    }
    if area is not None:
        body["areaId"] = str(area.id)
    return z_runs_router.post_z_run(ZRunCreateIn.model_validate(body), **_ctx(w, user))


def refused(fn, *a, **kw) -> HTTPException:
    with pytest.raises(HTTPException) as e:
        fn(*a, **kw)
    return e.value


def manager(w):
    u = User(id=uuid.uuid4(), role=UserRole.COMPANY_MANAGER, tenant_id=w.tenant.id, email="cm@x", username="cm",
             company_id=w.company.id)
    w.db.add(u)
    w.db.commit()
    return u


def events(w, row):
    return [e.action for e in w.db.query(CloudCardRefundEvent).filter_by(refund_id=row.id)]


def released_once_and_used(w, row):
    """Released by a super admin, and that release used up by the Z that went ahead."""
    got = events(w, row)
    return got.count(G.RELEASED) == 1 and got.count(G.RELEASE_USED) == 1 and not G.released(w.db, row)


# ── Shop scope: the cloud's run ───────────────────────────────────────────────


def test_shop_z_is_refused_while_a_till_without_an_open_shift_owes_a_note(g):
    closed(g, g.t1, 1, "100.00")
    closed(g, g.t2, 1, "60.00")
    owed(g, g.t1)
    before = last_shop_z_number(g.db, g.shop.id)
    e = refused(wizard, g)
    assert e.status_code == 409 and e.detail["code"] == G.REFUSED_CODE == "pending_cloud_card_refund"
    assert e.detail["message"] == MESSAGE and e.detail["canForce"] is True  # the admin is a super admin
    (r,) = e.detail["refunds"]
    assert r["words"] == "זיכוי אשראי מהענן ממתין להפקה (₪30.00)" and r["machineName"] == "Till 1"
    g.db.rollback()
    assert g.db.query(ZRun).count() == 0 and last_shop_z_number(g.db, g.shop.id) == before


def test_a_till_whose_open_shift_the_run_closes_issues_the_note_into_it_first(g):
    s1 = selling(g, g.t1, 1, "100.00")
    s2 = selling(g, g.t2, 1, "60.00")
    row = owed(g, g.t1)
    before = last_shop_z_number(g.db, g.shop.id)
    out = wizard(g)
    run = g.db.get(ZRun, out["id"])
    shown = z_runs_router.get_z_run(run.id, **_ctx(g))
    (p,) = shown["pendingCloudRefunds"]
    assert p["landsInThisZ"] is True and shown["cloudRefundsHold"] is False
    issue(g, row, g.t1, s1)  # the till's close issues it first (pos-android ShiftRepository.close)
    till_closes(g, g.t1, s1)
    till_closes(g, g.t2, s2)
    g.db.refresh(run)
    assert run.status == ZRunStatus.COMPLETED
    z = g.db.get(ZReport, run.z_report_id)
    assert z.z_number == before + 1  # strictly the next number


def test_the_build_waits_for_an_owed_note_and_a_super_admin_may_release_it(g):
    s1 = selling(g, g.t1, 1, "100.00")
    s2 = selling(g, g.t2, 1, "60.00")
    row = owed(g, g.t1)
    before = last_shop_z_number(g.db, g.shop.id)
    run = g.db.get(ZRun, wizard(g)["id"])
    till_closes(g, g.t1, s1)  # closed without the note (it never had it)
    till_closes(g, g.t2, s2)
    shown = z_runs_router.get_z_run(run.id, **_ctx(g))
    assert shown["status"] == "waiting" and shown["cloudRefundsHold"] is True
    assert shown["cloudRefundsMessage"] == MESSAGE and last_shop_z_number(g.db, g.shop.id) == before
    e = refused(z_runs_router.post_z_run_force_cloud_refunds, run.id,
                z_runs_router.ZRunForceCloudRefundsIn(reason="לא בודקים"), **_ctx(g, manager(g)))
    assert e.status_code == 403
    e = refused(z_runs_router.post_z_run_force_cloud_refunds, run.id,
                z_runs_router.ZRunForceCloudRefundsIn(reason="  "), **_ctx(g))
    assert e.status_code == 422
    out = z_runs_router.post_z_run_force_cloud_refunds(
        run.id, z_runs_router.ZRunForceCloudRefundsIn(reason="הקופה בתיקון, ה-Z נדרש היום"), **_ctx(g))
    assert out["status"] == "completed" and out["zNumber"] == before + 1
    assert released_once_and_used(g, row)
    exc = g.db.query(AuditException).filter_by(exception_type=G.EXCEPTION_TYPE).one()
    assert exc.details["reason"] == "הקופה בתיקון, ה-Z נדרש היום" and exc.details["refundId"] == str(row.id)
    # The release is used up: the refund goes into the NEXT Z, which it holds again.
    closed(g, g.t2, 2, "10.00")
    e = refused(wizard, g, tills=[g.t2])
    assert e.detail["code"] == "pending_cloud_card_refund"


def test_the_super_admins_force_at_the_start_with_a_reason_only(g):
    closed(g, g.t1, 1, "100.00")
    closed(g, g.t2, 1, "60.00")
    row = owed(g, g.t1)
    before = last_shop_z_number(g.db, g.shop.id)
    e = refused(wizard, g, manager(g), forceCloudRefundReason="בבקשה לכפות")
    assert e.status_code == 403 and e.detail["code"] == "force_super_admin_only"
    g.db.rollback()
    e = refused(wizard, g, forceCloudRefundReason="ab")
    assert e.status_code == 422 and e.detail["code"] == "force_reason_required"
    g.db.rollback()
    out = wizard(g, forceCloudRefundReason="ה-Z נדרש לדיווח היום")
    assert out["status"] == "completed" and out["zNumber"] == before + 1
    assert released_once_and_used(g, row)
    assert g.db.query(AuditException).filter_by(exception_type=G.EXCEPTION_TYPE).count() == 1


def test_a_note_issued_in_a_shift_the_z_does_not_take_holds_it(g):
    s1 = closed(g, g.t1, 1, "100.00")
    closed(g, g.t2, 1, "60.00")
    later = selling(g, g.t1, 2, "5.00")  # open, left out of this Z by the operator
    row = owed(g, g.t1)
    issue(g, row, g.t1, later)
    # Leaving an open shift out at all: only without "חסימת Z כשיש משמרות פתוחות", on confirmation.
    set_param(g, "zRequireAllShiftsClosed", "shop", g.shop.id, False)
    g.db.commit()
    e = refused(wizard, g, confirmOpenTills=True, machines=[
        {"machineId": str(g.t1.id), "throughShiftId": str(s1.id), "includeOpenShift": False},
        {"machineId": str(g.t2.id)},
    ])
    assert e.detail["code"] == "pending_cloud_card_refund" and "במשמרת שה-Z הזה לא כולל" in e.detail["message"]


# ── Area scope ────────────────────────────────────────────────────────────────


def _area(w, name, *tills):
    a = ShopArea(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, name=name)
    w.db.add(a)
    w.db.flush()
    for t in tills:
        t.area_id = a.id
    w.db.commit()
    return a


def test_an_area_z_is_held_only_by_its_own_tills(g):
    bar, kitchen = _area(g, "Bar", g.t1), _area(g, "Kitchen", g.t2)
    closed(g, g.t1, 1, "100.00")
    closed(g, g.t2, 1, "60.00")
    owed(g, g.t2)
    out = wizard(g, area=bar, tills=[g.t1])  # the bar's Z: the kitchen's refund is not in it
    assert out["status"] == "completed"
    e = refused(wizard, g, area=kitchen, tills=[g.t2])
    assert e.detail["code"] == "pending_cloud_card_refund" and "Till 2" in e.detail["message"]


# ── Machine scope: a till's own Z ─────────────────────────────────────────────


def _till_z(w, till):
    resp = sync_router.post_till_z(
        machine_id=str(till.id), body=TillZIn.model_validate({"clientRequestId": str(uuid.uuid4())}), machine=till, db=w.db,
    )
    return resp.status_code, json.loads(resp.body)


def test_a_tills_own_z_is_held_and_never_a_shop_z_for_it(g):
    g.t1.z_mode = "till"
    g.db.commit()
    closed(g, g.t1, 1, "100.00")
    closed(g, g.t2, 1, "60.00")
    row = owed(g, g.t1)
    before = last_machine_z_number(g.db, g.t1.id)
    code, body = _till_z(g, g.t1)
    assert code == 409 and body["detail"] == "pending_cloud_card_refund" and body["message"] == MESSAGE
    assert body["canForce"] is False and last_machine_z_number(g.db, g.t1.id) == before
    # The dashboard's / remote control's request for its Z: refused up front (no shift to issue into)…
    with pytest.raises(till_z.TillZRefused) as asked:
        till_z.request_for_machine(g.db, g.admin, g.t1)
    assert asked.value.status_code == 409 and asked.value.body["code"] == "pending_cloud_card_refund"
    g.db.rollback()
    # …the shop Z does not take that till, so it is not held by it.
    assert wizard(g, tills=[g.t2])["status"] == "completed"
    # The note issued in its next shift, closed: the till's Z goes ahead, strictly next.
    s2 = selling(g, g.t1, 2, "7.00")
    issue(g, row, g.t1, s2)
    till_closes(g, g.t1, s2)
    code, body = _till_z(g, g.t1)
    assert code == 201 and last_machine_z_number(g.db, g.t1.id) == before + 1


def test_a_till_z_request_with_an_open_shift_goes_ahead_the_close_issues_the_note(g):
    g.t1.z_mode = "till"
    g.db.commit()
    selling(g, g.t1, 1, "100.00")
    owed(g, g.t1)
    req, created = till_z.request_for_machine(g.db, g.admin, g.t1)
    assert created is True


# ── Remote control: remote close v2 ───────────────────────────────────────────


def test_remote_close_v2_shows_the_line_refuses_and_takes_the_super_admins_force(g):
    closed(g, g.t1, 1, "100.00")
    closed(g, g.t2, 1, "60.00")
    row = owed(g, g.t1)
    p = svc.shop_preview(g.db, g.shop, user=g.admin, now=NOW)
    guard = p["cloudRefundGuard"]
    assert guard["hold"] is True and guard["message"] == MESSAGE
    assert guard["pending"][0]["words"] == "זיכוי אשראי מהענן ממתין להפקה (₪30.00)"
    assert p["shopClose"]["available"] is False and p["shopClose"]["whyNot"] == MESSAGE
    assert p["shopClose"]["forceCloudRefundAllowed"] is True
    assert svc.shop_preview(g.db, g.shop, user=manager(g), now=NOW)["shopClose"]["forceCloudRefundAllowed"] is False
    e = refused(svc.shop_request, g.db, g.admin, g.tenant.id, g.shop, totals_key=p["totalsKey"],
                confirm_cloud_data=True, now=NOW)
    assert e.detail["code"] == "shop_close_unavailable" and e.detail["message"] == MESSAGE
    run = svc.shop_request(g.db, g.admin, g.tenant.id, g.shop, totals_key=p["totalsKey"], confirm_cloud_data=True,
                           force_cloud_refund_reason="ה-Z נדרש היום, הקופה בתיקון", now=NOW)
    assert isinstance(run, ZRun) and run.status == ZRunStatus.COMPLETED
    assert released_once_and_used(g, row)


def test_remote_close_v2_run_waiting_for_a_note_shows_it_and_support_forces_it(g):
    s1 = selling(g, g.t1, 1, "100.00")
    s2 = selling(g, g.t2, 1, "60.00")
    owed(g, g.t1)
    run = start(g)  # every till in the shop Z asked to close at rest
    till_closes(g, g.t1, s1)
    till_closes(g, g.t2, s2)
    progress = R.get_shop_close(run.id, **_ctx(g))
    assert progress["status"] == "waiting" and progress["cloudRefundsHold"] is True
    assert progress["forceCloudRefundsAllowed"] is True and progress["pendingCloudRefunds"][0]["machineName"] == "Till 1"
    out = R.post_shop_close_force_cloud_refunds(run.id, R.ShopCloseForceCloudRefundsIn(reason="נבדק מול הסניף"), **_ctx(g))
    assert out["status"] == "completed"


def test_remote_till_z_preview_says_why_not(g):
    g.t1.z_mode = "till"
    g.db.commit()
    closed(g, g.t1, 1, "100.00")
    owed(g, g.t1)
    p = svc.preview(g.db, g.t1, now=NOW)
    assert p["canRequest"] is False and p["whyNot"] == MESSAGE and p["pendingCloudRefunds"][0]["amount"] == "30.00"
    e = refused(svc.request, g.db, g.admin, g.t1, totals_key=p["totalsKey"], now=NOW)
    assert e.status_code == 409 and e.detail["message"] == MESSAGE


# ── The main till's local shop Z: asks first ──────────────────────────────────


def test_lan_shop_z_online_check(g):
    row = owed(g, g.t1)
    out = LR.till_shop_z_cloud_refund_guard(str(g.t2.id), machine=g.t2, db=g.db)
    assert out["required"] is True and out["hold"] is True and out["message"] == MESSAGE
    open1 = selling(g, g.t1, 1, "10.00")  # the round closes till 1's open shift: it issues the note first
    out = LR.till_shop_z_cloud_refund_guard(str(g.t2.id), machine=g.t2, db=g.db)
    assert out["hold"] is False and out["refunds"][0]["landsInThisZ"] is True
    g.t1.capabilities = ["remote_close_v2"]  # a build that would not: it holds the Z
    g.db.commit()
    assert LR.till_shop_z_cloud_refund_guard(str(g.t2.id), machine=g.t2, db=g.db)["hold"] is True
    issue(g, row, g.t1, open1)
    assert LR.till_shop_z_cloud_refund_guard(str(g.t2.id), machine=g.t2, db=g.db)["refunds"] == []


# ── Off ───────────────────────────────────────────────────────────────────────


def test_blocks_next_z_off_no_gate_and_a_warning(g):
    closed(g, g.t1, 1, "100.00")
    closed(g, g.t2, 1, "60.00")
    owed(g, g.t1)
    set_param(g, G.KEY_BLOCKS_Z, "machine", g.t1.id, False)
    g.db.commit()
    p = svc.shop_preview(g.db, g.shop, user=g.admin, now=NOW)
    assert p["cloudRefundGuard"]["hold"] is False and "לא חוסם Z" in p["cloudRefundGuard"]["warnings"][0]["warning"]
    assert wizard(g)["status"] == "completed"


def test_switch_off_nothing_changes(g, monkeypatch):
    closed(g, g.t1, 1, "100.00")
    closed(g, g.t2, 1, "60.00")
    owed(g, g.t1)
    monkeypatch.setattr(ccr, "enabled", lambda: False)
    assert G.blockers(g.db, [g.t1.id]) == []
    assert LR.till_shop_z_cloud_refund_guard(str(g.t2.id), machine=g.t2, db=g.db)["required"] is False
    assert wizard(g)["status"] == "completed"
