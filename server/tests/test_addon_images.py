"""
"תוספת" and pictures on add-ons (11.10.2026; app/services/addon_role.py, app/services/menu.py).

What could look right and still be wrong:

* `addonRole` accepting a code the devices do not know, or a product without one read as anything
  but "none" (`ProductCreate` / `ProductUpdate` / the response, the till's catalog rows);
* a "תוספת בלבד" product on the digital menu / online (app/services/digital_effective.py) or sold as a
  kiosk line of its own (the basket check) — while it stays a linked product and a meal component;
* an option's picture on the till: its own, else its linked product's, else null (`imageUrl`);
* a note chip's picture lost when the chips are saved again (the rows are written afresh);
* the pictures' uploads not going through the product pipeline (type / size checks, the background
  cut out, the same storage) or not reaching the tills (the menu's change stamp);
* a publication made before these fields reading as "changed" in every review-mode shop;
* the migration not being idempotent;
* `motion.itemFlow` ("תהליך פריט"): "sheet" by default, an unknown value refused (422).
"""
from __future__ import annotations

import asyncio
import importlib.util
import io
import uuid
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace

import pytest
import sqlalchemy as sa
from fastapi import BackgroundTasks, HTTPException
from pydantic import ValidationError
from starlette.datastructures import Headers, UploadFile

from app.models.menu import MenuSyncState, ModifierOption, PrepNotePreset
from app.models.product import Product
from app.routers import images as images_router
from app.routers import menu as R
from app.schemas.menu import NotesIn
from app.schemas.product import ProductCreate, ProductResponse, ProductUpdate
from app.services import addon_role
from app.services import digital_effective as DE
from app.services import kiosk_config as KC
from app.services import menu as M
from app.services import menu_broadcast as MB

from test_digital_effective import _create, _drinks, _select, _view, dw  # noqa: F401
from test_menu import _run, addons_body, create_group, menu, pull, put_product  # noqa: F401
from test_product_availability import world  # noqa: F401
from test_shop_areas import _ctx, refused, w  # noqa: F401


# ── addonRole: the schema ─────────────────────────────────────────────────────


def _create_body(**over):
    return {"name": "צ'יפס", "price": "12", "categoryId": str(uuid.uuid4()), **over}


def test_addon_role_defaults_to_none_and_takes_the_three_codes():
    assert ProductCreate.model_validate(_create_body()).addon_role == "none"
    for code in ("none", "addon_only", "both"):
        assert ProductCreate.model_validate(_create_body(addonRole=code)).addon_role == code
    with pytest.raises(ValidationError):
        ProductCreate.model_validate(_create_body(addonRole="sometimes"))


def test_an_update_leaves_it_unless_sent_and_refuses_an_unknown_code():
    assert "addon_role" not in ProductUpdate.model_validate({"name": "x"}).model_dump(exclude_unset=True)
    # The column is NOT NULL: an explicit null is "leave it".
    assert "addon_role" not in ProductUpdate.model_validate({"addonRole": None}).model_dump(exclude_unset=True)
    assert ProductUpdate.model_validate({"addonRole": "both"}).model_dump(exclude_unset=True) == {"addon_role": "both"}
    with pytest.raises(ValidationError):
        ProductUpdate.model_validate({"addonRole": "ADDON"})


def test_the_response_reads_an_unknown_or_missing_code_as_none():
    assert addon_role.out(None) == "none" and addon_role.out("weird") == "none"
    assert addon_role.out("addon_only") == "addon_only"
    assert addon_role.is_addon_only({"addonRole": "addon_only"}) and not addon_role.is_addon_only({})
    fields = ProductResponse.model_fields["addon_role"]
    assert fields.alias == "addonRole" and fields.default == "none"


# ── addonRole: what the tills get ─────────────────────────────────────────────


def test_the_till_catalog_carries_addon_role(menu):
    menu.fries.addon_role = "addon_only"
    menu.cola.addon_role = "both"
    menu.db.commit()
    rows = {p["id"]: p for p in pull(menu, menu.tills[0]).products}
    assert rows[str(menu.fries.id)]["addonRole"] == "addon_only"
    assert rows[str(menu.cola.id)]["addonRole"] == "both"
    assert rows[str(menu.burger.id)]["addonRole"] == "none"


