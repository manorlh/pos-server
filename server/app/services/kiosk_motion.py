"""
The kiosk's Motion Engine ("מנוע הנפשות", docs/SPEC_KIOSK_MOTION in pos-android): one central,
dynamic MotionConfig for every kiosk renderer — the Android kiosk (domain/KioskMotionEngine.kt),
the dashboard's preview and the Windows / web kiosks (client/src/lib/kioskMotionEngine.ts).

The config lives in the kiosk config's `motion` section, beside the older per-transition choices
(`categorySwitch`, `itemsEnter`, `screenChange`, `sheet`, `addToCart`, `speed`, `effects`, still
accepted and still sent, for older kiosks):

    "motion": {
      "preset": "standard",          # PRESETS: the base timings of every event
      "globalSpeed": null,           # GLOBAL_SPEEDS; null — follow the older `speed`
      "speedMultiplier": 1.0,        # with globalSpeed "custom"
      "events": {                    # per event, only what a level sets (an override)
        "addToCart": {"durationMs": 1050}
      }
    }

Every event resolves the same way on every platform (resolve_event; pinned by the shared golden
tests/fixtures/kiosk_motion_engine.json, byte-identical in pos-android):

  1. the preset's values (STANDARD ⊕ PRESET_DELTAS[preset]);
  2. the older choice of its kind, when the config has one (LEGACY_KINDS: the UI style's transitions
     and every config saved before the engine) — so no kiosk changes its kinds on upgrade;
  3. the event's own explicit values (`motion.events.<event>`), which win;
  4. the timings — durationMs, delayMs, staggerMs, repeatDelayMs — times the global speed unless
     set explicitly (resolve_duration: an override ignores the multiplier); dwell times (holdMs,
     autoAdvanceDelayMs) are never scaled;
  5. the light render profile (a weak device, `motion.effects`) — the cheaper kind of each event at
     no slower than the fast pace; then reduced motion (`general.reduceMotion`) — each event's
     `reducedMotionFallback` (fade / highlight / colour / none), never a big movement.

Pure: no database, no imports from kiosk_config (which builds its schema from these tables).
"""
from __future__ import annotations

import math
from typing import Any, Dict, Mapping, Optional, Tuple

#: The events, in the dashboard's order (spec §4, §9). Each is configured on its own.
EVENTS: Tuple[str, ...] = (
    "productPress",
    "addToCart",
    "cartBadge",
    "toast",
    "modalOpen",
    "select",
    "quantityChange",
    "priceChange",
    "categorySwitch",
    "itemsEnter",
    "cartOpen",
    "remove",
    "continueReady",
    "error",
    "serviceChoice",
    "upsell",
    "pageTransition",
    "payment",
    "paymentProgress",
    "success",
    "idle",
    "timeout",
    "soldOut",
    "loading",
    "scrollHint",
    "homeReturn",
)

#: The animation library (spec §3): 35 kinds, and "none".
TYPES: Tuple[str, ...] = (
    "scalePress", "bounce", "pulse", "flyToCart", "slideIn", "slideOut", "fadeIn", "fadeOut",
    "fadeScale", "expand", "collapse", "morph", "flip", "countUp", "countDown", "shake", "wiggle",
    "drawCheck", "progressFill", "highlight", "ripple", "floating", "swipeTransition", "staggeredEntry",
    "parallaxLight", "confetti", "skeletonShimmer", "attentionArrow", "cartBadgePop", "priceHighlight",
    "buttonFill", "successZoom", "cardLift", "crossfade", "reorderShift", "none",
)

