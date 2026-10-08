"""
Prepaid vouchers ("שוברי הפקה") on paper — the server's PDF (app/services/prepaid_voucher_pdf.py).

What each class pins:

* **Hebrew font** — "שובר יוצא ג'יבריש" (08.10.2026): on a server with no system fonts (the
  cloud's slim Docker image) every Hebrew letter and the "×" printed as a box, because the
  drawing fell back to Pillow's own face. Heebo now ships with the server and is tried
  first; with only Heebo (Arial / DejaVu hidden) nothing on a voucher or a cover sheet is
  drawn with a missing glyph; no font at all is logged as an error, never silent.
* **"הצגת הפריטים על השובר"** (`show_items`) — on by default; off, the voucher prints its
  title, free text, validity, barcode, code and serial but not the goods (nor a discount's
  benefit); set at creation, changed later, logged; the migration adds it once.
* **Free text** — editable after creation (and cleared); several lines, Hebrew, long lines
  wrapped inside the card, in every layout (the 80 mm tickets included), never pushing the
  validity and the terms off the voucher.

Runs on the in-memory SQLite world of tests/shift_world.py (fixtures of test_prepaid_vouchers).
"""
from __future__ import annotations

import importlib.util
import logging
import pathlib
import re
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, List, Tuple

import pytest
from PIL import ImageDraw

from app.models.prepaid_voucher import PrepaidVoucher, PrepaidVoucherBatch, PrepaidVoucherBatchItem
from app.routers import prepaid_vouchers as R
from app.schemas.prepaid_voucher import PrepaidVoucherBatchCreate, PrepaidVoucherBatchUpdate
from app.services import prepaid_voucher_pdf as PDF
from test_prepaid_vouchers import _ctx, w  # noqa: F401 — `w` is the fixture

ROOT = pathlib.Path(__file__).absolute().parents[1]
FREE = "יש להציג את השובר בקופה\nלא ניתן להמיר בכסף ולא ניתן לפצל בין כמה קופות שונות במתחם הפסטיבל"


# ── Helpers ───────────────────────────────────────────────────────────────────


@dataclass
class Drawn:
    text: str
    font: Any
    box: Tuple[int, int, int, int]
    size: Tuple[int, int]


@pytest.fixture
def drawn(monkeypatch) -> List[Drawn]:
    """Every text the PDF draws, with its font and where it lands on its card / page."""
    calls: List[Drawn] = []
    real = ImageDraw.ImageDraw.text

    def text(self, xy, text, fill=None, font=None, anchor=None, *args, **kwargs):
        calls.append(Drawn(text, font, self.textbbox(xy, text, font=font, anchor=anchor), self.im.size))
        return real(self, xy, text, fill, font, anchor, *args, **kwargs)

    monkeypatch.setattr(ImageDraw.ImageDraw, "text", text)
    return calls


@pytest.fixture
def heebo_only(monkeypatch):
    """The cloud's situation: no Arial, no DejaVu, no Consolas — only the fonts we ship."""
    monkeypatch.setattr(PDF, "_FONT_CANDIDATES", {
        False: [str(PDF.HEBREW_FONTS[False]), "/nonexistent/arial.ttf"],
        True: [str(PDF.HEBREW_FONTS[True]), "/nonexistent/arialbd.ttf"],
    })
    monkeypatch.setattr(PDF, "_MONO_CANDIDATES", ["/nonexistent/consolab.ttf"])
    PDF._font.cache_clear()
    PDF._mono.cache_clear()
    yield
    PDF._font.cache_clear()
    PDF._mono.cache_clear()


def batch_obj(*, show_items=True, free_text=FREE, items=(("נקניקייה", 1), ("שתייה קלה", 2), ("צ׳יפס", 1)),
              kind="items", **kw):
    b = PrepaidVoucherBatch(
        name="הפקה — מזון", event_name="פסטיבל הקיץ", kind=kind, split_allowed=False, free_text=free_text,
        valid_until=datetime(2026, 8, 14, 20, tzinfo=timezone.utc), show_code=True, show_items=show_items, **kw,
    )
    b.items = [
        PrepaidVoucherBatchItem(product_id=uuid.uuid4(), product_name=n, quantity=q, sort_order=i)
        for i, (n, q) in enumerate(items)
    ]
    return b


VOUCHER = PrepaidVoucher(serial=8, group_no=None, code="ABCDEFGH23456789")


def card(batch, preset="ticket80x50", width=None, height=None, opts=None):
    g = PDF.geometry(preset, width, height)
    return PDF._draw_card(batch, VOUCHER, g.card_w, g.card_h, None, PDF.Labels(), False, opts or PDF.options_for(batch))