def test_an_addon_only_product_is_still_a_meal_component_and_a_linked_product(menu):
    menu.fries.addon_role = "addon_only"
    menu.db.commit()
    made = create_group(menu, addons_body(options=[{"name": "צ'יפס", "price": "6", "linkedProductId": str(menu.fries.id)}]))
    assert made["options"][0]["linkedProductId"] == str(menu.fries.id)
    block = pull(menu, menu.tills[0]).menu
    assert block["groups"][0]["options"][0]["linkedProductId"] == str(menu.fries.id)
    # The option keeps its own price, whatever the product costs.
    assert block["groups"][0]["options"][0]["price"] == 6.0


# ── addonRole: the cloud's own catalogs ───────────────────────────────────────


def test_addon_only_is_never_on_the_digital_menu(dw):  # noqa: F811
    p = _create(dw)
    _select(dw, p, _drinks(dw))
    before = _view(dw, p, mode="preview")["products"]
    assert {str(dw.P.id), str(dw.Q.id)} <= set(before)
    dw.Q.addon_role = "addon_only"
    dw.db.commit()
    after = _view(dw, p, mode="preview")["products"]
    assert str(dw.Q.id) not in after and str(dw.P.id) in after
    # "גם וגם" is sold on its own: it stays.
    dw.Q.addon_role = "both"
    dw.db.commit()
    assert str(dw.Q.id) in _view(dw, p, mode="preview")["products"]


def test_the_kiosk_basket_check_refuses_an_addon_only_line(monkeypatch):
    from app.services import kiosk_basket_check as K
    from app.services import machine_catalog
    from app.services import promotions as P
    from app.services import sync as SY

    row = {"id": "p1", "price": 6.0, "categoryId": "c1", "isAvailable": True, "inStock": True,
           "salesChannel": "all", "inMachineCatalog": True, "addonRole": "addon_only"}
    monkeypatch.setattr(K, "_products_by_id", lambda db, m: {"p1": row})
    monkeypatch.setattr(SY, "get_categories_for_sync", lambda *a, **k: [{"id": "c1", "isActive": True}])
    monkeypatch.setattr(machine_catalog, "mode_of", lambda m: "all")
    monkeypatch.setattr(P, "promotions_for_machine", lambda db, m: [])
    machine = SimpleNamespace(tenant_id=uuid.uuid4(), id=uuid.uuid4())
    out = K.check(None, machine, [{"productId": "p1", "unitPriceAgorot": 600}], None)
    assert out["lines"][0]["reason"] == "not_on_kiosk"
    row["addonRole"] = "both"
    assert K.check(None, machine, [{"productId": "p1", "unitPriceAgorot": 600}], None)["lines"][0]["available"]


# ── Pictures: what the tills get ──────────────────────────────────────────────


def test_an_options_picture_is_its_own_else_its_linked_products_else_null(menu):
    menu.fries.image_url = "https://img.example/fries.png"
    menu.cola.image_url = "https://img.example/cola.png"
    menu.db.commit()
    made = create_group(menu, addons_body(options=[
        {"name": "own", "price": "1", "imageUrl": "https://img.example/own.png"},
        {"name": "own beats linked", "price": "1", "imageUrl": "https://img.example/mine.png",
         "linkedProductId": str(menu.cola.id)},
        {"name": "linked", "price": "1", "linkedProductId": str(menu.fries.id)},
        {"name": "none", "price": "1"},
    ]))
    # The dashboard sees the option's own picture only.
    assert [o["imageUrl"] for o in made["options"]] == [
        "https://img.example/own.png", "https://img.example/mine.png", None, None,
    ]
    options = {o["name"]: o for o in pull(menu, menu.tills[0]).menu["groups"][0]["options"]}
    assert options["own"]["imageUrl"] == "https://img.example/own.png"
    assert options["own beats linked"]["imageUrl"] == "https://img.example/mine.png"
    assert options["linked"]["imageUrl"] == "https://img.example/fries.png"
    assert options["linked"]["linkedProductId"] == str(menu.fries.id)
    assert options["none"]["imageUrl"] is None


