"""
"זיכוי באשראי מהענן" — where the credit note lands (docs/SPEC_REMOTE_CREDIT.md §11.8–§11.9).

The owner (09.10.2026): "אם יש Z-Credit, לאפשר זיכוי דרך הענן ושייכנס אוטומטית למשמרת הפתוחה או
למשמרת הבאה — אבל חובה שייכנס ל-Z הבא"; and "גם אם Z-Credit מוגדר ברמת הסניף".

* Till parameters, per layer: `cloudCardRefundsEnabled` (off) beside the server's switch;
  `cloudCardRefundLanding` (`open_shift_only` — as before — or `open_or_next_shift`);
  `cloudCardRefundBlocksNextZ` (on).
* Open shift: issued at once, as before. No open shift: refused as before — or, with
  `open_or_next_shift` and a till build that holds it, the card is refunded and the request waits
  at the till ("ממתין למשמרת הבאה") for its next shift.
* The till the dialog proposes: the sale's own first; with a terminal the branch shares, a till of
  the branch with an open shift before the sale's till's next shift; else refused.
* Support's release from the next Z: a super admin, a typed reason, audited.

**Only a fake gateway** (tests/test_cloud_card_refunds.py `FakeGateway`).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

import pytest

from app.models.audit_exception import AuditException
from app.models.cloud_card_refund import CloudCardRefundEvent
from app.models.remote_credit import RemoteCreditRequest
from app.models.shift import ShiftStatus
from app.routers import cloud_card_refunds as R
from app.routers import remote_credits as RCR
from app.schemas.cloud_card_refund import CloudCardRefundReleaseIn
from app.services import cloud_card_refunds as svc
from app.services import cloud_refund_z_gate as G
from app.services import payment_secrets as PS
from app.services import remote_credits as rc
from app.services import till_parameters as TP
from test_cloud_card_refunds import (  # noqa: F401
    SHOP_TERMINAL,
    TILL_PASSWORD,
    TILL_TERMINAL,
    create,
    request_of,
    world,
    zcredit_meta,
)
from test_main_till import set_param
from test_remote_credits import credit_note, items_of, open_shift
from test_shop_areas import _ctx, refused, w  # noqa: F401


def landing_next(w, scope="company", scope_id=None):
    set_param(w, G.KEY_LANDING, scope, scope_id or w.company.id, G.LANDING_NEXT_SHIFT)


def capable(*tills):
    for t in tills:
        t.capabilities = [G.NEXT_SHIFT_CAPABILITY]


def close(w, shift):
    shift.status = ShiftStatus.CLOSED
    shift.closed_at = datetime.now(timezone.utc)
    w.db.flush()


def prepare(w):
    return R.prepare_cloud_card_refund(transaction_id=w.original.id, **_ctx(w))


def target(out, till):
    return next((t for t in out["document"]["targets"] if t["machineId"] == str(till.id)), None)


def get(w, out):
    return R.get_cloud_card_refund(uuid.UUID(out["id"]), **_ctx(w))


# ── The parameters ────────────────────────────────────────────────────────────


def test_three_till_parameters_with_hebrew_labels_and_the_owners_defaults(world):
    specs = {p.key: p for p in TP.BUILTIN_PARAMETERS}
    enabled, landing, blocks = specs[G.KEY_ENABLED], specs[G.KEY_LANDING], specs[G.KEY_BLOCKS_Z]
    assert (enabled.value_type, enabled.default_value) == ("boolean", False)
    assert (landing.value_type, landing.default_value) == ("enum", "open_shift_only")
    assert tuple(landing.enum_options) == ("open_shift_only", "open_or_next_shift")
    assert (blocks.value_type, blocks.default_value) == ("boolean", True)
    for spec in (enabled, landing, blocks):
        assert "זיכוי באשראי מהענן" in spec.label and len(spec.description) > 80
    # They reach the till through the ordinary parameter sync, resolved company → … → till.
    params = TP.till_parameters_for_machine(world.db, world.tills[1]).parameters
    assert params[G.KEY_LANDING] == "open_shift_only" and params[G.KEY_BLOCKS_Z] is True
    landing_next(world, "machine", world.tills[1].id)
    assert TP.till_parameters_for_machine(world.db, world.tills[1]).parameters[G.KEY_LANDING] == "open_or_next_shift"
    assert G.landing_of(world.db, world.tills[0]) == "open_shift_only"


def test_offered_only_where_the_parameter_is_on_and_the_server_switch_too(world, monkeypatch):
    w = world
    set_param(w, G.KEY_ENABLED, "shop", w.shop.id, False)  # the shop, more specific than the company
    out = prepare(w)
    assert out["enabled"] is False and out["disabledMessage"] == svc.DISABLED_HERE_MESSAGE
    assert refused(create, w).detail["code"] == "cloud_refunds_disabled_here" and w.gw.calls == []
    set_param(w, G.KEY_ENABLED, "machine", w.tills[0].id, True)  # the sale's till, most specific
    assert prepare(w)["enabled"] is True
    monkeypatch.setattr(svc, "enabled", lambda: False)  # the kill switch beats every layer
    out = prepare(w)
    assert out["enabled"] is False and "ZCREDIT_CLOUD_REFUNDS_ENABLED" in out["disabledMessage"]
    assert refused(create, w).detail["code"] == "cloud_refunds_disabled" and w.gw.calls == []


# ── Open shift: at once, as before ────────────────────────────────────────────


def test_an_open_shift_takes_the_note_at_once_as_before(world):
    w = world
    out = prepare(w)
    t = target(out, w.tills[0])
    assert t["landing"] == "open_shift" and t["landingWords"] == "ייכנס למשמרת הפתוחה בקופה Till 1"
    assert t["blocksNextZ"] is True and out["document"]["defaultTargetId"] == str(w.tills[0].id)
    code, got = create(w)
    assert code == 201 and got["status"] == "refunded"
    assert got["documentLanding"] == "open_shift" and got["documentLandingWords"] == "ממתין להפקה במשמרת הפתוחה בקופה Till 1"
    assert got["attentionLabel"] == "ממתין להפקת מסמך הזיכוי בקופה" and got["pendingWords"] == "זיכוי אשראי מהענן ממתין להפקה (₪30.00)"
    created = w.db.query(CloudCardRefundEvent).filter_by(refund_id=uuid.UUID(got["id"]), action="created").one()
    assert created.data["landing"] == "open_shift"


def test_no_open_shift_with_open_shift_only_refuses_before_anything_is_sent(world):
    w = world
    capable(w.tills[1])
    e = refused(create, w, till=w.tills[1])
    assert e.detail["code"] == "target_no_open_shift" and w.gw.calls == []
    assert target(prepare(w), w.tills[1]) is None  # not offered either


# ── No open shift: the next one ───────────────────────────────────────────────


def test_no_open_shift_refunds_and_the_till_holds_it_for_its_next_shift(world):
    w = world
    landing_next(w)
    capable(w.tills[1])
    out = prepare(w)
    t = target(out, w.tills[1])
    assert t["landing"] == "next_shift"
    assert t["landingWords"] == "ייכנס למשמרת הבאה בקופה Till 2 — חובה לפני ה-Z הבא"
    code, got = create(w, till=w.tills[1])
    assert code == 201 and got["status"] == "refunded" and len(w.gw.refunds()) == 1
    req = request_of(w, got)
    assert req.machine_id == w.tills[1].id and req.mode == "card_refunded"
    # The till pulls it, has no shift, and says it waits for the next one.
    pulled = RCR.till_remote_credits(str(w.tills[1].id), machine=w.tills[1], db=w.db)
    assert [r["requestId"] for r in pulled["requests"]] == [str(req.id)]
    rc.apply_ack(w.db, w.tills[1], req.id, phase="waiting", error_code=G.WAITING_CODE, error_message=G.WAITING_WORDS)
    w.db.commit()
    got = get(w, got)
    assert got["documentLanding"] == "next_shift" and got["documentLandingWords"] == "ממתין למשמרת הבאה בקופה Till 2"
    assert got["attention"] == "document_pending" and got["attentionLabel"] == "ממתין למשמרת הבאה בקופה Till 2"
    assert got["blocksNextZ"] is True and got["zGateWarning"] is None
    w.db.expire_all()
    req = w.db.get(RemoteCreditRequest, req.id)
    assert (req.status, req.error_code, req.error_message) == ("received", G.WAITING_CODE, G.WAITING_WORDS)
    # Its first document of the next shift completes it, as any credit note does.
    beer, _ = items_of(w, w.original)
    shift = open_shift(w, w.tills[1])
    note = credit_note(w, w.tills[1], shift, w.original, [(beer, 1, "30.00")], method="card")
    note.remote_credit_request_id = req.id
    w.db.flush()
    rc.on_documents(w.db, w.tills[1], [note.id])
    w.db.commit()
    got = get(w, got)
    assert got["document"]["landed"] is True and got["documentLanding"] is None and got["pendingWords"] is None


def test_a_till_build_that_cannot_hold_it_is_refused(world):
    w = world
    landing_next(w)
    e = refused(create, w, till=w.tills[1])  # no `card_refund_next_shift` capability
    assert e.detail["code"] == "target_no_next_shift" and w.gw.calls == []


def test_the_landing_is_read_for_the_target_till(world):
    w = world
    capable(w.tills[1])
    landing_next(w, "machine", w.tills[1].id)
    assert svc.card_target_refusal(w.db, w.original, w.tills[1]) is None
    close(w, w.north_shift)
    capable(w.other_till)
    assert svc.card_target_refusal(w.db, w.original, w.other_till).detail["code"] == "target_no_open_shift"


def test_blocks_next_z_off_lands_wherever_and_the_row_warns(world):
    w = world
    landing_next(w)
    capable(w.tills[1])
    set_param(w, G.KEY_BLOCKS_Z, "machine", w.tills[1].id, False)
    t = target(prepare(w), w.tills[1])
    assert t["blocksNextZ"] is False and t["landingWords"] == "ייכנס למשמרת הבאה בקופה Till 2"
    _, got = create(w, till=w.tills[1])
    assert got["blocksNextZ"] is False and "לא חוסם Z" in got["zGateWarning"]
    assert G.blockers(w.db, [w.tills[1].id]) == []
    assert [b["refundId"] for b in G.not_blocking(w.db, [w.tills[1].id])] == [got["id"]]


def test_idempotency_is_unchanged_for_a_note_waiting_for_the_next_shift(world):
    w = world
    landing_next(w)
    capable(w.tills[1])
    rid = uuid.uuid4()
    c1, a = create(w, rid=rid, till=w.tills[1])
    c2, b = create(w, rid=rid, till=w.tills[1])
    assert (c1, c2) == (201, 200) and a["id"] == b["id"]
    assert len(w.gw.refunds()) == 1 and w.db.query(RemoteCreditRequest).count() == 1
    assert refused(create, w, rid=rid, till=w.tills[0]).detail["code"] == "card_refund_id_conflict"


# ── Which till: a branch-wide terminal (the owner: "ברמת הסניף") ───────────────


def test_shop_level_terminal_is_the_credentials_and_the_terminal_check(world):
    w = world
    creds, missing = svc.credentials_for(w.db, w.tills[0], w.original)
    assert missing is None and creds.terminal_number == SHOP_TERMINAL
    assert (creds.source, creds.terminal_source) == ("shop", "shop")
    assert prepare(w)["credentials"]["terminalSource"] == "shop"
    meta = zcredit_meta()
    meta["result"]["zcreditTerminalNumber"] = SHOP_TERMINAL  # charged on the branch's terminal
    w.zleg.nayax_meta = meta
    w.db.commit()
    code, out = create(w)
    assert code == 201 and out["credentialSource"] == "shop"
    assert w.gw.refunds()[0][1] == SHOP_TERMINAL
    meta = zcredit_meta()
    meta["result"]["zcreditTerminalNumber"] = "0990000077"
    w.zleg.nayax_meta = meta
    w.db.commit()
    chips = items_of(w, w.original)[1]
    e = refused(create, w, lines=[{"itemId": str(chips.id), "quantity": 1}])
    assert e.detail["code"] == "terminal_changed"


def test_branch_terminal_order_1_the_sales_till_when_its_shift_is_open(world):
    w = world
    open_shift(w, w.tills[1])
    assert prepare(w)["document"]["defaultTargetId"] == str(w.tills[0].id)


def test_branch_terminal_order_2_a_till_of_the_branch_with_an_open_shift(world):
    w = world
    landing_next(w)
    capable(*w.tills)
    close(w, w.shift1)
    open_shift(w, w.tills[1])
    out = prepare(w)
    # The sale's till could take it next shift, North 1 is open — the branch's open till first.
    assert out["document"]["defaultTargetId"] == str(w.tills[1].id)
    assert target(out, w.tills[0])["landing"] == "next_shift"
    assert target(out, w.other_till)["sameBranch"] is False and target(out, w.tills[1])["sameBranch"] is True


def test_branch_terminal_order_3_the_sales_tills_next_shift_before_another_branch(world):
    w = world
    landing_next(w)
    capable(w.tills[0])
    close(w, w.shift1)
    out = prepare(w)  # North 1 (another branch) is open: never proposed for a branch terminal
    assert out["document"]["defaultTargetId"] == str(w.tills[0].id)
    assert target(out, w.tills[0])["landingWords"] == "ייכנס למשמרת הבאה בקופה Till 1 — חובה לפני ה-Z הבא"
    code, got = create(w, till=w.tills[0])
    assert code == 201 and request_of(w, got).machine_id == w.tills[0].id


def test_branch_terminal_order_4_nothing_proposed_and_refused_as_before(world):
    w = world
    close(w, w.shift1)
    out = prepare(w)
    assert out["document"]["defaultTargetId"] is None
    assert refused(create, w, till=w.tills[0]).detail["code"] == "target_no_open_shift"
    assert w.gw.calls == []


def test_a_tills_own_terminal_proposes_the_sales_till_even_for_its_next_shift(world):
    w = world
    w.tills[0].settings = {"zcreditTerminalNumber": TILL_TERMINAL}
    PS.apply_secret_patch(w.db, "machine", w.tills[0].id, {"zcreditPassword": TILL_PASSWORD}, tenant_id=w.tenant.id)
    landing_next(w)
    capable(w.tills[0])
    close(w, w.shift1)
    open_shift(w, w.tills[1])
    out = prepare(w)
    assert out["credentials"]["terminalSource"] == "machine"
    assert out["document"]["defaultTargetId"] == str(w.tills[0].id)
    # Its own terminal and the open-shift-only landing: any eligible open till, as before.
    set_param(w, G.KEY_LANDING, "company", w.company.id, G.LANDING_OPEN_ONLY)
    assert prepare(w)["document"]["defaultTargetId"] in (str(w.tills[1].id), str(w.other_till.id))


# ── Support's release from the next Z ─────────────────────────────────────────


def test_release_from_the_next_z_is_the_super_admins_with_a_reason_and_audited(world):
    w = world
    _, out = create(w)
    rid = uuid.UUID(out["id"])
    e = refused(R.release_cloud_card_refund_from_z, rid, CloudCardRefundReleaseIn(reason="הקופה לא תחזור"),
                **_ctx(w, w.manager))
    assert e.status_code == 403 and e.detail["code"] == "force_super_admin_only"
    e = refused(R.release_cloud_card_refund_from_z, rid, CloudCardRefundReleaseIn(reason=" x "), **_ctx(w))
    assert e.status_code == 422 and e.detail["code"] == "force_reason_required"
    got = R.release_cloud_card_refund_from_z(rid, CloudCardRefundReleaseIn(reason="הקופה הושמדה, ה-Z נדרש היום"), **_ctx(w))
    assert got["zGateReleased"] is True and "z_gate_released" in [e["action"] for e in got["events"]]
    (exc,) = w.db.query(AuditException).filter_by(exception_type=G.EXCEPTION_TYPE).all()
    assert exc.details["reason"] == "הקופה הושמדה, ה-Z נדרש היום" and exc.details["forcedBy"] == "admin"
    assert "30.00" in exc.details["summary"] and exc.machine_id == w.tills[0].id
    assert G.blockers(w.db, [w.tills[0].id]) == []  # the next Z goes without it
    # Once the note lands there is nothing to release.
    beer, _ = items_of(w, w.original)
    note = credit_note(w, w.tills[0], w.shift1, w.original, [(beer, 1, "30.00")], method="card")
    note.remote_credit_request_id = request_of(w, out).id
    w.db.flush()
    rc.on_documents(w.db, w.tills[0], [note.id])
    w.db.commit()
    e = refused(R.release_cloud_card_refund_from_z, rid, CloudCardRefundReleaseIn(reason="שוב פעם בבקשה"), **_ctx(w))
    assert e.detail["code"] == "nothing_to_release"


def test_the_new_routes_are_mounted():
    from app.main import app

    mounted = {(m, r.path) for r in app.routes for m in (getattr(r, "methods", None) or ())}
    for route in (
        ("POST", "/api/v1/cloud-card-refunds/{refund_id}/release-z"),
        ("POST", "/api/v1/z-runs/{run_id}/force-cloud-refunds"),
        ("POST", "/api/v1/device-commands/shop-close/{run_id}/force-cloud-refunds"),
        ("GET", "/api/v1/sync/{machine_id}/shop-z/cloud-refund-guard"),
    ):
        assert route in mounted

