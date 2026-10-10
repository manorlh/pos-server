"""
"שליחת לוגים לענן" (the device-logs contract, specs/device-logs-api.md; app/services/device_logs.py,
app/routers/device_logs.py).

Each test names a way it could look fine and still fail the owner or support:

* an upload resent by a device on a bad line stored twice, or a duplicate refused as "too many";
* a gzip bomb inflated in memory, or a too-large log stored anyway;
* a device that floods the cloud (21 uploads in an hour), or a refusal that never lets it retry;
* a remote request ("בקש לוגים") whose status never turns "התקבל", or that blocks on the device;
* a manager of the organization reading a log (content or note) — privacy, §3;
* a distributor reading another organization's logs;
* a cashier's card number or phone left in the note (the cloud scrubs it again, §4);
* a device with an old build offered the request as if it could answer it;
* logs kept for ever (DEVICE_LOGS_RETENTION_DAYS).

Runs on the availability world (tests/test_product_availability.py), SQLite in memory.
"""
from __future__ import annotations

import base64
import gzip
import os
import uuid
from datetime import date, datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from fastapi import HTTPException, Response
from pydantic import ValidationError

from app.database import Base
from app.models.device_command import DeviceCommand
from app.models.device_log_upload import DeviceLogUpload
from app.models.user import User, UserRole
from app.routers import device_commands as RC
from app.routers import device_logs as R
from app.services import dashboard_access as DA
from app.services import dashboard_sections as DS
from app.services import device_commands as cmd_svc
from app.services import device_logs as svc
from app.services import device_logs_retention as retention

from test_product_availability import world  # noqa: F401

TABLES = (
    "device_commands", "device_remote_states", "kiosk_devices", "kiosk_settings", "machine_groups",
    "machine_group_members", "command_request_keys", "device_log_uploads", "tenant_memberships",
)


@pytest.fixture
def lw(world, monkeypatch):  # noqa: F811
    db = world.db
    for name in TABLES:
        if not db.get_bind().dialect.has_table(db.connection(), name):
            Base.metadata.tables[name].create(db.get_bind())
    world.woken = []
    monkeypatch.setattr(cmd_svc, "wake", lambda machines: world.woken.extend(str(m.id) for m in machines))

    def user(role, tenant_id=world.tid, **kw):
        return User(id=uuid.uuid4(), role=role, tenant_id=tenant_id, email=f"{uuid.uuid4()}@x", username=f"u-{uuid.uuid4().hex[:8]}", **kw)

    world.users.distributor = user(UserRole.DISTRIBUTOR)
    world.users.other_distributor = user(UserRole.DISTRIBUTOR, tenant_id=uuid.uuid4())
    return world


def gz_of(text: str) -> bytes:
    return gzip.compress(text.encode("utf-8"))


def body(**over):
    content = over.pop("text", "line one\nline two\n")
    data = {
        "upload_id": str(uuid.uuid4()),
        "reason": "manual",
        "command_id": None,
        "note": None,
        "app_version": "0.1.332+65cc58f-device",
        "version_code": 332,
        "device_model": "Nebullar P18",
        "os": "Android 11 (SDK 30)",
        "from_ms": 1760000000000,
        "to_ms": 1760003600000,
        "line_count": 2,
        "content_encoding": "gzip+base64",
        "content": base64.b64encode(gz_of(content)).decode("ascii"),
    }
    data.update(over)
    return R.UploadIn(**data)


def upload(w, machine=None, **over):
    return R.post_device_logs(str((machine or w.h1).id), body(**over), machine=machine or w.h1, db=w.db)


def code_of(e):
    return e.detail["code"] if isinstance(e.detail, dict) else e.detail


def request(w, machine=None, user=None, minutes=None, key=None, response=None):
    return R.post_logs_request(
        R.RequestIn(machineId=(machine or w.h1).id, minutes=minutes), current_user=user or w.users.admin, db=w.db,
        response=response, idempotency_key=key,
    )


# ── Upload ───────────────────────────────────────────────────────────────────