#: The kinds each event can play (the renderers draw every one of them); "none" always.
EVENT_TYPES: Dict[str, Tuple[str, ...]] = {
    "productPress": ("scalePress", "ripple", "highlight", "bounce", "none"),
    "addToCart": ("flyToCart", "bounce", "fadeOut", "none"),
    "cartBadge": ("cartBadgePop", "bounce", "pulse", "none"),
    "toast": ("fadeIn", "slideIn", "fadeScale", "none"),
    "modalOpen": ("fadeScale", "slideIn", "fadeIn", "expand", "morph", "none"),
    "select": ("highlight", "scalePress", "bounce", "cardLift", "ripple", "none"),
    "quantityChange": ("flip", "slideIn", "countUp", "bounce", "fadeIn", "none"),
    "priceChange": ("priceHighlight", "countUp", "highlight", "flip", "none"),
    "categorySwitch": ("slideIn", "swipeTransition", "fadeIn", "fadeScale", "crossfade", "none"),
    "itemsEnter": ("staggeredEntry", "fadeScale", "slideIn", "flip", "fadeIn", "none"),
    "cartOpen": ("slideIn", "swipeTransition", "fadeIn", "fadeScale", "none"),
    "remove": ("slideOut", "collapse", "fadeOut", "reorderShift", "none"),
    "continueReady": ("buttonFill", "pulse", "highlight", "bounce", "none"),
    "error": ("shake", "wiggle", "highlight", "none"),
    "serviceChoice": ("cardLift", "scalePress", "highlight", "bounce", "none"),
    "upsell": ("slideIn", "fadeScale", "fadeIn", "expand", "none"),
    "pageTransition": ("slideIn", "swipeTransition", "fadeIn", "fadeScale", "crossfade", "none"),
    "payment": ("buttonFill", "pulse", "highlight", "none"),
    "paymentProgress": ("progressFill", "pulse", "skeletonShimmer", "none"),
    "success": ("drawCheck", "successZoom", "confetti", "fadeIn", "none"),
    "idle": ("floating", "pulse", "parallaxLight", "wiggle", "none"),
    "timeout": ("fadeIn", "fadeScale", "slideIn", "countDown", "none"),
    "soldOut": ("fadeOut", "highlight", "none"),
    "loading": ("skeletonShimmer", "pulse", "none"),
    "scrollHint": ("attentionArrow", "wiggle", "pulse", "none"),
    "homeReturn": ("crossfade", "fadeIn", "fadeScale", "slideIn", "none"),
}

#: "auto": the natural way for the event (the reading order for screens); otherwise where it moves to.
DIRECTIONS: Tuple[str, ...] = ("auto", "left", "right", "up", "down")

#: The curves by name (CSS cubic-bezier x1, y1, x2, y2); "auto" is each kind's own.
EASINGS: Tuple[str, ...] = ("auto", "standard", "decelerate", "accelerate", "emphasized", "easeInOut", "overshoot", "linear")
EASING_CURVES: Dict[str, Tuple[float, float, float, float]] = {
    "standard": (0.3, 0.0, 0.2, 1.0),
    "decelerate": (0.2, 0.7, 0.2, 1.0),
    "accelerate": (0.4, 0.0, 1.0, 1.0),
    "emphasized": (0.05, 0.7, 0.1, 1.0),
    "easeInOut": (0.45, 0.0, 0.55, 1.0),
    "overshoot": (0.34, 1.56, 0.64, 1.0),
    "linear": (0.0, 0.0, 1.0, 1.0),
}

#: Reduced motion (spec §14): the feedback stays — a fade, a highlight, a colour change — or none.
FALLBACKS: Tuple[str, ...] = ("fade", "highlight", "color", "none")

#: The presets (spec §8) and "legacy": the pace kiosks had before the engine (migration).
PRESETS: Tuple[str, ...] = ("standard", "slow", "fast", "custom", "legacy")
DEFAULT_PRESET = "standard"

#: Global speed (spec §7). Without one (null) a config follows its older `speed`.
GLOBAL_SPEEDS: Tuple[str, ...] = ("slow", "normal", "fast", "custom")
SPEED_FACTORS: Dict[str, float] = {"slow": 1.30, "normal": 1.00, "fast": 0.75}
LEGACY_SPEED_FACTORS: Dict[str, float] = {"fast": 0.75, "normal": 1.00, "relaxed": 1.35}
MULTIPLIER_MIN = 0.5
MULTIPLIER_MAX = 2.0

#: The light profile plays no slower than the fast pace (fewer frames on a weak device).
LIGHT_MAX_MULTIPLIER = 0.75
#: A reduced-motion fade / highlight takes half the event's time.
REDUCED_FACTOR = 0.5
#: "Undo" stays at least this long after a remove (spec §4).
REMOVE_MIN_HOLD_MS = 3000
#: The staggered entry: the last card starts no later than this many steps (a screenful)…
STAGGER_CAP_STEPS = 8
#: …or, for "legacy", by 200 ms at normal speed (as before the engine).
LEGACY_STAGGER_CAP_MS = 200
#: A sold-out dish fades to this opacity (never vanishes).
SOLD_OUT_ALPHA = 0.45

