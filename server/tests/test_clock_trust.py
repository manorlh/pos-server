"""
"שעון המכשיר" — trusted time and the clock auto-fix (app/services/clock_trust.py; the owner, 17.10.2026: "האם יש דרך
לתקן את השעה באנדרואיד כשהתוכנה מזהה בעיה בשעה, וגם בווינדוס אוטומטית?").

* **The rule** lives on the devices; its golden `clock_trust_golden.json` is the same bytes here, in pos-android and in
  kiosk-desktop, and its vocabulary is this module's.
* **The parameter** `clockAutoFix`: a built-in boolean, on by default, at every level.
* **The heartbeat** `clockTrust` kept in `device_info["clockTrust"]`, cleaned key by key, never a 422; the devices list
  and page and "תקינות מכשירים" carry it.
* **The alert** "שעון המכשיר לא מדויק" (`till_clock`, status_watch): a trading till off by the rule's minutes — high
  while it stamps its own wrong time, medium once on the server's; closed when the clock is right again.

The in-memory SQLite world of tests/test_shop_areas.py.
"""
from __future__ import annotations

import hashlib
import json
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from app.models.audit_exception import AuditException, ExceptionRuleValue
from app.models.shift import ShiftStatus
from app.models.till_parameter import TillParameter
from app.routers import machines as MR
from app.schemas.pos_machine import MachineHeartbeatBody, POSMachineResponse
from app.services import clock_trust as CT
from app.services import exceptions as EX
from app.services import kiosk_health as H
from app.services import problems as P
from app.services import till_parameters as TP
from app.services.exception_alerts import catalog as CAT
from app.services.exception_alerts import push as PUSH
from app.services.exception_alerts import status_watch as SW
from shift_world import NOW
from test_shop_areas import w  # noqa: F401

GOLDEN = Path(__file__).parent / "fixtures" / "clock_trust_golden.json"
GOLDEN_SHA256 = "1e9432cefa78c4ae417fdda3968378cb896a2296bdb570462bc663a38c60a809"

CORRECTED = {
    "source": "server", "reason": "applied", "offsetMs": 420000, "autoFix": "device_owner", "autoFixEnabled": True,
    "autoTime": True, "pending": "none", "pendingReason": "waiting_network_time",
    "lastFixAt": "2026-10-17T10:00:00.000Z", "lastFixAction": "enable_auto_time", "lastFixResult": "ok",
    "lastFixFromMs": -420000,
}


def beat(w, machine, body):
    MR.post_my_heartbeat(body=MachineHeartbeatBody.model_validate(body), machine=machine, db=w.db, request=None)
    w.db.commit()


def rows(w):
    return (
        w.db.query(AuditException)
        .filter(AuditException.exception_type == "till_clock")
        .order_by(AuditException.detected_at, AuditException.dedupe_key)
        .all()
    )


class TestTheGolden:
    def test_the_same_bytes_as_the_devices(self):
        text = GOLDEN.read_text(encoding="utf-8").replace("\r\n", "\n")
        assert hashlib.sha256(text.encode("utf-8")).hexdigest() == GOLDEN_SHA256

    def test_its_words_are_this_modules(self):
        g = json.loads(GOLDEN.read_text(encoding="utf-8"))
        v = g["vocabulary"]
        assert tuple(v["sources"]) == CT.SOURCES
        assert tuple(v["trustReasons"]) == CT.TRUST_REASONS
        assert tuple(v["capabilities"]) == CT.CAPABILITIES
        assert tuple(v["actions"]) == CT.ACTIONS
        assert tuple(v["fixReasons"]) == CT.FIX_REASONS
        assert tuple(v["results"]) == CT.RESULTS
        assert g["constants"]["trustMs"] == CT.TRUST_MS