class TestUpload:
    def test_stored_compressed_with_its_metadata_and_where_it_came_from(self, lw):
        out = upload(lw, note="נתקע אחרי עסקה")
        assert set(out) == {"id", "received_at", "duplicate"} and out["duplicate"] is False
        row = lw.db.get(DeviceLogUpload, uuid.UUID(out["id"]))
        assert (row.tenant_id, row.branch_id, row.machine_id) == (lw.tid, lw.h_shop.id, lw.h1.id)
        assert gzip.decompress(row.content) == b"line one\nline two\n", "kept as the device sent it"
        assert row.size_bytes == len(row.content) and row.inflated_bytes == 18
        assert (row.reason, row.app_version, row.version_code, row.device_model) == ("manual", "0.1.332+65cc58f-device", 332, "Nebullar P18")
        assert (row.from_ms, row.to_ms, row.line_count, row.note) == (1760000000000, 1760003600000, 2, "נתקע אחרי עסקה")

    def test_the_same_upload_id_again_is_the_same_row_marked_duplicate(self, lw):
        b = body()
        first = R.post_device_logs(str(lw.h1.id), b, machine=lw.h1, db=lw.db)
        again = R.post_device_logs(str(lw.h1.id), b, machine=lw.h1, db=lw.db)
        assert again == {**first, "duplicate": True}
        assert lw.db.query(DeviceLogUpload).count() == 1

    def test_an_upload_id_is_per_machine(self, lw):
        b = body()
        a = R.post_device_logs(str(lw.h1.id), b, machine=lw.h1, db=lw.db)
        other = R.post_device_logs(str(lw.h2.id), b, machine=lw.h2, db=lw.db)
        assert a["id"] != other["id"] and not other["duplicate"]

    def test_a_racing_resend_is_answered_with_the_first(self, lw, monkeypatch):
        from sqlalchemy.exc import IntegrityError

        b = body()
        first = R.post_device_logs(str(lw.h1.id), b, machine=lw.h1, db=lw.db)
        real = svc.ingest

        def racing(db, machine, bd, now=None):
            # The twin committed between our look and our insert.
            raise IntegrityError("insert", {}, Exception("uq_device_log_uploads_machine_upload"))

        monkeypatch.setattr(svc, "ingest", racing)
        again = R.post_device_logs(str(lw.h1.id), b, machine=lw.h1, db=lw.db)
        monkeypatch.setattr(svc, "ingest", real)
        assert again == {**first, "duplicate": True}

    def test_the_note_is_scrubbed_again_by_the_cloud(self, lw):
        out = upload(lw, note="כרטיס 4111 1111 1111 1111, טל 052-1234567, dana@shop.co.il, password=abc")
        row = lw.db.get(DeviceLogUpload, uuid.UUID(out["id"]))
        assert row.note == "כרטיס ************1111, טל 052-***-XX67, d***@shop.co.il, password=***"

    def test_a_long_note_or_metadata_is_cut_never_refused(self, lw):
        out = upload(lw, note="א" * 700, os="x" * 300)
        row = lw.db.get(DeviceLogUpload, uuid.UUID(out["id"]))
        assert len(row.note) == 500 and len(row.os) == 100

    def test_an_unknown_reason_or_encoding_is_422(self, lw):
        with pytest.raises(ValidationError):
            body(reason="bored")
        with pytest.raises(ValidationError):
            body(content_encoding="zstd+base64")

    @pytest.mark.parametrize("content", [
        "not base64 !!",
        base64.b64encode(b"plain text, not gzip").decode(),
        base64.b64encode(gz_of(" ".join(str(i) for i in range(3000)))[:-12]).decode(),  # cut short
    ], ids=["not-base64", "not-gzip", "cut-short"])
    def test_unreadable_content_is_422_and_nothing_stored(self, lw, content):
        with pytest.raises(HTTPException) as refused:
            upload(lw, content=content)
        assert refused.value.status_code == 422 and code_of(refused.value) == svc.BAD_CONTENT
        assert lw.db.query(DeviceLogUpload).count() == 0

    def test_base64_with_line_breaks_is_read(self, lw):
        wrapped = base64.encodebytes(gz_of("a\nb\n")).decode("ascii")  # 76-column lines
        out = upload(lw, content=wrapped)
        assert gzip.decompress(lw.db.get(DeviceLogUpload, uuid.UUID(out["id"])).content) == b"a\nb\n"