#: The parameters of an event (spec §6), in the dashboard's order: (kind, low, high).
PARAMS: Dict[str, Tuple[str, Any, Any]] = {
    "enabled": ("bool", None, None),
    "animationType": ("type", None, None),
    "durationMs": ("int", 0, 5000),
    "delayMs": ("int", 0, 3000),
    "direction": ("enum", DIRECTIONS, None),
    "intensity": ("int", 0, 200),
    "scaleFrom": ("num", 0.2, 2.0),
    "scaleTo": ("num", 0.2, 2.0),
    "distancePx": ("int", 0, 600),
    "easing": ("enum", EASINGS, None),
    "repeat": ("int", 0, 20),
    "repeatDelayMs": ("int", 0, 10000),
    "holdMs": ("int", 0, 15000),
    "staggerMs": ("int", 0, 500),
    "autoAdvanceDelayMs": ("int", 0, 5000),
    "reducedMotionFallback": ("enum", FALLBACKS, None),
}
#: A narrower range for one event's parameter.
EVENT_PARAM_RANGES: Dict[str, Dict[str, Tuple[int, int]]] = {
    "remove": {"holdMs": (REMOVE_MIN_HOLD_MS, 15000)},
}
#: Motion timings: times the global speed unless set explicitly. holdMs / autoAdvanceDelayMs are dwell times.
TIMING_PARAMS: Tuple[str, ...] = ("durationMs", "delayMs", "staggerMs", "repeatDelayMs")


def _ev(t, ms, *, delay=0, direction="auto", intensity=100, s_from=1.0, s_to=1.0, distance=0, easing="auto",
        repeat=1, repeat_delay=0, hold=0, stagger=0, advance=0, fallback="fade") -> Dict[str, Any]:
    return {
        "enabled": True, "animationType": t, "durationMs": ms, "delayMs": delay, "direction": direction,
        "intensity": intensity, "scaleFrom": s_from, "scaleTo": s_to, "distancePx": distance, "easing": easing,
        "repeat": repeat, "repeatDelayMs": repeat_delay, "holdMs": hold, "staggerMs": stagger,
        "autoAdvanceDelayMs": advance, "reducedMotionFallback": fallback,
    }


#: "Runner Standard" (spec §2, §8): balanced and clear — Press 450 | Add 750 | Page 650 | Success 1000.
#: `repeat` is how many times it plays; 0 loops while its state lasts.
STANDARD: Dict[str, Dict[str, Any]] = {
    "productPress": _ev("scalePress", 450, s_to=0.96, fallback="highlight"),
    "addToCart": _ev("flyToCart", 750, s_to=0.25, hold=900),
    "cartBadge": _ev("cartBadgePop", 550, s_to=1.25, easing="overshoot", fallback="color"),
    "toast": _ev("fadeIn", 450, direction="up", distance=16, hold=2000),
    "modalOpen": _ev("fadeScale", 650, s_from=0.94),
    "select": _ev("highlight", 550, s_to=1.04, fallback="highlight"),
    "quantityChange": _ev("flip", 500, direction="up"),
    "priceChange": _ev("priceHighlight", 700, fallback="color"),
    "categorySwitch": _ev("slideIn", 600),
    "itemsEnter": _ev("staggeredEntry", 450, direction="up", s_from=0.85, distance=24, stagger=60, fallback="none"),
    "cartOpen": _ev("slideIn", 650, direction="up"),
    "remove": _ev("slideOut", 650, hold=4000),
    "continueReady": _ev("buttonFill", 650, s_to=1.04, fallback="color"),
    "error": _ev("shake", 550, direction="left", distance=10, fallback="color"),
    "serviceChoice": _ev("cardLift", 550, direction="up", s_to=1.04, distance=8, advance=600, fallback="highlight"),
    "upsell": _ev("slideIn", 650, direction="up"),
    "pageTransition": _ev("slideIn", 650),
    "payment": _ev("buttonFill", 550, fallback="color"),
    "paymentProgress": _ev("progressFill", 1200, easing="easeInOut", repeat=0),
    "success": _ev("drawCheck", 1000, s_from=0.6),
    "idle": _ev("floating", 2800, direction="up", s_to=1.05, distance=10, easing="easeInOut", repeat=0, fallback="none"),
    "timeout": _ev("fadeIn", 600, s_from=0.96),
    "soldOut": _ev("fadeOut", 600),
    "loading": _ev("skeletonShimmer", 1600, easing="linear", repeat=0, fallback="none"),
    "scrollHint": _ev("attentionArrow", 1500, delay=800, direction="down", distance=12, easing="easeInOut",
                      repeat=3, repeat_delay=400),
    "homeReturn": _ev("crossfade", 700),
}

