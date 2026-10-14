"""
"תמונת מחלקה" — a category's picture from the dashboard (P:/specs/category-color-image.md §1, §4):
`POST /categories/{id}/image` (multipart) and `DELETE /categories/{id}/image`.

* Stored like a product's picture (app/routers/images.py `store_upload`, `as_product`): Cloudinary
  when configured (`pos/<tenant>/categories`), else the server's media store
  (`<PUBLIC_BASE_URL>/media/pos/<tenant>/categories/<hex>.<ext>`) — never a real upload here, both
  are mocked or kept under a temporary directory; the background cut out unless `keepBackground`.
* Upright and shrunk to the product cap before it is stored (app/services/category_image.py); a
  picture within the cap goes as it came.
* The type (415), the 5 MB (413), bytes that are no picture (400), an empty file (400).
* Who: the roles that upload product pictures, on a category they may edit; another tenant's 403,
  an unknown id 404. The tills are told (catalog notify) and get `imageUrl` with the catalog.
* Removal: the category back to no picture, 200 whether or not it had one.

Runs on the in-memory SQLite world of tests/shift_world.py, through the router functions.
"""
from __future__ import annotations

import asyncio
import io
import uuid
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from fastapi import HTTPException, UploadFile
from PIL import Image
from starlette.datastructures import Headers

from app.models.category import CatalogLevel, Category
from app.models.company import Company
from app.models.tenant import Tenant
from app.models.user import User, UserRole
from app.routers import categories as CR
from app.routers import images as IMG
from app.services import category_image as CI
from app.services import local_media
from app.services.product_image_processing import ProcessedImage
from app.services.sync import _serialize_category
from shift_world import accept_str_uuids, make_world


@pytest.fixture
def world(monkeypatch, tmp_path):
    accept_str_uuids(monkeypatch)
    w = make_world()
    w.notified = []
    monkeypatch.setattr(CR, "_trigger_catalog_notify", lambda db, c: w.notified.append(str(c.id)))
    # The server's own media store, in a temporary directory; Cloudinary off unless a test turns it on.
    monkeypatch.setattr(local_media, "MEDIA_DIR", tmp_path)
    monkeypatch.setattr(IMG, "cloudinary_configured", lambda *a, **k: False)
    w.media = tmp_path
    w.drinks = Category(
        id=uuid.uuid4(), tenant_id=w.tenant.id, company_id=w.company.id, name="שתייה", color="#2563EB",
        catalog_level=CatalogLevel.GLOBAL, is_active=True, sort_order=0,
    )
    w.db.add(w.drinks)
    w.company_manager = _user(w, "cm", UserRole.COMPANY_MANAGER)
    w.shop_manager = _user(w, "sm", UserRole.SHOP_MANAGER, shop=w.shop)
    w.cashier = _user(w, "cash", UserRole.CASHIER, shop=w.shop)
    w.db.commit()
    return w


def _user(w, name, role, shop=None, company=None):
    u = User(
        id=uuid.uuid4(), role=role, tenant_id=w.tenant.id, company_id=(company or w.company).id,
        shop_id=shop.id if shop is not None else None, email=f"{name}@x", username=name,
    )
    w.db.add(u)
    w.db.flush()
    return u


def _png(size=(60, 40), color=(30, 120, 220), mode="RGB") -> bytes:
    buf = io.BytesIO()
    Image.new(mode, size, color).save(buf, format="PNG")
    return buf.getvalue()


def _jpeg(size=(60, 40), exif_orientation=None) -> bytes:
    image = Image.new("RGB", size, (200, 80, 40))
    buf = io.BytesIO()
    if exif_orientation:
        exif = Image.Exif()
        exif[0x0112] = exif_orientation
        image.save(buf, format="JPEG", exif=exif.tobytes())
    else:
        image.save(buf, format="JPEG")
    return buf.getvalue()


def _file(data: bytes, content_type="image/png", name="c.png") -> UploadFile:
    return UploadFile(file=io.BytesIO(data), filename=name, headers=Headers({"content-type": content_type}))


def _upload(w, data, *, user=None, category=None, content_type="image/png", keep=False, tenant=None):
    return asyncio.run(CR.upload_category_image(
        category_id=str((category or w.drinks).id), file=_file(data, content_type), keep_background=keep,
        current_user=user or w.admin, active_tenant_id=tenant or w.tenant.id, db=w.db,
    ))


def _remove(w, *, user=None, category=None, tenant=None):
    return CR.remove_category_image(
        category_id=str((category or w.drinks).id), current_user=user or w.admin,
        active_tenant_id=tenant or w.tenant.id, db=w.db,
    )


def _refused(call, status):
    with pytest.raises(HTTPException) as exc:
        call()
    assert exc.value.status_code == status
    return exc.value


def _stored_file(w, url: str):
    prefix = f"{local_media._base_url()}{local_media.MEDIA_PREFIX}/"
    assert url.startswith(prefix), url
    return w.media / url[len(prefix):]


# ── Upload ───────────────────────────────────────────────────────────────────


