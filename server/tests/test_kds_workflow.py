"""
"תצורת עבודה לעמדה" — workflow_mode (docs/SPEC_KDS.md §1–3; the owner's decision §1–8).

* **Pure rules** — normalization (off = legacy, coercions), validation §7 (errors and
  warnings), the version, profiles, a worker's switch.
* **Levels** — company → shop → point of sale → till, the most specific winning; the
  preview saves nothing; the backend refuses an invalid level even with no UI.
* **Snapshot & lifecycle (§8 of the decision)** — a change of the till's configuration
  leaves orders already released as they were; DIRECT_SALE asks for no preparation and
  never raises a ready event; a kiosk order opens on its own after payment; PRINTER+KDS
  makes no duplicate task; a service type change keeps the mode; a new kiosk order leaves
  the previous customer's tasks alone.
"""
from __future__ import annotations

import uuid

import pytest
from fastapi import BackgroundTasks, HTTPException

from app.models.kds import KitchenDispatch, KitchenOrder, KitchenTask
from app.models.outbox import OutboxEvent
from app.routers import kds as R
from app.schemas.kds import WorkflowValuesIn
from app.services import kds_workflow as WF
from app.services import till_parameters as TP
from test_kds import _assign, _station, _till, act, board, configure, device, item, kd, release, refused  # noqa: F401
from test_kitchen_printers import _run, k  # noqa: F401
from test_shop_areas import _ctx, w  # noqa: F401


def raw(**over):
    base = dict(WF.DEFAULTS)
    base["enabled"] = True
    base.update(over)
    return base


def codes(issues):
    return sorted({i["code"] for i in issues})


# ── Pure rules ────────────────────────────────────────────────────────────────


