"""
"שעת סיום יום עסקי" (app/services/business_day.py) — one rule, pinned by a golden fixture shared
with the dashboard (client/src/lib/businessDay.test.ts) and the till (pos-android BusinessDayTest):
the three must compute every case the same way, DST changes and month / year ends included.
"""
import hashlib
import json
import uuid
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path

import pytest

from app.models.till_parameter import TillParameter, TillParameterValue
from app.services import business_day as B
from app.services import till_parameters as TP
from test_shop_areas import w  # noqa: F401  (the reports' world)

GOLDEN = Path(__file__).parent / "fixtures" / "business_day_golden.json"
#: The file's SHA-256 (line endings read as LF) — the same constant in client/src/lib/businessDay.test.ts
#: and pos-android's BusinessDayTest. Change the fixture in both repositories, and every constant, together.
GOLDEN_SHA256 = "1b881752fc089378c9213024647ab2593449147a47d07be08aa2eb28de60552e"
#: pos-android beside pos-server (as on the developers' machines): the two copies must be equal.
SIBLING = Path(__file__).resolve().parents[3] / "pos-android" / "app" / "src" / "test" / "resources" / GOLDEN.name


def _text(path: Path) -> str:
    return path.read_bytes().decode("utf-8").replace("\r\n", "\n")


GOLDEN_DATA = json.loads(_text(GOLDEN))


def _at(text: str) -> datetime:
    return datetime.fromisoformat(text.replace("Z", "+00:00"))


def test_the_fixture_is_the_pinned_one():
    assert hashlib.sha256(_text(GOLDEN).encode("utf-8")).hexdigest() == GOLDEN_SHA256


def test_the_till_has_the_same_fixture():
    if not SIBLING.exists():
        pytest.skip("pos-android is not checked out beside pos-server")
    if not (SIBLING.parent / GOLDEN.name).exists():
        pytest.skip("the till's copy is not there yet")
    assert _text(SIBLING) == _text(GOLDEN)


def test_the_bounds_are_the_fixtures():
    assert (B.DEFAULT_END_HOUR, B.MIN_END_HOUR, B.MAX_END_HOUR) == (
        GOLDEN_DATA["defaultEndHour"], GOLDEN_DATA["minEndHour"], GOLDEN_DATA["maxEndHour"],
    )


@pytest.mark.parametrize("case", GOLDEN_DATA["endHours"], ids=lambda c: repr(c["input"]))
def test_end_hour_normalised(case):
    assert B.normalize_end_hour(case["input"]) == case["hour"]


@pytest.mark.parametrize("case", GOLDEN_DATA["days"], ids=lambda c: c["name"][:70])
def test_business_day_of_a_moment(case):
    moment = _at(case["at"])
    assert B.business_day(moment, case["tz"], case["endHour"]).isoformat() == case["businessDay"]
    assert B.local_time(moment, case["tz"]).strftime("%Y-%m-%dT%H:%M:%S").startswith(case["local"])


@pytest.mark.parametrize("case", GOLDEN_DATA["starts"], ids=lambda c: c["name"][:70])
def test_business_day_start(case):
    day = date.fromisoformat(case["businessDay"])
    start = B.business_day_start(day, case["tz"], case["endHour"])
    assert start == _at(case["startsAt"])
    # The start is in its own day, the instant before it in the day before.
    assert B.business_day(start, case["tz"], case["endHour"]) == day
    assert B.business_day(start - timedelta(seconds=1), case["tz"], case["endHour"]) == day - timedelta(days=1)


@pytest.mark.parametrize("case", GOLDEN_DATA["documentMonths"], ids=lambda c: c["name"][:70])
def test_document_months_and_the_cross_month_line(case):
    months = B.document_months([(_at(d["at"]), d["amount"]) for d in case["documents"]], case["tz"])
    assert months == case["months"]
    assert B.cross_month_line(months) == case["line"]