class TestLimits:
    def test_more_than_3mb_compressed_is_413(self, lw):
        noise = gzip.compress(os.urandom(svc.MAX_COMPRESSED_BYTES + 1024), compresslevel=1)
        assert len(noise) > svc.MAX_COMPRESSED_BYTES
        with pytest.raises(HTTPException) as refused:
            upload(lw, content=base64.b64encode(noise).decode("ascii"))
        assert refused.value.status_code == 413 and code_of(refused.value) == "device_logs_too_large"

    def test_base64_text_far_over_the_limit_is_refused_before_decoding(self, lw, monkeypatch):
        monkeypatch.setattr(svc.base64, "b64decode", lambda *a, **k: pytest.fail("decoded"))
        with pytest.raises(HTTPException) as refused:
            svc.decode_content("A" * (svc._B64_MAX_CHARS + 4))
        assert refused.value.status_code == 413

    def test_exactly_3mb_compressed_is_accepted(self):
        assert svc._B64_MAX_CHARS == 4 * 1048576  # 3 MiB of gzip → 4 MiB of base64

    def test_more_than_25mb_inflated_is_413(self, lw):
        bomb = gzip.compress(b"\0" * (svc.MAX_INFLATED_BYTES + 1), compresslevel=9)
        assert len(bomb) < 100_000
        with pytest.raises(HTTPException) as refused:
            upload(lw, content=base64.b64encode(bomb).decode("ascii"))
        assert refused.value.status_code == 413 and code_of(refused.value) == "device_logs_too_large"
        assert lw.db.query(DeviceLogUpload).count() == 0

    def test_inflating_stops_at_the_cap_never_holding_the_whole(self):
        bomb = gzip.compress(b"\0" * (8 * svc.MB))
        seen = []
        with pytest.raises(HTTPException) as refused:
            for chunk in svc._inflate_chunks(bomb, cap=1 * svc.MB):
                seen.append(len(chunk))
        assert refused.value.status_code == 413
        assert max(seen) <= svc._CHUNK and sum(seen) <= 1 * svc.MB

    def test_several_gzip_members_are_one_log(self, lw):
        two = gz_of("first\n") + gz_of("second\n")
        out = upload(lw, content=base64.b64encode(two).decode("ascii"))
        row = lw.db.get(DeviceLogUpload, uuid.UUID(out["id"]))
        assert row.inflated_bytes == 13
        assert [line for line in svc.iter_lines(row.content)] == ["first", "second"]

    def test_the_21st_upload_in_an_hour_is_429_with_when_to_retry(self, lw):
        for _ in range(svc.MAX_UPLOADS_PER_HOUR):
            upload(lw)
        with pytest.raises(HTTPException) as refused:
            upload(lw)
        assert refused.value.status_code == 429 and code_of(refused.value) == "device_logs_rate_limited"
        assert 1 <= int(refused.value.headers["Retry-After"]) <= 3601
        # Another device is not limited by this one.
        assert upload(lw, machine=lw.h2)["duplicate"] is False

    def test_a_resend_is_answered_even_when_rate_limited(self, lw):
        b = body()
        first = R.post_device_logs(str(lw.h1.id), b, machine=lw.h1, db=lw.db)
        for _ in range(svc.MAX_UPLOADS_PER_HOUR - 1):
            upload(lw)
        assert R.post_device_logs(str(lw.h1.id), b, machine=lw.h1, db=lw.db) == {**first, "duplicate": True}

    def test_uploads_older_than_an_hour_do_not_count(self, lw):
        for _ in range(svc.MAX_UPLOADS_PER_HOUR):
            upload(lw)
        for row in lw.db.query(DeviceLogUpload).all():
            row.received_at = datetime.now(timezone.utc) - timedelta(minutes=61)
        lw.db.commit()
        assert upload(lw)["duplicate"] is False