def test_saving_a_group_without_image_url_keeps_the_options_picture(menu):
    made = create_group(menu, addons_body(options=[{"name": "egg", "price": "4", "imageUrl": "https://img.example/egg.png"}]))
    oid = made["options"][0]["id"]
    tasks = BackgroundTasks()
    again = R.update_group(made["id"], addons_body(options=[{"id": oid, "name": "egg", "price": "5"}]), tasks, **_ctx(menu))
    assert again["options"][0]["imageUrl"] == "https://img.example/egg.png" and again["options"][0]["price"] == 5.0
    tasks = BackgroundTasks()
    cleared = R.update_group(made["id"], addons_body(options=[{"id": oid, "name": "egg", "imageUrl": None}]), tasks, **_ctx(menu))
    assert cleared["options"][0]["imageUrl"] is None
    with pytest.raises(ValidationError):
        addons_body(options=[{"name": "egg", "imageUrl": "javascript:alert(1)"}])


def test_a_note_chip_carries_its_picture_and_keeps_it_when_saved_again(menu):
    put_product(menu, menu.burger, {"notes": {"mode": "own", "notes": [
        {"text": "בלי בצל", "imageUrl": "https://img.example/onion.png"}, {"text": "חריף"},
    ]}})
    chips = pull(menu, menu.tills[0]).menu["notes"]["products"][str(menu.burger.id)]
    assert chips == [
        {"text": "בלי בצל", "important": False, "imageUrl": "https://img.example/onion.png"},
        {"text": "חריף", "important": False, "imageUrl": None},
    ]
    # The editor sends the chips back without the field: the picture stays with its text.
    put_product(menu, menu.burger, {"notes": {"mode": "own", "notes": [{"text": "חריף"}, {"text": "בלי בצל"}]}})
    out = M.notes_out(menu.db, menu.tenant.id, "product", menu.burger)
    assert [(n["text"], n["imageUrl"]) for n in out["notes"]] == [("חריף", None), ("בלי בצל", "https://img.example/onion.png")]
    # For every dish too.
    tasks = BackgroundTasks()
    R.put_global_notes(NotesIn.model_validate({"notes": [{"text": "אלרגיה", "imageUrl": "https://img.example/a.png"}]}),
                       tasks, **_ctx(menu))
    assert pull(menu, menu.tills[0]).menu["notes"]["all"][0]["imageUrl"] == "https://img.example/a.png"


# ── Pictures: the uploads ─────────────────────────────────────────────────────


@pytest.fixture
def pipeline(monkeypatch):
    """The product pipeline with its heavy parts stubbed: the cut-out and the storage."""
    calls = SimpleNamespace(processed=[], stored=[])

    def process(data, *, remove_background=True, enhance=False, max_side=None):
        calls.processed.append((data, remove_background, enhance))
        return SimpleNamespace(png=b"CUT:" + data, background_removed=remove_background, enhanced=enhance)

    def store(contents, folder, *, public_id=None, fmt=None, limit=None):
        pid = public_id or f"{folder}/{len(calls.stored)}"
        calls.stored.append((contents, folder, pid, fmt))
        return {"secure_url": f"https://media.example/{pid}.{fmt or 'jpg'}", "public_id": pid}

    monkeypatch.setattr(images_router, "cloudinary_configured", lambda: False)
    monkeypatch.setattr(images_router, "process_product_image", process)
    monkeypatch.setattr(images_router.local_media, "store", store)
    monkeypatch.setattr(images_router, "get_settings", lambda: SimpleNamespace(product_image_bg_removal=True))
    return calls


def _file(data=b"\x89PNG-bytes", content_type="image/png"):
    return UploadFile(file=io.BytesIO(data), filename="x.png", headers=Headers({"content-type": content_type}))


def _stamp(w):
    row = w.db.query(MenuSyncState).filter(MenuSyncState.tenant_id == w.tenant.id).first()
    return row.changed_at if row is not None else None


