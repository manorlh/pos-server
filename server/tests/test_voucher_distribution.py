"""
"הפצה בוואטסאפ" — prepaid vouchers sent per recipient (app/services/voucher_distribution.py).

What each class pins:

* **Phones** — Israeli numbers in every usual shape become E.164 (05X → +9725X, a leading zero
  Excel dropped, 972 / +972 / 00972, "+972 050"); a foreign number only in "+" form; a landline,
  an empty cell and a spreadsheet's "9.72501E+11" are flagged; a number twice is refused (or kept
  with a warning when asked).
* **Assignment** — by group (a row takes its envelope's unused vouchers), N each in serial order
  (the row's own count first; when they run out the rest is flagged, nothing partial), one each;
  the preview is the import; a voucher belongs to one recipient (a second import never takes it
  again, and the database refuses it); unassigning is audited and frees the vouchers.
* **Links** — 160 random bits, only their SHA-256 and ciphertext stored; expiry = the batch's
  end + 7 days (60 days without one); unknown / revoked / expired / removed / cancelled all answer
  the same 404 page; misses are rate-limited; a re-issue kills the old link; the PDF behind a link
  is only that recipient's vouchers; preview robots never count as "opened".
* **The PDF subset** — the batch's renderer draws exactly the recipient's usable vouchers, one a
  page, in the distribution's layout.
* **Status, export, erasure, permissions** — marks and their undo are audited with who; filters
  and counts; the CSV never carries links; personal data is erased only once the batch is over;
  the routes need the batch's manager and edit on "שוברי הפקה".

Runs on the in-memory SQLite world of tests/shift_world.py (fixtures of test_prepaid_vouchers).
"""
from __future__ import annotations

import asyncio
import csv
import hashlib
import importlib.util
import io
import pathlib
import re
import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy.exc import IntegrityError
from starlette.requests import Request

from app.models.prepaid_voucher import PrepaidVoucher, PrepaidVoucherBatch
from app.models.voucher_distribution import (
    VoucherDistributionAssignment,
    VoucherDistributionEvent,
    VoucherDistributionRecipient,
)
from app.routers import prepaid_vouchers as PR
from app.routers import voucher_distribution as R
from app.schemas.prepaid_voucher import PrepaidVoucherBatchCreate
from app.schemas.voucher_distribution import (
    DistributionImportIn,
    DistributionReasonIn,
    DistributionSentIn,
    DistributionSettingsIn,
    DistributionUnassignIn,
)
from app.services import dashboard_sections as DS
from app.services import prepaid_voucher_pdf as PDF
from app.services import voucher_distribution as VD
from test_prepaid_vouchers import _ctx, refused, w  # noqa: F401 — `w` is the fixture

ROOT = pathlib.Path(__file__).parents[1]


# ── Helpers ──────────────────────────────────────────────────────────────────


def make(w, *, count=12, group_size=None, valid_until=None, user=None):
    body = PrepaidVoucherBatchCreate(
        name="הפקה — הפצה", companyId=w.company.id, eventName="פסטיבל הקיץ",
        items=[{"productId": w.hotdog.id, "quantity": 1}], count=count, groupSize=group_size,
        validUntil=valid_until,
    )
    return PR.create_prepaid_voucher_batch(body, **_ctx(w, user))


def body(rows, mode="count", **kw):
    return DistributionImportIn(rows=rows, mode=mode, **kw)


def preview(w, batch, rows, mode="count", **kw):
    return R.preview_distribution(batch["id"], body(rows, mode, **kw), **_ctx(w))


def do_import(w, batch, rows, mode="count", **kw):
    return R.import_distribution(batch["id"], body(rows, mode, **kw), **_ctx(w))


def recipients(w, batch, **kw):
    return R.list_distribution(
        batch["id"], state=kw.get("state"), kind=kw.get("kind"), q=kw.get("q"),
        include_removed=kw.get("include_removed", False), limit=5000, offset=0, **_ctx(w),
    )


def voucher_rows(w, batch):
    return w.db.query(PrepaidVoucher).filter(PrepaidVoucher.batch_id == uuid.UUID(batch["id"])) \
        .order_by(PrepaidVoucher.serial).all()


def events(w, batch, action=None):
    q = w.db.query(VoucherDistributionEvent).filter(VoucherDistributionEvent.batch_id == uuid.UUID(batch["id"]))
    if action:
        q = q.filter(VoucherDistributionEvent.action == action)
    return q.order_by(VoucherDistributionEvent.created_at).all()


def token_of(item) -> str:
    return item["link"].rsplit("/", 1)[1]


def request(*, ua="Mozilla/5.0 (Linux; Android 14) Chrome/129 Mobile", ip=None, method="GET", fly_ip=None):
    ip = ip or f"10.{uuid.uuid4().int % 250}.{uuid.uuid4().int % 250}.{uuid.uuid4().int % 250}"
    headers = [(b"user-agent", ua.encode())]
    if fly_ip:
        headers.append((b"fly-client-ip", fly_ip.encode()))
    return Request({
        "type": "http", "method": method, "path": "/", "query_string": b"",
        "headers": headers, "client": (ip, 1234),
    })


def page(w, token, **kw):
    return R.public_voucher_page(token, request(**kw), db=w.db)