# ── "בקש לוגים": the remote request ──────────────────────────────────────────


class TestRemoteRequest:
    def test_a_request_returns_at_once_as_sent_and_wakes_the_device(self, lw):
        out = request(lw, minutes=30)
        assert out["status"] == "pending" and out["minutes"] == 30 and out["received"] is False
        assert lw.woken == [str(lw.h1.id)]
        row = lw.db.get(DeviceCommand, uuid.UUID(out["id"]))
        assert (row.action, row.params) == ("upload_logs", {"minutes": 30})
        assert row.expires_at - row.created_at == timedelta(hours=24), "waits a day for an offline device"

    def test_the_device_gets_the_minutes_and_its_upload_answers_the_command(self, lw):
        out = request(lw)
        pulled = cmd_svc.pull(lw.db, lw.h1)
        lw.db.commit()
        (cmd,) = pulled["commands"]
        assert (cmd["action"], cmd["params"], cmd["status"]) == ("upload_logs", {"minutes": 120}, "delivered")
        up = upload(lw, reason="remote", command_id=cmd["id"])
        row = lw.db.get(DeviceCommand, uuid.UUID(out["id"]))
        assert (row.status, row.result) == ("done", {"log_id": up["id"]})
        stored = lw.db.get(DeviceLogUpload, uuid.UUID(up["id"]))
        assert stored.command_id == row.id and stored.requested_by_name == lw.users.admin.username
        # The device's ack afterwards keeps it.
        acked = RC.till_ack(str(lw.h1.id), cmd["id"], RC.AckIn(status="done", log_id=up["id"]), machine=lw.h1, db=lw.db)
        assert (acked["status"], acked["result"]) == ("done", {"log_id": up["id"]})

    def test_an_ack_with_the_log_id_first_is_kept(self, lw):
        out = request(lw)
        cmd_svc.pull(lw.db, lw.h1)
        log_id = str(uuid.uuid4())
        acked = RC.till_ack(str(lw.h1.id), out["id"], RC.AckIn.model_validate({"status": "done", "logId": log_id}), machine=lw.h1, db=lw.db)
        assert acked["result"] == {"log_id": log_id}

    def test_an_upload_naming_another_devices_command_is_kept_unlinked(self, lw):
        out = request(lw, machine=lw.h2)
        up = upload(lw, reason="remote", command_id=out["id"])
        assert lw.db.get(DeviceLogUpload, uuid.UUID(up["id"])).command_id is None
        assert lw.db.get(DeviceCommand, uuid.UUID(out["id"])).status == "pending"

    def test_logs_arriving_after_the_command_expired_still_answer_it(self, lw):
        out = request(lw)
        row = lw.db.get(DeviceCommand, uuid.UUID(out["id"]))
        row.status = "expired"
        lw.db.commit()
        up = upload(lw, reason="remote", command_id=out["id"])
        assert (row.status, row.result) == ("done", {"log_id": up["id"]})

    @pytest.mark.parametrize("minutes", [14, 1441])
    def test_minutes_outside_15_to_1440_are_refused(self, lw, minutes):
        with pytest.raises(ValidationError):
            R.RequestIn(machineId=lw.h1.id, minutes=minutes)
        with pytest.raises(ValidationError):
            RC.CommandIn(action="upload_logs", machineIds=[lw.h1.id], params={"minutes": minutes})

    def test_the_remote_control_endpoint_takes_upload_logs_too(self, lw):
        body_ = RC.CommandIn(action="upload_logs", machineIds=[lw.h1.id])
        assert body_.params == {"minutes": 120}
        (out,) = RC.create_commands(body_, current_user=lw.users.h_shop_manager, active_tenant_id=lw.tid, db=lw.db)
        assert (out["action"], out["params"]) == ("upload_logs", {"minutes": 120})
        # Another action never carries params.
        assert RC.CommandIn(action="sync_now", machineIds=[lw.h1.id], params={"minutes": 30}).params is None

    def test_a_retry_with_the_same_key_never_sends_twice(self, lw):
        resp = Response()
        first = request(lw, key="k-logs-0001")
        again = request(lw, key="k-logs-0001", response=resp)
        assert again["id"] == first["id"] and resp.headers.get("Idempotent-Replayed") == "true"
        assert lw.db.query(DeviceCommand).filter(DeviceCommand.action == "upload_logs").count() == 1

    def test_the_background_read_says_sent_then_received(self, lw):
        out = request(lw)
        (s,) = R.get_requests_status(ids=[uuid.UUID(out["id"])], current_user=lw.users.admin, db=lw.db)["items"]
        assert (s["status"], s["received"]) == ("pending", False)
        cmd_svc.pull(lw.db, lw.h1)
        lw.db.commit()
        upload(lw, reason="remote", command_id=out["id"])
        (s,) = R.get_requests_status(ids=[uuid.UUID(out["id"])], current_user=lw.users.admin, db=lw.db)["items"]
        assert (s["status"], s["received"]) == ("done", True)
        # Another shop's manager never sees it.
        assert R.get_requests_status(ids=[uuid.UUID(out["id"])], current_user=lw.users.a_shop_manager, db=lw.db)["items"] == []