class TestRules:
    def test_off_is_the_legacy_configuration_whatever_is_stored(self):
        cfg = WF.normalize(raw(enabled=False, defaultMode="ORDER_PROCESS", targets=["kds"], readyNotification=True))
        assert cfg["enabled"] is False and cfg["defaultMode"] == "DIRECT_SALE" and cfg["targets"] == ["printer"]
        assert cfg["readyNotification"] is False

    def test_ready_notification_requires_order_process_and_a_ready_source(self):
        errors, _ = WF.validate(raw(readyNotification=True))
        assert "ready_notification_requires_order_process" in codes(errors)
        errors, _ = WF.validate(raw(defaultMode="ORDER_PROCESS", allowedModes=["ORDER_PROCESS"], readyNotification=True))
        assert "ready_notification_requires_ready_source" in codes(errors)
        errors, _ = WF.validate(raw(
            defaultMode="ORDER_PROCESS", allowedModes=["ORDER_PROCESS"], targets=["kds"], readyNotification=True,
        ))
        assert errors == []

    def test_public_pickup_requires_a_managed_state(self):
        assert "pickup_screen_requires_order_process" in codes(WF.validate(raw(targets=["printer", "pickup_screen"]))[0])
        errors, _ = WF.validate(raw(defaultMode="ORDER_PROCESS", allowedModes=["ORDER_PROCESS"], targets=["pickup_screen"]))
        assert "pickup_screen_requires_managed_state" in codes(errors)

    def test_require_expo_requires_an_expo(self):
        errors, _ = WF.validate(raw(defaultMode="ORDER_PROCESS", allowedModes=["ORDER_PROCESS"], targets=["kds"], requireExpo=True))
        assert "require_expo_requires_expo_target" in codes(errors)

    def test_a_mandatory_target_needs_an_active_device(self):
        cfg = raw(defaultMode="ORDER_PROCESS", allowedModes=["ORDER_PROCESS"], targets=["kds", "expo"], requireExpo=True)
        errors, _ = WF.validate(cfg, devices={})
        assert {"kds_target_without_device", "expo_target_without_device"} <= set(codes(errors))
        assert WF.validate(cfg, devices={"station": 1, "expo": 1})[0] == []
        # At company level no shop's devices are known: a warning, checked again per shop.
        errors, warnings = WF.validate(cfg, devices=None)
        assert errors == [] and "devices_checked_per_shop" in codes(warnings)

    def test_default_mode_must_be_allowed_and_kiosk_pays_first(self):
        assert "default_mode_not_allowed" in codes(WF.validate(raw(defaultMode="ORDER_PROCESS"))[0])
        assert "kiosk_releases_after_payment" in codes(WF.validate(raw(source="KIOSK", paymentPolicy="BEFORE_PAYMENT"))[0])

    def test_inactivity_zero_is_off_and_out_of_range_is_refused(self):
        assert WF.validate(raw(inactivityTable=0))[0] == []
        assert WF.normalize(raw(inactivityTable=0))["inactivityTable"] is None
        assert "inactivity_out_of_range" in codes(WF.validate(raw(inactivityKiosk=5))[0])
        assert WF.normalize(raw(inactivityKiosk=90))["inactivityKiosk"] == 90

    def test_order_process_fields_are_refused_in_direct_sale(self):
        errors, _ = WF.validate(raw(requireStartPreparation=True))
        assert "order_process_field_in_direct_sale" in codes(errors)

    def test_normalize_coerces_what_validate_refuses(self):
        cfg = WF.normalize(raw(readyNotification=True, requireExpo=True, targets=["printer", "pickup_screen"], workerCanSwitch=True))
        assert cfg["readyNotification"] is False and cfg["requireExpo"] is False
        assert cfg["targets"] == ["printer"] and cfg["workerCanSwitch"] is False
        assert WF.normalize(raw(source="KIOSK", paymentPolicy="BEFORE_PAYMENT"))["paymentPolicy"] == "AFTER_PAYMENT"

    def test_the_version_follows_the_configuration(self):
        a = WF.normalize(raw())
        b = WF.normalize(raw(targets=["printer", "kds"]))
        assert WF.config_version(a) == WF.config_version(WF.normalize(raw()))
        assert WF.config_version(a) != WF.config_version(b) and len(WF.config_version(a)) == 12

    def test_profiles_are_presets(self):
        bon = WF.normalize(raw(**WF.PROFILES["kiosk_bon"]))
        kds = WF.normalize(raw(**WF.PROFILES["kiosk_kds"]))
        assert WF.describe(bon)["profile"] == "kiosk_bon" and WF.describe(bon)["kioskFulfillmentMode"] == "BON"
        assert WF.describe(kds)["kioskFulfillmentMode"] == "KDS"

    def test_direct_sale_with_the_printer_only_creates_no_task(self):
        rules = WF.mode_rules(WF.normalize(raw()), "DIRECT_SALE")
        assert rules["createsTasks"] is False and rules["readyEvent"] is False
        view = WF.mode_rules(WF.normalize(raw(targets=["printer", "kds_view"])), "DIRECT_SALE")
        assert view["createsTasks"] and view["viewOnly"] and not view["readyEvent"]

    def test_a_worker_switches_only_when_allowed(self):
        both = WF.normalize(raw(allowedModes=["DIRECT_SALE", "ORDER_PROCESS"], workerCanSwitch=True))
        assert WF.resolve_mode(both, "ORDER_PROCESS") == ("ORDER_PROCESS", True)
        one = WF.normalize(raw())
        assert WF.resolve_mode(one, "ORDER_PROCESS") == ("DIRECT_SALE", False)

    def test_the_parameters_are_built_in_and_kept_off_the_generic_page(self):
        keys = {p.key for p in TP.BUILTIN_PARAMETERS}
        assert set(WF.WORKFLOW_KEYS) <= keys
        assert all(TP.managed_on(key) == "workflow" for key in WF.WORKFLOW_KEYS)
        assert TP.managed_on("kitchenTicketsOnSale") == "printers"


# ── Levels ────────────────────────────────────────────────────────────────────