def pdf(w, token, **kw):
    return R.public_voucher_pdf(token, request(**kw), download=False, db=w.db)


@pytest.fixture
def stub_pdf(monkeypatch):
    """The drawing replaced by a record of which vouchers each file holds."""
    calls = []

    def fake(batch, vouchers, g, *, logo=None, labels=None, opts=None, cover=None, made=None):
        calls.append({"serials": [v.serial for v in vouchers], "page": (g.page_w, g.page_h), "opts": opts})
        return b"%PDF-stub " + ",".join(str(v.serial) for v in vouchers).encode()

    monkeypatch.setattr(PDF, "render_pdf", fake)
    monkeypatch.setattr(PDF, "load_logo", lambda url: None)
    return calls


PEOPLE = [
    {"name": "דנה", "phone": "050-123-4567"},
    {"name": "יוסי", "phone": "0521234567"},
    {"name": "רון", "phone": "+972 54 765 4321"},
]


# ── Phones ───────────────────────────────────────────────────────────────────


class TestPhones:
    @pytest.mark.parametrize("raw", [
        "050-123-4567", "0501234567", "050 123 4567", "(050) 123-4567", "501234567", 501234567, 501234567.0,
        "501234567.0", "972501234567", "+972501234567", "+972 50-123-4567", "00972501234567", "+972 050 123 4567",
        "‏050-1234567",
    ])
    def test_israeli_mobile_in_every_usual_shape(self, raw):
        assert VD.normalize_phone(raw) == ("+972501234567", None)
        assert VD.wa_digits("+972501234567") == "972501234567"
        assert VD.display_phone("+972501234567") == "050-123-4567"

    def test_international_only_in_plus_form(self):
        assert VD.normalize_phone("+1 (415) 555-2671") == ("+14155552671", None)
        assert VD.normalize_phone("+44 7911 123456") == ("+447911123456", None)
        assert VD.normalize_phone("004479111234567")[0] == "+4479111234567"
        assert VD.normalize_phone("14155552671") == (None, "phone_invalid")
        assert VD.display_phone("+14155552671") == "+14155552671"

    @pytest.mark.parametrize("raw, why", [
        (None, "phone_missing"), ("", "phone_missing"), ("   ", "phone_missing"),
        ("03-1234567", "phone_not_mobile"), ("+97231234567", "phone_not_mobile"),
        ("050-123", "phone_invalid"), ("abc", "phone_invalid"), ("05012345678", "phone_invalid"),
        ("9.72501E+11", "phone_scientific"),
    ])
    def test_flagged(self, raw, why):
        assert VD.normalize_phone(raw) == (None, why)

    def test_duplicates_in_the_list_and_against_the_batch(self, w):
        batch = make(w, count=10)
        rows = [{"phone": "0501234567"}, {"phone": "+972 50-123-4567"}, {"phone": "0521234567"}]
        out = preview(w, batch, rows)
        assert [r["status"] for r in out["rows"]] == ["ok", "error", "ok"]
        assert out["rows"][1]["problems"] == ["duplicate_phone"]
        kept = preview(w, batch, rows, allowDuplicates=True)
        assert [r["status"] for r in kept["rows"]] == ["ok", "warning", "ok"]
        do_import(w, batch, rows[:1])
        again = preview(w, batch, [{"phone": "050-1234567"}])
        assert again["rows"][0]["problems"] == ["duplicate_phone"]

    def test_the_phone_is_encrypted_at_rest(self, w):
        batch = make(w, count=3)
        do_import(w, batch, PEOPLE[:1])
        r = w.db.query(VoucherDistributionRecipient).one()
        assert "501234567" not in (r.phone_ciphertext or "")
        assert r.phone_hash and len(r.phone_hash) == 64
        assert recipients(w, batch)["items"][0]["phone"] == "972501234567"


# ── Assignment ───────────────────────────────────────────────────────────────