def texts(calls: List[Drawn]) -> str:
    return "\n".join(c.text for c in calls)


def hebrew_words(text: str) -> List[str]:
    return re.findall(r"[א-ת]+", text)


def shows(calls: List[Drawn], logical: str) -> bool:
    """Every Hebrew word of [logical] is on the card (drawn in visual order: reversed)."""
    out = texts(calls)
    return all(word[::-1] in out for word in hebrew_words(logical))


# ── Hebrew font ───────────────────────────────────────────────────────────────


class TestHebrewFont:
    def test_heebo_ships_with_the_server_and_is_tried_first(self):
        for bold in (False, True):
            assert PDF.HEBREW_FONTS[bold].is_file()
            assert PDF._FONT_CANDIDATES[bold][0] == str(PDF.HEBREW_FONTS[bold])
        licence = (PDF.FONT_DIR / "LICENSE-Heebo.txt").read_text(encoding="utf-8")
        assert "SIL Open Font License" in licence or "SIL OPEN FONT LICENSE" in licence

    def test_the_docker_image_carries_the_fonts(self):
        docker = (ROOT / "Dockerfile").read_text(encoding="utf-8")
        assert re.search(r"^COPY app/ \./app/", docker, re.M)
        ignored = (ROOT / ".dockerignore").read_text(encoding="utf-8").split()
        assert not [p for p in ignored if p in ("*.ttf", "assets", "app/assets", "**/assets", "*.txt")]

    def test_no_hebrew_font_is_an_error_not_silence(self, monkeypatch, caplog):
        # What the cloud did before: Pillow's own face — every Hebrew letter and "×" a box,
        # only the digits right (the owner's screenshot).
        monkeypatch.setattr(PDF, "_FONT_CANDIDATES", {False: ["/nonexistent/a.ttf"], True: ["/nonexistent/b.ttf"]})
        # An earlier test's alembic env.py (fileConfig) disables every existing logger.
        monkeypatch.setattr(PDF.logger, "disabled", False)
        PDF._font.cache_clear()
        try:
            with caplog.at_level(logging.ERROR, logger=PDF.logger.name):
                font = PDF._font(40)
            assert any(r.levelno == logging.ERROR and "no font with Hebrew" in r.getMessage() for r in caplog.records)
            missing = PDF.missing_glyphs(font, "שובר מס׳ 0008 1×")
            assert "ש" in missing and "×" in missing
            assert not set("0123456789") & set(missing)
        finally:
            PDF._font.cache_clear()

    def test_heebo_has_every_character_a_voucher_prints(self, heebo_only):
        for bold in (False, True):
            font = PDF._font(40, bold)
            assert pathlib.Path(font.path).name.startswith("Heebo")
            assert PDF.missing_glyphs(font, "אבגדהוזחטיכךלמםנןסעפףצץקרשת׳״×₪…·–—%-:/0123456789") == []

    def test_a_hebrew_voucher_is_drawn_without_a_missing_glyph(self, heebo_only, drawn):
        batch = batch_obj(customer_name="קייטרינג אלון", order_ref="הזמנה 77")
        g = PDF.geometry("ticket80x50")
        cover = PDF.GroupInfo(group=1, groups=3, low=1, high=10, count=10)
        data = PDF.render_pdf(batch, [VOUCHER], g, opts=PDF.options_for(batch), cover=cover, made="08/10/2026")
        assert data[:4] == b"%PDF"
        assert len(drawn) > 15
        for call in drawn:
            assert pathlib.Path(call.font.path).name.startswith("Heebo"), call.text
            assert PDF.missing_glyphs(call.font, call.text) == [], call.text
        out = texts(drawn)
        # The line beside the serial, the item lines with their "×", the title.
        assert PDF._visual("שובר מס׳ 0008") in out
        assert "2×" in out and shows(drawn, "פסטיבל הקיץ")

    def test_every_layout_and_a_discount_voucher_too(self, heebo_only, drawn):
        discount = batch_obj(kind="order_discount", discount_type="fixed", discount_value=3000, items=())
        for b in (batch_obj(), discount):
            for preset in PDF.PRESETS:
                card(b, preset)
        assert shows(drawn, "הנחה על כל ההזמנה")
        for call in drawn:
            assert PDF.missing_glyphs(call.font, call.text) == [], call.text


# ── "הצגת הפריטים על השובר" ───────────────────────────────────────────────────


