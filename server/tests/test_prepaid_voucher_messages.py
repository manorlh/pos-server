"""
Prepaid vouchers ("שוברי הפקה"): the till's words when a voucher is refused — the spec's §11
("השובר מומש כבר בקופה 12 בשעה 22:14", "השובר אינו תקף בנקודת המכירה הזאת"), in the lookup's
`message`, with the facts the cloud has (which till used it up and when, in the tenant's clock;
the date it expired / starts). The reason code is unchanged; a client that knows no `message`
keeps its own text.

Runs on the in-memory SQLite world of tests/shift_world.py (fixtures of test_prepaid_vouchers).
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from app.models.prepaid_voucher import PrepaidVoucher, PrepaidVoucherRedemption
from app.routers import prepaid_vouchers as R
from app.services import prepaid_vouchers as PV
from test_prepaid_vouchers import _ctx, first_code, lookup, make_batch, redeem, w  # noqa: F401 — `w` is the fixture

ZONE = ZoneInfo("Asia/Jerusalem")


def _voucher(w, code) -> PrepaidVoucher:
    return w.db.query(PrepaidVoucher).filter(PrepaidVoucher.code == code.replace("-", "")).one()


class TestRefusalWords:
    def test_used_up_says_which_till_and_when(self, w):
        batch = make_batch(w)
        code = first_code(w, batch)
        redeem(w, code, [(w.hotdog, 1), (w.drink, 2)])
        out = lookup(w, code)
        assert out["reason"] == PV.USED and out["redeemable"] is False
        when = w.db.query(PrepaidVoucherRedemption).one().redeemed_at
        if when.tzinfo is None:
            when = when.replace(tzinfo=timezone.utc)
        local = when.astimezone(ZONE)
        assert out["message"] == f"השובר מומש כבר בקופה {w.tills[0].name} בשעה {local:%H:%M}"

    def test_used_on_another_day_says_the_date(self, w):
        batch = make_batch(w)
        code = first_code(w, batch)
        redeem(w, code, [(w.hotdog, 1), (w.drink, 2)])
        voucher = _voucher(w, code)
        r = w.db.query(PrepaidVoucherRedemption).one()
        r.redeemed_at = datetime(2026, 8, 13, 19, 14, tzinfo=timezone.utc)  # 22:14 in Israel
        w.db.flush()
        msg = PV.refusal_message(w.db, voucher, PV.USED, now=datetime(2026, 8, 15, 10, 0, tzinfo=timezone.utc))
        assert msg == f"השובר מומש כבר בקופה {w.tills[0].name} ב-13/08 בשעה 22:14"

    def test_a_reversed_redemption_is_not_where_it_was_used(self, w):
        batch = make_batch(w)
        voucher = _voucher(w, first_code(w, batch))
        voucher.status = "used"
        w.db.flush()
        assert PV.refusal_message(w.db, voucher, PV.USED) == "השובר מומש כבר במלואו"

    def test_another_point_of_sale(self, w):
        batch = make_batch(w, shops=[w.shop.id])
        out = lookup(w, first_code(w, batch), till=w.other_till)
        assert (out["reason"], out["message"]) == (PV.WRONG_SHOP, "השובר אינו תקף בנקודת המכירה הזאת")

    def test_expired_and_not_yet_valid_say_the_date(self, w):
        now = datetime.now(timezone.utc)
        old = make_batch(w, valid_from=now - timedelta(days=3), valid_until=now - timedelta(days=1))
        out = lookup(w, first_code(w, old))
        assert out["message"] == f"תוקף השובר הסתיים ב-{(now - timedelta(days=1)).astimezone(ZONE):%d/%m/%Y}"
        later = make_batch(w, valid_from=now + timedelta(days=2))
        assert lookup(w, first_code(w, later))["message"] == f"השובר יהיה בתוקף מ-{(now + timedelta(days=2)).astimezone(ZONE):%d/%m/%Y}"

    def test_cancelled(self, w):
        batch = make_batch(w)
        code = first_code(w, batch)
        R.cancel_prepaid_voucher_batch(batch["id"], body=None, **_ctx(w))
        assert lookup(w, code)["message"] == "השובר בוטל"

    def test_a_redeemable_voucher_has_no_message(self, w):
        batch = make_batch(w)
        out = lookup(w, first_code(w, batch))
        assert out["redeemable"] is True and out["message"] is None