class TestAssignment:
    def test_count_mode_in_serial_order_and_the_rows_own_count_first(self, w):
        batch = make(w, count=10)
        out = do_import(w, batch, [PEOPLE[0], {**PEOPLE[1], "count": 1}, PEOPLE[2]], mode="count", perRecipient=3)
        assert out["summary"]["created"] == 3
        items = recipients(w, batch)["items"]
        assert [i["serials"] for i in items] == [[1, 2, 3], [4], [5, 6, 7]]
        assert items[0]["serialsText"] == "0001-0003"

    def test_when_vouchers_run_out_the_rest_is_flagged_and_nothing_is_partial(self, w):
        batch = make(w, count=5)
        rows = [{"phone": "0501111111"}, {"phone": "0502222222"}, {"phone": "0503333333", "count": 1}]
        out = preview(w, batch, rows, mode="count", perRecipient=3)
        assert [r["status"] for r in out["rows"]] == ["ok", "error", "error"]
        assert out["rows"][1]["problems"] == ["not_enough"] and out["rows"][1]["serials"] == []
        assert out["summary"] == {"rows": 3, "ok": 1, "errors": 2, "warnings": 0, "vouchersFree": 5,
                                  "vouchersAssigned": 3, "vouchersLeft": 2}

    def test_a_bad_row_takes_nothing_and_the_next_goes_on(self, w):
        batch = make(w, count=4)
        out = preview(w, batch, [{"phone": "03-1234567"}, {"phone": "0501234567"}], mode="one")
        assert out["rows"][0]["problems"] == ["phone_not_mobile"]
        assert out["rows"][1]["serials"] == [1]

    def test_one_each(self, w):
        batch = make(w, count=3)
        do_import(w, batch, PEOPLE, mode="one")
        assert [i["serials"] for i in recipients(w, batch)["items"]] == [[1], [2], [3]]

    def test_a_long_name_is_cut_never_refusing_the_list(self, w):
        batch = make(w, count=1)
        out = preview(w, batch, [{"name": "א" * 1000, "phone": "0501234567"}], mode="one")
        assert out["rows"][0]["status"] == "ok" and len(out["rows"][0]["name"]) == VD.NAME_MAX

    def test_count_invalid(self, w):
        batch = make(w, count=3)
        out = preview(w, batch, [{"phone": "0501234567", "count": 0}, {"phone": "0521234567", "count": "x"}])
        assert [r["problems"] for r in out["rows"]] == [["count_invalid"], ["count_invalid"]]

    def test_group_mode_gives_each_row_its_envelope(self, w):
        batch = make(w, count=20, group_size=5)
        vs = voucher_rows(w, batch)
        vs[10].status = "used"  # serial 11, group 3
        vs[11].status = "cancelled"  # serial 12, group 3
        w.db.commit()
        out = preview(w, batch, [
            {"name": "ראש 1", "phone": "0501111111", "group": 1},
            {"name": "ראש 3", "phone": "0502222222", "group": "3"},
            {"phone": "0503333333", "group": 3},
            {"phone": "0504444444", "group": 9},
            {"phone": "0505555555"},
        ], mode="group")
        assert out["rows"][0]["serials"] == [1, 2, 3, 4, 5]
        assert out["rows"][1]["serials"] == [13, 14, 15]  # the used and the cancelled stay out
        assert [r["problems"] for r in out["rows"][2:]] == [["group_duplicate"], ["group_not_found"], ["group_missing"]]
        do_import(w, batch, [{"phone": "0501111111", "group": 1}], mode="group")
        assert preview(w, batch, [{"phone": "0509999999", "group": 1}], mode="group")["rows"][0]["problems"] == ["group_taken"]

    def test_the_preview_stores_nothing_and_is_what_the_import_does(self, w):
        batch = make(w, count=9)
        shown = preview(w, batch, PEOPLE, mode="count", perRecipient=2)
        assert w.db.query(VoucherDistributionRecipient).count() == 0
        assert w.db.query(VoucherDistributionAssignment).count() == 0
        do_import(w, batch, PEOPLE, mode="count", perRecipient=2)
        assert [i["serials"] for i in recipients(w, batch)["items"]] == [r["serials"] for r in shown["rows"]]

    def test_a_voucher_belongs_to_one_recipient(self, w):
        batch = make(w, count=4)
        do_import(w, batch, PEOPLE[:2], mode="count", perRecipient=2)
        out = preview(w, batch, [{"phone": "0531234567"}], mode="one")
        assert out["rows"][0]["problems"] == ["not_enough"]
        # The database refuses it too.
        a = w.db.query(VoucherDistributionAssignment).first()
        w.db.add(VoucherDistributionAssignment(
            id=uuid.uuid4(), tenant_id=a.tenant_id, batch_id=a.batch_id, recipient_id=a.recipient_id,
            voucher_id=a.voucher_id, serial=a.serial,
        ))
        with pytest.raises(IntegrityError):
            w.db.flush()
        w.db.rollback()

    def test_unassigning_is_audited_and_frees_the_vouchers(self, w):
        batch = make(w, count=4)
        do_import(w, batch, PEOPLE[:1], mode="count", perRecipient=3)
        rid = recipients(w, batch)["items"][0]["id"]
        v2 = voucher_rows(w, batch)[1]
        out = R.unassign_recipient_vouchers(
            batch["id"], rid, DistributionUnassignIn(voucherIds=[str(v2.id)], reason="נמסר ידנית"), **_ctx(w),
        )
        assert out["freed"] == 1 and out["recipient"]["serials"] == [1, 3]
        ev = events(w, batch, "unassign")[-1]
        assert ev.details["serials"] == [2] and ev.details["reason"] == "נמסר ידנית" and ev.user_name == "admin"
        assert preview(w, batch, [{"phone": "0521234567"}], mode="count", perRecipient=2)["rows"][0]["serials"] == [2, 4]

    def test_every_assignment_is_in_the_trail_without_personal_data(self, w):
        batch = make(w, count=3)
        do_import(w, batch, PEOPLE[:2], mode="one")
        assigned = events(w, batch, "assign")
        assert [e.details["serials"] for e in assigned] == [[1], [2]]
        text = repr([(e.details, e.user_name) for e in events(w, batch)])
        assert "050" not in text and "דנה" not in text

    def test_a_cancelled_batch_takes_no_list(self, w):
        batch = make(w, count=3)
        PR.cancel_prepaid_voucher_batch(batch["id"], None, **_ctx(w))
        assert refused(do_import, w, batch, PEOPLE[:1]).status_code == 409