#: Each preset as its difference from Standard: "Runner Slow" — extra clear (×≈1.3); "Runner Fast" —
#: quick but readable (×≈0.75); "custom" — Standard, to be set event by event; "legacy" — the pace
#: and the reduced-motion behaviour of the kiosks before the engine (the transitions' times by
#: their kind are LEGACY_DURATIONS), the new feedback at the fast pace.
PRESET_DELTAS: Dict[str, Dict[str, Dict[str, Any]]] = {
    "standard": {},
    "custom": {},
    "slow": {
        "productPress": {"durationMs": 600}, "addToCart": {"durationMs": 950, "holdMs": 1100},
        "cartBadge": {"durationMs": 700}, "toast": {"durationMs": 600, "holdMs": 2600},
        "modalOpen": {"durationMs": 800}, "select": {"durationMs": 650}, "quantityChange": {"durationMs": 650},
        "priceChange": {"durationMs": 900}, "categorySwitch": {"durationMs": 750},
        "itemsEnter": {"durationMs": 600, "staggerMs": 80}, "cartOpen": {"durationMs": 800},
        "remove": {"durationMs": 800, "holdMs": 5000}, "continueReady": {"durationMs": 800},
        "error": {"durationMs": 700}, "serviceChoice": {"durationMs": 700, "autoAdvanceDelayMs": 700},
        "upsell": {"durationMs": 800}, "pageTransition": {"durationMs": 800}, "payment": {"durationMs": 700},
        "paymentProgress": {"durationMs": 1500}, "success": {"durationMs": 1300}, "idle": {"durationMs": 3400},
        "timeout": {"durationMs": 750}, "soldOut": {"durationMs": 750}, "loading": {"durationMs": 2000},
        "scrollHint": {"durationMs": 1800}, "homeReturn": {"durationMs": 900},
    },
    "fast": {
        "productPress": {"durationMs": 350}, "addToCart": {"durationMs": 550, "holdMs": 800},
        "cartBadge": {"durationMs": 450}, "toast": {"durationMs": 350, "holdMs": 1600},
        "modalOpen": {"durationMs": 500}, "select": {"durationMs": 450}, "quantityChange": {"durationMs": 400},
        "priceChange": {"durationMs": 550}, "categorySwitch": {"durationMs": 450},
        "itemsEnter": {"durationMs": 350, "staggerMs": 45}, "cartOpen": {"durationMs": 500},
        "remove": {"durationMs": 500, "holdMs": 3500}, "continueReady": {"durationMs": 500},
        "error": {"durationMs": 450}, "serviceChoice": {"durationMs": 450, "autoAdvanceDelayMs": 500},
        "upsell": {"durationMs": 500}, "pageTransition": {"durationMs": 450}, "payment": {"durationMs": 450},
        "paymentProgress": {"durationMs": 1000}, "success": {"durationMs": 800}, "idle": {"durationMs": 2400},
        "timeout": {"durationMs": 450}, "soldOut": {"durationMs": 450}, "loading": {"durationMs": 1400},
        "scrollHint": {"durationMs": 1200}, "homeReturn": {"durationMs": 550},
    },
    "legacy": {
        # The springy press, the ~0.56 s pop-and-fly and its badge, the card's ✓ for 0.6 s.
        "productPress": {"durationMs": 250, "scaleTo": 0.97},
        "addToCart": {"durationMs": 560, "holdMs": 600},
        "cartBadge": {"durationMs": 480, "reducedMotionFallback": "none"},
        "priceChange": {"durationMs": 360, "animationType": "countUp", "reducedMotionFallback": "none"},
        "toast": {"durationMs": 350, "holdMs": 1600},
        # The transitions: their times by kind (LEGACY_DURATIONS); reduced motion — none at all.
        "modalOpen": {"reducedMotionFallback": "none"},
        "categorySwitch": {"reducedMotionFallback": "none"},
        "itemsEnter": {"staggerMs": 32},
        "cartOpen": {"reducedMotionFallback": "none"},
        "upsell": {"reducedMotionFallback": "none"},
        "pageTransition": {"reducedMotionFallback": "none"},
        "homeReturn": {"reducedMotionFallback": "none"},
        "select": {"durationMs": 450}, "quantityChange": {"durationMs": 400},
        "remove": {"durationMs": 500, "holdMs": 3500}, "continueReady": {"durationMs": 500},
        "error": {"durationMs": 450}, "serviceChoice": {"durationMs": 450, "autoAdvanceDelayMs": 500},
        "payment": {"durationMs": 450}, "paymentProgress": {"durationMs": 1300}, "success": {"durationMs": 800},
        # The attract screen's "touch" hint breathed once a 1.1 s each way.
        "idle": {"durationMs": 2200, "animationType": "pulse", "scaleTo": 1.06},
        "timeout": {"durationMs": 450}, "soldOut": {"durationMs": 450}, "loading": {"durationMs": 1400},
        "scrollHint": {"durationMs": 1200},
    },
}