class TestTheParameter:
    def test_a_builtin_boolean_on_by_default_at_every_level(self, w):
        (spec,) = [p for p in TP.BUILTIN_PARAMETERS if p.key == CT.CLOCK_AUTO_FIX_KEY]
        assert spec.label == "תיקון שעון אוטומטי"
        assert spec.value_type == "boolean" and spec.default_value is True and not spec.admin_only
        assert "90 שניות" in spec.description and "תיקון שעון" in spec.description and "TLS" in spec.description
        TP.ensure_builtin_parameters(w.db)
        w.db.commit()
        row = w.db.query(TillParameter).filter(TillParameter.key == CT.CLOCK_AUTO_FIX_KEY).one()
        assert row.is_active and row.default_value is True
        assert TP.till_parameters_for_machine(w.db, w.tills[0]).parameters[CT.CLOCK_AUTO_FIX_KEY] is True


class TestTheHeartbeat:
    def test_kept_in_device_info_beside_what_was_there(self, w):
        till = w.tills[0]
        till.device_info = {"autostart": {"ready": True}}
        w.db.commit()
        beat(w, till, {"clockSkewMs": -420000, "clockTrust": CORRECTED})
        kept = till.device_info["clockTrust"]
        assert {k: kept[k] for k in CORRECTED} == CORRECTED and kept["reportedAt"]
        assert till.device_info["autostart"] == {"ready": True}
        assert till.clock_skew_ms == -420000
        assert CT.corrected(till)

    def test_cleaned_key_by_key_never_a_422(self, w):
        till = w.tills[0]
        beat(w, till, {"clockTrust": {"source": "SERVER", "offsetMs": "a lot", "autoFix": "root", "pending": 7,
                                      "lastFixResult": "ok", "extra": {"x": 1}, "autoFixEnabled": "yes"}})
        assert {k: v for k, v in till.device_info["clockTrust"].items() if k != "reportedAt"} == {
            "source": "server", "lastFixResult": "ok",
        }

    def test_absent_or_unreadable_leaves_it_as_it_was(self, w):
        till = w.tills[0]
        beat(w, till, {"clockTrust": CORRECTED})
        before = dict(till.device_info["clockTrust"])
        beat(w, till, {"appVersion": "1.2.3"})
        beat(w, till, {"clockTrust": {"nothing": "known"}})
        assert till.device_info["clockTrust"] == before

    def test_the_devices_list_page_and_health_view_carry_it(self, w):
        till, other = w.tills
        beat(w, till, {"clockSkewMs": -420000, "clockTrust": CORRECTED})
        row = MR._enrich_machine_status(till, w.db)
        assert row["clockTrust"]["source"] == "server"
        assert row["clockTrust"]["lastFix"] == {"at": "2026-10-17T10:00:00.000Z", "action": "enable_auto_time", "result": "ok", "fromMs": -420000}
        out = POSMachineResponse.model_validate(row).model_dump(mode="json", by_alias=True)
        assert out["clockTrust"]["autoFix"] == "device_owner"
        assert MR._enrich_machine_status(other, w.db)["clockTrust"] is None  # never reported
        devices = {d["machineId"]: d for d in H.health_view(w.db, w.admin, w.tenant.id, now=NOW + timedelta(minutes=1))["devices"]}
        assert devices[str(till.id)]["clockTrust"]["source"] == "server"
        assert devices[str(till.id)]["clockSkewMs"] == -420000
        assert devices[str(other.id)]["clockTrust"] is None

    def test_the_words(self):
        assert CT.skew_words(-420_000) == "מאחר ב-7 דקות"
        assert CT.skew_words(10_000) == "מקדים ב-1 דקות"
        assert CT.skew_words(3 * 3_600_000) == "מקדים ב-3 שעות"
        assert CT.skew_words(-400 * 86_400_000) == "מאחר ב-400 ימים"


# ── The alert ────────────────────────────────────────────────────────────────


def _trading(w, till, t0):
    w.shift(till, 1, status=ShiftStatus.OPEN, opened_at=t0 - timedelta(hours=2))


def _at(w, till, t0, minutes, skew_ms):
    till.clock_skew_ms = skew_ms
    till.last_heartbeat_at = t0 + timedelta(minutes=minutes, seconds=-10)
    w.db.flush()
    return SW.scan(w.db, now=t0 + timedelta(minutes=minutes))