# ── Links ────────────────────────────────────────────────────────────────────


class TestLinks:
    def test_160_random_bits_and_only_the_hash_and_ciphertext_stored(self, w):
        batch = make(w, count=3)
        do_import(w, batch, PEOPLE, mode="one")
        items = recipients(w, batch)["items"]
        tokens = [token_of(i) for i in items]
        assert len(set(tokens)) == 3
        assert all(re.fullmatch(r"[A-Za-z0-9_-]{27}", t) for t in tokens)  # 20 bytes, base64url
        assert VD.TOKEN_BYTES * 8 >= 128
        rows = {r.token_hash: r for r in w.db.query(VoucherDistributionRecipient)}
        for t in tokens:
            r = rows[hashlib.sha256(t.encode()).hexdigest()]
            assert t not in r.token_ciphertext
        assert items[0]["link"].startswith(VD.link_base_url() + "/api/v1/public/vouchers/")

    def test_expiry_is_the_batch_end_plus_seven_days_or_sixty_days(self, w):
        end = datetime(2026, 12, 31, 21, 0, tzinfo=timezone.utc)
        dated = make(w, count=1, valid_until=end)
        do_import(w, dated, PEOPLE[:1], mode="one")
        assert recipients(w, dated)["items"][0]["linkExpiresAt"].startswith("2027-01-07T21:00")
        open_ended = make(w, count=1)
        before = datetime.now(timezone.utc)
        do_import(w, open_ended, PEOPLE[:1], mode="one")
        at = datetime.fromisoformat(recipients(w, open_ended)["items"][0]["linkExpiresAt"])
        assert timedelta(days=59) < at - before <= timedelta(days=60, seconds=5)

    def test_links_follow_the_batch_when_its_validity_is_extended(self, w, stub_pdf, monkeypatch):
        from app.schemas.prepaid_voucher import PrepaidVoucherBatchUpdate

        end = datetime.now(timezone.utc) + timedelta(days=2)
        batch = make(w, count=1, valid_until=end)
        do_import(w, batch, PEOPLE[:1], mode="one")
        t = token_of(recipients(w, batch)["items"][0])
        later = end + timedelta(days=30)
        PR.update_prepaid_voucher_batch(batch["id"], PrepaidVoucherBatchUpdate(validUntil=later), **_ctx(w))
        assert recipients(w, batch)["items"][0]["linkExpiresAt"][:10] == (later + VD.LINK_GRACE).date().isoformat()
        # Past the old end + 7 days, the link still opens.
        monkeypatch.setattr(VD, "_now", lambda: end + timedelta(days=10))
        assert page(w, t).status_code == 200
        # Shortening never cuts a link below what it was issued with (end + 7 days) …
        PR.update_prepaid_voucher_batch(batch["id"], PrepaidVoucherBatchUpdate(validUntil=end - timedelta(days=1)), **_ctx(w))
        assert page(w, t).status_code == 404  # day 10: past the issued end + 7
        monkeypatch.setattr(VD, "_now", lambda: end + timedelta(days=6, hours=12))
        assert page(w, t).status_code == 200  # within it, though the batch's own end + 7 has passed
        # … and an explicit date of the distribution is fixed.
        monkeypatch.setattr(VD, "_now", lambda: datetime.now(timezone.utc))
        fixed = datetime.now(timezone.utc) + timedelta(days=3)
        R.update_distribution(batch["id"], DistributionSettingsIn(linkExpiresAt=fixed), **_ctx(w))
        monkeypatch.setattr(VD, "_now", lambda: fixed + timedelta(minutes=1))
        assert page(w, t).status_code == 404

    def test_a_new_expiry_moves_every_live_link(self, w):
        batch = make(w, count=2)
        do_import(w, batch, PEOPLE[:2], mode="one")
        when = datetime(2027, 3, 1, tzinfo=timezone.utc)
        out = R.update_distribution(batch["id"], DistributionSettingsIn(linkExpiresAt=when), **_ctx(w))
        assert out["effectiveLinkExpiresAt"].startswith("2027-03-01")
        assert {i["linkExpiresAt"][:10] for i in recipients(w, batch)["items"]} == {"2027-03-01"}

    def test_unknown_revoked_expired_removed_and_cancelled_all_look_the_same(self, w, stub_pdf, monkeypatch):
        batch = make(w, count=5)
        do_import(w, batch, [{"phone": f"05{i}1234567"} for i in range(5)], mode="one")
        items = recipients(w, batch)["items"]
        ok = page(w, token_of(items[0]))
        assert ok.status_code == 200

        R.revoke_recipient_link(batch["id"], items[1]["id"], None, **_ctx(w))
        R.remove_recipient(batch["id"], items[2]["id"], None, **_ctx(w))
        r3 = w.db.query(VoucherDistributionRecipient).filter_by(id=uuid.UUID(items[3]["id"])).one()
        r3.token_expires_at = datetime.now(timezone.utc) - timedelta(minutes=1)
        w.db.commit()
        refusals = [page(w, t) for t in (
            "x" * 27, token_of(items[1]), token_of(items[2]), token_of(items[3]), "short",
        )]
        assert {r.status_code for r in refusals} == {404}
        assert len({bytes(r.body) for r in refusals}) == 1  # the same page, whatever the reason
        reasons = [e.details["reason"] for e in events(w, batch, "link_denied")]
        assert reasons == ["revoked", "removed", "expired"]
        PR.cancel_prepaid_voucher_batch(batch["id"], None, **_ctx(w))
        assert page(w, token_of(items[4])).status_code == 404
        assert pdf(w, token_of(items[0])).status_code == 404

    def test_misses_are_rate_limited_per_address(self, w):
        ip = "192.0.2.77"
        for _ in range(R.MISSES_PER_MINUTE):
            assert page(w, VD.new_token(), ip=ip).status_code == 404
        with pytest.raises(HTTPException) as e:
            page(w, VD.new_token(), ip=ip)
        assert e.value.status_code == 429

    def test_behind_flys_proxy_each_client_has_its_own_limit(self, w):
        # Every request reaches the API from Fly's proxy; the client is in Fly-Client-IP.
        proxy = "172.16.0.1"
        for _ in range(R.MISSES_PER_MINUTE):
            assert page(w, VD.new_token(), ip=proxy, fly_ip="203.0.113.5").status_code == 404
        assert page(w, VD.new_token(), ip=proxy, fly_ip="203.0.113.6").status_code == 404
        with pytest.raises(HTTPException):
            page(w, VD.new_token(), ip=proxy, fly_ip="203.0.113.5")

    def test_a_ceiling_on_misses_for_the_whole_server(self, w, monkeypatch):
        from app.middleware import rate_limit as RL

        monkeypatch.setattr(R, "MISSES_PER_MINUTE_ALL", 3)
        RL._buckets.pop("voucher_link_miss_all", None)
        try:
            for _ in range(3):
                assert page(w, VD.new_token()).status_code == 404  # each from another address
            with pytest.raises(HTTPException) as e:
                page(w, VD.new_token())
            assert e.value.status_code == 429
        finally:
            RL._buckets.pop("voucher_link_miss_all", None)

    def test_the_token_never_reaches_the_logs(self, w):
        import logging

        token = VD.new_token()
        for name in R.LOGGERS_WITH_PATHS:
            assert any(isinstance(f, R.RedactVoucherLinks) for f in logging.getLogger(name).filters)
        f = R.RedactVoucherLinks()
        access = logging.LogRecord("uvicorn.access", logging.INFO, "", 0, '%s - "%s %s HTTP/%s" %d',
                                   ("1.2.3.4:5", "GET", f"/api/v1/public/vouchers/{token}/pdf?download=1", "1.1", 200), None)
        f.filter(access)
        assert token not in access.getMessage() and "/public/vouchers/[link]/pdf?download=1" in access.getMessage()
        done = logging.LogRecord("app.middleware.request_context", logging.INFO, "", 0, "request completed", None, None)
        done.path = f"/api/v1/public/vouchers/{token}"
        done.response_body = f"<a href='/api/v1/public/vouchers/{token}/pdf'>"
        f.filter(done)
        assert token not in done.path and token not in done.response_body
        # Through the real logger, as the middleware logs it — with a handler of the test's own on
        # that logger (whatever propagation another test left configured).
        seen = []

        class Keep(logging.Handler):
            def emit(self, record):
                seen.append(record)

        lg = logging.getLogger("app.middleware.request_context")
        handler, level, disabled = Keep(logging.INFO), lg.level, lg.disabled
        lg.addHandler(handler)
        lg.setLevel(logging.INFO)
        lg.disabled = False
        try:
            lg.info("request completed", extra={"path": f"/api/v1/public/vouchers/{token}"})
        finally:
            lg.removeHandler(handler)
            lg.setLevel(level)
            lg.disabled = disabled
        assert len(seen) == 1 and seen[0].path == "/api/v1/public/vouchers/[link]"

    def test_a_past_expiry_is_refused(self, w):
        batch = make(w, count=1)
        past = datetime.now(timezone.utc) - timedelta(hours=1)
        e = refused(R.update_distribution, batch["id"], DistributionSettingsIn(linkExpiresAt=past), **_ctx(w))
        assert (e.status_code, e.detail) == (400, VD.EXPIRY_PAST)

    def test_reissue_kills_the_old_link(self, w, stub_pdf):
        batch = make(w, count=2)
        do_import(w, batch, PEOPLE[:1], mode="one")
        item = recipients(w, batch)["items"][0]
        old = token_of(item)
        new = R.reissue_recipient_link(batch["id"], item["id"], **_ctx(w))
        assert token_of(new) != old and new["linkVersion"] == 2
        assert page(w, old).status_code == 404 and page(w, token_of(new)).status_code == 200
        assert events(w, batch, "link_reissued")[-1].details == {"from": 1, "to": 2, "expiresAt": new["linkExpiresAt"]}

    def test_the_link_gives_only_that_recipients_vouchers(self, w, stub_pdf):
        batch = make(w, count=6)
        do_import(w, batch, PEOPLE[:2], mode="count", perRecipient=3)
        second = recipients(w, batch)["items"][1]
        resp = pdf(w, token_of(second))
        assert resp.status_code == 200 and resp.media_type == "application/pdf"
        assert stub_pdf[-1]["serials"] == [4, 5, 6]
        assert resp.headers["cache-control"].startswith("no-store")
        assert "noindex" in resp.headers["x-robots-tag"]
        assert "inline" in resp.headers["content-disposition"]

    def test_the_page_never_shows_the_name_or_the_phone(self, w):
        batch = make(w, count=2)
        do_import(w, batch, PEOPLE[:1], mode="count", perRecipient=2)
        html = bytes(page(w, token_of(recipients(w, batch)["items"][0])).body).decode()
        assert "פסטיבל הקיץ" in html and "2 שוברים" in html and "0001-0002" in html
        assert "דנה" not in html and "4567" not in html
        assert 'og:title' in html and "<img" not in html

    def test_preview_robots_never_count_as_opened(self, w, stub_pdf):
        batch = make(w, count=1)
        do_import(w, batch, PEOPLE[:1], mode="one")
        t = token_of(recipients(w, batch)["items"][0])
        for ua in ("WhatsApp/2.24.1 A", "facebookexternalhit/1.1", "TelegramBot (like TwitterBot)"):
            page(w, t, ua=ua)
        page(w, t, method="HEAD")
        item = recipients(w, batch)["items"][0]
        assert item["state"] == "pending" and item["openCount"] == 0
        assert len(events(w, batch, "link_preview")) == 4
        page(w, t)
        pdf(w, t)
        item = recipients(w, batch)["items"][0]
        assert (item["state"], item["openCount"], item["downloadCount"]) == ("opened", 1, 1)
        opened = events(w, batch, "link_opened")[0]
        assert opened.ip and opened.user_agent.startswith("Mozilla")