def test_an_upload_is_stored_in_the_categories_folder_and_set_on_the_category(world):
    data = _png()
    out = _upload(world, data)

    url = out["imageUrl"]
    assert url.startswith(f"{local_media._base_url()}/media/pos/{world.tenant.id}/categories/")
    assert url.endswith(".png")
    assert out == {
        "id": str(world.drinks.id), "imageUrl": url, "originalUrl": None, "backgroundRemoved": False,
        "processed": False, "width": 60, "height": 40,
    }
    assert world.db.get(Category, world.drinks.id).image_url == url
    assert _stored_file(world, url).is_file()
    # The tills are told, and get it with the catalog — the colour beside it, as before.
    assert world.notified == [str(world.drinks.id)]
    row = _serialize_category(world.db.get(Category, world.drinks.id))
    assert (row["imageUrl"], row["color"]) == (url, "#2563EB")


def test_every_upload_is_a_new_url(world):
    first = _upload(world, _png())["imageUrl"]
    second = _upload(world, _png())["imageUrl"]
    assert first != second
    assert world.db.get(Category, world.drinks.id).image_url == second


def test_with_cloudinary_it_goes_where_the_product_pictures_go(world):
    def fake_upload(contents, **kwargs):
        public_id = kwargs.get("public_id") or f"{kwargs['folder']}/abc"
        return {"secure_url": f"https://res.cloudinary.com/demo/image/upload/v1/{public_id}.png", "public_id": public_id}

    with patch.object(IMG, "cloudinary_configured", return_value=True), patch.object(IMG, "configure_cloudinary"), \
            patch.object(IMG.cloudinary.uploader, "upload", side_effect=fake_upload) as upload:
        out = _upload(world, _png())
    assert upload.call_count == 1
    assert upload.call_args.kwargs["folder"] == f"pos/{world.tenant.id}/categories"
    assert upload.call_args.kwargs["overwrite"] is False
    assert out["imageUrl"] == f"https://res.cloudinary.com/demo/image/upload/v1/pos/{world.tenant.id}/categories/abc.png"
    assert world.db.get(Category, world.drinks.id).image_url == out["imageUrl"]


def test_the_background_is_cut_like_a_products_unless_kept(world, monkeypatch):
    monkeypatch.setattr(IMG, "get_settings", lambda: SimpleNamespace(product_image_bg_removal=True))
    cut = ProcessedImage(png=_png((30, 30), (0, 0, 0, 0), "RGBA"), width=30, height=30, method="flood")
    with patch.object(IMG, "process_product_image", return_value=cut) as process:
        out = _upload(world, _png())
    process.assert_called_once()
    assert process.call_args.kwargs == {"remove_background": True, "enhance": False}
    assert (out["backgroundRemoved"], out["processed"]) == (True, True)
    # The upload kept beside the cut-out, so it can be put back (PUT /categories/{id} imageUrl).
    assert out["originalUrl"] and out["originalUrl"].endswith("_orig.png")
    assert _stored_file(world, out["originalUrl"]).is_file()

    with patch.object(IMG, "process_product_image") as process:
        kept = _upload(world, _png(), keep=True)
    process.assert_not_called()
    assert (kept["backgroundRemoved"], kept["originalUrl"]) == (False, None)


def test_the_generic_category_upload_is_still_stored_as_uploaded(world, monkeypatch):
    # `POST /images/upload?resource=categories` (the old path) is not processed.
    monkeypatch.setattr(IMG, "get_settings", lambda: SimpleNamespace(product_image_bg_removal=True))
    with patch.object(IMG, "process_product_image") as process:
        out = asyncio.run(IMG.store_upload(_png(), world.tenant.id, "categories", False))
    process.assert_not_called()
    assert out.processed is False


# ── Shrunk and upright ───────────────────────────────────────────────────────


def test_a_big_photo_is_shrunk_to_the_product_cap(world):
    out = _upload(world, _jpeg((3000, 1500)), content_type="image/jpeg")
    assert (out["width"], out["height"], out["processed"]) == (1024, 512, True)
    with Image.open(_stored_file(world, out["imageUrl"])) as stored:
        assert stored.size == (1024, 512)


def test_a_picture_within_the_cap_is_stored_as_it_came():
    data = _png((800, 600))
    prepared = CI.prepare(data)
    assert prepared.data == data and prepared.changed is False and (prepared.width, prepared.height) == (800, 600)


def test_a_photo_taken_sideways_is_turned_upright():
    prepared = CI.prepare(_jpeg((60, 40), exif_orientation=6))
    assert prepared.changed is True
    assert (prepared.width, prepared.height) == (40, 60)
    with Image.open(io.BytesIO(prepared.data)) as image:
        assert image.size == (40, 60) and image.format == "JPEG"


def test_transparency_survives_the_shrink():
    prepared = CI.prepare(_png((2048, 1024), (10, 20, 30, 0), "RGBA"), limit=512)
    with Image.open(io.BytesIO(prepared.data)) as image:
        assert image.format == "PNG" and image.mode == "RGBA" and image.size == (512, 256)
        assert image.getchannel("A").getextrema() == (0, 0)