class TestTheAlert:
    def test_the_rule_and_its_kind(self, w):
        rule = EX.rules_for_machine(w.db, w.tills[0])["till_clock"]
        assert rule.enabled and rule.params == {"minutes": 5}
        assert CAT.KINDS_BY_KEY["till_clock"].label == "שעון המכשיר לא מדויק"
        assert "till_clock" in CAT.OPT_IN_KINDS and "till_clock" in SW.KINDS
        assert PUSH.CATEGORY_BY_KEY["till_clock"].kinds == ("till_clock",)
        assert "till_clock" in PUSH.CATEGORY_KEYS and "till_clock" in PUSH.STATE_KINDS
        assert P.KIND_GROUP["till_clock"] == "devices"

    def test_a_trading_till_off_by_five_minutes_once_per_streak_closed_when_fixed(self, w):
        t0 = datetime(2026, 10, 17, 9, 0, tzinfo=timezone.utc)
        till = w.tills[0]
        _trading(w, till, t0)
        assert _at(w, till, t0, 0, -240_000) == 0                       # four minutes: under the rule
        assert _at(w, till, t0, 2, -420_000) == 1
        [row] = rows(w)
        assert row.machine_id == till.id and row.severity == "high"     # stamps its own wrong time (no report)
        assert row.details["summary"].endswith("שעון המכשיר לא מדויק (מאחר ב-7 דקות) — המסמכים נחתמים בשעה של המכשיר")
        assert row.details["skewMs"] == -420_000 and row.details["corrected"] is False
        assert row.threshold == 5 and row.value == 7 and row.dedupe_key.endswith(":1")
        assert _at(w, till, t0, 4, -420_000) == 0                       # the same streak
        assert _at(w, till, t0, 6, 1_000) == 1 and rows(w)[0].details["resolvedAt"]
        assert rows(w)[0].details["resolvedBecause"] == "שעון המכשיר תוקן"
        till.device_info = {"clockTrust": {**CORRECTED, "reportedAt": "x"}}
        assert _at(w, till, t0, 8, 600_000) == 1                        # a new streak, documents corrected
        new = rows(w)[1]
        assert new.severity == "medium" and new.details["corrected"] is True and new.dedupe_key.endswith(":2")
        assert "המסמכים נחתמים לפי שעון השרת" in new.details["summary"]

    def test_only_a_trading_heard_from_till(self, w):
        t0 = datetime(2026, 10, 17, 9, 0, tzinfo=timezone.utc)
        till, idle = w.tills
        _trading(w, till, t0)
        idle.clock_skew_ms = 3_600_000                                    # no open shift
        idle.last_heartbeat_at = t0
        till.clock_skew_ms = 3_600_000
        till.last_heartbeat_at = t0 - timedelta(hours=1)                  # not heard from
        w.db.flush()
        assert SW.scan(w.db, now=t0) == 0
        assert rows(w) == []

    def test_switched_off_or_more_minutes_at_a_level(self, w):
        t0 = datetime(2026, 10, 17, 9, 0, tzinfo=timezone.utc)
        till, second = w.tills
        _trading(w, till, t0)
        _trading(w, second, t0)
        w.db.add(ExceptionRuleValue(id=uuid.uuid4(), tenant_id=w.tenant.id, scope_type="machine", scope_id=till.id,
                                    exception_type="till_clock", enabled=False, params=None))
        w.db.add(ExceptionRuleValue(id=uuid.uuid4(), tenant_id=w.tenant.id, scope_type="machine", scope_id=second.id,
                                    exception_type="till_clock", enabled=None, params={"minutes": 30}))
        w.db.flush()
        second.clock_skew_ms = 20 * 60_000
        second.last_heartbeat_at = t0
        assert _at(w, till, t0, 0, 3_600_000) == 0
        assert rows(w) == []
        second.clock_skew_ms = 31 * 60_000
        w.db.flush()
        assert SW.scan(w.db, now=t0 + timedelta(minutes=1)) == 1
        assert rows(w)[0].machine_id == second.id and rows(w)[0].threshold == 30


@pytest.fixture(autouse=True)
def _fresh_watch(monkeypatch):
    monkeypatch.setattr(SW, "_printer_since", {})