# ── The PDF ──────────────────────────────────────────────────────────────────


class TestPdf:
    def test_the_real_renderer_draws_exactly_the_usable_vouchers_one_a_page(self, w, monkeypatch):
        monkeypatch.setattr(PDF, "load_logo", lambda url: None)
        batch = make(w, count=4)
        do_import(w, batch, PEOPLE[:1], mode="count", perRecipient=3)
        voucher_rows(w, batch)[1].status = "used"
        w.db.commit()
        b = w.db.query(PrepaidVoucherBatch).filter_by(id=uuid.UUID(batch["id"])).one()
        r = w.db.query(VoucherDistributionRecipient).one()
        data, name, count = VD.render_recipient_pdf(w.db, b, r)
        assert data.startswith(b"%PDF") and count == 2
        assert len(re.findall(rb"/Type\s*/Page\b(?!s)", data)) == 2
        assert name == "פסטיבל הקיץ_0001-0003.pdf"

    def test_the_distribution_layout_and_a6_by_default(self, w, stub_pdf):
        batch = make(w, count=2)
        do_import(w, batch, PEOPLE[:1], mode="one")
        rid = recipients(w, batch)["items"][0]["id"]
        R.recipient_pdf(batch["id"], rid, purpose="download", **_ctx(w))
        assert stub_pdf[-1]["page"] == (105.0, 148.0)
        R.update_distribution(batch["id"], DistributionSettingsIn(layout="card86x54"), **_ctx(w))
        R.recipient_pdf(batch["id"], rid, purpose="share", **_ctx(w))
        assert stub_pdf[-1]["page"] == (86.0, 54.0)
        assert [e.details["purpose"] for e in events(w, batch, "dashboard_pdf")] == ["download", "share"]
        assert refused(R.update_distribution, batch["id"], DistributionSettingsIn(layout="poster"), **_ctx(w)).status_code == 400

    def test_nothing_left_is_404(self, w, stub_pdf):
        batch = make(w, count=1)
        do_import(w, batch, PEOPLE[:1], mode="one")
        voucher_rows(w, batch)[0].status = "used"
        w.db.commit()
        item = recipients(w, batch)["items"][0]
        assert refused(R.recipient_pdf, batch["id"], item["id"], purpose="download", **_ctx(w)).detail == VD.NO_VOUCHERS
        # The link still opens, and says so without a voucher in it.
        resp = pdf(w, token_of(item))
        assert resp.status_code == 404 and "אין בקישור זה שוברים פעילים" in bytes(resp.body).decode()
        assert stub_pdf == []


