"""
The receipt logo as a till parameter (`receiptLogoUrl`, "לוגו בקבלה").

A built-in string parameter the dashboard edits with an image picker (`widget: "image"`),
uploaded through the branding upload for kind `receipt`. Resolved per till like every
parameter: till, then area, then shop, then company; no default, so a till with no value
keeps printing the branding receipt logo.
"""
from __future__ import annotations

import asyncio
import io
import uuid
from unittest.mock import MagicMock, patch

import pytest
from fastapi import BackgroundTasks, HTTPException, UploadFile
from starlette.datastructures import Headers

from app.models.shop_area import ShopArea
from app.models.till_parameter import TillParameter
from app.models.user import User, UserRole
from app.routers import images as images_router
from app.routers import till_parameters as R
from app.routers.sync import get_till_parameters_sync
from app.schemas.till_parameter import TillParameterCreate, TillParameterValueIn
from app.services import local_media
from app.services import till_parameters as TP
from shift_world import make_world

LOGO_COMPANY = "https://res.cloudinary.com/demo/image/upload/company.png"
LOGO_SHOP = "https://res.cloudinary.com/demo/image/upload/shop.png"
LOGO_AREA = "https://res.cloudinary.com/demo/image/upload/area.png"


@pytest.fixture
def world(monkeypatch):
    monkeypatch.setattr(TP, "publish_settings_notify", lambda *a, **k: None)
    w = make_world()
    area = ShopArea(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, name="Bar")
    w.db.add(area)
    w.db.flush()
    w.tills[0].area_id = area.id
    w.db.commit()
    w.area = area
    TP.ensure_builtin_parameters(w.db)
    w.db.commit()
    return w


def _admin():
    return MagicMock(spec=User, role=UserRole.SUPER_ADMIN)


def _run(tasks: BackgroundTasks) -> None:
    for task in tasks.tasks:
        task.func(*task.args, **task.kwargs)


def _logo(world) -> TillParameter:
    return world.db.query(TillParameter).filter(TillParameter.key == TP.RECEIPT_LOGO_KEY).one()


def _set(world, scope_type, scope_id, value):
    tasks = BackgroundTasks()
    out = R.set_till_parameter_value(
        parameter_id=_logo(world).id,
        body=TillParameterValueIn(scopeType=scope_type, scopeId=scope_id, value=value),
        background_tasks=tasks,
        _admin=_admin(),
        db=world.db,
    )
    _run(tasks)
    return out


def _pulled_logo(world, till):
    resp = get_till_parameters_sync(machine_id=str(till.id), machine=till, db=world.db)
    return resp.model_dump(mode="json", by_alias=True)["parameters"].get(TP.RECEIPT_LOGO_KEY)


# ── The definition ───────────────────────────────────────────────────────────


def test_the_receipt_logo_is_a_built_in_string_parameter_without_default(world):
    logo = _logo(world)
    assert logo.label == "לוגו בקבלה"
    assert logo.value_type == "string"
    assert logo.default_value is None
    assert logo.is_active
    assert logo.description


def test_creating_the_built_ins_is_idempotent_and_ignores_case(world):
    assert TP.ensure_builtin_parameters(world.db) == []
    other = make_world()
    other.db.add(
        TillParameter(id=uuid.uuid4(), key="ReceiptLogoURL", label="x", value_type="string", is_active=True)
    )
    other.db.flush()
    assert TP.RECEIPT_LOGO_KEY not in TP.ensure_builtin_parameters(other.db)


def test_the_list_exposes_the_image_widget_and_its_upload_kind(world):
    tasks = BackgroundTasks()
    R.create_till_parameter(
        body=TillParameterCreate(key="footerText", label="L", valueType="string"),
        background_tasks=tasks,
        _admin=_admin(),
        db=world.db,
    )
    rows = {
        p.key: p.model_dump(mode="json", by_alias=True)
        for p in R.list_till_parameters(_admin=_admin(), db=world.db)
    }
    assert rows[TP.RECEIPT_LOGO_KEY]["widget"] == "image"
    assert rows[TP.RECEIPT_LOGO_KEY]["imageKind"] == "receipt"
    assert rows["footerText"]["widget"] is None
    assert rows["footerText"]["imageKind"] is None


