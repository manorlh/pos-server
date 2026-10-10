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
* **The design** ("שיהיה מקצועי") — one layout (app/services/prepaid_voucher_layout.py) that the
  dashboard runs too (client/src/lib/voucherLayout.ts): the golden fixture
  tests/fixtures/prepaid_voucher_layout.json pins its operations for both; the code in Geist
  Mono; everything drawn in black; "נוצר על ידי Runner Systems" (`show_credit`) on by default,
  off per batch, in the same migration as `show_items`.

Runs on the in-memory SQLite world of tests/shift_world.py (fixtures of test_prepaid_vouchers).
"""
from __future__ import annotations

import importlib.util
import json
import logging
import os
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
from app.services import prepaid_voucher_layout as L
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
    fill: Any = None


@pytest.fixture
def drawn(monkeypatch) -> List[Drawn]:
    """Every text the PDF draws, with its font and where it lands on its card / page."""
    calls: List[Drawn] = []
    real = ImageDraw.ImageDraw.text

    def text(self, xy, text, fill=None, font=None, anchor=None, *args, **kwargs):
        calls.append(Drawn(text, font, self.textbbox(xy, text, font=font, anchor=anchor), self.im.size, fill))
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
    PDF.clear_font_caches()
    yield
    PDF.clear_font_caches()


def batch_obj(*, show_items=True, show_credit=True, show_validity=True, free_text=FREE, items=(("נקניקייה", 1), ("שתייה קלה", 2), ("צ׳יפס", 1)),
              kind="items", **kw):
    b = PrepaidVoucherBatch(
        name="הפקה — מזון", event_name="פסטיבל הקיץ", kind=kind, split_allowed=False, free_text=free_text,
        valid_until=datetime(2026, 8, 14, 20, tzinfo=timezone.utc), show_code=True, show_items=show_items,
        show_credit=show_credit, show_validity=show_validity, **kw,
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
        PDF.clear_font_caches()
        try:
            with caplog.at_level(logging.ERROR, logger=PDF.logger.name):
                font = PDF._font(40)
            assert any(r.levelno == logging.ERROR and "no font with Hebrew" in r.getMessage() for r in caplog.records)
            missing = PDF.missing_glyphs(font, "שובר מס׳ 0008 1×")
            assert "ש" in missing and "×" in missing
            assert not set("0123456789") & set(missing)
        finally:
            PDF.clear_font_caches()

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
            # Heebo, or Geist Mono for the code under the barcode — both ship with the server.
            assert pathlib.Path(call.font.path).name.startswith(("Heebo", "GeistMono")), call.text
            assert PDF.missing_glyphs(call.font, call.text) == [], call.text
        out = texts(drawn)
        # The line beside the serial, the item lines with their "×", the title.
        assert PDF._visual("מס׳ 0008") in out
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
        assert PDF._visual("מס׳ 0008") in out and "ABCD-EFGH-2345-6789" in out
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
            columns = {c["name"] for c in sa.inspect(conn).get_columns("prepaid_voucher_batches")}
            assert {"show_items", "show_credit"} <= columns
            row_ = conn.execute(sa.text("SELECT show_items, show_credit FROM prepaid_voucher_batches")).one()
            assert all(v in (1, True) for v in row_)
        # Offline (`alembic upgrade --sql`): the plain statement, no database looked at.
        import io

        buf = io.StringIO()
        offline = MigrationContext.configure(dialect_name="postgresql", opts={"as_sql": True, "output_buffer": buf})
        with Operations.context(offline):
            module.upgrade()
        for column in ("show_items", "show_credit"):
            assert f"ALTER TABLE prepaid_voucher_batches ADD COLUMN {column} BOOLEAN DEFAULT true NOT NULL" in buf.getvalue()


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
        assert shows(drawn, "ועוד פריטים")  # the rest summed up, not cut off the card
        assert PDF._visual("יש להציג את השובר בקופה") in texts(drawn)
        assert PDF._visual("בתוקף עד 14/08/2026") in texts(drawn)


# ── The design ────────────────────────────────────────────────────────────────

GOLDEN = ROOT / "tests" / "fixtures" / "prepaid_voucher_layout.json"
GOODS = [["1×", "נקניקייה בלחמניה", False], ["2×", "שתייה קלה", False], ["0.5 ק\"ג", "זיתים", True]]
BASE = {
    "title": "פסטיבל הקיץ 2026",
    "terms": "מימוש חד-פעמי",
    "serial": "מס׳ 0008 · קבוצה 3",
    "items": GOODS,
    "freeText": "יש להציג את השובר בקופה.\nלא ניתן להמיר בכסף ולא ניתן לפצל בין כמה קופות שונות במתחם.",
    "validity": "בתוקף עד 14/08/2026",
    "code": "ABCD-EFGH-2345-6789",
    "credit": "נוצר על ידי Runner Systems",
}
#: The inputs in the dashboard's words (camelCase): src/lib/voucherLayout.test.ts runs the same.
CASES = [
    {"name": "ticket 80x50, goods", "w": 80, "h": 50, "content": BASE},
    {"name": "card 54x86, logo, type and value", "w": 54, "h": 86,
     "content": {**BASE, "logo": True, "kicker": "שובר ארוחה", "valueLine": "שווי השובר: ₪80"}},
    {"name": "card 86x54, discount", "w": 86, "h": 54,
     "content": {**BASE, "items": [], "benefit": "₪30 הנחה על כל ההזמנה בקנייה מעל ₪100", "terms": "3 שימושים"}},
    {"name": "ticket 80x120, Code 128, many goods", "w": 80, "h": 120,
     "content": {**BASE, "barcode": "code128",
                 "items": [[f"{1 + i % 3}×", f"מוצר מספר {i + 1} עם שם ארוך מאוד", False] for i in range(20)]}},
    {"name": "A6, goods hidden, long free text", "w": 105, "h": 148,
     "content": {**BASE, "items": [], "freeText": "\n".join(f"שורה {i} של הטקסט החופשי" for i in range(1, 20))}},
    {"name": "A4 sheet cell, no credit, no code, no validity", "w": 105, "h": 74.25,
     "content": {**BASE, "credit": None, "code": None, "validity": None}},
    {"name": "custom 30x30", "w": 30, "h": 30, "content": BASE},
    {"name": "ticket 80x120, validity hidden", "w": 80, "h": 120, "content": {**BASE, "validity": None, "terms": None}},
]


def _content(d) -> L.CardContent:
    return L.CardContent(
        title=d["title"], terms=d.get("terms"), serial=d["serial"], barcode=d.get("barcode", "qr"),
        logo=bool(d.get("logo")), benefit=d.get("benefit"), items=[tuple(i) for i in d.get("items") or []],
        free_text=d.get("freeText"), validity=d.get("validity"), code=d.get("code"), credit=d.get("credit"),
        kicker=d.get("kicker"), value_line=d.get("valueLine"),
    )


def _labels() -> dict:
    lb = PDF.Labels()
    return {
        "serial": lb.serial, "group": lb.group, "splitAllowed": lb.split_allowed, "oneTime": lb.one_time,
        "validUntil": lb.valid_until, "validFrom": lb.valid_from, "validBetween": lb.valid_between,
        "usesOne": lb.uses_one, "usesMany": lb.uses_many, "includeExtras": lb.include_extras,
        "moreItems": lb.more_items, "credit": lb.credit, "valueFixed": lb.value_fixed, "valueCover": lb.value_cover,
    }


class TestDesign:
    def test_the_golden_layout_both_renderers_run(self):
        """
        The layout's operations for fixed voucher texts and a fixed measure. The dashboard's
        src/lib/voucherLayout.test.ts checks its port against the same file: a change to the
        design is made in both and regenerated here (UPDATE_PREPAID_VOUCHER_LAYOUT=1).
        """
        data = {
            "labels": _labels(),
            "cases": [
                {**case, "ops": L.layout(case["w"], case["h"], _content(case["content"]), L.fake_measure)}
                for case in CASES
            ],
        }
        if os.environ.get("UPDATE_PREPAID_VOUCHER_LAYOUT"):
            GOLDEN.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        assert json.loads(GOLDEN.read_text(encoding="utf-8")) == json.loads(json.dumps(data, ensure_ascii=False))

    def test_the_design_in_operations(self):
        ops = L.layout(80, 50, _content(BASE), L.fake_measure)
        kinds = [o["op"] for o in ops]
        assert kinds.count("qr") == 1 and kinds.count("box") == 1
        text = {o["text"]: o for o in ops if o["op"] == "text"}
        # The service number prominent, the code in monospace, the credit at the very bottom.
        assert text[BASE["serial"]]["bold"] and text[BASE["serial"]]["size"] > text[BASE["code"]]["size"]
        assert text[BASE["code"]]["mono"] and not text[BASE["code"]]["rtl"]
        credit = text[BASE["credit"]]
        assert credit["y"] == max(o["y"] for o in ops if o["op"] == "text")
        # The goods sit inside the box; the title above it; the QR on the left of a wide card.
        box = next(o for o in ops if o["op"] == "box")
        qr = next(o for o in ops if o["op"] == "qr")
        assert box["y"] < text["1×"]["y"] < box["y"] + box["h"]
        assert text[BASE["title"]]["y"] < box["y"]
        assert qr["x"] + qr["side"] < box["x"]
        # A weighed quantity is RTL text ("0.5 ק״ג"); "2×" is not.
        assert text['0.5 ק"ג']["rtl"] and not text["2×"]["rtl"]

    def test_a_tall_card_puts_the_barcode_under_the_text(self):
        ops = L.layout(54, 86, _content(BASE), L.fake_measure)
        qr = next(o for o in ops if o["op"] == "qr")
        last_text_above = max(o["y"] for o in ops if o["op"] == "text" and o["y"] < qr["y"])
        assert last_text_above < qr["y"]
        assert 86 * L.QR_PORTRAIT_MIN - 0.01 <= qr["side"] <= 86 * L.QR_PORTRAIT_MAX + 0.01

    def test_everything_is_drawn_black(self, drawn):
        card(batch_obj())
        assert drawn and {c.fill for c in drawn} == {"black"}

    def test_the_code_is_in_geist_mono_bold(self):
        PDF.clear_font_caches()
        font = PDF._mono(60)
        assert pathlib.Path(font.path).name == "GeistMono-latin.woff2"
        assert PDF.missing_glyphs(font, "ABCDEFGHJKMNPQRSTUVWXYZ23456789-") == []
        licence = (PDF.FONT_DIR / "LICENSE-GeistMono.txt").read_text(encoding="utf-8")
        assert "SIL OPEN FONT LICENSE" in licence

    def test_the_dashboard_ships_the_same_fonts(self):
        public = ROOT.parent / "client" / "public" / "fonts" / "voucher"
        for name in ("Heebo-Regular.ttf", "Heebo-Bold.ttf", "GeistMono-latin.woff2"):
            assert (public / name).read_bytes() == (PDF.FONT_DIR / name).read_bytes(), name

    def test_the_credit_line_is_on_by_default_and_off_per_batch(self, w, drawn):
        assert make(w)["showCredit"] is True
        off = make(w, showCredit=False)
        assert off["showCredit"] is False and PDF.options_for(row(w, off["id"])).show_credit is False
        out = R.update_prepaid_voucher_batch(off["id"], PrepaidVoucherBatchUpdate(showCredit=None), **_ctx(w))
        assert out["showCredit"] is False
        out = R.update_prepaid_voucher_batch(off["id"], PrepaidVoucherBatchUpdate(showCredit=True), **_ctx(w))
        assert out["showCredit"] is True
        events = R.prepaid_voucher_events(off["id"], **_ctx(w))["items"]
        assert events[0]["details"]["fields"] == ["show_credit"]
        card(batch_obj())
        assert shows(drawn, "נוצר על ידי") and "Runner Systems" in texts(drawn)
        drawn.clear()
        card(batch_obj(show_credit=False))
        assert not shows(drawn, "נוצר על ידי") and "Runner Systems" not in texts(drawn)

    @pytest.mark.parametrize("barcode", ["qr", "code128"])
    def test_every_layout_keeps_its_text_on_the_card(self, drawn, barcode):
        for preset in list(PDF.PRESETS) + ["custom"]:
            drawn.clear()
            b = batch_obj(barcode_type=barcode, items=tuple((f"מוצר {i}", 1) for i in range(9)))
            image = card(b, preset, 60, 40)
            W, H = image.size
            for call in drawn:
                x0, y0, x1, y1 = call.box
                assert 0 <= x0 and x1 <= W and 0 <= y0 and y1 <= H, (preset, barcode, call.text)


class TestShowValidity:
    """"הצג תוקף על השובר" — off: no validity and no terms line, and no empty band where they were."""

    def test_off_leaves_out_the_validity_and_the_terms(self, drawn):
        card(batch_obj(show_validity=False), "ticket80x120")
        out = texts(drawn)
        assert PDF._visual("בתוקף עד 14/08/2026") not in out and PDF._visual("מימוש חד-פעמי") not in out
        assert shows(drawn, "פסטיבל הקיץ") and PDF._visual("מס׳ 0008") in out

    def test_the_gap_closes(self):
        with_ = L.layout(80, 120, _content(BASE), L.fake_measure)
        without = L.layout(80, 120, _content({**BASE, "validity": None, "terms": None}), L.fake_measure)
        # The text block (centred above the barcode) is shorter by the footer and its gap, no more.
        def text_span(ops):
            ys = [o["y"] for o in ops if o["op"] == "text" and o["text"] not in (BASE["serial"], BASE["code"], BASE["credit"])]
            return max(ys) - min(ys)
        assert text_span(without) < text_span(with_)
        assert not any(o["op"] == "text" and o["text"] in (BASE["validity"], BASE["terms"]) for o in without)

    def test_on_by_default_and_per_batch(self, w):
        assert make(w)["showValidity"] is True
        off = make(w, showValidity=False)
        assert off["showValidity"] is False and PDF.options_for(row(w, off["id"])).show_validity is False
