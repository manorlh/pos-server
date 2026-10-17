"""
A TILL's own cash-device alerts ("מכשיר מזומן" on a till — its CashMag recycler or its PayLink station unreachable
/ at fault): reported on its `kiosk/sync` (`status.alerts`, kind "cash") like a kiosk's, and routed exactly as a
kiosk's (app/services/kiosk_ops.py `reconcile_till_cash` → app/services/cash_alerts.py `open_kiosk_alert`). Only
the "cash" kind is taken from a till; nothing of it is ever listed as a kiosk alert.
"""
from __future__ import annotations

from app.services import cash_alerts as CA
from app.services import kiosk_control as KC
from app.services import kiosk_ops as OPS
from test_cash_stations import _cashmag_alert, cash_rows, w  # noqa: F401 - the shared world fixture


def _unit_rows(w, machine, *, open_only=True):
    return CA.rows_of_station(w.db, f"cashmag:{machine.id}", open_only=open_only)


def _sync(w, machine, alerts):
    out = KC.kiosk_sync(w.db, machine, {"alerts": alerts})
    w.db.commit()
    return out


class TestTillCashAlerts:
    def test_a_tills_cashmag_alert_opens_and_closes(self, w):
        out = _sync(w, w.till1, _cashmag_alert(w.till1.id))
        assert out["kiosk"] is False
        (row,) = _unit_rows(w, w.till1)
        assert (row.exception_type, row.severity, row.machine_id) == ("cash_unit", "high", w.till1.id)
        assert row.details["summary"].startswith("CashMag (Till 1): ")
        assert row.details["unit"] == f"kiosk:{w.till1.id}" and row.details["device"] == "cashmag"
        # Never a kiosk alert of the till's on any till's list (the cash alert is, once, by its routing).
        items = OPS.alerts_for_till(w.db, w.till1)
        assert all(a["id"].startswith("cash:") for a in items if a["kind"] == "cash")
        # Still reported: nothing new; reached again: closed.
        _sync(w, w.till1, _cashmag_alert(w.till1.id))
        assert len(_unit_rows(w, w.till1, open_only=False)) == 1
        _sync(w, w.till1, [])
        assert _unit_rows(w, w.till1) == []
        assert _unit_rows(w, w.till1, open_only=False)[0].details["resolvedAt"]

    def test_a_tills_paylink_station_alert(self, w):
        reported = [{"kind": "cash", "key": "cash:unreachable", "reason": "unreachable", "text": "אין קשר לעמדת המזומן",
                     "detail": {"stationId": str(w.station.id), "stationName": "עמדת מזומן 2"}}]
        _sync(w, w.till2, reported)
        (row,) = cash_rows(w, "unreachable")
        assert row.details["unit"] == f"kiosk:{w.till2.id}" and "אין קשר לעמדת המזומן" in row.details["summary"]
        _sync(w, w.till2, [])
        assert cash_rows(w, "unreachable") == []

    def test_only_the_cash_kind_from_a_till(self, w):
        _sync(w, w.till1, [{"kind": "printer", "key": "p", "reason": "no_paper"},
                           {"kind": "help", "key": "h", "reason": "help", "requestId": "r1"}])
        from app.models.kiosk_ops import KioskAlert

        assert w.db.query(KioskAlert).filter(KioskAlert.kiosk_machine_id == w.till1.id).count() == 0

    def test_no_alerts_key_no_change(self, w):
        _sync(w, w.till1, _cashmag_alert(w.till1.id))
        KC.kiosk_sync(w.db, w.till1, {})
        KC.kiosk_sync(w.db, w.till1, None)
        w.db.commit()
        assert len(_unit_rows(w, w.till1)) == 1
