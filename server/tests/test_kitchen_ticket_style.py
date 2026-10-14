"""
"עיצוב בון" — the `ticketStyle` contract (P:/specs/kitchen-ticket-designs.md §1, §6–§10;
app/services/kitchen_ticket_style.py), pinned by the shared golden
tests/fixtures/kitchen_ticket_designs_golden.json (byte-identical in pos-android and read by the
dashboard's preview tests).

* The templates' looks, the styles the cloud sends with nothing set, and the resolve cases are the
  module's own output — byte for byte the golden's.
* `classic` is the default (§7: smaller and aligned); `classic_legacy` is the ticket of before.
* No solid black in any default look (§8); one line per item where it fits, sizes capped by the paper.
* The ink saver is on by default and leaves no filled area but the text (§6ב); a fill is only a
  named design's explicit choice with the ink saver off there.
* The till parameters set at a level lay over the template — their defaults never do; a design's
  overrides lay over them; the printer's own options over the design.
* Mandatory information can be restyled, never hidden: no "hidden" value anywhere, and the table
  stays in the header whatever a list says.
* The notice's parts print in the band of their kind.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import pytest

from app.services import kitchen_ticket_style as S

GOLDEN_PATH = Path(__file__).parent / "fixtures" / "kitchen_ticket_designs_golden.json"
GOLDEN = json.loads(GOLDEN_PATH.read_text(encoding="utf-8"))


def test_the_golden_is_lf_utf8_and_ends_with_a_newline():
    raw = GOLDEN_PATH.read_bytes().replace(b"\r\n", b"\n")  # a Windows checkout may hold CRLF; the blob is LF
    assert b"\r" not in raw
    assert raw.endswith(b"}\n")
    raw.decode("utf-8")


def test_the_templates_classic_first_and_the_default():
    assert GOLDEN["templates"] == list(S.TEMPLATES) == [
        "classic", "classic_legacy", "large", "compact", "courses", "modern",
    ]
    assert GOLDEN["defaultTemplate"] == S.DEFAULT_TEMPLATE == "classic"
    assert GOLDEN["templateLabels"] == S.TEMPLATE_LABELS
    assert S.TEMPLATE_LABELS["classic_legacy"] == "קלאסי (ישן)"


def test_the_looks_and_the_styles_are_the_module_s():
    assert GOLDEN["looks"] == {t: S.template_style(t) for t in S.TEMPLATES}
    assert GOLDEN["styles"] == {t: S.resolve_with_params(t) for t in S.TEMPLATES}
    for template, style in GOLDEN["styles"].items():
        assert list(style) == list(S.STYLE_KEYS), template


def test_the_vocabulary_metrics_and_notice_kinds_are_the_module_s():
    v = GOLDEN["vocabulary"]
    assert v["infoFields"] == list(S.INFO_FIELDS)
    assert v["bandKeys"] == list(S.BAND_KEYS)
    assert v["bandStyles"] == list(S.BAND_STYLES)
    assert v["fits"] == ["fit", "wrap"]
    assert v["minTextSizes"] == ["xs", "s", "m"] and v["maxTextSizes"] == ["s", "m", "l"]
    assert v["headerSizes"] == ["s", "m", "l"]
    assert v["fontScale"] == [80, 150] and v["feedLines"] == [0, 6]
    assert GOLDEN["metrics"] == S.METRICS
    assert GOLDEN["noticeSeparator"] == S.NOTICE_SEPARATOR
    assert [(k["kind"], tuple(k["prefixes"])) for k in GOLDEN["noticeKinds"]] == list(S.NOTICE_KINDS)


@pytest.mark.parametrize("case", GOLDEN["resolveCases"], ids=[c["id"] for c in GOLDEN["resolveCases"]])
def test_the_resolve_cases(case):
    inp = case["input"]
    got = S.resolve_with_params(
        inp["template"], params=inp.get("params"), overrides=inp.get("overrides"),
        design_id=inp.get("designId"), design_name=inp.get("designName"), printer=inp.get("printer"),
    )
    assert got == case["expect"]


def test_the_preview_sample_is_the_module_s_and_has_what_the_spec_lists():
    preview = next(s for s in GOLDEN["samples"] if s.get("preview"))
    assert preview["id"] == GOLDEN["testPrint"]["sampleId"] == "preview_table"
    assert preview["ticket"] == S.SAMPLE_TICKET
    t = preview["ticket"]
    # §4: a table, two courses, seats, choices and removals, a note, an allergy, "תוספת", "לקחת".
    assert t["tableName"] and t["isAddition"] and t["dining"] == "take_away"
    assert len({line["course"] for line in t["lines"]}) == 2
    assert {line["seat"] for line in t["lines"]} == {"מ1", "מ2"}
    assert any(line["mods"] for line in t["lines"]) and any(line["removals"] for line in t["lines"])
    assert any(line["notes"] for line in t["lines"]) and any(line["allergies"] for line in t["lines"])


def test_every_sample_is_in_the_till_s_ticket_shape_and_lists_what_every_template_must_show():
    ticket_keys = [
        "source", "tableName", "zoneName", "guests", "waiterName", "createdAt", "isAddition", "lines",
        "orderRef", "sourceName", "fire", "customerName", "dining", "notice", "training", "openedAt",
    ]
    line_keys = [
        "productId", "categoryId", "name", "quantity", "notes", "mods", "removals", "important",
        "allergies", "seat", "course", "mealName", "refill", "held",
    ]
    ids = [s["id"] for s in GOLDEN["samples"]]
    assert ids == [
        "preview_table", "addition_fire", "takeaway_customer", "reprint_redirect", "training_eat_in",
        "order_three_courses",
    ]
    for sample in GOLDEN["samples"]:
        assert list(sample["ticket"]) == ticket_keys, sample["id"]
        for line in sample["ticket"]["lines"]:
            assert list(line) == line_keys, sample["id"]
        assert sample["mustAppear"]["all"], sample["id"]
        assert set(sample["mustAppear"]["byTemplate"]) <= set(S.TEMPLATES), sample["id"]
    # Between them, every band the kitchen must never miss (§1).
    every = " ".join(" ".join(s["mustAppear"]["all"]) for s in GOLDEN["samples"])
    for word in ("תוספת", "הוצא", "העתק", "הדפסה חוזרת — ייתכן שכבר הודפס", "הופנה מ:", "אלרגיה",
                 "לקחת", "לשבת", "הערה לשולחן", "הדרכה"):
        assert word in every, word


def test_classic_is_smaller_and_aligned_and_legacy_is_the_ticket_of_before():
    new, old = S.template_style("classic"), S.template_style("classic_legacy")
    assert new["layout"] == {"qtyColumn": True, "hangingIndent": True}
    assert old["layout"] == {"qtyColumn": False, "hangingIndent": False}
    m = S.METRICS
    # Smaller than the ticket of before (36 / 56 dots at 58 mm, ×1.5 at 80 mm) at both widths (§7).
    for paper, scale in (("58", 1.0), ("80", 1.5)):
        item = m["itemSize"][paper][new["itemName"]["maxSize"]]
        table = item * m["headerRatio"][new["header"]["size"]]
        assert 0.6 <= item / (36 * scale) <= 0.9, paper
        assert 0.6 <= table / (56 * scale) <= 0.9, paper
    assert new["fit"] == "fit" and new["mods"]["layout"] == "inline" and new["header"]["layout"] == "inline"
    assert old["fit"] == "wrap" and old["mods"]["layout"] == "indent"
    assert new["spacing"] == "tight" and old["spacing"] == "normal"
    assert new["feedLines"] == 2 and old["feedLines"] == 3
    # Every design but the legacy aligns the same way.
    for t in S.TEMPLATES:
        if t != "classic_legacy":
            assert S.template_style(t)["layout"] == {"qtyColumn": True, "hangingIndent": True}, t


def test_no_default_look_has_solid_black_but_the_legacy():
    for template in S.TEMPLATES:
        parts = S.black_parts(S.template_style(template))
        assert (parts != []) == (template == "classic_legacy"), (template, parts)
    assert GOLDEN["blackParts"] == {t: S.black_parts(S.template_style(t)) for t in S.TEMPLATES}
    # The table and the quantity framed, never inverted, in large and modern.
    assert S.template_style("large")["header"]["fill"] == "outline" and S.template_style("large")["qty"] == "box_outline"
    assert S.template_style("modern")["header"]["fill"] == "outline"


def test_the_sizes_are_capped_by_the_paper():
    m = S.METRICS
    # An item at m: ≈ 32 characters a line at 80 mm, ≈ 24 at 58 mm (§8); the table at most twice an item.
    for paper in ("58", "80"):
        usable = m["paper"][paper]["dots"] - 2 * m["paper"][paper]["pad"]
        for size in S.TEXT_SIZES:
            chars = usable / (m["itemSize"][paper][size] * m["avgCharEm"])
            assert chars == pytest.approx(m["charsPerLine"][paper][size], abs=1.0), (paper, size)
    assert m["charsPerLine"]["80"]["m"] == 32 and m["charsPerLine"]["58"]["m"] == 24
    assert max(m["headerRatio"].values()) <= 2.0


def test_the_ink_saver_leaves_no_filled_area():
    for template in S.TEMPLATES:
        style = S.resolve_with_params(template)
        assert style["inkSaver"] is True
        assert S.black_parts(style) == [], template
        assert style["separatorWeight"] == "thin", template
    # Off: the legacy exactly as before.
    off = S.resolve_with_params("classic_legacy", params={"kitchenTicketInkSaver": False})
    look = S.template_style("classic_legacy")
    assert {k: off[k] for k in look if k != "order"} == {k: v for k, v in look.items() if k != "order"}
    assert off["order"]["groupHeaders"] is True and look["order"]["groupHeaders"] == "on"
    assert off["bands"]["addition"] == "fill"


def test_a_fill_is_only_a_design_s_explicit_choice_with_the_ink_saver_off():
    chosen = {"bands": {"addition": "fill"}, "qty": "box_fill", "header": {"fill": "fill"}}
    style = S.resolve_with_params("large", overrides={"inkSaver": False, **chosen})
    assert style["inkSaver"] is False and style["qty"] == "box_fill" and style["header"]["fill"] == "fill"
    assert style["bands"]["addition"] == "fill" and style["bands"]["fire"] == "double"
    # With the ink saver on (the default) even the explicit choice is framed.
    assert S.black_parts(S.resolve_with_params("large", overrides=chosen)) == []
    # The ink saver off at a level fills nothing by itself.
    assert S.black_parts(S.resolve_with_params("classic", params={"kitchenTicketInkSaver": False})) == []


def test_parameter_defaults_never_beat_a_template_s_own_look():
    courses = S.resolve_with_params("courses")
    assert courses["checkboxes"] is True and courses["grouping"] == "seat" and courses["totals"] is True
    assert courses["order"]["by"] == "course"
    assert S.resolve_with_params("modern")["elapsed"] is True
    assert S.resolve_with_params("compact")["itemName"]["maxSize"] == "s"
    # Set at a level, they do.
    assert S.resolve_with_params("courses", params={"kitchenTicketCheckboxes": False})["checkboxes"] is False


def test_the_order_level_then_design_then_printer():
    style = S.resolve_with_params(
        "classic",
        params={"kitchenTicketFontScale": 130},
        overrides={"fontScale": 110},
        printer={"fontScale": 90},
    )
    assert style["fontScale"] == 90
    assert S.resolve_with_params("classic", params={"kitchenTicketFontScale": 130}, overrides={"fontScale": 110})["fontScale"] == 110
    assert S.resolve_with_params("classic", params={"kitchenTicketFontScale": 130})["fontScale"] == 130


def test_the_fit_options_by_level_design_and_printer():
    style = S.resolve_with_params(
        "classic",
        params={"kitchenTicketFit": "wrap", "kitchenTicketMaxTextSize": "l", "kitchenTicketInlineMods": False},
    )
    assert style["fit"] == "wrap" and style["itemName"]["maxSize"] == "l" and style["mods"]["layout"] == "indent"
    style = S.resolve_with_params(
        "classic", params={"kitchenTicketFit": "wrap"}, overrides={"fit": "fit"}, printer={"headerSize": "s"},
    )
    assert style["fit"] == "fit" and style["header"]["size"] == "s"
    # The smallest size never above the largest.
    style = S.resolve_with_params("compact", params={"kitchenTicketMinTextSize": "m"})
    assert style["itemName"] == {"maxSize": "s", "minSize": "s", "maxLines": 0}


def test_the_table_is_never_left_out():
    style = S.resolve_with_params("classic", params={"kitchenTicketHeader": "guests"})
    assert style["header"]["fields"][0] == "table"
    assert "waiter" not in style["header"]["fields"] and "time" not in style["header"]["fields"]
    assert style["footer"]["fields"] == ["printer"]
    style = S.resolve_with_params("modern", overrides={"header": {"fields": ["waiter"]}})
    assert style["header"]["fields"] == ["table", "waiter"]
    assert S.clean_value("kitchenTicketHeader", "waiter, guests") == "table,guests,waiter"


@pytest.mark.parametrize(
    "overrides",
    [
        {"bands": {"addition": "hidden"}},
        {"bands": {"allergy": "fill"}},
        {"allergy": "none"},
        {"note": {"frame": "yes"}},
        {"fontScale": 79},
        {"fontScale": 151},
        {"feedLines": 7},
        {"itemName": {"maxLines": 5}},
        {"itemName": {"maxSize": "xl"}},
        {"itemName": {"minSize": "l"}},
        {"itemName": {"size": "m"}},
        {"header": {"size": "xl"}},
        {"header": {"tableSize": "m"}},
        {"fit": "shrink"},
        {"header": {"fields": ["table", "table"]}},
        {"header": {"fields": ["zone"]}},
        {"footer": {"fields": ["printer", "logo"]}},
        {"template": "large"},
        {"designId": "x"},
        {"hidden": True},
        ["classic"],
    ],
)
def test_overrides_the_look_does_not_take_are_refused(overrides):
    with pytest.raises(S.StyleError):
        S.clean_overrides(overrides)


def test_overrides_are_stored_in_a_stable_order_without_nulls():
    cleaned = S.clean_overrides({"qty": "box_outline", "bands": {"fire": "stars", "addition": None}, "inkSaver": True, "header": {}})
    assert cleaned == {"inkSaver": True, "bands": {"fire": "stars"}, "qty": "box_outline"}
    assert list(cleaned) == ["inkSaver", "bands", "qty"]
    assert S.clean_overrides(None) == {}


@pytest.mark.parametrize(
    "key, value, stored",
    [
        ("kitchenTicketDesign", "large", "large"),
        ("kitchenTicketDesign", " classic_legacy ", "classic_legacy"),
        ("kitchenTicketDesign", "5B0E4C1A-2F3D-4E5F-8A9B-0C1D2E3F4A5B", "5b0e4c1a-2f3d-4e5f-8a9b-0c1d2e3f4a5b"),
        ("kitchenTicketInkSaver", False, False),
        ("kitchenTicketFontScale", 120.0, 120),
        ("kitchenTicketHeader", "time,table", "table,time"),
        ("kitchenTicketCheckboxes", True, True),
        ("kitchenTicketElapsed", False, False),
        ("kitchenTicketFit", "wrap", "wrap"),
        ("kitchenTicketMinTextSize", "xs", "xs"),
        ("kitchenTicketMaxTextSize", "l", "l"),
        ("kitchenTicketHeaderSize", "s", "s"),
        ("kitchenTicketInlineMods", False, False),
        ("kitchenTicketOrder", "custom", "custom"),
        ("kitchenTicketGroupHeaders", "off", "off"),
        ("kitchenTicketNoCourse", "first", "first"),
        ("kitchenTicketOrderList", "", ""),
        (
            "kitchenTicketOrderList",
            " course:C0000000-0000-4000-8000-000000000003 , category:a0000000-0000-4000-8000-000000000001",
            "course:c0000000-0000-4000-8000-000000000003,category:a0000000-0000-4000-8000-000000000001",
        ),
    ],
)
def test_parameter_values_the_till_parses(key, value, stored):
    assert S.clean_value(key, value) == stored


@pytest.mark.parametrize(
    "key, value",
    [
        ("kitchenTicketDesign", "fancy"),
        ("kitchenTicketDesign", ""),
        ("kitchenTicketInkSaver", "on"),
        ("kitchenTicketFontScale", 79),
        ("kitchenTicketFontScale", 150.5),
        ("kitchenTicketHeader", "table,zone"),
        ("kitchenTicketHeader", ""),
        ("kitchenTicketCheckboxes", 1),
        ("kitchenTicketFit", "shrink"),
        ("kitchenTicketMinTextSize", "l"),
        ("kitchenTicketMaxTextSize", "xs"),
        ("kitchenTicketHeaderSize", "xl"),
        ("kitchenTicketInlineMods", "on"),
        ("kitchenTicketOrder", "alphabet"),
        ("kitchenTicketGroupHeaders", True),
        ("kitchenTicketNoCourse", "middle"),
        ("kitchenTicketOrderList", "dish:c0000000-0000-4000-8000-000000000003"),
        ("kitchenTicketOrderList", "course:nope"),
        ("kitchenTicketOrderList", "course:c0000000-0000-4000-8000-000000000003,course:c0000000-0000-4000-8000-000000000003"),
    ],
)
def test_parameter_values_the_till_cannot_parse_are_refused(key, value):
    with pytest.raises(ValueError):
        S.clean_value(key, value)


def test_the_parameters_are_built_in_with_the_owner_s_defaults():
    from app.services.till_parameters import BUILTIN_PARAMETERS

    built = {p.key: p for p in BUILTIN_PARAMETERS}
    expected = {
        "kitchenTicketDesign": "classic",
        "kitchenTicketInkSaver": True,
        "kitchenTicketFontScale": 100,
        "kitchenTicketHeader": "table,guests,waiter,time,till,order,customer",
        "kitchenTicketCheckboxes": False,
        "kitchenTicketElapsed": False,
        "kitchenTicketFit": "fit",
        "kitchenTicketMinTextSize": "s",
        "kitchenTicketMaxTextSize": "m",
        "kitchenTicketHeaderSize": "m",
        "kitchenTicketInlineMods": True,
        "kitchenTicketOrder": "added",
        "kitchenTicketOrderList": "",
        "kitchenTicketGroupHeaders": "auto",
        "kitchenTicketNoCourse": "last",
    }
    for key, default in expected.items():
        assert built[key].default_value == default, key
        assert built[key].label.startswith("בון מטבח"), key
        assert built[key].description, key
    assert set(expected) == set(S.PARAMETER_KEYS)


def test_the_notice_s_parts_print_in_their_bands():
    reprint = next(s for s in GOLDEN["samples"] if s["id"] == "reprint_redirect")["ticket"]
    assert S.notice_parts(reprint["notice"]) == [
        ("copy", "העתק"),
        ("redirected", "הופנה מ: בר"),
        ("resent", "הדפסה חוזרת — ייתכן שכבר הודפס"),
    ]
    assert S.notice_parts("הערה לשולחן: נר · זרז") == [("tableNote", "הערה לשולחן: נר"), ("notice", "זרז")]
    assert S.notice_parts("עותק 2") == [("copy", "עותק 2")]
    assert S.notice_parts(None) == [] and S.notice_parts(" · ") == []


def test_the_test_print_ticket_is_the_sample_now_and_marked_a_test():
    now = datetime(2026, 10, 14, 12, 0, tzinfo=timezone.utc)
    t = S.test_print_ticket(now, waiter="רון", till="קופה 9")
    assert t["createdAt"] == "2026-10-14T12:00:00Z" and t["openedAt"] == "2026-10-14T11:35:00Z"
    assert t["waiterName"] == "רון" and t["sourceName"] == "קופה 9"
    assert S.notice_parts(t["notice"])[0] == ("notice", S.TEST_PRINT_NOTICE)
    assert t["lines"] == S.SAMPLE_TICKET["lines"]
    assert S.SAMPLE_TICKET["notice"] == "הערה לשולחן: יום הולדת — להביא נר"  # the sample itself untouched


# ── The order of the lines (§9) ───────────────────────────────────────────────


@pytest.mark.parametrize("case", GOLDEN["orderCases"], ids=[c["id"] for c in GOLDEN["orderCases"]])
def test_the_order_cases(case):
    sample = next(s for s in GOLDEN["samples"] if s["id"] == "order_three_courses")["ticket"]
    style = {"order": case["order"], "grouping": case["grouping"]}
    groups = S.order_lines(sample["lines"], style, GOLDEN["orderData"]["courses"], GOLDEN["orderData"]["categories"])
    assert [{"kind": g["kind"], "title": g["title"], "lines": g["lines"]} for g in groups] == [
        {"kind": g["kind"], "title": g["title"], "lines": g["lines"]} for g in case["expect"]
    ]
    # Every line once, whatever the order.
    assert sorted(i for g in groups for i in g["lines"]) == list(range(len(sample["lines"])))


def test_the_order_by_level_design_and_printer_and_its_headers():
    assert S.resolve_with_params("classic")["order"] == {"by": "added", "groupHeaders": False, "noCourse": "last", "list": []}
    # Today's ticket: as added, the course's name where it changes.
    assert S.resolve_with_params("classic_legacy")["order"]["groupHeaders"] is True
    # Sorting turns the headings on by itself ("auto"); off stays off.
    assert S.resolve_with_params("classic", params={"kitchenTicketOrder": "course"})["order"]["groupHeaders"] is True
    off = S.resolve_with_params("classic", params={"kitchenTicketOrder": "course", "kitchenTicketGroupHeaders": "off"})
    assert off["order"]["groupHeaders"] is False
    listed = "category:a0000000-0000-4000-8000-000000000001,course:c0000000-0000-4000-8000-000000000003"
    style = S.resolve_with_params(
        "classic",
        params={"kitchenTicketOrder": "custom", "kitchenTicketOrderList": listed},
        overrides={"order": {"noCourse": "first"}},
        printer={"groupHeaders": "off"},
        names={("course", "c0000000-0000-4000-8000-000000000003"): "קינוחים"},
    )
    assert style["order"] == {
        "by": "custom",
        "groupHeaders": False,
        "noCourse": "first",
        "list": [
            {"kind": "category", "id": "a0000000-0000-4000-8000-000000000001", "name": None},
            {"kind": "course", "id": "c0000000-0000-4000-8000-000000000003", "name": "קינוחים"},
        ],
    }
    # The courses design: by course, by seat, with headings.
    courses = S.resolve_with_params("courses")
    assert courses["order"]["by"] == "course" and courses["grouping"] == "seat" and courses["order"]["groupHeaders"] is True


@pytest.mark.parametrize(
    "value",
    [
        [{"kind": "dish", "id": "c0000000-0000-4000-8000-000000000003"}],
        [{"kind": "course", "id": "x"}],
        [{"kind": "course"}],
        "course",
        [1],
        [{"kind": "course", "id": f"c0000000-0000-4000-8000-{i:012d}"} for i in range(41)],
    ],
)
def test_an_order_list_the_till_cannot_use_is_refused(value):
    with pytest.raises(S.StyleError):
        S.clean_overrides({"order": {"list": value}})


def test_a_design_s_order_list_is_kept_in_its_order():
    cleaned = S.clean_overrides({"order": {"by": "custom", "list": [
        {"kind": "course", "id": "C0000000-0000-4000-8000-000000000002"},
        "category:a0000000-0000-4000-8000-000000000002",
    ]}})
    assert cleaned == {"order": {"by": "custom", "list": [
        {"kind": "course", "id": "c0000000-0000-4000-8000-000000000002"},
        {"kind": "category", "id": "a0000000-0000-4000-8000-000000000002"},
    ]}}
