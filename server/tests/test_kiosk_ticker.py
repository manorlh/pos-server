"""
"כיתוב רץ" — the kiosk's scrolling ticker (config `ticker`, app/services/kiosk_config.py).

* Defaults: off, no texts, on the menu and the basket, under the header, slow, the theme's
  colours, medium text, no pause on touch — and valid.
* A layer's text gets its defaults (on, all day, every day, no dates).
* Strict validation with paths: screens, position, speed, size, colours, the text's length,
  ids, hours, days, the number of texts; cross-field: one id per text, an hour window that is
  not empty, dates in order.
* Layers: the section deep-merges key by key, its list of texts replaces whole.
* The limits the dashboard reads, and the config version that changes with it.

Pure: no database.
"""
from __future__ import annotations

from app.services import kiosk_config as C


def paths(errors):
    return {e.path: e.code for e in errors}


def errs(layer):
    """The layer's own errors, else the effective config's (cross-field) ones."""
    cleaned, layer_errors = C.validate_layer(layer)
    if layer_errors:
        return paths(layer_errors)
    return paths(C.validate_config(C.merge(C.default_config(), cleaned)))


def test_defaults_are_off_and_valid():
    cfg = C.default_config()
    assert cfg["ticker"] == {
        "enabled": False, "items": [], "screens": ["catalog", "cart"], "position": "top",
        "speed": "slow", "backgroundColor": None, "textColor": None, "size": "m", "pauseOnTouch": False,
    }
    assert C.validate_config(cfg) == []
    assert C.resolve({}, {}, {})["ticker"] == cfg["ticker"]


def test_a_text_gets_its_defaults():
    cleaned, errors = C.validate_layer({"ticker": {"enabled": True, "items": [{"id": "t1", "text": "מבצע: קפה ב-5 ₪"}]}})
    assert errors == []
    assert cleaned["ticker"]["items"] == [{
        "id": "t1", "text": "מבצע: קפה ב-5 ₪", "enabled": True, "from": None, "to": None,
        "days": [0, 1, 2, 3, 4, 5, 6], "startsAt": None, "endsAt": None,
    }]
    cfg = C.resolve(cleaned)
    assert cfg["ticker"]["enabled"] is True and C.validate_config(cfg) == []


def test_a_full_ticker_validates():
    layer = {"ticker": {
        "enabled": True,
        "items": [
            {"id": "t1", "text": "Happy hour", "enabled": True, "from": "17:00", "to": "19:00", "days": [4, 5],
             "startsAt": "2026-10-01T00:00:00+03:00", "endsAt": "2026-11-01T00:00:00+03:00"},
            {"id": "t2", "text": "פתוחים עד מאוחר", "enabled": False, "from": "22:00", "to": "02:00", "days": [5]},
        ],
        "screens": ["attract", "service", "catalog", "cart", "details", "pay", "success"],
        "position": "bottom", "speed": "fast", "backgroundColor": "#111111", "textColor": "#FFD60A",
        "size": "l", "pauseOnTouch": True,
    }}
    assert errs(layer) == {}


def test_validation_errors_have_paths():
    got = errs({"ticker": {
        "enabled": "yes",
        "screens": ["catalog", "paused"],
        "position": "middle",
        "speed": "warp",
        "size": "xl",
        "backgroundColor": "red",
        "textColor": "#12345",
        "pauseOnTouch": 1,
        "bogus": True,
        "items": [
            {"id": "bad id!", "text": "x"},
            {"id": "t2", "text": "x" * 201},
            {"id": "t3", "text": "x", "from": "25:00", "to": "7:5"},
            {"id": "t4", "text": "x", "days": []},
            {"id": "t5", "text": "x", "days": [7]},
            {"id": "t6", "text": "x", "startsAt": "tomorrow"},
            {"id": "t7", "text": "x", "color": "#000000"},
        ],
    }})
    assert got["ticker.enabled"] == "invalid_type"
    assert got["ticker.screens[1]"] == "invalid_value"
    assert got["ticker.position"] == "invalid_value"
    assert got["ticker.speed"] == "invalid_value"
    assert got["ticker.size"] == "invalid_value"
    assert got["ticker.backgroundColor"] == "invalid_color"
    assert got["ticker.textColor"] == "invalid_color"
    assert got["ticker.pauseOnTouch"] == "invalid_type"
    assert got["ticker.bogus"] == "unknown_key"
    assert got["ticker.items[0].id"] == "invalid_format"
    assert got["ticker.items[1].text"] == "too_long"
    assert got["ticker.items[2].from"] == "invalid_time"
    assert got["ticker.items[2].to"] == "invalid_time"
    assert got["ticker.items[3].days"] == "too_few"
    assert got["ticker.items[4].days[0]"] == "out_of_range"
    assert got["ticker.items[5].startsAt"] == "invalid_datetime"
    assert got["ticker.items[6].color"] == "unknown_key"