class TestLevels:
    def test_company_then_shop_then_till(self, k):
        configure(k, "company", k.company.id, enabled=True, targets=["printer", "kds_view"])
        view = R.get_workflow_config(scope_type="machine", scope_id=k.tills[0].id, **_ctx(k))
        assert view["effective"]["targets"] == ["printer", "kds_view"]
        configure(k, "machine", k.tills[0].id, enabled=False)
        assert R.get_workflow_config(scope_type="machine", scope_id=k.tills[0].id, **_ctx(k))["effective"]["enabled"] is False
        assert R.get_workflow_config(scope_type="machine", scope_id=k.tills[1].id, **_ctx(k))["effective"]["enabled"] is True
        # Removing the till's value falls back to the shop / company.
        configure(k, "machine", k.tills[0].id, enabled=None)
        assert R.get_workflow_config(scope_type="machine", scope_id=k.tills[0].id, **_ctx(k))["own"] == {}

    def test_the_preview_saves_nothing(self, k):
        out = R.preview_workflow_config(
            WorkflowValuesIn(scopeType="shop", scopeId=k.shop.id, values={"enabled": True, "readyNotification": True}),
            **_ctx(k),
        )
        assert "ready_notification_requires_order_process" in codes(out["errors"])
        assert R.get_workflow_config(scope_type="shop", scope_id=k.shop.id, **_ctx(k))["own"] == {}

    def test_the_backend_refuses_an_invalid_level(self, k):
        e = refused(configure, k, enabled=True, defaultMode="ORDER_PROCESS", allowedModes=["ORDER_PROCESS"], targets=["kds"])
        assert e.status_code == 422 and "kds_target_without_device" in codes(e.detail["errors"])
        e = refused(configure, k, enabled=True, readyNotification=True)
        assert e.status_code == 422

    def test_only_the_shops_managers_edit_it(self, k):
        with pytest.raises(HTTPException) as e:
            R.put_workflow_config(
                WorkflowValuesIn(scopeType="shop", scopeId=k.shop.id, values={"enabled": True}),
                BackgroundTasks(), **_ctx(k, k.cashier),
            )
        assert e.value.status_code == 403
        with pytest.raises(HTTPException) as e:
            R.get_workflow_config(scope_type="company", scope_id=k.company.id, **_ctx(k, k.manager))
        assert e.value.status_code == 403

    def test_the_till_reads_its_configuration(self, k):
        configure(k, enabled=True, targets=["printer", "kds_view"])
        out = R.get_till_workflow(str(k.tills[0].id), machine=k.tills[0], db=k.db)
        assert out["targets"] == ["printer", "kds_view"] and out["configVersion"]
        assert R.get_kds_device(str(k.tills[0].id), machine=k.tills[0], db=k.db)["device"] is None


# ── Snapshot and lifecycle ────────────────────────────────────────────────────