def test_a_dst_day_is_23_or_25_hours_long():
    tz = "Asia/Jerusalem"
    spring = B.business_day_range(date(2026, 3, 26), date(2026, 3, 26), tz, 4)
    autumn = B.business_day_range(date(2026, 10, 24), date(2026, 10, 24), tz, 4)
    assert spring[1] - spring[0] == timedelta(hours=23)
    assert autumn[1] - autumn[0] == timedelta(hours=25)


def test_today_is_the_business_day_now():
    one_am = datetime(2026, 9, 30, 22, 0, tzinfo=timezone.utc)  # 01:00 on 1.10 in Israel
    assert B.today("Asia/Jerusalem", 4, now=one_am) == date(2026, 9, 30)
    assert B.today("Asia/Jerusalem", 0, now=one_am) == date(2026, 10, 1)


class TestEndHours:
    def test_calendar_is_midnight_for_everyone(self):
        hours = B.EndHours.calendar()
        assert hours.default == 0 and hours.uniform
        assert hours.day_of(datetime(2026, 9, 30, 22, 0, tzinfo=timezone.utc), "Asia/Jerusalem") == date(2026, 10, 1)

    def test_a_till_goes_by_its_own_hour(self):
        till = uuid.uuid4()
        hours = B.EndHours(default=4, by_machine={till: 0})
        one_am = datetime(2026, 9, 30, 22, 0, tzinfo=timezone.utc)
        assert not hours.uniform and hours.hours == (0, 4)
        assert hours.day_of(one_am, "Asia/Jerusalem", till) == date(2026, 10, 1)
        assert hours.day_of(one_am, "Asia/Jerusalem", uuid.uuid4()) == date(2026, 9, 30)
        assert hours.day_of(one_am, "Asia/Jerusalem", str(till)) == date(2026, 10, 1)

    def test_bounds_cover_every_hour(self):
        hours = B.EndHours(default=4, by_machine={uuid.uuid4(): 0, uuid.uuid4(): 12})
        start, end = hours.bounds(date(2026, 10, 1), date(2026, 10, 1), "Asia/Jerusalem")
        assert start == datetime(2026, 9, 30, 21, 0, tzinfo=timezone.utc)  # midnight (end 0)
        assert end == datetime(2026, 10, 2, 9, 0, tzinfo=timezone.utc)  # noon on 2.10 (end 12)

    def test_basis(self):
        assert B.check_basis(None) == "business" and B.check_basis("document") == "document"
        with pytest.raises(Exception):
            B.check_basis("calendar")


# ── The parameter, resolved like every till parameter ──────────────────────────────


@pytest.fixture
def world(monkeypatch):
    from shift_world import make_world

    w = make_world()
    TP.ensure_builtin_parameters(w.db)
    w.db.commit()
    return w


def _set(w, scope_type, scope_id, value):
    parameter = w.db.query(TillParameter).filter(TillParameter.key == B.PARAMETER_KEY).one()
    w.db.add(TillParameterValue(
        id=uuid.uuid4(), parameter_id=parameter.id, scope_type=scope_type, scope_id=scope_id, value=value,
    ))
    w.db.commit()