def test_at_most_twenty_texts():
    items = [{"id": f"t{i}", "text": "x"} for i in range(C.TICKER_ITEMS_MAX + 1)]
    assert errs({"ticker": {"items": items}})["ticker.items"] == "too_many"
    assert errs({"ticker": {"items": items[:-1]}}) == {}


def test_cross_field_rules():
    assert errs({"ticker": {"items": [{"id": "a", "text": "x"}, {"id": "a", "text": "y"}]}})["ticker.items[1].id"] == "duplicate"
    assert errs({"ticker": {"items": [{"id": "a", "text": "x", "from": "08:00", "to": "08:00"}]}})["ticker.items[0].to"] == "must_differ"
    # Past midnight is a window, not an error.
    assert errs({"ticker": {"items": [{"id": "a", "text": "x", "from": "22:00", "to": "02:00"}]}}) == {}
    # Only one end of the window is fine too.
    assert errs({"ticker": {"items": [{"id": "a", "text": "x", "from": "12:00"}, {"id": "b", "text": "y", "to": "12:00"}]}}) == {}
    late = {"id": "a", "text": "x", "startsAt": "2026-10-06T10:00:00+03:00", "endsAt": "2026-10-06T09:00:00+03:00"}
    assert errs({"ticker": {"items": [late]}})["ticker.items[0].endsAt"] == "must_be_after"


def test_layers_merge_the_section_and_replace_the_texts():
    company = {"ticker": {"enabled": True, "items": [{"id": "t1", "text": "החברה"}, {"id": "t2", "text": "עוד"}],
                          "backgroundColor": "#000000"}}
    shop = {"ticker": {"speed": "normal", "items": [{"id": "s1", "text": "הסניף"}]}}
    machine = {"ticker": {"position": "bottom", "backgroundColor": None}}
    cfg = C.resolve(company, shop, machine)
    t = cfg["ticker"]
    assert t["enabled"] is True                      # from the company
    assert t["speed"] == "normal"                    # from the shop
    assert t["position"] == "bottom"                 # from the kiosk
    assert t["backgroundColor"] == "#000000"         # null inherits
    assert [i["id"] for i in t["items"]] == ["s1"]   # the list replaces whole
    assert t["screens"] == ["catalog", "cart"]       # untouched default
    assert C.validate_config(cfg) == []


def test_stored_layer_with_a_bad_ticker_value_is_sanitised():
    stored = {"ticker": {"enabled": True, "speed": "warp", "items": [{"id": "t1", "text": "שלום"}]}}
    cfg = C.resolve(stored)
    assert cfg["ticker"]["enabled"] is True and cfg["ticker"]["speed"] == "slow"
    assert cfg["ticker"]["items"][0]["text"] == "שלום"


def test_limits_and_config_version():
    lim = C.limits()["ticker"]
    assert lim == {
        "itemsMax": 20, "textMax": 200,
        "screens": ["attract", "service", "catalog", "cart", "details", "pay", "success"],
        "positions": ["top", "bottom"], "speeds": ["slow", "normal", "fast"], "sizes": ["s", "m", "l"],
    }
    base = C.config_version(C.resolve())
    on = C.config_version(C.resolve({"ticker": {"enabled": True, "items": [{"id": "t1", "text": "x"}]}}))
    assert base != on