#: The older per-transition choices (still in every config: the UI style's, or a level's) give the
#: kind of their event unless the event sets its own. Old value → the event's values.
_PAGE_KINDS = {
    "slide": {"animationType": "slideIn"},
    "fade": {"animationType": "fadeIn"},
    "zoom": {"animationType": "fadeScale", "scaleFrom": 0.92},
    "none": {"animationType": "none"},
}
_SHEET_KINDS = {
    "slide_up": {"animationType": "slideIn", "direction": "up"},
    "scale": {"animationType": "fadeScale", "scaleFrom": 0.94},
    "fade": {"animationType": "fadeIn"},
    "none": {"animationType": "none"},
}
LEGACY_KINDS: Dict[str, Tuple[str, Dict[str, Dict[str, Any]]]] = {
    "categorySwitch": ("categorySwitch", {
        "slide": {"animationType": "slideIn"},
        "fade": {"animationType": "fadeIn"},
        "fade_scale": {"animationType": "fadeScale", "scaleFrom": 0.96},
        "push": {"animationType": "swipeTransition"},
        "none": {"animationType": "none"},
    }),
    "itemsEnter": ("itemsEnter", {
        "pop": {"animationType": "fadeScale"},
        "cascade": {"animationType": "staggeredEntry"},
        "rise": {"animationType": "slideIn", "direction": "up"},
        "flip": {"animationType": "flip"},
        "none": {"animationType": "none"},
    }),
    "pageTransition": ("screenChange", _PAGE_KINDS),
    "modalOpen": ("sheet", _SHEET_KINDS),
    "addToCart": ("addToCart", {
        "fly": {"animationType": "flyToCart"},
        "bounce": {"animationType": "bounce"},
        "none": {"animationType": "none"},
    }),
}
#: Only with the "legacy" preset: the events that played the screens' / the windows' transition.
LEGACY_ONLY_KINDS: Dict[str, Tuple[str, Dict[str, Dict[str, Any]]]] = {
    "cartOpen": ("screenChange", _PAGE_KINDS),
    "homeReturn": ("screenChange", _PAGE_KINDS),
    "upsell": ("sheet", _SHEET_KINDS),
}

#: "legacy": the transitions' times by their kind at normal speed (kiosk_motion_timings.json).
_LEGACY_PAGE_MS = {"slideIn": 220, "fadeIn": 180, "fadeScale": 200, "swipeTransition": 260, "crossfade": 180}
_LEGACY_SHEET_MS = {"slideIn": 260, "fadeScale": 220, "fadeIn": 180, "expand": 220, "morph": 220}
LEGACY_DURATIONS: Dict[str, Dict[str, int]] = {
    "categorySwitch": {"slideIn": 240, "fadeIn": 200, "fadeScale": 220, "swipeTransition": 280, "crossfade": 200},
    "itemsEnter": {"staggeredEntry": 260, "fadeScale": 260, "slideIn": 280, "flip": 300, "fadeIn": 260},
    "pageTransition": _LEGACY_PAGE_MS,
    "cartOpen": _LEGACY_PAGE_MS,
    "homeReturn": _LEGACY_PAGE_MS,
    "modalOpen": _LEGACY_SHEET_MS,
    "upsell": _LEGACY_SHEET_MS,
}

#: The staggered entry's gap by the cards' kind, as a share of the event's staggerMs.
STAGGER_FACTORS: Dict[str, float] = {"staggeredEntry": 1.0, "fadeScale": 0.5, "slideIn": 0.75, "flip": 0.875, "fadeIn": 0.5}