class TestTheParameter:
    def test_it_is_built_in_with_a_hebrew_label_and_default_4(self, world):
        parameter = world.db.query(TillParameter).filter(TillParameter.key == "businessDayEndHour").one()
        assert parameter.label == "שעת סיום יום עסקי"
        assert parameter.value_type == "integer" and parameter.default_value == 4
        assert "01:00" in parameter.description and "מבנה אחיד" in parameter.description

    def test_unset_is_four_everywhere(self, world):
        hours = B.end_hours_for_scope(world.db, shop_id=world.shop.id)
        assert hours.default == 4 and hours.uniform
        assert B.end_hour_for(world.db, machine_id=world.tills[0].id) == 4

    def test_company_shop_area_till_the_most_specific_wins(self, world):
        from app.models.shop_area import ShopArea

        w = world
        area = ShopArea(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, name="Bar")
        w.db.add(area)
        w.tills[1].area_id = area.id
        w.db.commit()
        _set(w, "company", w.company.id, 5)
        assert B.end_hour_for(w.db, shop_id=w.other_shop.id) == 5
        _set(w, "shop", w.shop.id, 6)
        assert B.end_hour_for(w.db, shop_id=w.shop.id) == 6
        assert B.end_hour_for(w.db, machine_id=w.tills[0].id) == 6
        _set(w, "area", area.id, 2)
        assert B.end_hour_for(w.db, machine_id=w.tills[1].id) == 2
        _set(w, "machine", w.tills[0].id, 0)
        assert B.end_hour_for(w.db, machine_id=w.tills[0].id) == 0

        # A shop report: the shop's hour, and each till that differs on its own.
        hours = B.end_hours_for_scope(w.db, shop_id=w.shop.id)
        assert hours.default == 6
        assert dict(hours.by_machine) == {w.tills[0].id: 0, w.tills[1].id: 2}
        # A company report: the company's, the center's tills on theirs.
        hours = B.end_hours_for_scope(w.db, company_id=w.company.id)
        assert hours.default == 5 and hours.for_machine(w.other_till.id) == 5
        assert hours.for_machine(w.tills[0].id) == 0

    def test_a_value_out_of_range_is_refused_when_set(self):
        assert TP.validate_keyed_value("businessDayEndHour", 12) == 12
        assert TP.validate_keyed_value("businessDayEndHour", 0) == 0
        for bad in (13, -1, 24):
            with pytest.raises(TP.TillParameterValueError):
                TP.validate_keyed_value("businessDayEndHour", bad)

    def test_a_deactivated_parameter_is_four(self, world):
        w = world
        _set(w, "shop", w.shop.id, 7)
        parameter = w.db.query(TillParameter).filter(TillParameter.key == B.PARAMETER_KEY).one()
        parameter.is_active = False
        w.db.commit()
        assert B.end_hour_for(w.db, shop_id=w.shop.id) == 4


# ── Postgres computes the same day (the reports group in SQL) ──────────────────────


@pytest.fixture(scope="module")
def pg():
    import os

    from sqlalchemy import create_engine

    url = os.environ.get("DATABASE_URL", "")
    # Read-only SELECTs of literals, but still only against a scratch database.
    if not url.startswith("postgres") or not url.rsplit("/", 1)[-1].endswith("_test"):
        pytest.skip("needs a scratch Postgres DATABASE_URL (…_test)")
    engine = create_engine(url)
    try:
        engine.connect().close()
    except Exception:  # pragma: no cover - no server
        pytest.skip("Postgres is not reachable")
    yield engine
    engine.dispose()


@pytest.mark.parametrize("case", GOLDEN_DATA["days"], ids=lambda c: c["name"][:70])
def test_postgres_files_every_golden_moment_on_the_same_day(pg, case):
    from sqlalchemy import DateTime, literal, select
    from sqlalchemy.dialects.postgresql import UUID

    moment = literal(_at(case["at"]), DateTime(timezone=True))
    expected = date.fromisoformat(case["businessDay"])
    with pg.connect() as conn:
        assert conn.execute(select(B.EndHours(default=case["endHour"]).day_sql(moment, case["tz"]))).scalar() == expected
        # The per-till form (CASE machine_id …): a till on this hour among tills on another.
        till, other = uuid.uuid4(), uuid.uuid4()
        mixed = B.EndHours(default=(case["endHour"] + 5) % 13, by_machine={till: case["endHour"]})
        assert conn.execute(select(mixed.day_sql(moment, case["tz"], literal(till, UUID(as_uuid=True))))).scalar() == expected
        assert conn.execute(select(mixed.day_sql(moment, case["tz"], literal(other, UUID(as_uuid=True))))).scalar() == (
            B.business_day(_at(case["at"]), case["tz"], (case["endHour"] + 5) % 13)
        )


# ── The reports: a 01:00 sale is the evening before's ─────────────────────────────