# ── Messages ─────────────────────────────────────────────────────────────────


class TestMessages:
    def test_the_default_message_has_the_name_the_serials_and_the_link(self, w):
        batch = make(w, count=3)
        do_import(w, batch, PEOPLE[:1], mode="count", perRecipient=3)
        item = recipients(w, batch)["items"][0]
        assert item["message"].startswith("שלום דנה,\nמצורפים השוברים שלך לפסטיבל הקיץ (3 שוברים, מס׳ 0001-0003).")
        assert item["message"].endswith(item["link"])

    def test_placeholders_aliases_a_missing_name_and_the_link_always_there(self):
        values = {"name": "", "event": "פסטיבל", "count": 2, "serials": "0001-0002", "link": "https://x/v/T"}
        assert VD.render_message("שלום {שם}, {כמות} שוברים ל{event}", values) == "שלום, 2 שוברים לפסטיבל\nhttps://x/v/T"
        assert VD.render_message("{unknown} {קישור}", values) == "{unknown} https://x/v/T"
        assert VD.serials_text([7, 1, 2, 3, 5, 8]) == "0001-0003, 0005, 0007-0008"
        assert VD.serials_text(range(1, 40, 2), limit=3) == "0001, 0003, 0005, …"

    def test_a_group_send_has_no_name_and_its_own_text(self, w):
        batch = make(w, count=10, group_size=5)
        do_import(w, batch, [{"group": 2}, {"group": 1, "phone": "0501234567", "name": "ראש קבוצה"}], mode="group", kind="group")
        items = recipients(w, batch, kind="group")["items"]
        assert [(i["group"], i["phone"]) for i in items] == [(2, None), (1, "972501234567")]
        assert items[0]["message"].startswith("שוברי פסטיבל הקיץ — קבוצה 2 (5 שוברים, מס׳ 0006-0010).")
        R.update_distribution(batch["id"], DistributionSettingsIn(groupMessageTemplate="קבוצה {קבוצה}: {קישור}"), **_ctx(w))
        assert recipients(w, batch, kind="group")["items"][0]["message"] == f"קבוצה 2: {items[0]['link']}"