def test_an_animated_gif_keeps_its_first_frame():
    frames = [Image.new("RGB", (40, 40), c) for c in ((255, 0, 0), (0, 255, 0))]
    buf = io.BytesIO()
    frames[0].save(buf, format="GIF", save_all=True, append_images=frames[1:])
    prepared = CI.prepare(buf.getvalue())
    assert prepared.changed is True
    with Image.open(io.BytesIO(prepared.data)) as image:
        assert getattr(image, "n_frames", 1) == 1 and image.size == (40, 40)


# ── What is refused ──────────────────────────────────────────────────────────


def test_a_file_that_is_not_a_picture_is_refused(world):
    assert _refused(lambda: _upload(world, b"%PDF-1.4", content_type="application/pdf"), 415)
    assert _refused(lambda: _upload(world, b"not really a png"), 400).detail == "Not a readable image"
    assert _refused(lambda: _upload(world, b""), 400).detail == "Empty file"
    assert world.db.get(Category, world.drinks.id).image_url is None
    assert world.notified == []


def test_over_5_mb_is_refused(world):
    big = _png() + b"\0" * (5 * 1024 * 1024)
    assert _refused(lambda: _upload(world, big), 413).detail == "File exceeds 5 MB limit"
    assert world.db.get(Category, world.drinks.id).image_url is None


def _png_header_only(width: int, height: int) -> bytes:
    """A PNG that claims `width` x `height` in a few bytes (a decompression bomb's shape)."""
    import struct
    import zlib

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(b"\0" * 64)) + chunk(b"IEND", b"")


def test_a_picture_of_too_many_pixels_is_refused_before_it_is_decoded(world):
    bomb = _png_header_only(10_000, 10_000)
    assert len(bomb) < 200
    with patch.object(CI.Image.Image, "load", side_effect=AssertionError("decoded")):
        assert _refused(lambda: _upload(world, bomb), 413).detail == "Image exceeds 50 megapixels"
    assert world.db.get(Category, world.drinks.id).image_url is None
    # Just under the cap is read (and then found broken, here): not the size's refusal.
    assert _refused(lambda: _upload(world, _png_header_only(7_000, 7_000)), 400).detail == "Not a readable image"


def test_who_may_upload_and_remove(world):
    # The roles that upload product pictures: a company manager of the category's company.
    assert _upload(world, _png(), user=world.company_manager)["imageUrl"]
    assert _remove(world, user=world.company_manager) == {"id": str(world.drinks.id), "imageUrl": None}
    # Not a shop manager ("a photograph is chain artwork"), not a cashier.
    for user in (world.shop_manager, world.cashier):
        assert _refused(lambda: _upload(world, _png(), user=user), 403)
        assert _refused(lambda: _remove(world, user=user), 403)
    # A company manager of another company.
    other = Company(id=uuid.uuid4(), tenant_id=world.tenant.id, name="Other", vat_number="514141414")
    world.db.add(other)
    world.db.flush()
    stranger = _user(world, "stranger", UserRole.COMPANY_MANAGER, company=other)
    assert _refused(lambda: _upload(world, _png(), user=stranger), 403)
    assert _refused(lambda: _remove(world, user=stranger), 403)


def test_another_tenants_or_an_unknown_category(world):
    other = Tenant(id=uuid.uuid4(), name="Other", slug="other", timezone="Asia/Jerusalem")
    world.db.add(other)
    world.db.flush()
    foreign = Category(
        id=uuid.uuid4(), tenant_id=other.id, name="של מישהו אחר", catalog_level=CatalogLevel.GLOBAL, is_active=True, sort_order=0,
    )
    world.db.add(foreign)
    world.db.commit()
    assert _refused(lambda: _upload(world, _png(), category=foreign), 403)
    assert _refused(lambda: _remove(world, category=foreign), 403)
    assert world.db.get(Category, foreign.id).image_url is None

    ghost = Category(id=uuid.uuid4(), name="x")
    assert _refused(lambda: _upload(world, _png(), category=ghost), 404)
    assert _refused(lambda: _remove(world, category=ghost), 404)
    bad = lambda: CR.remove_category_image(  # noqa: E731
        category_id="not-a-uuid", current_user=world.admin, active_tenant_id=world.tenant.id, db=world.db,
    )
    assert _refused(bad, 404)


# ── Removal ──────────────────────────────────────────────────────────────────


def test_removing_the_picture(world):
    url = _upload(world, _png())["imageUrl"]
    world.notified.clear()
    assert _remove(world) == {"id": str(world.drinks.id), "imageUrl": None}
    category = world.db.get(Category, world.drinks.id)
    assert category.image_url is None and category.color == "#2563EB"
    assert world.notified == [str(world.drinks.id)]
    assert _serialize_category(category)["imageUrl"] is None
    # The file stays: a till that cached its URL never sees it break.
    assert _stored_file(world, url).is_file()
    # Again: nothing to remove, still 200, nobody told.
    assert _remove(world) == {"id": str(world.drinks.id), "imageUrl": None}
    assert world.notified == [str(world.drinks.id)]