class TestSnapshotAndLifecycle:
    def test_off_records_nothing(self, k):
        out = release(k, till=k.tills[0], items=[item("l1:0", k.steak)])
        assert out == {"accepted": False, "reason": "kds_disabled"}
        assert k.db.query(KitchenOrder).count() == 0

    def test_a_change_of_configuration_leaves_released_orders_as_they_were(self, kd):
        first = release(kd, ref="old", items=[item("l1:0", kd.steak)])
        old = kd.db.query(KitchenOrder).filter(KitchenOrder.id == uuid.UUID(first["orderId"])).one()
        configure(kd, defaultMode="DIRECT_SALE", allowedModes=["DIRECT_SALE"], targets=["printer"], readyNotification=False)
        # The old order keeps its mode and version, and its next round runs under them.
        later = release(kd, ref="old", items=[item("l2:0", kd.cola)])
        assert later["workflowMode"] == "ORDER_PROCESS" and later["configVersion"] == first["configVersion"]
        assert old.config_snapshot["defaultMode"] == "ORDER_PROCESS"
        fresh = release(kd, ref="new", items=[item("l1:0", kd.steak)])
        assert fresh["workflowMode"] == "DIRECT_SALE" and fresh["configVersion"] != first["configVersion"]
        assert fresh["noTasks"] is True

    def test_direct_sale_asks_for_no_preparation_and_sends_no_ready(self, kd):
        configure(kd, defaultMode="DIRECT_SALE", allowedModes=["DIRECT_SALE"], targets=["printer"], readyNotification=False)
        out = release(kd, source="quick", ref="ds", paid=True, trigger="payment", contactPhone="+972501234567",
                      items=[item("l1:0", kd.steak)])
        assert out["noTasks"] is True and out["tasksCreated"] == 0
        assert kd.db.query(KitchenTask).count() == 0
        assert board(kd, kd.expo_screen)["orders"] == []
        assert kd.db.query(OutboxEvent).count() == 0
        # The snapshot is kept: the order, its mode and its version.
        order = kd.db.query(KitchenOrder).one()
        assert order.workflow_mode == "DIRECT_SALE" and order.config_version == out["configVersion"]

    def test_direct_sale_with_a_view_kds_shows_it_but_never_raises_ready(self, kd):
        configure(kd, defaultMode="DIRECT_SALE", allowedModes=["DIRECT_SALE"], targets=["printer", "kds_view"], readyNotification=False)
        out = release(kd, source="quick", ref="dv", paid=True, trigger="payment", contactPhone="+972501234567",
                      items=[item("l1:0", kd.steak)])
        o = board(kd, kd.grill_screen)["orders"][0]
        assert o["viewOnly"] is True and o["tasks"][0]["targetKind"] == "view"
        act(kd, kd.grill_screen, "station_ready", orderId=out["orderId"])
        assert kd.db.query(OutboxEvent).count() == 0
        assert act(kd, kd.expo_screen, "ready_for_pickup", orderId=out["orderId"])["reason"] == "not_order_process"

    def test_a_kiosk_order_opens_by_itself_after_payment(self, kd):
        out = release(kd, source="kiosk", ref="kk", paid=True, trigger="payment", items=[item("l1:0", kd.steak)])
        o = board(kd, kd.grill_screen)["orders"][0]
        assert o["status"] == "open" and o["tableRef"] is None and o["pickupNumber"] == out["pickupNumber"]

    def test_printer_and_kds_together_make_no_duplicate_task(self, kd):
        configure(kd, targets=["printer", "kds", "expo"])
        out = release(kd, ref="pk", items=[item("l1:0", kd.steak, 2), item("l2:0", kd.cola)])
        assert out["tasksCreated"] == 2 and kd.db.query(KitchenTask).count() == 2

    def test_a_change_of_service_type_keeps_the_mode(self, kd):
        first = release(kd, source="quick", ref="sv", paid=True, trigger="payment", serviceType="take_away",
                        items=[item("l1:0", kd.steak)])
        configure(kd, defaultMode="DIRECT_SALE", allowedModes=["DIRECT_SALE"], targets=["printer"], readyNotification=False)
        again = release(kd, source="quick", ref="sv", paid=True, trigger="payment", serviceType="eat_in",
                        items=[item("l2:0", kd.cola)])
        assert again["workflowMode"] == first["workflowMode"] == "ORDER_PROCESS"
        order = kd.db.query(KitchenOrder).one()
        assert order.service_type == "eat_in"

    def test_a_new_kiosk_customer_leaves_the_previous_ones_tasks(self, kd):
        a = release(kd, source="kiosk", ref="cust-1", paid=True, trigger="payment", items=[item("l1:0", kd.steak)])
        release(kd, source="kiosk", ref="cust-2", paid=True, trigger="payment", items=[item("l2:0", kd.cola)])
        assert len([t for t in kd.db.query(KitchenTask).all() if str(t.order_id) == a["orderId"]]) == 1
        assert len(board(kd, kd.expo_screen)["orders"]) == 2

    def test_a_worker_switch_is_honoured_only_when_allowed_and_recorded(self, kd):
        from app.models.kds import KitchenAction

        out = release(kd, ref="sw", workflowMode="DIRECT_SALE", items=[item("l1:0", kd.steak)])
        assert out["workflowMode"] == "ORDER_PROCESS"  # not allowed here
        configure(kd, allowedModes=["DIRECT_SALE", "ORDER_PROCESS"], workerCanSwitch=True)
        out = release(kd, ref="sw2", workflowMode="DIRECT_SALE", items=[item("l1:0", kd.steak)])
        assert out["workflowMode"] == "DIRECT_SALE"
        assert kd.db.query(KitchenAction).filter(KitchenAction.type == "mode_switch").count() == 1

    def test_every_release_keeps_what_was_sent_without_the_phone(self, kd):
        out = release(kd, source="kiosk", ref="aud", paid=True, trigger="payment", contactPhone="+972509999999",
                      items=[item("l1:0", kd.steak)])
        dispatch = kd.db.query(KitchenDispatch).filter(KitchenDispatch.id == out["dispatchId"]).one()
        assert dispatch.payload["items"][0]["lineKey"] == "l1:0"
        assert "+972509999999" not in repr(dispatch.payload)