def test_the_widget_needs_the_key_and_the_string_type():
    assert TP.parameter_widget("receiptLogoUrl", "string") == "image"
    assert TP.parameter_widget("receiptLogoUrl", "enum") is None
    assert TP.parameter_widget("otherLogoUrl", "string") is None


# ── Values per level ─────────────────────────────────────────────────────────


def test_area_beats_shop_beats_company(world):
    in_area, same_shop, other_shop = world.tills[0], world.tills[1], world.other_till
    assert _pulled_logo(world, in_area) is None  # No value, no default: key absent.

    _set(world, "company", world.company.id, LOGO_COMPANY)
    assert _pulled_logo(world, in_area) == LOGO_COMPANY

    _set(world, "shop", world.shop.id, LOGO_SHOP)
    assert _pulled_logo(world, in_area) == LOGO_SHOP
    assert _pulled_logo(world, other_shop) == LOGO_COMPANY

    area_value = _set(world, "area", world.area.id, LOGO_AREA)
    assert _pulled_logo(world, in_area) == LOGO_AREA
    # The other till of the shop is not in the area.
    assert _pulled_logo(world, same_shop) == LOGO_SHOP
    assert _pulled_logo(world, other_shop) == LOGO_COMPANY

    R.delete_till_parameter_value(
        parameter_id=_logo(world).id,
        value_id=area_value.id,
        background_tasks=BackgroundTasks(),
        _admin=_admin(),
        db=world.db,
    )
    assert _pulled_logo(world, in_area) == LOGO_SHOP


@pytest.mark.parametrize(
    "bad",
    ["", "   ", "not a url", "http://cdn.example.com/l.png", "ftp://x/l.png", "/media/l.png"],
)
def test_a_value_must_be_an_https_image_url(world, bad):
    with pytest.raises(HTTPException) as exc:
        _set(world, "shop", world.shop.id, bad)
    assert exc.value.status_code == 422


def test_the_servers_own_media_store_is_accepted_over_http(world):
    local = f"{local_media._base_url()}{local_media.MEDIA_PREFIX}/t/branding/receipt/abc.png"
    assert _set(world, "shop", world.shop.id, local).value == local


def test_an_image_default_must_be_a_url_too(world):
    tasks = BackgroundTasks()
    with pytest.raises(HTTPException) as exc:
        R.update_till_parameter(
            parameter_id=_logo(world).id,
            body=R.TillParameterUpdate(defaultValue="nope"),
            background_tasks=tasks,
            _admin=_admin(),
            db=world.db,
        )
    assert exc.value.status_code == 422


# ── The upload it goes through ───────────────────────────────────────────────


def _png(width: int, height: int) -> bytes:
    from PIL import Image

    out = io.BytesIO()
    Image.new("RGB", (width, height), "white").save(out, format="PNG")
    return out.getvalue()


def _upload(contents: bytes, content_type: str = "image/png"):
    file = UploadFile(
        file=io.BytesIO(contents), filename="l.png", headers=Headers({"content-type": content_type})
    )
    return asyncio.run(
        images_router.upload_branding_image(
            kind="receipt",
            file=file,
            current_user=MagicMock(spec=User, role=UserRole.SUPER_ADMIN),
            active_tenant_id=uuid.uuid4(),
        )
    )


def test_the_receipt_upload_still_enforces_its_limits():
    with pytest.raises(HTTPException) as exc:
        _upload(_png(40, 40))
    assert exc.value.status_code == 422

    too_big = b"\x89PNG" + b"\0" * (images_router._BRANDING_LIMITS["receipt"]["max_bytes"] + 1)
    with pytest.raises(HTTPException) as exc:
        _upload(too_big)
    assert exc.value.status_code == 413

    with pytest.raises(HTTPException) as exc:
        _upload(_png(100, 100), content_type="image/gif")
    assert exc.value.status_code == 415


def test_the_receipt_upload_falls_back_to_local_media_at_the_print_head_width(tmp_path, monkeypatch):
    monkeypatch.setattr(local_media, "MEDIA_DIR", tmp_path)
    with patch.object(images_router, "cloudinary_configured", return_value=False):
        out = _upload(_png(1200, 300))
    assert out.width == 384
    assert out.url.startswith(f"{local_media._base_url()}{local_media.MEDIA_PREFIX}/")
    # …and what it returns is a value the parameter accepts.
    assert TP.validate_image_url(out.url) == out.url