# ── Who ──────────────────────────────────────────────────────────────────────


class TestWho:
    def test_who_may_request(self, lw):
        u = lw.users
        assert request(lw, user=u.admin)["status"] == "pending"
        assert request(lw, user=u.distributor)["status"] == "pending"
        assert request(lw, user=u.h_manager)["status"] == "pending"
        assert request(lw, user=u.h_shop_manager)["status"] == "pending"
        for nobody in (u.a_shop_manager, u.h_cashier, u.other_distributor):
            with pytest.raises(HTTPException) as refused:
                request(lw, user=nobody)
            assert refused.value.status_code == 403

    def test_a_manager_needs_device_control_at_edit(self, lw, monkeypatch):
        view_only = DA.EffectiveAccess(restricted=True, sections={"device_control": DS.VIEW, "devices": DS.EDIT})
        monkeypatch.setattr(DA, "effective_access", lambda db, user: view_only)
        with pytest.raises(HTTPException):
            request(lw, user=lw.users.h_manager)
        edit = DA.EffectiveAccess(restricted=True, sections={"device_control": DS.EDIT})
        monkeypatch.setattr(DA, "effective_access", lambda db, user: edit)
        assert request(lw, user=lw.users.h_manager)["status"] == "pending"

    def test_a_manager_sees_sent_and_received_never_the_content_or_note(self, lw):
        out = request(lw, user=lw.users.h_manager)
        cmd_svc.pull(lw.db, lw.h1)
        up = upload(lw, reason="remote", command_id=out["id"], note="secret customer story")
        summary = R.get_machine_logs(lw.h1.id, current_user=lw.users.h_manager, db=lw.db)
        assert (summary["canRead"], summary["canRequest"], summary["uploads"]) == (False, True, None)
        assert [(r["status"], r["received"]) for r in summary["requests"]] == [("done", True)]
        assert "secret" not in repr(summary)
        for read in (
            lambda: R.get_device_log(uuid.UUID(up["id"]), current_user=lw.users.h_manager, db=lw.db),
            lambda: R.get_device_log_lines(uuid.UUID(up["id"]), q=None, limit=2000, current_user=lw.users.h_manager, db=lw.db),
            lambda: R.download_device_log(uuid.UUID(up["id"]), format="txt", current_user=lw.users.h_manager, db=lw.db),
        ):
            with pytest.raises(HTTPException) as refused:
                read()
            assert refused.value.status_code == 404
        with pytest.raises(HTTPException) as refused:
            R.list_device_logs(current_user=lw.users.h_manager, db=lw.db, **_no_filters())
        assert refused.value.status_code == 403

    def test_a_distributor_reads_their_organizations_logs_only(self, lw):
        up = upload(lw, note="n")
        assert R.get_device_log(uuid.UUID(up["id"]), current_user=lw.users.distributor, db=lw.db)["note"] == "n"
        with pytest.raises(HTTPException) as refused:
            R.get_device_log(uuid.UUID(up["id"]), current_user=lw.users.other_distributor, db=lw.db)
        assert refused.value.status_code == 404
        listed = R.list_device_logs(current_user=lw.users.other_distributor, db=lw.db, **_no_filters())
        assert listed["items"] == []

    def test_a_membership_opens_another_organization_to_a_distributor(self, lw):
        from app.models.tenant_membership import TenantMembership

        up = upload(lw)
        lw.db.add(TenantMembership(id=uuid.uuid4(), user_id=lw.users.other_distributor.id, tenant_id=lw.tid))
        lw.db.commit()
        assert R.get_device_log(uuid.UUID(up["id"]), current_user=lw.users.other_distributor, db=lw.db)["id"] == up["id"]

    def test_the_route_rules(self):
        for method, path in (("GET", "/device-logs"), ("GET", "/device-logs/{}/lines"), ("POST", "/device-logs/requests")):
            rule = DS.rule_for(method, path)
            assert rule.sections == ("devices", "device_control") and rule.needed_level(method) == DS.VIEW, path
        assert DS.rule_for("POST", "/sync/{}/device-logs").kind == "till"


