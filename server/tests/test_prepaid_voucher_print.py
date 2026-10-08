"""
Prepaid vouchers ("שוברי הפקה") on paper — the server's PDF (app/services/prepaid_voucher_pdf.py).

What each class pins:

* **Hebrew font** — "שובר יוצא ג'יבריש" (08.10.2026): on a server with no system fonts (the
  cloud's slim Docker image) every Hebrew letter and the "×" printed as a box, because the
  drawing fell back to Pillow's own face. Heebo now ships with the server and is tried
  first; with only Heebo (Arial / DejaVu hidden) nothing on a voucher or a cover sheet is
  drawn with a missing glyph; no font at all is logged as an error, never silent.

No database: the batches are drawn as they are built.
"""
from __future__ import annotations

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
from app.services import prepaid_voucher_pdf as PDF

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


def batch_obj(*, free_text=FREE, items=(("נקניקייה", 1), ("שתייה קלה", 2), ("צ׳יפס", 1)),
              kind="items", **kw):
    b = PrepaidVoucherBatch(
        name="הפקה — מזון", event_name="פסטיבל הקיץ", kind=kind, split_allowed=False, free_text=free_text,
        valid_until=datetime(2026, 8, 14, 20, tzinfo=timezone.utc), show_code=True, **kw,
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