def make(w, **extra):
    body = PrepaidVoucherBatchCreate(
        name="הפקה — מזון",
        companyId=w.company.id,
        eventName="פסטיבל הקיץ",
        freeText="שורה ראשונה",
        items=[{"productId": w.hotdog.id, "quantity": 1}, {"productId": w.drink.id, "quantity": 2}],
        count=2,
        **extra,
    )
    return R.create_prepaid_voucher_batch(body, **_ctx(w))


def row(w, batch_id) -> PrepaidVoucherBatch:
    return w.db.query(PrepaidVoucherBatch).filter(PrepaidVoucherBatch.id == uuid.UUID(batch_id)).one()


class TestShowItems:
    def test_on_by_default_and_off_per_batch(self, w):
        assert make(w)["showItems"] is True
        off = make(w, showItems=False)
        assert off["showItems"] is False and row(w, off["id"]).show_items is False
        assert PDF.options_for(row(w, off["id"])).show_items is False
        assert PDF.options_for(row(w, make(w)["id"])).show_items is True

    def test_changed_later_logged_and_never_cleared_by_a_null(self, w):
        batch = make(w)
        out = R.update_prepaid_voucher_batch(batch["id"], PrepaidVoucherBatchUpdate(showItems=False), **_ctx(w))
        assert out["showItems"] is False
        events = R.prepaid_voucher_events(batch["id"], **_ctx(w))["items"]
        assert events[0]["action"] == "update" and events[0]["details"]["fields"] == ["show_items"]
        out = R.update_prepaid_voucher_batch(batch["id"], PrepaidVoucherBatchUpdate(showItems=None), **_ctx(w))
        assert out["showItems"] is False
        out = R.update_prepaid_voucher_batch(batch["id"], PrepaidVoucherBatchUpdate(showItems=True), **_ctx(w))
        assert out["showItems"] is True

    def test_off_the_paper_has_no_goods_but_everything_else(self, drawn):
        card(batch_obj(show_items=False))
        assert not shows(drawn, "נקניקייה") and not shows(drawn, "שתייה קלה") and "×" not in texts(drawn)
        assert shows(drawn, "פסטיבל הקיץ") and shows(drawn, "יש להציג את השובר בקופה")
        out = texts(drawn)
        assert PDF._visual("בתוקף עד 14/08/2026") in out
        assert PDF._visual("שובר מס׳ 0008") in out and "ABCD-EFGH-2345-6789" in out
        drawn.clear()
        card(batch_obj(show_items=True))
        assert shows(drawn, "נקניקייה") and shows(drawn, "שתייה קלה") and "2×" in texts(drawn)

    def test_off_a_discount_voucher_leaves_out_what_it_gives(self, drawn):
        b = batch_obj(kind="order_discount", discount_type="fixed", discount_value=3000, items=(), show_items=False)
        assert PDF.card_contents(b, PDF.options_for(b)) == (None, [])
        card(b)
        assert not shows(drawn, "הנחה על כל ההזמנה") and shows(drawn, "פסטיבל הקיץ")

    def test_the_file_route_prints_by_the_batch(self, w, monkeypatch):
        seen = []

        def fake(batch, vouchers, g, *, logo=None, labels=None, opts=None, cover=None, made=None):
            seen.append(opts)
            return b"%PDF-stub"

        monkeypatch.setattr(PDF, "render_pdf", fake)
        for show in (True, False):
            b = make(w, showItems=show)
            R.prepaid_vouchers_file(
                b["id"], fmt="pdf", layout="ticket80x50", width=None, height=None, voucher_id=None,
                include_used=True, group=None, covers=True, **_ctx(w),
            )
        assert [o.show_items for o in seen] == [True, False]

    def test_the_migration_is_a_unique_revision_on_the_single_head(self):
        from alembic.config import Config
        from alembic.script import ScriptDirectory

        revision = "6b1e9d4f2a87"
        declaring = [
            p.name for p in (ROOT / "alembic" / "versions").glob("*.py")
            if re.search(rf"^revision(?::\s*str)?\s*=\s*['\"]{revision}['\"]", p.read_text(encoding="utf-8"), re.M)
        ]
        assert declaring == [f"{revision}_prepaid_voucher_show_items.py"]
        config = Config(str(ROOT / "alembic.ini"))
        config.set_main_option("script_location", str(ROOT / "alembic"))
        script = ScriptDirectory.from_config(config)
        heads = script.get_heads()
        assert len(heads) == 1
        assert revision in {r.revision for r in script.walk_revisions("base", heads[0])}
        assert script.get_revision(revision).down_revision == "8c4a2f6e1b93"

    def test_the_migration_adds_the_column_once_and_every_batch_keeps_its_goods(self):
        import sqlalchemy as sa
        from alembic.operations import Operations
        from alembic.runtime.migration import MigrationContext

        path = ROOT / "alembic" / "versions" / "6b1e9d4f2a87_prepaid_voucher_show_items.py"
        spec = importlib.util.spec_from_file_location("migration_6b1e9d4f2a87", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        engine = sa.create_engine("sqlite://")
        with engine.begin() as conn:
            conn.execute(sa.text("CREATE TABLE prepaid_voucher_batches (id VARCHAR PRIMARY KEY, name VARCHAR)"))
            conn.execute(sa.text("INSERT INTO prepaid_voucher_batches VALUES ('a', 'old')"))
            with Operations.context(MigrationContext.configure(conn)):
                module.upgrade()
                module.upgrade()  # idempotent
            assert "show_items" in {c["name"] for c in sa.inspect(conn).get_columns("prepaid_voucher_batches")}
            assert conn.execute(sa.text("SELECT show_items FROM prepaid_voucher_batches")).scalar() in (1, True)
        # Offline (`alembic upgrade --sql`): the plain statement, no database looked at.
        import io

        buf = io.StringIO()
        offline = MigrationContext.configure(dialect_name="postgresql", opts={"as_sql": True, "output_buffer": buf})
        with Operations.context(offline):
            module.upgrade()
        assert "ALTER TABLE prepaid_voucher_batches ADD COLUMN show_items BOOLEAN DEFAULT true NOT NULL" in buf.getvalue()


# ── Free text ─────────────────────────────────────────────────────────────────


class TestFreeText:
    def test_edited_after_creation_and_cleared(self, w):
        batch = make(w)
        assert batch["freeText"] == "שורה ראשונה"
        out = R.update_prepaid_voucher_batch(batch["id"], PrepaidVoucherBatchUpdate(freeText=FREE), **_ctx(w))
        assert out["freeText"] == FREE and row(w, batch["id"]).free_text == FREE
        events = R.prepaid_voucher_events(batch["id"], **_ctx(w))["items"]
        assert events[0]["details"]["fields"] == ["free_text"]
        out = R.update_prepaid_voucher_batch(batch["id"], PrepaidVoucherBatchUpdate(freeText="  "), **_ctx(w))
        assert out["freeText"] is None

    @pytest.mark.parametrize("preset,width,height", [(p, None, None) for p in PDF.PRESETS] + [("custom", 58, 40)])
    def test_every_layout_prints_it_wrapped_inside_the_card(self, drawn, preset, width, height):
        image = card(batch_obj(), preset, width, height)
        W, H = image.size
        # The first line as typed; the long second one wrapped over more lines, word by word.
        assert PDF._visual("יש להציג את השובר בקופה") in texts(drawn)
        assert shows(drawn, "לא ניתן להמיר בכסף")
        for call in drawn:
            x0, y0, x1, y1 = call.box
            assert 0 <= x0 and x1 <= W and 0 <= y0 and y1 <= H, (preset, call.text)
        # Never at the cost of the validity and the terms.
        assert PDF._visual("בתוקף עד 14/08/2026") in texts(drawn)
        assert PDF._visual("מימוש חד-פעמי") in texts(drawn)

    def test_the_80mm_ticket_wraps_a_long_line_over_several(self, drawn):
        card(batch_obj(free_text="לא ניתן להמיר בכסף ולא ניתן לפצל בין כמה קופות שונות במתחם הפסטיבל"))
        free = [c for c in drawn if any(word[::-1] in c.text for word in ("להמיר", "קופות", "הפסטיבל"))]
        assert len({c.box[1] for c in free}) >= 2

    def test_a_very_long_text_ends_with_an_ellipsis_above_the_validity(self, drawn):
        long = "\n".join(f"שורה מספר {i} של הטקסט החופשי" for i in range(1, 30))
        card(batch_obj(free_text=long))
        out = texts(drawn)
        assert "…" in out
        assert PDF._visual("בתוקף עד 14/08/2026") in out and PDF._visual("מימוש חד-פעמי") in out

    def test_many_goods_still_leave_room_for_it(self, drawn):
        goods = tuple((f"מוצר {chr(0x05d0 + i)}", 1) for i in range(12))
        card(batch_obj(items=goods))
        assert PDF._visual("יש להציג את השובר בקופה") in texts(drawn)
        assert PDF._visual("בתוקף עד 14/08/2026") in texts(drawn)