def _no_filters():
    return dict(
        tenant_id=None, company_id=None, shop_id=None, machine_id=None, reason=None, date_from=None, date_to=None,
        only_new=False, limit=50, offset=0,
    )


# ── Reading ──────────────────────────────────────────────────────────────────


class TestReading:
    def test_view_is_the_first_2000_lines_and_search_looks_through_all(self, lw):
        text = "".join(f"line {i}{' NEEDLE' if i in (5, 2400) else ''}\n" for i in range(1, 2501))
        up = upload(lw, text=text)
        first = R.get_device_log_lines(uuid.UUID(up["id"]), q=None, limit=2000, current_user=lw.users.admin, db=lw.db)
        assert len(first["lines"]) == 2000 and first["more"] is True
        assert first["lines"][0] == {"n": 1, "text": "line 1"} and first["lines"][-1]["n"] == 2000
        found = R.get_device_log_lines(uuid.UUID(up["id"]), q="needle", limit=2000, current_user=lw.users.admin, db=lw.db)
        assert [(x["n"], x["text"]) for x in found["lines"]] == [(5, "line 5 NEEDLE"), (2400, "line 2400 NEEDLE")]
        assert found["more"] is False

    def test_an_invalid_utf8_byte_never_breaks_the_view(self, lw):
        raw = gzip.compress(b"ok\n\xff\xfebad\n")
        up = upload(lw, content=base64.b64encode(raw).decode("ascii"))
        lines = R.get_device_log_lines(uuid.UUID(up["id"]), q=None, limit=2000, current_user=lw.users.admin, db=lw.db)["lines"]
        assert [x["text"] for x in lines] == ["ok", "��bad"]

    def test_download_as_text_or_as_sent(self, lw):
        up = upload(lw, text="α\nβ\n")
        txt = R.download_device_log(uuid.UUID(up["id"]), format="txt", current_user=lw.users.admin, db=lw.db)
        assert txt.media_type.startswith("text/plain") and ".txt" in txt.headers["content-disposition"]

        async def drain(resp):
            return b"".join([c async for c in resp.body_iterator])

        import asyncio

        assert asyncio.run(drain(txt)) == "α\nβ\n".encode("utf-8")
        gz = R.download_device_log(uuid.UUID(up["id"]), format="gz", current_user=lw.users.admin, db=lw.db)
        assert gz.body == lw.db.get(DeviceLogUpload, uuid.UUID(up["id"])).content
        assert gz.headers["content-disposition"].endswith('.log.gz"')

    def test_new_is_a_manual_upload_with_a_note_until_opened(self, lw):
        noted = upload(lw, note="הקופה איטית")
        upload(lw)  # no note
        upload(lw, reason="crash", note="crash")
        listed = R.list_device_logs(current_user=lw.users.admin, db=lw.db, **_no_filters())
        assert listed["newCount"] == 1 and [i["id"] for i in listed["items"] if i["isNew"]] == [noted["id"]]
        only = R.list_device_logs(current_user=lw.users.admin, db=lw.db, **{**_no_filters(), "only_new": True})
        assert [i["id"] for i in only["items"]] == [noted["id"]]
        R.get_device_log_lines(uuid.UUID(noted["id"]), q=None, limit=10, current_user=lw.users.admin, db=lw.db)
        after = R.list_device_logs(current_user=lw.users.admin, db=lw.db, **_no_filters())
        assert after["newCount"] == 0
        row = next(i for i in after["items"] if i["id"] == noted["id"])
        assert row["openedBy"] == lw.users.admin.username and row["openedAt"]

    def test_filters(self, lw):
        a = upload(lw)
        b = upload(lw, machine=lw.a1, reason="crash")
        c = upload(lw, machine=lw.b1)
        old = lw.db.get(DeviceLogUpload, uuid.UUID(c["id"]))
        old.received_at = datetime(2026, 9, 1, 10, tzinfo=timezone.utc)
        lw.db.commit()

        def ids(**kw):
            return {i["id"] for i in R.list_device_logs(current_user=lw.users.admin, db=lw.db, **{**_no_filters(), **kw})["items"]}

        assert ids() == {a["id"], b["id"], c["id"]}
        assert ids(tenant_id=lw.tid) == {a["id"], b["id"], c["id"]} and ids(tenant_id=uuid.uuid4()) == set()
        assert ids(company_id=lw.H.id) == {a["id"]} and ids(company_id=lw.A.id) == {b["id"]}
        assert ids(shop_id=lw.b_shop.id) == {c["id"]} and ids(machine_id=lw.a1.id) == {b["id"]}
        assert ids(reason="crash") == {b["id"]}
        assert ids(date_from=date(2026, 9, 1), date_to=date(2026, 9, 1)) == {c["id"]}
        assert ids(date_to=date(2026, 9, 30)) == {c["id"]}
        listed = R.list_device_logs(current_user=lw.users.admin, db=lw.db, **_no_filters())
        assert {i["machineName"] for i in listed["items"]} == {"h1", "a1", "b1"} and listed["items"][0]["tenantName"] == "T"
        assert "content" not in listed["items"][0]

    def test_the_device_page_summary_for_a_reader(self, lw):
        up = upload(lw, note="x")
        s = R.get_machine_logs(lw.h1.id, current_user=lw.users.admin, db=lw.db)
        assert (s["canRead"], s["canRequest"], s["capable"]) == (True, True, False)
        assert s["minutes"] == {"min": 15, "max": 1440, "default": 120}
        assert [i["id"] for i in s["uploads"]["items"]] == [up["id"]]