# ── Status, export, erasure ──────────────────────────────────────────────────


class TestStatus:
    def test_marks_and_their_undo_with_who(self, w):
        batch = make(w, count=3)
        do_import(w, batch, PEOPLE, mode="one")
        ids = [i["id"] for i in recipients(w, batch)["items"]]
        out = R.mark_recipient_sent(batch["id"], ids[0], DistributionSentIn(via="wa_link"), **_ctx(w))
        assert (out["state"], out["sentVia"], out["sentByName"]) == ("sent", "wa_link", "admin")
        R.mark_recipient_sent(batch["id"], ids[1], DistributionSentIn(via="share"), **_ctx(w))
        back = R.mark_recipient_pending(batch["id"], ids[1], **_ctx(w))
        assert back["state"] == "pending" and back["sentAt"] is None
        R.mark_recipient_sent(batch["id"], ids[0], DistributionSentIn(via="manual"), **_ctx(w))
        sent = events(w, batch, "sent")
        assert [(e.details["via"], e.details["resend"]) for e in sent] == [("wa_link", False), ("share", False), ("manual", True)]
        assert events(w, batch, "unsent")[0].details["via"] == "share"
        listing = recipients(w, batch)
        assert listing["counts"] == {"pending": 2, "sent": 1, "delivered": 0, "read": 0, "opened": 0, "failed": 0}
        assert [i["id"] for i in recipients(w, batch, state="pending")["items"]] == ids[1:]
        assert [i["name"] for i in recipients(w, batch, q="יוס")["items"]] == ["יוסי"]
        assert [i["name"] for i in recipients(w, batch, q="054-765")["items"]] == ["רון"]
        assert [i["name"] for i in recipients(w, batch, q="2")["items"]] == ["יוסי"]  # by serial

    def test_the_csv_has_every_row_and_never_a_link(self, w):
        batch = make(w, count=3)
        do_import(w, batch, PEOPLE, mode="one")
        items = recipients(w, batch)["items"]
        R.mark_recipient_sent(batch["id"], items[0]["id"], DistributionSentIn(via="wa_link"), **_ctx(w))
        resp = R.export_distribution(batch["id"], **_ctx(w))
        text = resp.body.decode("utf-8")
        assert text.startswith("﻿")
        rows = list(csv.reader(io.StringIO(text[1:])))
        assert rows[0][:7] == ["שם", "טלפון", "סוג", "קבוצה", "מספרי שוברים", "כמות", "מצב"]
        assert rows[1][:7] == ["דנה", "050-123-4567", "נמען", "", "0001", "1", "נשלח"]
        assert rows[1][8] == "וואטסאפ (קישור)" and rows[1][9] == "admin"
        assert len(rows) == 4
        assert all(token_of(i) not in text for i in items) and "/public/vouchers/" not in text

    def test_erasure_only_once_the_batch_is_over(self, w, stub_pdf):
        batch = make(w, count=2)
        do_import(w, batch, PEOPLE[:2], mode="one")
        items = recipients(w, batch)["items"]
        page(w, token_of(items[0]))
        assert refused(R.erase_recipient, batch["id"], items[0]["id"], **_ctx(w)).detail == VD.BATCH_ACTIVE
        assert refused(R.erase_all_recipients, batch["id"], **_ctx(w)).detail == VD.BATCH_ACTIVE
        PR.cancel_prepaid_voucher_batch(batch["id"], None, **_ctx(w))
        out = R.erase_recipient(batch["id"], items[0]["id"], **_ctx(w))
        assert (out["name"], out["phone"], out["link"]) == (None, None, None) and out["anonymizedAt"]
        assert all(e.ip is None and e.user_agent is None for e in events(w, batch, "link_opened"))
        assert R.erase_all_recipients(batch["id"], **_ctx(w)) == {"erased": 1}
        r = w.db.query(VoucherDistributionRecipient).filter_by(id=uuid.UUID(items[1]["id"])).one()
        assert r.phone_ciphertext is None and r.phone_hash is None and r.name is None

    def test_a_removed_recipient_holding_nothing_can_be_erased_at_once(self, w):
        batch = make(w, count=2)
        do_import(w, batch, PEOPLE[:1], mode="one")
        rid = recipients(w, batch)["items"][0]["id"]
        R.remove_recipient(batch["id"], rid, DistributionReasonIn(reason="ביקש להסיר"), **_ctx(w))
        assert recipients(w, batch)["recipients"] == 0
        assert recipients(w, batch, include_removed=True)["items"][0]["deletedAt"]
        assert events(w, batch, "unassign")[-1].details["serials"] == [1]
        assert R.erase_recipient(batch["id"], rid, **_ctx(w))["anonymizedAt"]