class TestReportsOnTheBusinessDay:
    """
    `w` (tests/test_shop_areas.py): TODAY is 27.9.2026, NOW 21:00 local. A sale at 01:00 on 28.9
    (22:00 UTC on 27.9) belongs to business day 27.9; on the document's date it is 28.9's.
    """

    @pytest.fixture
    def night(self, w):
        from test_shop_areas import open_shift

        till = w.tills[0]
        shift = open_shift(w, till, 1)
        evening = w.doc(till, shift, "100.00")
        evening.created_at = datetime(2026, 9, 27, 18, 0, tzinfo=timezone.utc)  # 21:00 on 27.9
        late = w.doc(till, shift, "40.00")
        late.created_at = datetime(2026, 9, 27, 22, 0, tzinfo=timezone.utc)  # 01:00 on 28.9
        w.db.commit()
        return till

    def _cashiers(self, w, day, **extra):
        from test_shop_areas import _ctx

        from app.routers import reports as R

        args = dict(from_date=day, to_date=day, from_hour=None, to_hour=None, tz="Asia/Jerusalem",
                    shop_id=None, machine_id=None, area_id=None)
        args.update(extra)
        return R.get_cashier_sales_report(**args, **_ctx(w))

    def test_by_business_day_the_night_is_one_day(self, w, night):
        day = self._cashiers(w, date(2026, 9, 27))
        assert sum(r.net for r in day.rows) == 140.0
        assert day.window.day_basis == "business" and day.window.business_day_end_hour == 4
        assert self._cashiers(w, date(2026, 9, 28)).rows == []

    def test_by_document_date_the_01_sale_is_the_next_day(self, w, night):
        assert sum(r.net for r in self._cashiers(w, date(2026, 9, 27), day_basis="document").rows) == 100.0
        assert sum(r.net for r in self._cashiers(w, date(2026, 9, 28), day_basis="document").rows) == 40.0

    def test_the_shops_own_hour(self, w, night):
        w2 = w
        TP.ensure_builtin_parameters(w2.db)
        _set(w2, "shop", w2.shop.id, 0)  # this shop's days end at midnight
        day = self._cashiers(w2, date(2026, 9, 27), shop_id=w2.shop.id)
        assert sum(r.net for r in day.rows) == 100.0 and day.window.business_day_end_hour == 0

    def test_a_bad_basis_is_refused(self, w, night):
        from fastapi import HTTPException

        with pytest.raises(HTTPException) as e:
            self._cashiers(w, date(2026, 9, 27), day_basis="calendar")
        assert e.value.status_code == 400



# ── The cross-month line on the Z ───────────────────────────────────────────────


