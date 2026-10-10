"""
A kiosk among the shop's tills (app/services/kiosk_ops.py, docs/SPEC_KIOSK.md §16):

* "התראות לקופות": the kiosk's printer / card-terminal / help alerts, routed by its config
  (main till — else all the shop's tills —, all, selected; everyone or managers), raised
  once, de-duplicated, cleared when the kiosk recovers; a help request re-pinged by a
  second tap, answered by a till ("בדרך" → the kiosk hears "acknowledged"), and cleared by
  itself after `clearAfterMin`.
* "סגירה יחד עם ה-Z הסניפי": the shop's Z (cloud run or local) asks the kiosks set so —
  and not closed by that Z itself — to close; the kiosk reports back; the status shows.
* KDS: a kiosk's order reaches the KDS only in KDS mode.

Runs on the in-memory SQLite world of tests/shift_world.py, through the router functions.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException

from app.models.kiosk_ops import KioskAlert, KioskCloseRequest
from app.models.pos_machine import PairingStatus, POSMachine
from app.models.till_parameter import TillParameter, TillParameterValue
from app.models.user import User, UserRole
from app.routers import kiosk_alerts as AR
from app.routers import kiosks as R
from app.schemas.kiosk import KioskCreateIn, KioskSettingsIn, KioskSyncIn
from app.services import ably_notify
from app.services import kds as KDS
from app.services import kiosk_config as C
from app.services import kiosk_ops as OPS
from app.services import main_till as MT
from app.services import till_parameters as TP
from shift_world import accept_str_uuids, make_world

T0 = datetime(2026, 10, 6, 12, 34, 13, tzinfo=timezone.utc)


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    world = make_world()
    world.woken = []
    monkeypatch.setattr(
        ably_notify, "publish_notify",
        lambda tenant, machine, event, body: world.woken.append((machine, body.get("reason")))
        if event == OPS.WAKE_EVENT else None,
    )
    for name in ("publish_close_shift_notify", "publish_till_z_notify", "publish_settings_notify"):
        if hasattr(ably_notify, name):
            monkeypatch.setattr(ably_notify, name, lambda *a, **k: None)
    TP.ensure_builtin_parameters(world.db)
    world.kiosk, world.main = world.tills
    world.third = _till(world, "Till 3")
    R.create_kiosk(
        body=KioskCreateIn(machineId=world.kiosk.id, name="קיוסק רויאל", controllerMachineIds=[str(world.main.id)]),
        current_user=world.admin, active_tenant_id=world.tenant.id, db=world.db,
    )
    world.db.commit()
    return world


def _till(w, name):
    m = POSMachine(
        id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, distributor_id=w.admin.id,
        name=name, machine_code=f"X-{uuid.uuid4().hex[:8]}", pos_number="9", is_active=True,
        pairing_status=PairingStatus.ASSIGNED,
    )
    w.db.add(m)
    w.db.flush()
    return m


def set_param(w, key, scope_type, scope_id, value):
    parameter = w.db.query(TillParameter).filter(TillParameter.key == key).one()
    w.db.add(TillParameterValue(id=uuid.uuid4(), parameter_id=parameter.id, scope_type=scope_type, scope_id=scope_id, value=value))
    w.db.flush()


def put(w, overrides, level="machine", entity=None):
    return R.put_settings(
        body=KioskSettingsIn(overrides=overrides), level=level, scope_id=(entity or w.kiosk).id,
        current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
    )


def refused(fn, *args, **kwargs) -> HTTPException:
    with pytest.raises(HTTPException) as caught:
        fn(*args, **kwargs)
    return caught.value


def kiosk_sync(w, status=None, now=None):
    from app.services import kiosk_control as S

    out = S.kiosk_sync(w.db, w.kiosk, status, now=now or T0)
    w.db.commit()
    return out


def till_alerts(w, till, now=None):
    out = OPS.alerts_for_till(w.db, till, now=now or T0)
    w.db.commit()
    return out


PAPER = {"kind": "printer", "key": "printer:receipt", "reason": "no_paper", "detail": {"target": "receipt"}}
PINPAD = {"kind": "terminal", "key": "terminal", "reason": "unreachable", "detail": {"address": "192.168.0.167"}}


def help_alert(request_id="h1", pings=1, **detail):
    return {"kind": "help", "key": "help", "reason": "help", "requestId": request_id, "pings": pings,
            "detail": {"screen": "pay", "step": "declined", "totalAgorot": 100, **detail}}


# ── The setting ──────────────────────────────────────────────────────────────


def test_the_setting_defaults_to_the_main_till_for_everyone():
    cfg = C.default_config()
    assert C.validate_config(cfg) == []
    assert cfg["alerts"]["printer"] == {"tills": "main", "machineIds": [], "audience": "everyone"}
    assert cfg["alerts"]["help"]["clearAfterMin"] == 10
    assert cfg["operations"]["closeWithShopZ"] is False


def test_the_setting_is_validated_with_paths(w):
    e = refused(put, w, {"alerts": {"printer": {"tills": "kitchen"}}})
    assert {x["path"]: x["code"] for x in e.detail["errors"]}["alerts.printer.tills"] == "invalid_value"
    e = refused(put, w, {"alerts": {"terminal": {"tills": "selected"}}})
    assert {x["path"]: x["code"] for x in e.detail["errors"]}["alerts.terminal.machineIds"] == "too_few"
    e = refused(put, w, {"alerts": {"help": {"audience": "owners", "clearAfterMin": 500}}})
    codes = {x["path"]: x["code"] for x in e.detail["errors"]}
    assert codes["alerts.help.audience"] == "invalid_value" and codes["alerts.help.clearAfterMin"] == "out_of_range"
    # A chosen till must be one of this business's tills, never a kiosk.
    e = refused(put, w, {"alerts": {"help": {"tills": "selected", "machineIds": [str(uuid.uuid4())]}}})
    assert {x["path"]: x["code"] for x in e.detail["errors"]}["alerts.help.machineIds[0]"] == "unknown_till"
    e = refused(put, w, {"alerts": {"help": {"tills": "selected", "machineIds": [str(w.kiosk.id)]}}})
    assert {x["path"]: x["code"] for x in e.detail["errors"]}["alerts.help.machineIds[0]"] == "kiosk_not_a_till"
    put(w, {"alerts": {"help": {"tills": "selected", "machineIds": [str(w.third.id)], "audience": "managers"}}})


def test_a_chosen_list_left_empty_by_a_parent_is_repaired_to_main():
    cfg = C.resolve({"alerts": {"printer": {"tills": "selected", "machineIds": []}}})
    assert cfg["alerts"]["printer"]["tills"] == "main"


# ── Routing ──────────────────────────────────────────────────────────────────


def test_main_till_when_the_shop_has_one_else_all_its_tills(w):
    kiosk_sync(w, {"alerts": [PAPER]})
    # No main till: every till of the shop (never the kiosk, never another shop's).
    assert len(till_alerts(w, w.main)) == 1 and len(till_alerts(w, w.third)) == 1
    assert till_alerts(w, w.other_till) == []
    set_param(w, MT.MAIN_TILL_KEY, "machine", w.main.id, True)
    assert len(till_alerts(w, w.main)) == 1
    assert till_alerts(w, w.third) == []


def test_all_tills_and_selected_tills(w):
    set_param(w, MT.MAIN_TILL_KEY, "machine", w.main.id, True)
    put(w, {"alerts": {"printer": {"tills": "all"}, "terminal": {"tills": "selected", "machineIds": [str(w.third.id)], "audience": "managers"}}})
    kiosk_sync(w, {"alerts": [PAPER, PINPAD]})
    assert [a["kind"] for a in till_alerts(w, w.main)] == ["printer"]
    third = {a["kind"]: a for a in till_alerts(w, w.third)}
    assert set(third) == {"printer", "terminal"}
    assert third["terminal"]["audience"] == "managers" and third["printer"]["audience"] == "everyone"


# ── Printer and card-terminal alerts ─────────────────────────────────────────


def test_a_printer_alert_is_raised_once_and_clears_when_the_printer_is_back(w):
    kiosk_sync(w, {"alerts": [PAPER]})
    alerts = till_alerts(w, w.main)
    assert [a["text"] for a in alerts] == ["קיוסק רויאל — מדפסת קבלות: אין נייר"]
    assert (str(w.main.id), "kiosk_alert") in w.woken
    # Reported again and again: one alert, no new wake-up.
    w.woken.clear()
    kiosk_sync(w, {"alerts": [PAPER]}, now=T0 + timedelta(seconds=15))
    kiosk_sync(w, {"alerts": [PAPER]}, now=T0 + timedelta(seconds=30))
    assert len(till_alerts(w, w.main)) == 1 and w.woken == []
    assert w.db.query(KioskAlert).count() == 1
    # The printer is back: the kiosk stops reporting it, and it clears by itself.
    kiosk_sync(w, {"alerts": []}, now=T0 + timedelta(seconds=45))
    assert till_alerts(w, w.main) == []
    row = w.db.query(KioskAlert).one()
    assert row.clear_reason == "recovered"


def test_a_status_without_alerts_changes_nothing(w):
    kiosk_sync(w, {"alerts": [PAPER]})
    kiosk_sync(w, {"flowState": "attract"})  # an older kiosk build: no `alerts` key
    assert len(till_alerts(w, w.main)) == 1


def test_the_card_terminal_alert_names_the_pinpad(w):
    kiosk_sync(w, {"alerts": [PINPAD, {"kind": "terminal", "key": "terminal:card", "reason": "card_unknown",
                                        "detail": {"amountAgorot": 100}}]})
    texts = sorted(a["text"] for a in till_alerts(w, w.main))
    assert texts == [
        "קיוסק רויאל — אין תקשורת למסופון האשראי (192.168.0.167)",
        "קיוסק רויאל — תשלום באשראי לא הוכרע — נדרש צוות (₪1)",
    ]


def test_the_kiosk_hears_which_alerts_are_open(w):
    out = kiosk_sync(w, {"alerts": [PAPER]})
    assert out["alerts"]["open"] == ["printer:receipt"] and out["alerts"]["help"] is None


def test_a_till_says_it_saw_a_printer_alert_without_clearing_it(w):
    kiosk_sync(w, {"alerts": [PAPER]})
    alert = till_alerts(w, w.main)[0]
    out = AR.till_kiosk_alert_ack(
        machine_id=str(w.main.id), alert_id=alert["id"], body=AR.KioskAlertAckIn(posUserName="דנה"), machine=w.main, db=w.db,
    )
    assert out["acknowledgedBy"] == "דנה · Till 2"
    assert len(till_alerts(w, w.main)) == 1  # open until the printer is back


# ── "בקשת עזרה" ──────────────────────────────────────────────────────────────


def test_a_help_request_reaches_the_tills_with_where_the_customer_is(w):
    kiosk_sync(w, {"alerts": [help_alert(error="התשלום לא אושר")]})
    (alert,) = till_alerts(w, w.main)
    assert alert["kind"] == "help"
    assert alert["text"] == "קיוסק רויאל מבקש עזרה · תשלום · תשלום נדחה · ₪1 · התשלום לא אושר"
    assert alert["pingCount"] == 1


def test_a_second_tap_re_pings_the_same_request(w):
    kiosk_sync(w, {"alerts": [help_alert(pings=1)]})
    w.woken.clear()
    kiosk_sync(w, {"alerts": [help_alert(pings=2)]}, now=T0 + timedelta(seconds=20))
    (alert,) = till_alerts(w, w.main, now=T0 + timedelta(seconds=20))
    assert alert["pingCount"] == 2
    assert (str(w.main.id), "kiosk_alert") in w.woken
    assert w.db.query(KioskAlert).count() == 1  # one open request per kiosk


def test_a_till_answers_on_my_way_and_the_kiosk_hears_it(w):
    kiosk_sync(w, {"alerts": [help_alert()]})
    alert = till_alerts(w, w.main)[0]
    AR.till_kiosk_alert_ack(
        machine_id=str(w.main.id), alert_id=alert["id"], body=AR.KioskAlertAckIn(posUserName="דנה"), machine=w.main, db=w.db,
    )
    w.db.commit()
    assert (str(w.kiosk.id), "kiosk_alert_ack") in w.woken
    assert till_alerts(w, w.main) == [] and till_alerts(w, w.third) == []
    # The kiosk still reports its request until it hears: never raised again.
    out = kiosk_sync(w, {"alerts": [help_alert()]}, now=T0 + timedelta(seconds=10))
    assert out["alerts"]["help"]["state"] == "acknowledged"
    assert out["alerts"]["help"]["by"] == "דנה · Till 2"
    assert till_alerts(w, w.main) == []
    assert w.db.query(KioskAlert).count() == 1


def test_only_a_till_it_was_routed_to_may_answer(w):
    kiosk_sync(w, {"alerts": [help_alert()]})
    alert = till_alerts(w, w.main)[0]
    e = refused(AR.till_kiosk_alert_ack, machine_id=str(w.other_till.id), alert_id=alert["id"], body=None, machine=w.other_till, db=w.db)
    assert e.status_code == 404


def test_a_help_request_clears_by_itself_after_its_minutes(w):
    put(w, {"alerts": {"help": {"clearAfterMin": 5}}})
    kiosk_sync(w, {"alerts": [help_alert()]})
    assert len(till_alerts(w, w.main, now=T0 + timedelta(minutes=4))) == 1
    assert till_alerts(w, w.main, now=T0 + timedelta(minutes=5, seconds=1)) == []
    row = w.db.query(KioskAlert).one()
    assert row.clear_reason == "expired"


def test_a_new_request_after_an_answered_one_is_raised_again(w):
    kiosk_sync(w, {"alerts": [help_alert("h1")]})
    alert = till_alerts(w, w.main)[0]
    AR.till_kiosk_alert_ack(machine_id=str(w.main.id), alert_id=alert["id"], body=None, machine=w.main, db=w.db)
    w.db.commit()
    kiosk_sync(w, {"alerts": [help_alert("h2")]}, now=T0 + timedelta(minutes=1))
    (again,) = till_alerts(w, w.main, now=T0 + timedelta(minutes=1))
    assert again["id"] != alert["id"]


def test_the_controlling_tills_list_shows_open_alerts(w):
    kiosk_sync(w, {"alerts": [PAPER]})
    from app.services import kiosk_control as S

    (summary,) = S.summaries(w.db, [S.get_device(w.db, w.kiosk.id)], now=T0)
    assert summary["alerts"][0]["text"] == "קיוסק רויאל — מדפסת קבלות: אין נייר"


# ── "סגירה יחד עם ה-Z הסניפי" ────────────────────────────────────────────────


def test_the_shop_z_asks_a_kiosk_set_so_to_close_and_it_reports_back(w):
    put(w, {"operations": {"closeWithShopZ": True}})
    made = OPS.request_shop_z_close(w.db, w.shop.id, source="cloud_shop_z", ref="run-1", now=T0)
    w.db.commit()
    assert len(made) == 1
    assert (str(w.kiosk.id), "kiosk_close") in w.woken
    out = kiosk_sync(w, {"flowState": "attract"})
    request = out["closeRequest"]
    assert request["source"] == "cloud_shop_z"
    assert w.db.query(KioskCloseRequest).one().state == "delivered"
    # Asked again while it is still on its way: the same one.
    assert OPS.request_shop_z_close(w.db, w.shop.id, source="cloud_shop_z", now=T0) == []
    # The kiosk closed once idle and made its Z: done, and nothing more is asked.
    out = kiosk_sync(w, {"closeResult": {"id": request["id"], "state": "done", "zNumber": 12, "shiftId": "s1"}},
                     now=T0 + timedelta(minutes=2))
    assert out["closeRequest"] is None
    from app.services import kiosk_control as S

    (summary,) = S.summaries(w.db, [S.get_device(w.db, w.kiosk.id)], now=T0 + timedelta(minutes=3))
    assert summary["shopZClose"]["state"] == "done" and summary["shopZClose"]["zNumber"] == 12


def test_a_kiosk_not_set_so_is_left_alone(w):
    assert OPS.request_shop_z_close(w.db, w.shop.id, source="cloud_shop_z", now=T0) == []


def test_a_kiosk_the_run_closes_itself_is_not_asked_twice(w):
    put(w, {"operations": {"closeWithShopZ": True}})

    class _Item:
        def __init__(self, machine_id, status):
            self.machine_id, self.status = machine_id, status

    class _Run:
        id = "run-2"
        shop_id = w.shop.id
        items = [_Item(w.kiosk.id, "waiting_close")]

    assert OPS.on_cloud_z_run(w.db, _Run(), now=T0) == []
    _Run.items = [_Item(w.kiosk.id, "excluded")]
    assert len(OPS.on_cloud_z_run(w.db, _Run(), now=T0)) == 1


def test_the_local_shop_z_asks_only_an_independent_kiosk(w):
    put(w, {"operations": {"closeWithShopZ": True}})
    # On the LAN: the main till's local Z took the kiosk as a participating till.
    assert OPS.on_local_shop_z(w.db, w.shop.id, None, now=T0) == []
    # An independent kiosk ("קופה עצמאית", makes its own Z): no LAN, not in the local Z.
    w.kiosk.z_mode = "till"
    w.kiosk.independent_till = True
    w.db.flush()
    assert len(OPS.on_local_shop_z(w.db, w.shop.id, None, now=T0)) == 1


def test_an_unanswered_close_request_expires_after_a_day(w):
    put(w, {"operations": {"closeWithShopZ": True}})
    OPS.request_shop_z_close(w.db, w.shop.id, source="cloud_shop_z", now=T0)
    out = kiosk_sync(w, {"flowState": "attract"}, now=T0 + timedelta(hours=25))
    assert out["closeRequest"] is None
    assert w.db.query(KioskCloseRequest).one().state == "expired"


# ── KDS ──────────────────────────────────────────────────────────────────────


def test_a_bon_kiosk_never_releases_to_the_kds(w):
    assert KDS.is_kiosk_device(w.db, w.kiosk) is True
    assert KDS.kiosk_releases_to_kds(w.db, w.kiosk) is False
    assert KDS.is_kiosk_device(w.db, w.main) is False


def test_a_kds_kiosk_does(w, monkeypatch):
    monkeypatch.setattr(C, "kds_available", lambda: True)
    put(w, {"general": {"fulfillmentMode": "KDS"}})
    assert KDS.kiosk_releases_to_kds(w.db, w.kiosk) is True


def test_the_release_refuses_a_bon_kiosks_order(w, monkeypatch):
    from app.schemas.kds import KdsReleaseIn
    from app.services import kds_workflow as WF

    monkeypatch.setattr(WF, "config_for_machine", lambda db, m: {"enabled": True})
    body = KdsReleaseIn.model_validate({
        "id": str(uuid.uuid4()), "source": "kiosk", "sourceRef": "tx-1", "trigger": "payment", "paid": True,
        "items": [],
    })
    assert KDS.release(w.db, w.kiosk, body) == {"accepted": False, "reason": "kiosk_not_kds"}


# ── No internet never stops the kiosk (docs/SPEC_KIOSK.md §17) ───────────────


def test_both_offline_options_are_off_by_default_and_validated(w):
    general = C.default_config()["general"]
    assert general["blockWhenOffline"] is False and general["offlineNotice"] is False
    put(w, {"general": {"blockWhenOffline": True, "offlineNotice": True}})
    e = refused(put, w, {"general": {"blockWhenOffline": "yes"}})
    assert {x["path"]: x["code"] for x in e.detail["errors"]}["general.blockWhenOffline"] == "invalid_type"


def test_a_kiosk_silent_while_trading_is_an_alert_on_the_terminal_route(w):
    from app.models.kiosk import KioskDevice

    device = w.db.query(KioskDevice).filter(KioskDevice.machine_id == w.kiosk.id).one()
    device.last_kiosk_sync_at = T0
    device.status = {"shiftOpen": True}
    w.db.commit()
    # Quiet for less than the rule's minutes: nothing.
    assert till_alerts(w, w.main, now=T0 + timedelta(minutes=2)) == []
    later = till_alerts(w, w.main, now=T0 + timedelta(minutes=6))
    assert [a["key"] for a in later] == ["kiosk:offline"]
    assert later[0]["text"].startswith("קיוסק רויאל — אין חיבור לאינטרנט מאז ")
    # Not trading (its shift closed): no alert.
    device.status = {"shiftOpen": False}
    w.db.commit()
    assert till_alerts(w, w.main, now=T0 + timedelta(minutes=6)) == []
    # Back: the next sync clears it.
    device.status = {"shiftOpen": True}
    w.db.commit()
    kiosk_sync(w, {"flowState": "attract", "shiftOpen": True}, now=T0 + timedelta(minutes=7))
    assert till_alerts(w, w.main, now=T0 + timedelta(minutes=8)) == []


# ── A kiosk away from the shop's LAN: its bon through the cloud relay ────────


def _kitchen_printer(w, **over):
    from app.models.printers import KitchenPrinter

    p = KitchenPrinter(
        id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, name=over.pop("name", "Kitchen"),
        connection_type=over.pop("connection_type", "network"), host=over.pop("host", "192.168.0.50"), port=9100,
        **over,
    )
    w.db.add(p)
    w.db.commit()
    return p


def _bon(w, printer, job_id=None):
    from app.routers import printers as PR
    from app.schemas.kitchen_printers import PrintJobIn
    from fastapi import BackgroundTasks

    body = PrintJobIn.model_validate({
        "id": str(job_id or uuid.uuid4()), "printerId": str(printer.id),
        "ticket": {"source": "sale", "createdAt": "2026-10-06T15:34:35+03:00", "orderRef": "A-1",
                   "lines": [{"productId": "p", "name": "קפה", "quantity": 1}]},
    })
    tasks = BackgroundTasks()
    out = PR.post_print_job(str(w.kiosk.id), body, tasks, machine=w.kiosk, db=w.db)
    for task in tasks.tasks:
        task.func(*task.args, **task.kwargs)
    return out


def _host_side(w, host):
    from app.routers import printers as PR

    return PR.get_pending_print_jobs(str(host.id), machine=host, db=w.db)["jobs"]


def _ack(w, host, job_id, status="done", error=None):
    from app.routers import printers as PR
    from app.schemas.kitchen_printers import PrintJobAckIn

    return PR.ack_print_job(str(host.id), job_id, PrintJobAckIn(status=status, error=error), machine=host, db=w.db)


def _kiosk_view(w, *ids):
    from app.routers import printers as PR

    return {j["id"]: j for j in PR.get_print_job_statuses(str(w.kiosk.id), ids=",".join(ids), machine=w.kiosk, db=w.db)["jobs"]}


def test_an_independent_kiosk_away_from_the_lan_prints_its_bon_at_the_shop(w):
    # "קיוסק רויאל" is independent (no LAN) and the kitchen printer stands on the shop's LAN:
    # the bon goes up to the cloud and the shop's print server (its main till) prints it.
    w.kiosk.z_mode = "till"
    w.kiosk.independent_till = True
    set_param(w, MT.MAIN_TILL_KEY, "machine", w.main.id, True)
    w.db.commit()
    printer = _kitchen_printer(w)
    job = _bon(w, printer)
    jid = job["id"]
    # The kiosk's view while the host has not printed it yet: handed over ("נשלח למדפסת").
    assert _kiosk_view(w, jid)[jid]["status"] in ("pending", "leased")
    handed = _host_side(w, w.main)
    assert [j["id"] for j in handed] == [jid]
    assert handed[0]["ticket"]["orderRef"] == "A-1"
    # Printed at the shop: the relay's ack is what the kiosk reads back.
    _ack(w, w.main, jid, "done")
    w.db.commit()
    assert _kiosk_view(w, jid)[jid]["status"] == "done"


def test_a_failed_print_at_the_host_reaches_the_kiosk(w):
    set_param(w, MT.MAIN_TILL_KEY, "machine", w.main.id, True)
    printer = _kitchen_printer(w)
    jid = _bon(w, printer)["id"]
    _host_side(w, w.main)
    _ack(w, w.main, jid, "failed", "no paper")
    w.db.commit()
    seen = _kiosk_view(w, jid)[jid]
    assert seen["status"] == "failed" and seen["error"] == "no paper"


def test_a_cloud_printer_hosted_by_a_till_takes_the_kiosks_bon(w):
    printer = _kitchen_printer(w, name="Bar", connection_type="cloud", host=None, host_machine_id=w.third.id, host_connection="network")
    jid = _bon(w, printer)["id"]
    assert [j["id"] for j in _host_side(w, w.third)] == [jid]
    assert _host_side(w, w.main) == []


def test_a_retried_upload_after_a_cloud_outage_is_the_same_bon(w):
    # The kiosk keeps the bon queued while the cloud is down and sends it again: one job.
    set_param(w, MT.MAIN_TILL_KEY, "machine", w.main.id, True)
    printer = _kitchen_printer(w)
    jid = str(uuid.uuid4())
    _bon(w, printer, jid)
    _bon(w, printer, jid)
    assert [j["id"] for j in _host_side(w, w.main)] == [jid]


def test_an_independent_kiosk_is_told_to_reach_the_shops_printers_through_the_cloud(w):
    from app.routers import printers as PR

    set_param(w, MT.MAIN_TILL_KEY, "machine", w.main.id, True)
    _kitchen_printer(w)
    w.kiosk.z_mode = "till"
    w.kiosk.independent_till = True
    w.db.commit()
    pulled = PR.get_own_printers(str(w.kiosk.id), etag=None, machine=w.kiosk, db=w.db)
    host = pulled["printHost"]
    # The shop's print server, never itself, with no LAN address: direct if it can, else the cloud.
    assert host["machineId"] == str(w.main.id) and host["isSelf"] is False and host["lanAddress"] is None
    # An independent till that is no kiosk still prints by itself, as before.
    w.third.z_mode = "till"
    w.third.independent_till = True
    w.db.commit()
    assert PR.get_own_printers(str(w.third.id), etag=None, machine=w.third, db=w.db)["printHost"] is None


# ── An unprinted bon: wording, "הדפס עכשיו" / "סמן כטופל" from the controlling till (§16.8) ──


def _paid_order(w, local_id="o1", label="A-1", bon="failed"):
    from datetime import date
    from app.schemas.kiosk import KioskOrdersIn

    body = {
        "localId": local_id, "transactionId": "t1", "transactionNumber": "30000001",
        "pickupNumber": 1, "pickupLabel": label, "businessDate": date.today().isoformat(),
        "serviceType": "take_away", "fulfillmentMode": "BON", "configVersion": "abc",
        "customerName": None, "customerPhone": None, "itemCount": 1, "totalAgorot": 100,
        "tipAgorot": 0, "paidAt": datetime.now(timezone.utc).isoformat(), "bonStatus": bon,
        "receiptStatus": "printed", "status": "paid_print_failed" if bon == "failed" else "paid",
    }
    R.post_kiosk_orders(machine_id=str(w.kiosk.id), body=KioskOrdersIn(orders=[body]), machine=w.kiosk, db=w.db)
    w.db.commit()


def _till_bon_command(w, action, local_id):
    from fastapi import Response
    from app.schemas.kiosk import KioskCommandIn

    response = Response()
    out = R.post_till_kiosk_command(
        machine_id=str(w.main.id), kiosk_machine_id=str(w.kiosk.id),
        body=KioskCommandIn(action=action, message=local_id, posUserName="דנה"), response=response,
        machine=w.main, db=w.db,
    )
    w.db.commit()
    return out, response.status_code


def test_the_printer_is_fine_but_a_bon_did_not_print_is_said_so():
    assert OPS.alert_text("קיוסק רויאל", "printer", "bon_unprinted", {"orders": "A-1", "count": 1}) == \
        "קיוסק רויאל — בון של הזמנה A-1 לא הודפס"
    assert OPS.alert_text("קיוסק רויאל", "printer", "bon_unprinted", {"orders": "A-1, A-2", "count": 2}) == \
        "קיוסק רויאל — 2 בונים לא הודפסו (A-1, A-2)"


def test_the_controlling_till_sees_the_unprinted_bon_and_prints_it_now(w):
    from app.models.kiosk import KioskCommand
    from app.services import kiosk_control as S

    _paid_order(w)
    (summary,) = S.summaries(w.db, [S.get_device(w.db, w.kiosk.id)])
    assert [o["label"] for o in summary["unprintedOrders"]] == ["A-1"]
    out, code = _till_bon_command(w, "bon_print", "o1")
    assert code == 201 and out["status"] == "requested"
    assert (str(w.kiosk.id), "kiosk_bon") in w.woken
    # The kiosk gets it on its next sync, does it, and says so.
    pending = kiosk_sync(w, {"flowState": "attract"})["bonCommands"]
    assert [(c["action"], c["localId"]) for c in pending] == [("bon_print", "o1")]
    after = kiosk_sync(w, {"flowState": "attract", "commandsDone": [pending[0]["id"]]})
    assert after["bonCommands"] == []
    row = w.db.query(KioskCommand).filter(KioskCommand.action == "bon_print").one()
    assert row.status == "applied" and row.requested_by_name


def test_marked_handled_is_audited_and_leaves_the_list(w):
    from app.models.kiosk import KioskCommand
    from app.services import kiosk_control as S

    _paid_order(w)
    _till_bon_command(w, "bon_handled", "o1")
    pending = kiosk_sync(w, {"flowState": "attract"})["bonCommands"]
    kiosk_sync(w, {"flowState": "attract", "commandsDone": [pending[0]["id"]]})
    # The kiosk re-posts the order handled: status "paid", the audit line on the bon.
    _paid_order(w, bon="failed")
    from app.models.kiosk import KioskOrder

    o = w.db.query(KioskOrder).one()
    o.status = "paid"
    o.bon_detail = "סומן כטופל — דנה"
    w.db.commit()
    (summary,) = S.summaries(w.db, [S.get_device(w.db, w.kiosk.id)])
    assert summary["unprintedOrders"] == []
    assert w.db.query(KioskCommand).filter(KioskCommand.action == "bon_handled", KioskCommand.status == "applied").count() == 1


def test_a_bon_command_for_an_unknown_order_is_refused(w):
    out, _code = _till_bon_command(w, "bon_print", "nope")
    assert out.status_code == 404