# ── Permissions ──────────────────────────────────────────────────────────────


class TestPermissions:
    def test_only_who_manages_the_batch(self, w):
        batch = make(w, count=2)
        do_import(w, batch, PEOPLE[:1], mode="one")
        for fn, args in (
            (R.list_distribution, dict(state=None, kind=None, q=None, include_removed=False, limit=10, offset=0)),
            (R.get_distribution, {}),
            (R.export_distribution, {}),
        ):
            e = refused(fn, batch["id"], **args, **_ctx(w, w.cashier))
            assert e.status_code == 403

    def test_reading_the_lists_needs_edit_on_the_section(self):
        for method, path in (
            ("GET", "/prepaid-vouchers/batches/{batch_id}/distribution/recipients"),
            ("GET", "/prepaid-vouchers/batches/{batch_id}/distribution/export"),
            ("GET", "/prepaid-vouchers/distribution/whatsapp-config"),
            ("POST", "/prepaid-vouchers/batches/{batch_id}/distribution/recipients"),
        ):
            rule = DS.rule_for(method, path)
            assert (rule.sections, rule.needed_level(method)) == (("prepaid_vouchers",), DS.EDIT)
        assert DS.rule_for("GET", "/prepaid-vouchers/batches/{batch_id}").needed_level("GET") == DS.VIEW

    def test_the_public_routes_need_no_login(self):
        from app.main import app
        from app.middleware import auth as auth_mw
        from fastapi.routing import APIRoute

        def deps(route):
            stack, out = list(route.dependant.dependencies), set()
            while stack:
                d = stack.pop()
                out.add(d.call)
                stack.extend(d.dependencies)
            return out

        public = [r for r in app.routes if isinstance(r, APIRoute) and "/public/vouchers/" in r.path or
                  isinstance(r, APIRoute) and "/public/whatsapp/" in r.path]
        assert len(public) == 4
        assert all(auth_mw.get_current_user not in deps(r) for r in public)


# ── The migration ────────────────────────────────────────────────────────────


class TestMigration:
    REVISION = "c3f8a1d6e94b"

    def _module(self):
        path = ROOT / "alembic" / "versions" / f"{self.REVISION}_voucher_distribution.py"
        spec = importlib.util.spec_from_file_location("migration_" + self.REVISION, path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_a_unique_revision_on_the_single_head(self):
        from alembic.config import Config
        from alembic.script import ScriptDirectory

        declaring = [
            p.name for p in (ROOT / "alembic" / "versions").glob("*.py")
            if re.search(rf"^revision(?::\s*str)?\s*=\s*['\"]{self.REVISION}['\"]", p.read_text(encoding="utf-8"), re.M)
        ]
        assert declaring == [f"{self.REVISION}_voucher_distribution.py"]
        config = Config(str(ROOT / "alembic.ini"))
        config.set_main_option("script_location", str(ROOT / "alembic"))
        script = ScriptDirectory.from_config(config)
        assert len(script.get_heads()) == 1
        assert script.get_revision(self.REVISION).down_revision == "6b1e9d4f2a87"

    def test_idempotent_and_the_models_tables(self):
        import sqlalchemy as sa
        from alembic.operations import Operations
        from alembic.runtime.migration import MigrationContext

        from app.database import Base

        module = self._module()
        engine = sa.create_engine("sqlite://")
        with engine.begin() as conn:
            with Operations.context(MigrationContext.configure(conn)):
                module.upgrade()
                module.upgrade()
            insp = sa.inspect(conn)
            for table in module._tables():
                assert insp.has_table(table)
                model_cols = {c.name for c in Base.metadata.tables[table].columns}
                assert {c["name"] for c in insp.get_columns(table)} == model_cols
                model_ix = {i.name for i in Base.metadata.tables[table].indexes}
                assert model_ix <= {i["name"] for i in insp.get_indexes(table)}
        buf = io.StringIO()
        offline = MigrationContext.configure(dialect_name="postgresql", opts={"as_sql": True, "output_buffer": buf})
        with Operations.context(offline):
            module.upgrade()
        assert "CREATE TABLE voucher_distribution_assignments" in buf.getvalue()
        assert "uq_voucher_distribution_assignments_voucher UNIQUE (voucher_id)" in buf.getvalue()


def test_the_route_map_fixture_lists_every_distribution_route():
    text = (ROOT / "tests" / "fixtures" / "dashboard_route_sections.txt").read_text(encoding="utf-8")
    lines = [l for l in text.splitlines() if "distribution" in l]
    assert len(lines) == 21 and all(l.endswith("prepaid_vouchers:edit") for l in lines)
