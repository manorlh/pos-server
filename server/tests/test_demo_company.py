"""
"בניית חברת הדגמה" (P:/specs/demo-company.md, app/services/demo_company.py, app/routers/demo_company.py).

* One click builds the whole live company once: the company with its business details and the stand-in
  logo, the two shops out of training mode with their work profiles, the restaurant's four points of
  sale, its maps and 30 tables, both demo menus (the new "מזנון" template among them), the area menus,
  the kitchen, the employees, the kiosk, the customer display, a till design per shop, the digital
  menu, three voucher batches, the club, and a live pairing code for each of the eight devices.
* A second click makes nothing new, and what the owner changed or deleted since stays as he left it;
  an expired code is replaced, a paired device is not given another; what waits for a paired device
  (the voucher station's mode) is done on the click after it pairs.
* The super admin's only (403); two builds at once: 409.
* The "מזנון" template holds together (names unique across the catalogue, every group and meal resolves).
* The employees' codes appear in no answer.

The build runs on a real Postgres — the scratch database in DATABASE_URL (its name must end in
"_scratch" or "_test"), inside one transaction that is rolled back at the end, so nothing is kept.
The template's checks need no database.
"""
from __future__ import annotations

import importlib.util
import io
import json
import os
import pathlib
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import BackgroundTasks, HTTPException

from app.services import demo_company_images as IMG
from app.services import demo_menu as DM
from app.services import demo_menu_templates as T

URL = os.environ.get("DATABASE_URL", "")
_DB_NAME = URL.rsplit("/", 1)[-1].split("?", 1)[0]
needs_pg = pytest.mark.skipif(
    not URL.startswith("postgresql") or not _DB_NAME.endswith(("_scratch", "_test")),
    reason="needs a scratch Postgres DATABASE_URL (its name ending in _scratch or _test)",
)


# ── The "מזנון" template (no database) ────────────────────────────────────────


def test_the_snack_bar_template_holds_together():
    names = [n for _c, _color, items in T.CATEGORIES for n, _p in items]
    assert len(names) == len(set(names)), "a product name is a key: unique across the catalogue"
    categories = [c for c, _color, _items in T.CATEGORIES]
    assert len(categories) == len(set(categories))
    p = DM.plan("snack_bar")
    assert [c for c, _color, _items in p["categories"]] == [
        "פלאפל ושווארמה", "טוסטים וכריכים", "צ׳יפס ותוספות", "שתייה קלה וקפה", "ארוחות קומבו",
    ]
    products = {n for _c, _color, items in p["categories"] for n, _p in items}
    # Falafel and shawarma in a pita, a laffa, a baguette and on a plate.
    for dish in ("פלאפל", "שווארמה"):
        assert {f"{dish} בפיתה", f"{dish} בלאפה", f"{dish} בבאגט", f"מנת {dish}"} <= products
    # Every meal names products of the template, each slot valid.
    assert set(p["meals"]) == {"קומבו פלאפל", "קומבו שווארמה", "קומבו טוסט"}
    for meal, slots in p["meals"].items():
        assert meal in products and len(slots) == len(T.MEALS[meal])
        assert all(o[0] in products for s in slots for o in s["options"])
    # The salads and the sauces are free, the extras are paid.
    groups = p["groups"]
    assert {"snack_salads", "snack_sauces", "snack_paid"} <= set(groups)
    assert all(float(o["price"]) == 0 for g in ("snack_salads", "snack_sauces") for o in groups[g]["options"])
    paid = {o["name"]: float(o["price"]) for o in groups["snack_paid"]["options"]}
    assert paid["ביצה קשה"] > 0 and paid["גבינה צהובה"] > 0
    assert all(g["categories"] or g.get("kind") for g in groups.values())
    # Israeli snack-bar prices: a falafel under a shawarma, a combo cheaper than its parts.
    prices = {n: price for _c, _color, items in p["categories"] for n, price in items}
    assert 10 <= prices["פלאפל בפיתה"] < prices["שווארמה בפיתה"] <= 60
    assert prices["קומבו פלאפל"] < prices["פלאפל בפיתה"] + prices["צ׳יפס קטן"] + prices["פחית קולה"]
    assert [u["name"] for u in p["upsells"]] == ["צ׳יפס ליד המנה"]