class TestCrossMonthZ:
    """A Z of the night of 30.9 holds documents of September and of October (by document date)."""

    @pytest.fixture
    def zw(self, monkeypatch):
        from shift_world import accept_str_uuids, make_world

        accept_str_uuids(monkeypatch)
        return make_world()

    def _z(self, w, docs):
        from app.models.shift import ShiftStatus
        from app.schemas.shift import ShiftCloseIn
        from app.services.shifts import apply_shift_close
        from app.services.z_builder import build_z
        from shift_world import NOW

        till = w.tills[0]
        shift = w.shift(till, 1, status=ShiftStatus.OPEN)
        for total, at, credit in docs:
            tx = w.doc(till, shift, total, credit_note=credit)
            tx.created_at = tx.document_production_date = at
        w.db.flush()
        apply_shift_close(w.db, till, shift.id, ShiftCloseIn.model_validate({"closedAt": NOW.isoformat()}))
        z = build_z(w.db, tenant_id=w.tenant.id, shop_id=w.shop.id, selections=[(till, shift.id)])
        w.db.commit()
        return z

    def test_the_z_shows_each_months_documents(self, zw):
        from zoneinfo import ZoneInfo

        from app.routers import z_reports as ZR
        from app.services import z_print

        z = self._z(zw, [
            ("120.00", datetime(2026, 9, 30, 19, 0, tzinfo=timezone.utc), False),  # 22:00 on 30.9
            ("45.00", datetime(2026, 9, 30, 21, 30, tzinfo=timezone.utc), False),  # 00:30 on 1.10
            ("10.00", datetime(2026, 9, 30, 22, 0, tzinfo=timezone.utc), True),  # a refund at 01:00 on 1.10
        ])
        months = [{"month": "2026-09", "total": "120.00"}, {"month": "2026-10", "total": "35.00"}]
        assert z.header["documentMonths"] == months
        # The months add up to the Z's own net.
        assert sum(Decimal(m["total"]) for m in months) == z.total_sales - z.total_refunds
        line = "מתוך ה-Z: ₪120.00 מסמכי ספטמבר · ₪35.00 מסמכי אוקטובר (לדיווח לפי תאריך המסמך)"
        assert z_print.build_print_document(z, ZoneInfo("Asia/Jerusalem"))["footer"][0] == line
        assert line in z_print.build_summary_document(z, ZoneInfo("Asia/Jerusalem"))["footer"]
        out = ZR.z_detail_out(zw.db, z)
        assert (out.document_months, out.document_months_source) == (months, "stored")

    def test_a_z_of_one_month_shows_nothing(self, zw):
        from zoneinfo import ZoneInfo

        from app.services import z_print

        z = self._z(zw, [("99.90", datetime(2026, 10, 1, 9, 0, tzinfo=timezone.utc), False)])
        assert z.header["documentMonths"] == [{"month": "2026-10", "total": "99.90"}]
        footer = z_print.build_print_document(z, ZoneInfo("Asia/Jerusalem"))["footer"]
        assert not any(f.startswith("מתוך ה-Z") for f in footer)

    def test_a_z_built_before_reads_its_documents(self, zw):
        from app.routers import z_reports as ZR

        z = self._z(zw, [
            ("100.00", datetime(2026, 12, 31, 20, 0, tzinfo=timezone.utc), False),
            ("50.00", datetime(2026, 12, 31, 22, 30, tzinfo=timezone.utc), False),
        ])
        z.header = {k: v for k, v in z.header.items() if k != "documentMonths"}
        zw.db.commit()
        out = ZR.z_detail_out(zw.db, z)
        assert out.document_months_source == "documents"
        assert out.document_months == [{"month": "2026-12", "total": "100.00"}, {"month": "2027-01", "total": "50.00"}]


class TestEveryManagementDayReadsTheParameter:
    def test_insights_clock(self, world):
        from app.services.insights import service as S

        _set(world, "shop", world.shop.id, 2)
        clock = S.make_clock(world.db, world.tenant.id, tz=None, day_start_hour=None, scope={"shop_id": world.shop.id})
        assert clock.day_start_hour == 2
        assert S.make_clock(world.db, world.tenant.id, tz=None, day_start_hour=None).day_start_hour == 4
        # The request's own hour still wins (the insights page's "dayStartHour").
        assert S.make_clock(world.db, world.tenant.id, tz=None, day_start_hour=6, scope={"shop_id": world.shop.id}).day_start_hour == 6
        one_am = datetime(2026, 9, 30, 22, 0, tzinfo=timezone.utc)
        assert clock.business_date(one_am) == date(2026, 9, 30)

    def test_targets_and_the_leaderboard(self, world):
        from app.services import sales_targets as T

        _set(world, "shop", world.shop.id, 0)
        assert T.shop_end_hour(world.db, world.shop.id) == 0
        one_am = datetime(2026, 9, 30, 22, 0, tzinfo=timezone.utc)
        assert T.business_today("Asia/Jerusalem", one_am, 0) == date(2026, 10, 1)
        assert T.business_today("Asia/Jerusalem", one_am) == date(2026, 9, 30)
        start, end = T.business_day_range(date(2026, 9, 30), "Asia/Jerusalem", 4)
        assert (start, end) == B.business_day_range(date(2026, 9, 30), date(2026, 9, 30), "Asia/Jerusalem", 4)

    def test_a_shift_sent_without_a_business_date(self, world):
        till = world.tills[0]
        one_am = datetime(2026, 9, 30, 22, 0, tzinfo=timezone.utc)
        assert B.machine_business_day(world.db, till, one_am) == date(2026, 9, 30)
        _set(world, "machine", till.id, 0)
        assert B.machine_business_day(world.db, till, one_am) == date(2026, 10, 1)