def test_an_option_picture_upload_cuts_the_background_and_reaches_the_tills(menu, pipeline):
    made = create_group(menu, addons_body())
    oid = made["options"][0]["id"]
    before = _stamp(menu)
    tasks = BackgroundTasks()
    out = asyncio.run(R.upload_option_image(oid, tasks, file=_file(), keep_background=False, **_ctx(menu)))
    assert pipeline.processed == [(b"\x89PNG-bytes", True, False)]
    stored_png = pipeline.stored[0]
    assert stored_png[0] == b"CUT:\x89PNG-bytes" and stored_png[3] == "png" and "/products" in stored_png[1]
    assert out["backgroundRemoved"] is True and out["processed"] is True and out["originalUrl"]
    assert out["option"]["imageUrl"] == out["url"]
    assert menu.db.get(ModifierOption, uuid.UUID(oid)).image_url == out["url"]
    assert _stamp(menu) is not None and (before is None or _stamp(menu) >= before)
    synced = pull(menu, menu.tills[0]).menu["groups"][0]["options"][0]
    assert synced["imageUrl"] == out["url"]
    # Removed: the linked product's picture (none here) — null.
    R.delete_option_image(oid, BackgroundTasks(), **_ctx(menu))
    assert pull(menu, menu.tills[0]).menu["groups"][0]["options"][0]["imageUrl"] is None


def test_keep_background_stores_the_upload_as_it_came(menu, pipeline):
    made = create_group(menu, addons_body())
    out = asyncio.run(R.upload_option_image(made["options"][1]["id"], BackgroundTasks(), file=_file(b"JPEG", "image/jpeg"),
                                            keep_background=True, **_ctx(menu)))
    assert pipeline.processed == [] and pipeline.stored[0][0] == b"JPEG"
    assert out["backgroundRemoved"] is False


def test_the_uploads_refuse_what_a_product_upload_refuses(menu, pipeline):
    made = create_group(menu, addons_body())
    oid = made["options"][0]["id"]
    with pytest.raises(HTTPException) as e:
        asyncio.run(R.upload_option_image(oid, BackgroundTasks(), file=_file(b"x", "application/pdf"),
                                          keep_background=False, **_ctx(menu)))
    assert e.value.status_code == 415
    with pytest.raises(HTTPException) as e:
        asyncio.run(R.upload_option_image(oid, BackgroundTasks(), file=_file(b"x" * (5 * 1024 * 1024 + 1)),
                                          keep_background=False, **_ctx(menu)))
    assert e.value.status_code == 413
    with pytest.raises(HTTPException) as e:
        asyncio.run(R.upload_option_image(str(uuid.uuid4()), BackgroundTasks(), file=_file(),
                                          keep_background=False, **_ctx(menu)))
    assert e.value.status_code == 404
    assert pipeline.stored == []


def test_a_note_picture_upload(menu, pipeline):
    put_product(menu, menu.burger, {"notes": {"mode": "own", "notes": [{"text": "בלי בצל"}]}})
    note = menu.db.query(PrepNotePreset).filter(PrepNotePreset.target_id == menu.burger.id).one()
    out = asyncio.run(R.upload_note_image(str(note.id), BackgroundTasks(), file=_file(), keep_background=False, **_ctx(menu)))
    assert pipeline.processed and out["note"]["imageUrl"] == out["url"]
    chip = pull(menu, menu.tills[0]).menu["notes"]["products"][str(menu.burger.id)][0]
    assert chip == {"text": "בלי בצל", "important": False, "imageUrl": out["url"]}
    R.delete_note_image(str(note.id), BackgroundTasks(), **_ctx(menu))
    assert pull(menu, menu.tills[0]).menu["notes"]["products"][str(menu.burger.id)][0]["imageUrl"] is None
    assert refused(R.delete_note_image, str(uuid.uuid4()), BackgroundTasks(), **_ctx(menu)).status_code == 404


# ── The review before broadcast: a publication from before these fields ───────