#: The light profile: the screens, the category, the windows fade; no cascade of cards; the
#: celebration and the moving placeholders give way to their plain kind.
LIGHT_FADE_EVENTS: Tuple[str, ...] = ("categorySwitch", "pageTransition", "modalOpen", "cartOpen", "upsell", "homeReturn")
LIGHT_NONE_EVENTS: Tuple[str, ...] = ("itemsEnter",)
LIGHT_REPLACE: Dict[str, str] = {"confetti": "drawCheck", "parallaxLight": "floating", "skeletonShimmer": "none"}

#: Reduced motion's fade for the events that take something away.
LEAVING_EVENTS: Tuple[str, ...] = ("remove", "soldOut")


def round_half_up(x: float) -> int:
    """Rounding as every renderer does it (Kotlin roundToInt, JS Math.round): halves up."""
    return int(math.floor(x + 0.5))


def resolve_duration(global_multiplier: float, event_default: int, override: Optional[int] = None) -> int:
    """
    An event's duration (spec §7, §13): its explicit override as is — it ignores the global speed —
    else its default times the global multiplier. resolve_duration(1.30, 700) == 910;
    resolve_duration(1.30, 700, 1050) == 1050.
    """
    if override is not None:
        return int(override)
    return round_half_up(event_default * global_multiplier)


def preset_of(motion: Optional[Mapping[str, Any]]) -> str:
    p = (motion or {}).get("preset")
    return p if p in PRESETS else DEFAULT_PRESET


def global_multiplier(motion: Optional[Mapping[str, Any]], profile: str = "full") -> float:
    """
    The global speed: slow 1.30 / normal 1 / fast 0.75 / custom `speedMultiplier` (0.5–2); without
    `globalSpeed` the older `speed` (fast 0.75, normal 1, relaxed 1.35). The light profile caps it at
    the fast pace.
    """
    m = motion or {}
    gs = m.get("globalSpeed")
    if gs in SPEED_FACTORS:
        k = SPEED_FACTORS[gs]
    elif gs == "custom":
        raw = m.get("speedMultiplier")
        k = float(raw) if isinstance(raw, (int, float)) and not isinstance(raw, bool) else 1.0
        k = min(MULTIPLIER_MAX, max(MULTIPLIER_MIN, k))
    else:
        k = LEGACY_SPEED_FACTORS.get(m.get("speed"), 1.0)
    if profile == "light":
        k = min(k, LIGHT_MAX_MULTIPLIER)
    return k


def preset_values(preset: str, event: str) -> Dict[str, Any]:
    """The preset's own values of the event (before the older choices and the overrides)."""
    out = dict(STANDARD[event])
    out.update(PRESET_DELTAS.get(preset, {}).get(event, {}))
    return out


def _param_ok(event: str, name: str, value: Any) -> bool:
    kind, lo, hi = PARAMS[name]
    lo, hi = EVENT_PARAM_RANGES.get(event, {}).get(name, (lo, hi))
    if kind == "bool":
        return isinstance(value, bool)
    if kind == "type":
        return value in EVENT_TYPES[event]
    if kind == "enum":
        return value in lo
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    if kind == "int" and not float(value).is_integer():
        return False
    return lo <= value <= hi


def explicit_of(motion: Optional[Mapping[str, Any]], event: str) -> Dict[str, Any]:
    """The event's own values (`motion.events.<event>`) that are valid; the rest is ignored."""
    raw = ((motion or {}).get("events") or {}).get(event)
    if not isinstance(raw, Mapping):
        return {}
    return {k: v for k, v in raw.items() if k in PARAMS and v is not None and _param_ok(event, k, v)}