def test_the_other_templates_are_unchanged_by_the_snack_bar():
    counts = {t["key"]: t["counts"] for t in DM.templates_out()["templates"]}
    assert counts["restaurant_bar"] == {
        "categories": 14, "products": 76, "groups": 22, "meals": 4, "upsells": 2, "notes": 6, "courses": 3,
    }
    assert counts["snack_bar"]["products"] == 30 and counts["snack_bar"]["meals"] == 3


def test_the_stand_in_pictures_are_pngs_the_uploads_take():
    from app.services.image_validation import read_image_dimensions

    assert read_image_dimensions(IMG.logo_png()) == (512, 512)
    assert read_image_dimensions(IMG.receipt_logo_png()) == (384, 160)
    assert read_image_dimensions(IMG.banner_png("R2M Demo", "x", "#EA580C", (1080, 1920))) == (1080, 1920)
    assert read_image_dimensions(IMG.tile_png("#D97706")) == (800, 600)


ROOT = pathlib.Path(__file__).absolute().parents[1]


def _migration():
    path = ROOT / "alembic" / "versions" / "d3f8a6c2b9e1_demo_company_items.py"
    spec = importlib.util.spec_from_file_location("migration_d3f8a6c2b9e1", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_the_migration_is_idempotent_and_renders_offline():
    import sqlalchemy as sa
    from alembic.operations import Operations
    from alembic.runtime.migration import MigrationContext

    from app.models.demo_company import DemoCompanyItem

    module = _migration()
    assert (module.revision, module.down_revision) == ("d3f8a6c2b9e1", "c7e4a2f9d1b6")
    engine = sa.create_engine("sqlite://")
    with engine.begin() as conn:
        for t in ("tenants", "companies"):
            conn.execute(sa.text(f"CREATE TABLE {t} (id CHAR(32) PRIMARY KEY)"))
        with Operations.context(MigrationContext.configure(conn)):
            module.upgrade()
            module.upgrade()  # idempotent
        insp = sa.inspect(conn)
        cols = {c["name"] for c in insp.get_columns("demo_company_items")}
        assert {c.name for c in DemoCompanyItem.__table__.columns} == cols
        assert "ix_demo_company_items_company" in {i["name"] for i in insp.get_indexes("demo_company_items")}
    # The table the API's create_all made first: only the missing index is added.
    engine = sa.create_engine("sqlite://")
    with engine.begin() as conn:
        for t in ("tenants", "companies"):
            conn.execute(sa.text(f"CREATE TABLE {t} (id CHAR(32) PRIMARY KEY)"))
        DemoCompanyItem.__table__.create(conn)
        with Operations.context(MigrationContext.configure(conn)):
            module.upgrade()
    buf = io.StringIO()
    offline = MigrationContext.configure(dialect_name="postgresql", opts={"as_sql": True, "output_buffer": buf})
    with Operations.context(offline):
        module.upgrade()
        module.downgrade()
    sql = buf.getvalue()
    assert "CREATE TABLE demo_company_items" in sql and "uq_demo_company_items_tenant_key" in sql


def test_the_migration_is_the_single_head():
    from alembic.config import Config
    from alembic.script import ScriptDirectory

    script = ScriptDirectory.from_config(Config(str(ROOT / "alembic.ini")))
    heads = script.get_heads()
    assert len(heads) == 1
    assert "d3f8a6c2b9e1" in {r.revision for r in script.iterate_revisions(heads[0], "base")}


#: Made-up codes for the test's own server configuration.
TEST_CODES = {"manager": "70531", "cashier": "70642", "waiter": "70753"}
TEST_CODES_SETTING = ",".join(f"{k}={v}" for k, v in TEST_CODES.items())


def test_the_employees_codes_are_configured_or_random_never_in_the_code(monkeypatch):
    from app.config import get_settings
    from app.services import demo_company as DC

    monkeypatch.setattr(get_settings(), "demo_company_pos_codes", "")
    codes, configured = DC.employee_codes()
    assert set(codes) == {"manager", "cashier", "waiter"} and not any(configured.values())
    assert all(c.isdigit() and len(c) == 4 and c != "1234" for c in codes.values())
    assert len(set(codes.values())) == 3
    # One role configured (spaces, ":" and ";" tolerated); a bad value is not taken.
    monkeypatch.setattr(get_settings(), "demo_company_pos_codes", " manager : 70531 ; cashier=12a4 ")
    codes, configured = DC.employee_codes()
    assert codes["manager"] == "70531" and configured == {"manager": True, "cashier": False, "waiter": False}
    assert codes["cashier"].isdigit()
    # No code in the module's source.
    source = (ROOT / "app" / "services" / "demo_company.py").read_text(encoding="utf-8")
    assert "70531" not in source


def test_the_route_is_the_super_admins_on_the_dashboard_map():
    from app.services import dashboard_sections as DS

    assert DS.rule_for("POST", "/demo-company/build").kind == "super_admin"
    assert DS.rule_for("GET", "/demo-company").kind == "super_admin"


# ── The build, on the scratch Postgres ────────────────────────────────────────


def _add_missing_columns(conn) -> None:
    """A scratch database made by an older `create_all`: the newer columns, inside the rolled-back transaction."""
    from sqlalchemy import inspect, text

    from app.database import Base

    insp = inspect(conn)
    tables = set(insp.get_table_names())
    for name, table in Base.metadata.tables.items():
        if name not in tables:
            continue
        have = {c["name"] for c in insp.get_columns(name)}
        for col in table.columns:
            if col.name in have:
                continue
            ddl = f'ALTER TABLE "{name}" ADD COLUMN "{col.name}" {col.type.compile(dialect=conn.dialect)}'
            arg = col.server_default.arg if col.server_default is not None else None
            if arg is not None:
                # A plain string default is a quoted literal (as SQLAlchemy renders it); else its SQL.
                ddl += f" DEFAULT '{arg}'" if isinstance(arg, str) else f" DEFAULT {arg.compile(dialect=conn.dialect)}"
            conn.execute(text(ddl))


@pytest.fixture
def pg(monkeypatch, tmp_path):
    from sqlalchemy import create_engine
    from sqlalchemy.orm import Session

    import app.models  # noqa: F401
    from app.database import Base
    from app.models.tenant import Tenant
    from app.models.user import User, UserRole
    from app.routers import images as images_router
    from app.services import ably_notify, cloudinary_service, local_media

    # Nothing leaves this machine: no Ably, no Cloudinary; uploads land in a temporary folder.
    monkeypatch.setattr(ably_notify, "_rest", lambda: None)
    # The employees' codes as a server would configure them (made up here, for the test only).
    from app.config import get_settings

    monkeypatch.setattr(get_settings(), "demo_company_pos_codes", TEST_CODES_SETTING)
    monkeypatch.setattr(cloudinary_service, "cloudinary_configured", lambda: False)
    monkeypatch.setattr(images_router, "cloudinary_configured", lambda: False)
    monkeypatch.setattr(local_media, "MEDIA_DIR", tmp_path)

    # A database that does not answer fails the test in seconds instead of hanging it.
    engine = create_engine(URL, connect_args={"connect_timeout": 10})
    conn = engine.connect()
    outer = conn.begin()
    db = Session(bind=conn, join_transaction_mode="create_savepoint")
    try:
        _add_missing_columns(conn)
        Base.metadata.create_all(conn)
        tag = uuid.uuid4().hex[:10]
        tenant = Tenant(id=uuid.uuid4(), name=f"Demo {tag}", slug=f"demo-{tag}", timezone="Asia/Jerusalem")
        db.add(tenant)
        db.flush()
        admin = User(id=uuid.uuid4(), role=UserRole.SUPER_ADMIN, tenant_id=tenant.id, email=f"sa-{tag}@example.test",
                     username=f"sa-{tag}")
        manager = User(id=uuid.uuid4(), role=UserRole.DISTRIBUTOR, tenant_id=tenant.id,
                       email=f"dist-{tag}@example.test", username=f"dist-{tag}")
        db.add_all([admin, manager])
        db.commit()

        class World:
            pass

        w = World()
        w.db, w.tenant, w.admin, w.other = db, tenant, admin, manager
        yield w
    finally:
        db.close()
        outer.rollback()
        conn.close()
        engine.dispose()


def _build(w, user=None, **details):
    from app.routers import demo_company as R

    return R.build_demo_company(
        BackgroundTasks(), R.DemoCompanyBuildIn.model_validate(details) if details else None,
        current_user=user or w.admin, active_tenant_id=w.tenant.id, db=w.db,
    )


def _items(w):
    from app.models.demo_company import DemoCompanyItem

    return w.db.query(DemoCompanyItem).filter(DemoCompanyItem.tenant_id == w.tenant.id).all()


def _counts(w):
    """Rows per table that the build writes, in this organization (the world's own)."""
    from app.models.catalog_menu import CatalogMenu
    from app.models.category import Category
    from app.models.company import Company
    from app.models.pairing_code import PairingCode
    from app.models.pos_user import PosUser
    from app.models.prepaid_voucher import PrepaidVoucherBatch
    from app.models.printers import KitchenPrinter
    from app.models.product import Product
    from app.models.shop import Shop
    from app.models.shop_area import ShopArea
    from app.models.tables import DiningTable, TableZone

    db, tid = w.db, w.tenant.id
    return {
        "companies": db.query(Company).filter(Company.tenant_id == tid).count(),
        "shops": db.query(Shop).filter(Shop.tenant_id == tid).count(),
        "areas": db.query(ShopArea).filter(ShopArea.tenant_id == tid).count(),
        "zones": db.query(TableZone).filter(TableZone.tenant_id == tid).count(),
        "tables": db.query(DiningTable).join(Shop, Shop.id == DiningTable.shop_id).filter(Shop.tenant_id == tid).count(),
        "categories": db.query(Category).filter(Category.tenant_id == tid).count(),
        "products": db.query(Product).filter(Product.tenant_id == tid).count(),
        "menus": db.query(CatalogMenu).filter(CatalogMenu.tenant_id == tid).count(),
        "printers": db.query(KitchenPrinter).filter(KitchenPrinter.tenant_id == tid).count(),
        "pos_users": db.query(PosUser).filter(PosUser.tenant_id == tid).count(),
        "batches": db.query(PrepaidVoucherBatch).filter(PrepaidVoucherBatch.tenant_id == tid).count(),
        "codes": db.query(PairingCode).filter(PairingCode.tenant_id == tid).count(),
    }


@needs_pg
def test_one_click_builds_the_whole_live_company(pg):
    from app.models.company import Company
    from app.models.shop import Shop
    from app.models.shop_area import ShopArea
    from app.services import customer_display as CD
    from app.services import work_profile as WP

    w = pg
    out = _build(w, vatNumber="515151515", address="הרצל 1", city="תל אביב", phone="03-5555555")
    assert out["failed"] == [], out["failed"]
    assert out["exists"] is True
    company = w.db.get(Company, uuid.UUID(out["company"]["id"]))
    assert company.name == "R2M הדגמה" and company.vat_number == "515151515" and company.address == "הרצל 1"
    assert out["company"]["phone"] == "03-5555555" and out["missingDetails"] == []
    # The phone reaches the receipt header the till prints.
    from app.services.settings_merge import build_business_info

    assert build_business_info(company).phone == "03-5555555"
    # The stand-in logo is the company's, for the receipt and the screens.
    assert company.settings["brandLogoUrl"].endswith(".png") and company.settings["brandReceiptLogoUrl"]

    shops = {s["key"]: s for s in out["shops"]}
    snack = w.db.get(Shop, uuid.UUID(shops["snack"]["id"]))
    rest = w.db.get(Shop, uuid.UUID(shops["restaurant"]["id"]))
    assert (snack.name, rest.name) == ("מזנון", "מסעדה")
    # Live: not training mode, numbered shops with branch codes.
    assert snack.training_mode is False and rest.training_mode is False
    assert {snack.branch_id, rest.branch_id} == {"1", "2"} and snack.shop_number and rest.shop_number
    # The work profiles.
    assert WP.stored_profile(snack)["templateId"] == "quick_counter"
    assert WP.stored_profile(snack)["customerDisplay"] is True
    rp = WP.stored_profile(rest)
    assert rp["templateId"] == "restaurant_tables" and rp["attendance"] is True and rp["tips"]["enabled"] is True
    # The kitchen to printers and a KDS (printers alone where the organization's workflow needs a
    # paired KDS station first — the summary then says so).
    assert rp["kitchen"] in ("both", "printer")
    assert (rp["kitchen"] == "both") == (not out["notes"])
    # The restaurant's points of sale, their maps and tables.
    areas = {a.name for a in w.db.query(ShopArea).filter(ShopArea.shop_id == rest.id)}
    assert areas == {"אולם", "מרפסת", "בר", "טייק אווי"}
    counts = _counts(w)
    assert counts["zones"] == 3 and counts["tables"] == 30
    assert counts["companies"] == 1 and counts["shops"] == 2
    # Both menus (76 + 30 products, and the company's general item), two area menus, the kitchen.
    assert counts["products"] == 76 + 30 + 1
    assert counts["menus"] == 2 and counts["printers"] == 4
    # Employees: the default user of each shop + 2 + 3.
    assert counts["pos_users"] == 2 + 5
    assert counts["batches"] == 3
    # The customer display's ad.
    layer = CD.layer_of(snack.settings)
    assert layer["enabled"] is True and layer["playlist"][0]["kind"] == "image"
    # The kiosk's look, a till design per shop, the published digital menu.
    from app.models.kiosk import KioskSettings
    from app.models.presentation_profile import PresentationProfile
    from app.models.till_design import TillDesignSettings

    kiosk = w.db.query(KioskSettings).filter(KioskSettings.shop_id == snack.id).one().overrides
    assert kiosk["theme"]["logo"]["url"] and len(kiosk["catalog"]["categoryImages"]) == 5
    assert kiosk["attract"]["playlist"][0]["media"]["kind"] == "image"
    designs = {
        d.shop_id: d.overrides["template"]
        for d in w.db.query(TillDesignSettings).filter(TillDesignSettings.shop_id.in_([snack.id, rest.id]))
    }
    assert designs == {snack.id: "fast", rest.id: "seated"}
    menu = w.db.query(PresentationProfile).filter(PresentationProfile.shop_id == rest.id).one()
    assert menu.kind == "menu" and menu.status == "published" and out["digitalMenuSlug"] == menu.slug
    # The devices' codes carry their role: the main till its plan, the KDS its kitchen station.
    from app.models.pairing_code import PairingCode

    codes = {c.machine_name or c.device_role: c for c in w.db.query(PairingCode).filter(PairingCode.tenant_id == w.tenant.id)}
    assert codes["קופה ראשית (שרת מקומי)"].work_config == {"preset": "main_till", "enableLocalNetwork": True}
    assert codes["kds"].kds_options["screenRole"] == "station" and codes["kds"].kds_options["stationIds"]
    assert codes["kiosk"].device_role == "kiosk" and codes["customer_display"].device_role == "customer_display"
    # Eight devices, each with a live code.
    devices = [d for s in out["shops"] for d in s["devices"]]
    assert len(devices) == 8 and all(d["status"] == "waiting" and d["code"] for d in devices)
    assert counts["codes"] == 8
    assert all(s["checklist"] for s in out["shops"])
    # The employees sign in with the server's configured codes; no code is in any answer.
    from app.models.pos_user import PosUser
    from app.services.auth import verify_password

    staff = {(u.shop_id, u.username): u for u in w.db.query(PosUser).filter(PosUser.tenant_id == w.tenant.id)}
    assert verify_password(TEST_CODES["waiter"], staff[(rest.id, "waiter")].pin_hash)
    assert verify_password(TEST_CODES["manager"], staff[(snack.id, "manager")].pin_hash)
    assert out["employeesToSetCode"] == []
    text = json.dumps(out, ensure_ascii=False, default=str)
    assert not any(code in text for code in TEST_CODES.values())


@needs_pg
def test_a_second_click_makes_nothing_new(pg):
    w = pg
    first = _build(w)
    assert first["failed"] == [], first["failed"]
    before = _counts(w)
    rows = len(_items(w))
    second = _build(w)
    assert second["failed"] == [] and second["created"] == []
    after = _counts(w)
    # The codes are still live: none replaced, nothing else made.
    assert after == before
    assert len(_items(w)) == rows
    assert [d["code"] for s in second["shops"] for d in s["devices"]] == [
        d["code"] for s in first["shops"] for d in s["devices"]
    ]


@needs_pg
def test_what_the_owner_changed_or_deleted_survives_a_second_click(pg):
    from app.models.company import Company
    from app.models.pairing_code import PairingCode
    from app.models.product import Product
    from app.models.shop import Shop
    from app.models.tables import DiningTable

    w = pg
    out = _build(w, vatNumber="515151515")
    db = w.db
    company = db.get(Company, uuid.UUID(out["company"]["id"]))
    rest = db.get(Shop, uuid.UUID(next(s["id"] for s in out["shops"] if s["key"] == "restaurant")))
    # The owner renames the company, changes a price, deletes a table and changes the VAT number.
    company.name = "המסעדה של רן"
    company.vat_number = "999999999"
    burger = db.query(Product).filter(Product.tenant_id == w.tenant.id, Product.name == "המבורגר קלאסי").one()
    burger.price = 70
    table = db.query(DiningTable).filter(DiningTable.shop_id == rest.id, DiningTable.number == 5).one()
    table.archived_at = datetime.now(timezone.utc)
    db.commit()
    # A code expired.
    code = db.query(PairingCode).filter(PairingCode.tenant_id == w.tenant.id).first()
    code.expires_at = datetime.now(timezone.utc) - timedelta(minutes=1)
    db.commit()
    expired = code.code

    again = _build(w, vatNumber="123456782", address="רחוב חדש 5")
    assert again["failed"] == [], again["failed"]
    db.refresh(company)
    assert company.name == "המסעדה של רן" and company.vat_number == "999999999"
    # A detail the company lacked is filled; one it had is not overwritten.
    assert company.address == "רחוב חדש 5"
    assert float(db.query(Product).filter(Product.id == burger.id).one().price) == 70
    assert db.query(DiningTable).filter(DiningTable.shop_id == rest.id, DiningTable.number == 5,
                                        DiningTable.archived_at.is_(None)).count() == 0
    assert {r["label"] for r in again["removedByOwner"]} >= {"אולם — 5"}
    # Only the expired code was replaced.
    codes = [d["code"] for s in again["shops"] for d in s["devices"]]
    assert expired not in codes and all(codes)
    assert db.query(PairingCode).filter(PairingCode.tenant_id == w.tenant.id).count() == 9


@needs_pg
def test_a_paired_voucher_station_becomes_one_on_the_next_click(pg):
    from app.models.demo_company import DemoCompanyItem
    from app.models.pairing_code import PairingCode
    from app.models.pos_machine import POSMachine
    from app.services.pairing import validate_pairing_code

    w = pg
    _build(w)
    db = w.db
    row = db.query(DemoCompanyItem).filter(DemoCompanyItem.tenant_id == w.tenant.id,
                                           DemoCompanyItem.item_key == "device:snack:voucher_station").one()
    code = db.get(PairingCode, row.entity_id)
    machine = validate_pairing_code(db, code.code, {"model": "N55F", "serial": "VS-1"})
    assert machine is not None
    out = _build(w)
    assert out["failed"] == [], out["failed"]
    station = next(d for s in out["shops"] for d in s["devices"] if d["key"] == "voucher_station")
    assert station["status"] == "paired" and station["code"] is None
    db.refresh(machine)
    assert (machine.settings or {}).get("voucherStation") == "on"
    # The shop's other tills sell as usual.
    snack = db.get(POSMachine, machine.id).shop
    assert (snack.settings or {}).get("voucherStation") in (None, "off")
    # No second code for a paired device.
    assert db.query(PairingCode).filter(PairingCode.tenant_id == w.tenant.id).count() == 8


@needs_pg
def test_only_the_super_admin_builds_it(pg):
    from app.routers import demo_company as R

    w = pg
    with pytest.raises(HTTPException) as refused:
        _build(w, user=w.other)
    assert refused.value.status_code == 403
    with pytest.raises(HTTPException) as refused:
        R.get_demo_company(current_user=w.other, active_tenant_id=w.tenant.id, db=w.db)
    assert refused.value.status_code == 403
    assert _counts(w)["companies"] == 0


@needs_pg
def test_two_builds_at_once_are_refused(pg):
    from app.services import demo_company as DC

    w = pg
    DC._acquire(w.db, w.tenant.id, w.admin)
    with pytest.raises(HTTPException) as refused:
        _build(w)
    assert refused.value.status_code == 409
    assert refused.value.detail["code"] == DC.BUILD_IN_PROGRESS
    DC._release(w.db, w.tenant.id)


@needs_pg
def test_before_the_first_build_the_summary_says_so(pg):
    from app.routers import demo_company as R

    w = pg
    out = R.get_demo_company(current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
    assert out["exists"] is False and out["companyName"] == "R2M הדגמה"