def test_a_publication_without_the_new_fields_is_the_same_content():
    old = {
        "products": {"p": {"name": "fries", "price": 12}},
        "menu": {
            "groups": [{"id": "g", "name": "תוספות", "options": [{"id": "o", "name": "cheese", "price": 5}]}],
            "notes": {"all": [{"text": "חריף", "important": False}], "categories": {}, "products": {"p": [{"text": "x", "important": True}]}},
        },
    }
    new = {
        "products": {"p": {"name": "fries", "price": 12, "addonRole": "none"}},
        "menu": {
            "groups": [{"id": "g", "name": "תוספות", "options": [{"id": "o", "name": "cheese", "price": 5, "imageUrl": None}]}],
            "notes": {"all": [{"text": "חריף", "important": False, "imageUrl": None}], "categories": {},
                      "products": {"p": [{"text": "x", "important": True, "imageUrl": None}]}},
        },
    }
    assert MB.fingerprint(old) == MB.fingerprint(new)
    assert all(not items for items in MB.diff(old, new).values())
    # A real change is one.
    new["products"]["p"]["addonRole"] = "addon_only"
    new["menu"]["groups"][0]["options"][0]["imageUrl"] = "https://img.example/c.png"
    assert MB.fingerprint(old) != MB.fingerprint(new)
    sections = MB.diff(old, new)
    assert [c["field"] for c in sections["products"][0]["changes"]] == ["addonRole"]
    assert [c["field"] for c in sections["modifiers"][0]["changes"]] == ["option.imageUrl"]


# ── The migration ─────────────────────────────────────────────────────────────


def _migration():
    path = Path(__file__).parent.parent / "alembic" / "versions" / "b5e2c8a417d3_addon_role_and_option_images.py"
    spec = importlib.util.spec_from_file_location("addon_images_migration", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _upgrade(engine):
    from alembic.migration import MigrationContext
    from alembic.operations import Operations

    module = _migration()
    with engine.begin() as conn:
        with Operations.context(MigrationContext.configure(conn)):
            module.upgrade()


def test_the_migration_adds_the_columns_once():
    engine = sa.create_engine("sqlite://")
    with engine.begin() as conn:
        conn.execute(sa.text("CREATE TABLE products (id TEXT PRIMARY KEY, name TEXT)"))
        conn.execute(sa.text("CREATE TABLE modifier_options (id TEXT PRIMARY KEY, name TEXT)"))
        conn.execute(sa.text("CREATE TABLE prep_note_presets (id TEXT PRIMARY KEY, text TEXT)"))
        conn.execute(sa.text("INSERT INTO products (id, name) VALUES ('a', 'old')"))
    _upgrade(engine)
    _upgrade(engine)  # idempotent: a second run changes nothing
    insp = sa.inspect(engine)
    assert "addon_role" in {c["name"] for c in insp.get_columns("products")}
    assert "image_url" in {c["name"] for c in insp.get_columns("modifier_options")}
    assert "image_url" in {c["name"] for c in insp.get_columns("prep_note_presets")}
    with engine.connect() as conn:
        assert conn.execute(sa.text("SELECT addon_role FROM products")).scalar() == "none"
    module = _migration()
    assert (module.revision, module.down_revision) == ("b5e2c8a417d3", "7c3a9d2e5b14")


# ── Kiosk: "תהליך פריט עם תוספות והערות" (motion.itemFlow) ─────────────────────


def test_item_flow_defaults_to_one_sheet_and_takes_pages():
    assert KC.default_config()["motion"]["itemFlow"] == "sheet"
    assert KC.MOTION_ITEM_FLOWS == ("sheet", "pages")
    cleaned, errors = KC.validate_layer({"motion": {"itemFlow": "pages"}})
    assert errors == [] and cleaned == {"motion": {"itemFlow": "pages"}}
    assert KC.resolve({"motion": {"itemFlow": "pages"}})["motion"]["itemFlow"] == "pages"
    # A config stored before the field reads as one sheet.
    assert KC.resolve({"motion": {"speed": "fast"}})["motion"]["itemFlow"] == "sheet"


def test_an_unknown_item_flow_is_refused():
    _cleaned, errors = KC.validate_layer({"motion": {"itemFlow": "carousel"}})
    assert errors and errors[0].to_wire()["path"] == "motion.itemFlow"