# ── Capability ───────────────────────────────────────────────────────────────


class TestCapability:
    def test_a_build_that_says_device_logs_v1_can_answer(self, lw):
        m = lw.h1
        m.app_version = "0.1.340"
        svc.apply_heartbeat(m, ["device_logs_v1", "  ", 7, "x" * 100], "0.1.340")
        assert m.reported_capabilities["list"] == ["device_logs_v1"] and svc.capable(m)

    def test_a_build_put_back_to_an_older_one_is_old_again(self, lw):
        m = lw.h1
        m.app_version = "0.1.340"
        svc.apply_heartbeat(m, ["device_logs_v1"], "0.1.340")
        m.app_version = "0.1.300"  # the older build's beat: no capabilities, another version
        assert not svc.capable(m)

    def test_absent_leaves_it_as_it_was_and_garbage_never_fails_a_beat(self, lw):
        m = lw.h1
        svc.apply_heartbeat(m, ["device_logs_v1"], None)
        svc.apply_heartbeat(m, None, None)
        svc.apply_heartbeat(m, "device_logs_v1", None)
        assert svc.capable(m)

    def test_the_heartbeat_body_takes_capabilities(self):
        from app.schemas.pos_machine import MachineHeartbeatBody

        assert MachineHeartbeatBody.model_validate({"capabilities": ["device_logs_v1"]}).capabilities == ["device_logs_v1"]
        assert MachineHeartbeatBody.model_validate({"capabilities": "nope"}).capabilities is None