def resolve_event(
    motion: Optional[Mapping[str, Any]],
    event: str,
    *,
    reduce_motion: bool = False,
    profile: str = "full",
) -> Dict[str, Any]:
    """One event as the kiosk plays it (the module docstring's five steps)."""
    m = motion or {}
    preset = preset_of(m)
    base = preset_values(preset, event)
    kinds = LEGACY_KINDS.get(event) or (LEGACY_ONLY_KINDS.get(event) if preset == "legacy" else None)
    if kinds is not None:
        key, table = kinds
        old = m.get(key)
        if old in table:
            base.update(table[old])
    explicit = explicit_of(m, event)
    p = {**base, **explicit}
    kind = p["animationType"] if p["animationType"] in EVENT_TYPES[event] else STANDARD[event]["animationType"]
    if not p["enabled"]:
        kind = "none"
    k = global_multiplier(m, profile)
    if profile == "light" and not reduce_motion and kind != "none":
        if event in LIGHT_NONE_EVENTS:
            kind = "none"
        elif event in LIGHT_FADE_EVENTS:
            kind = "fadeIn"
        else:
            kind = LIGHT_REPLACE.get(kind, kind)
            if kind not in EVENT_TYPES[event]:
                kind = "none"
    base_ms = base["durationMs"]
    if preset == "legacy" and event in LEGACY_DURATIONS:
        base_ms = LEGACY_DURATIONS[event].get(kind, base_ms)
    duration = resolve_duration(k, base_ms, explicit.get("durationMs"))
    stagger_base = base["staggerMs"]
    if event == "itemsEnter":
        stagger_base = round_half_up(stagger_base * STAGGER_FACTORS.get(kind, 1.0))
    stagger = resolve_duration(k, stagger_base, explicit.get("staggerMs"))
    out = {
        "event": event,
        "enabled": bool(p["enabled"]),
        "animationType": kind,
        "durationMs": duration,
        "delayMs": resolve_duration(k, base["delayMs"], explicit.get("delayMs")),
        "direction": p["direction"],
        "intensity": int(p["intensity"]),
        "scaleFrom": float(p["scaleFrom"]),
        "scaleTo": float(p["scaleTo"]),
        "distancePx": int(p["distancePx"]),
        "easing": p["easing"],
        "repeat": int(p["repeat"]),
        "repeatDelayMs": resolve_duration(k, base["repeatDelayMs"], explicit.get("repeatDelayMs")),
        "holdMs": int(p["holdMs"]),
        "staggerMs": stagger if kind != "none" else 0,
        "staggerCapMs": 0,
        "autoAdvanceDelayMs": int(p["autoAdvanceDelayMs"]),
        "reducedMotionFallback": p["reducedMotionFallback"],
        "reduced": False,
    }
    if event == "remove":
        out["holdMs"] = max(out["holdMs"], REMOVE_MIN_HOLD_MS)
    if event == "itemsEnter" and kind != "none":
        out["staggerCapMs"] = round_half_up(LEGACY_STAGGER_CAP_MS * k) if preset == "legacy" else out["staggerMs"] * STAGGER_CAP_STEPS
    if kind == "none":
        out["durationMs"] = 0
    if reduce_motion and kind != "none":
        out = _reduced(out)
    return out


def _reduced(spec: Dict[str, Any]) -> Dict[str, Any]:
    """Reduced motion (spec §14): no movement; the event's fallback — a fade, a highlight, a colour change, or none."""
    fallback = spec["reducedMotionFallback"]
    out = dict(spec, reduced=True, direction="auto", scaleFrom=1.0, scaleTo=1.0, distancePx=0,
               staggerMs=0, staggerCapMs=0, delayMs=0, repeatDelayMs=0)
    if fallback == "none":
        out.update(animationType="none", durationMs=0, repeat=1)
        return out
    out["animationType"] = ("fadeOut" if spec["event"] in LEAVING_EVENTS else "fadeIn") if fallback == "fade" else "highlight"
    out["durationMs"] = round_half_up(spec["durationMs"] * REDUCED_FACTOR)
    # Never a loop that keeps pulsing (no flashing): once.
    out["repeat"] = 1
    return out


def resolve_all(motion: Optional[Mapping[str, Any]], *, reduce_motion: bool = False, profile: str = "full") -> Dict[str, Dict[str, Any]]:
    """Every event as the kiosk plays it."""
    return {e: resolve_event(motion, e, reduce_motion=reduce_motion, profile=profile) for e in EVENTS}


def speed_of_global(global_speed: Optional[str], multiplier: Any = None) -> str:
    """
    The older `speed` closest to a global speed (the dashboard writes both, so a kiosk with an
    older app keeps the pace): slow → relaxed, fast → fast, custom by its multiplier.
    """
    if global_speed == "slow":
        return "relaxed"
    if global_speed == "fast":
        return "fast"
    if global_speed == "custom" and isinstance(multiplier, (int, float)) and not isinstance(multiplier, bool):
        return "fast" if multiplier <= 0.85 else "relaxed" if multiplier >= 1.2 else "normal"
    return "normal"