# ── Retention ────────────────────────────────────────────────────────────────


class TestRetention:
    def _aged(self, lw, days):
        out = upload(lw)
        row = lw.db.get(DeviceLogUpload, uuid.UUID(out["id"]))
        row.received_at = datetime.now(timezone.utc) - timedelta(days=days)
        lw.db.commit()
        return out["id"]

    def test_older_than_the_days_are_deleted(self, lw):
        old, recent = self._aged(lw, 31), self._aged(lw, 29)
        assert svc.purge_expired(lw.db, days=30) == 1
        lw.db.commit()
        assert {str(r.id) for r in lw.db.query(DeviceLogUpload).all()} == {recent}
        assert old not in {str(r.id) for r in lw.db.query(DeviceLogUpload).all()}

    def test_zero_keeps_everything(self, lw):
        self._aged(lw, 400)
        assert svc.purge_expired(lw.db, days=0) == 0
        assert lw.db.query(DeviceLogUpload).count() == 1

    def test_the_default_is_30_days_from_the_setting(self, lw, monkeypatch):
        from app.config import get_settings

        assert get_settings().device_logs_retention_days == 30
        monkeypatch.setattr(svc, "retention_days", lambda: 7)
        self._aged(lw, 8)
        assert svc.purge_expired(lw.db) == 1

    def test_the_nightly_pass_runs_once_a_night_from_3am(self, lw):
        night = datetime(2026, 10, 9, 0, 30, tzinfo=timezone.utc)  # 03:30 in Israel
        assert retention.due(night, None) and not retention.due(night, date(2026, 10, 9))
        assert retention.due(night, date(2026, 10, 8)), "the next night runs again"
        assert not retention.due(datetime(2026, 10, 8, 23, 30, tzinfo=timezone.utc), date(2026, 10, 8))  # 02:30: too early
        self._aged(lw, 31)
        factory = lambda: lw.db  # noqa: E731
        lw.db.close = lambda: None
        assert retention.run_once(factory, days=30) == 1
        assert lw.db.query(DeviceLogUpload).count() == 0


# ── Display devices and the migration ────────────────────────────────────────


def test_a_display_device_may_send_its_logs(lw):
    lw.h2.is_fiscal = False
    lw.db.commit()
    assert upload(lw, machine=lw.h2)["duplicate"] is False


def test_the_migration_is_a_unique_revision_on_the_single_head():
    import pathlib
    import re

    from alembic.config import Config
    from alembic.script import ScriptDirectory

    root = pathlib.Path(__file__).absolute().parents[1]
    revision = "5e1d0c9a7b3f"
    declaring = [
        p.name for p in (root / "alembic" / "versions").glob("*.py")
        if re.search(rf"^revision(?::\s*str)?\s*=\s*['\"]{revision}['\"]", p.read_text(encoding="utf-8"), re.M)
    ]
    assert declaring == [f"{revision}_device_logs.py"]
    config = Config(str(root / "alembic.ini"))
    config.set_main_option("script_location", str(root / "alembic"))
    script = ScriptDirectory.from_config(config)
    heads = script.get_heads()
    assert len(heads) == 1
    assert revision in {r.revision for r in script.walk_revisions("base", heads[0])}
    assert script.get_revision(revision).down_revision == "95b3f4e1893b"  # re-chained at the integration (10.10.2026); written on c8a1e5f3d9b7
