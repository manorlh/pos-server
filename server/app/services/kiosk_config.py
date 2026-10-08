"""
The self-order kiosk's config: defaults, validation, merge, version, fonts and media.

The config is JSON, camelCase on the wire, stored as PARTIAL override layers:
company → shop → machine (`kiosk_settings`). What a kiosk gets is

    DEFAULT_CONFIG ⊕ company ⊕ shop ⊕ machine

Merge: objects (and the id-keyed maps `texts`, `screenImages`, `catalog.productOrder`,
`catalog.categoryImages`) deep-merge; lists, MediaRefs and scalars replace. In a layer a
key whose value is `null` means "inherit" and is dropped on save. Unknown keys are refused
at every level.

Validation is driven by one declarative schema (`SCHEMA`) so the merge, the layer check,
the full check and the dashboard's limits (`limits()`) cannot drift apart. Errors are a
list of `{path, code, message}`: `path` is dotted with list indexes in brackets
(`messages[0].screens[1]`), `code` is a stable token for the dashboard, `message` a short
English explanation (for `kds_not_available` and `cash_not_supported` the message is the
token itself, as the contract names them).

A stored layer is never trusted blindly: `effective_config` drops whatever no longer
validates in a layer (a key the schema lost, a value out of a narrowed range) and repairs
the few cross-field rules a parent's later change can break below it (warningSec <
inactivitySec, pickup start < max, `bonMode: single` without a printer, the club's URL,
KDS while it is not available). So what a kiosk receives always validates.

KDS (docs/SPEC_KDS.md, docs/SPEC_LAN_MODE.md §8): `kds_available()` — the kitchen engine's
release API exists and every kiosk releases through it: a paid `fulfillmentMode: "KDS"` order
goes to `POST /sync/{id}/kds/release` (source "kiosk", no table) from the Android kiosk
(KdsBridge), the Windows kiosk and its bridge (kiosk-desktop kiosk/kdsRelease.ts), and — for a
browser kiosk's pay-at-till order — from the till that settles it (KioskPayAtTill). The
order's `fulfillment_mode` snapshot decides, never the kiosk's current config; the shop's
`kdsEnabled` must be on too.
"""
from __future__ import annotations

import copy
import hashlib
import json
import re
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from sqlalchemy.orm import Session

from app.services import kiosk_layout as layouts
from app.services import kiosk_motion as motion_engine

# ── The KDS hook ──────────────────────────────────────────────────────────────


def kds_available() -> bool:
    """
    Whether `fulfillmentMode: "KDS"` may be chosen: yes — every kiosk releases its paid KDS
    orders to the kitchen engine (the module docstring). Kept as a switch: False closes it
    again everywhere (the dashboard's choice, the kiosk's config, the KDS health alert).
    """
    return True


# ── The font catalog (contract §1.2) ─────────────────────────────────────────

_GF = "https://raw.githubusercontent.com/google/fonts/main"


@dataclass(frozen=True)
class KioskFont:
    id: str
    label: str
    css_family: str
    regular: Optional[str] = None
    bold: Optional[str] = None
    variable: bool = False

    def to_wire(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "label": self.label,
            "cssFamily": self.css_family,
            "regular": self.regular,
            "bold": self.bold,
            "variable": self.variable,
        }

    def files(self) -> List[str]:
        return [url for url in (self.regular, self.bold) if url]


FONT_CATALOG: Tuple[KioskFont, ...] = (
    KioskFont("system", "ברירת מחדל של המכשיר", "system-ui"),
    KioskFont("rubik", "Rubik", "Rubik", f"{_GF}/ofl/rubik/Rubik%5Bwght%5D.ttf", None, True),
    KioskFont("heebo", "Heebo", "Heebo", f"{_GF}/ofl/heebo/Heebo%5Bwght%5D.ttf", None, True),
    KioskFont("assistant", "Assistant", "Assistant", f"{_GF}/ofl/assistant/Assistant%5Bwght%5D.ttf", None, True),
    KioskFont(
        "noto_sans_hebrew", "Noto Sans Hebrew", "Noto Sans Hebrew",
        f"{_GF}/ofl/notosanshebrew/NotoSansHebrew%5Bwdth%2Cwght%5D.ttf", None, True,
    ),
    KioskFont("alef", "Alef", "Alef", f"{_GF}/ofl/alef/Alef-Regular.ttf", f"{_GF}/ofl/alef/Alef-Bold.ttf", False),
    KioskFont("varela_round", "Varela Round", "Varela Round", f"{_GF}/ofl/varelaround/VarelaRound-Regular.ttf"),
    KioskFont("secular_one", "Secular One", "Secular One", f"{_GF}/ofl/secularone/SecularOne-Regular.ttf"),
    KioskFont("suez_one", "Suez One", "Suez One", f"{_GF}/ofl/suezone/SuezOne-Regular.ttf"),
    KioskFont(
        "frank_ruhl_libre", "Frank Ruhl Libre", "Frank Ruhl Libre",
        f"{_GF}/ofl/frankruhllibre/FrankRuhlLibre%5Bwght%5D.ttf", None, True,
    ),
)
FONTS_BY_ID: Dict[str, KioskFont] = {f.id: f for f in FONT_CATALOG}


def fonts_wire() -> List[Dict[str, Any]]:
    return [f.to_wire() for f in FONT_CATALOG]


# ── Vocabularies and limits ──────────────────────────────────────────────────

FULFILLMENT_MODES = ("BON", "KDS")
#: "התראות לקופות" — which tills: the main till (else all the shop's), all, or a chosen list.
ALERT_TILLS = ("main", "all", "selected")
#: …and who on them: everyone signed in, or only a manager signed in.
ALERT_AUDIENCES = ("everyone", "managers")
#: "battery": a device's low battery (app/services/battery_alerts.py) — any device of the shop,
#: routed with the same settings.
ALERT_KINDS = ("printer", "terminal", "help", "battery")
ALERT_MACHINES_MAX = 50
#: A help request clears by itself after this many minutes (staff said "בדרך" or not).
HELP_CLEAR_MIN = 1
HELP_CLEAR_MAX = 120
SERVICE_TYPES = ("take_away", "eat_in")
LANGUAGES = ("he", "en", "ar", "ru")
SKIP_CART = ("off", "direct", "confirm")
SOLD_OUT_MODES = ("disable", "hide")
#: "מנוע תצוגה בקיוסק אנדרואיד": the APK's built-in screens, or the web screens bundle
#: (app releases of platform "kiosk_web", updated from the cloud without an APK install).
RENDERERS = ("native", "web")
THEME_MODES = ("light", "dark")
#: "רקע הקיוסק": where the background picture shows — behind every screen (the owner's request,
#: the default) or only on the rest screens (attract, the closed screens) as before.
BACKGROUND_SCOPES = ("all", "rest")
#: The background colour's veil over the picture, in percent (the attract screen at half).
BACKGROUND_OVERLAY_MIN, BACKGROUND_OVERLAY_MAX, BACKGROUND_OVERLAY_DEFAULT = 0, 90, 70
#: "גודל טקסט" per element, in percent over `typeScale` (80–150 by 10; 100 = as drawn today) —
#: the dashboard's TEXT_SIZE_KEYS and the till's KioskTextSizes; the shared golden
#: tests/fixtures/kiosk_theme_colors_golden.json pins them for all three.
TEXT_SIZE_KEYS = (
    "productName", "productDescription", "productPrice", "categoryName",
    "itemName", "itemDescription", "itemOptions", "cartLines", "buttons",
)
TEXT_SIZE_MIN, TEXT_SIZE_MAX, TEXT_SIZE_STEP, TEXT_SIZE_DEFAULT = 80, 150, 10, 100
CARD_STYLES = ("elevated", "outlined", "flat")
BUTTON_SHAPES = ("pill", "rounded", "square")
GRID_DENSITIES = ("compact", "comfortable", "large")
IMAGE_RATIOS = ("1:1", "4:3", "16:9")
CATEGORY_STYLES = ("chips", "tabs", "images")
#: Where the catalog's categories stand: a rail on the start side (right in RTL), scrolled on its
#: own, or the strip across the top. `categoryStyle` styles the top strip.
CATEGORY_LAYOUTS = ("side", "top")
#: "סגנון ממשק": a coherent bundle of layout and shape choices (and a few colours) a business
#: picks before styling anything itself — see UI_PRESETS. Its values sit between the defaults
#: and the layers: whatever a layer sets explicitly wins over the preset. "tech" ("טכנולוגי")
#: also draws a chrome the clients derive from the style (the dashboard's kioskChrome, the till's
#: KioskChrome): a grid backdrop, 1 dp outlines, a status line, tabular / monospaced figures.
UI_STYLES = ("ios", "wolt", "classic", "minimal_dark", "tech")
TYPE_SCALES = ("normal", "large", "xlarge")
TYPE_WEIGHTS = ("light", "regular", "bold")
#: The basket while ordering: the floating bar, or a side panel on a wide screen.
CART_STYLES = ("bar", "panel")
#: How much the screens move (add-to-cart flight, the badge's bounce). `general.reduceMotion`
#: turns it all off whatever this says.
ANIMATIONS = ("subtle", "lively")
#: "כפתור מסך הפתיחה" — the attract screen's call to action (attract.cta).
CTA_SIZES = ("s", "m", "l", "xl", "custom")
#: Physical places (the screen is the same whatever the language): a 3×3 grid, the full width
#: at the bottom, or `custom` at (x, y) — the button's centre in percent of the screen.
CTA_POSITIONS = (
    "top_right", "top_center", "top_left",
    "middle_right", "middle_center", "middle_left",
    "bottom_right", "bottom_center", "bottom_left",
    "bottom_full", "custom",
)
CTA_WEIGHTS = ("regular", "bold", "black")
CTA_ICONS = ("none", "cart", "arrow", "hand", "star")
CTA_ICON_POSITIONS = ("start", "end")
CTA_ANIMATIONS = ("none", "pulse", "glow", "bounce")
#: "הנפשות ומעברים" (config `motion`): one choice per transition — the dishes' grid when the
#: category changes, its cards coming in, the screens, the windows, the add-to-cart — and a speed
#: that scales them all. Each style's preset chooses (UI_PRESET_MOTION); `general.reduceMotion`
#: turns them all off on the kiosk.
MOTION_CATEGORY_SWITCH = ("slide", "fade", "fade_scale", "push", "none")
MOTION_ITEMS_ENTER = ("pop", "cascade", "rise", "flip", "none")
MOTION_SCREEN_CHANGE = ("slide", "fade", "zoom", "none")
MOTION_SHEET = ("slide_up", "scale", "fade", "none")
MOTION_ADD_TO_CART = ("fly", "bounce", "none")
MOTION_SPEEDS = ("fast", "normal", "relaxed")
#: "אפקטים" (`motion.effects`, the till's domain/KioskPerf.kt KioskPerfRules.EFFECTS): "auto" — the
#: device decides (its strength; on the web kiosks prefers-reduced-motion or a slow-frame probe),
#: "full" — every effect, "light" — the cheaper variant of each (no shadows, no cascade of cards,
#: fades at the fast pace, none of the tech style's glow and scan line). Not a style's choice.
MOTION_EFFECTS = ("auto", "full", "light")
#: The Motion Engine ("מנוע הנפשות", kiosk_motion.py): a preset of every event's timings, a global
#: speed (null: the older `speed` above), and each event's own values as overrides.
MOTION_PRESETS = motion_engine.PRESETS
MOTION_GLOBAL_SPEEDS = motion_engine.GLOBAL_SPEEDS
#: "כיתוב רץ" (config `ticker`): a slim strip whose texts scroll without end on the chosen screens,
#: under the header ("top") or above the basket / action bar ("bottom"). The dashboard's
#: src/lib/kioskConfig.ts TICKER_* and the till's domain/KioskTicker.kt mirror this.
TICKER_SCREENS = ("attract", "service", "catalog", "cart", "details", "pay", "success")
TICKER_POSITIONS = ("top", "bottom")
TICKER_SPEEDS = ("slow", "normal", "fast")
TICKER_SIZES = ("s", "m", "l")
TICKER_ITEMS_MAX = 20
TICKER_TEXT_MAX = 200
TEXT_KEYS = (
    "attractTitle", "attractSubtitle", "attractCta", "serviceTitle", "takeAwayLabel", "eatInLabel",
    "catalogTitle", "cartTitle", "checkoutCta", "payTitle", "payInstruction", "successTitle",
    "successBody", "pickupLabel", "customerTitle", "customerExplain", "pausedTitle", "pausedBody",
    "closedTitle", "closedBody", "helpText", "upsellTitle", "noPaymentTitle", "noPaymentBody",
    "offlineTitle", "offlineBody",
    # "רוצים להוסיף טיפ לצוות?": the tip step before the payment and its step bar.
    "tipCaption", "tipTitle", "tipSubtitle", "tipOtherLabel", "tipOtherHint", "tipOrderTotal", "tipLine",
    "tipTotal", "tipContinue", "tipSkip", "stepReview", "stepTip", "stepDetails", "stepPay", "tipOtherError",
    # "לאכול כאן או לקחת?": the service window.
    "serviceCaption", "serviceSubtitle", "takeAwaySub", "eatInSub", "serviceContinue", "serviceHint",
    # "איך לקרוא לכם?": the details window (name, phone, table).
    "detailsCaption", "nameTitle", "nameSubtitle", "nameLabel", "nameHint", "nameConfirm", "nameSkip",
    "phoneTitle", "phoneHint", "tableTitle", "entryContinue", "entrySkip", "fieldRequired", "phoneInvalid",
    # The kiosk's own keyboard.
    "kbSpace", "kbToEnglish", "kbToHebrew", "kbNumbers", "kbLettersHe", "kbLettersEn",
    # "ההזמנה שלי": the review before the payment ({n}: the number of items).
    "reviewHint", "reviewItems", "reviewItemsOne", "reviewSubtotal", "reviewTotal", "addMoreCta",
    # The search and the dish's note, typed in the same window.
    "searchTitle", "searchHint", "noteTitle", "noteHint", "noteSave",
    # The attract screen with its button hidden: the line in its place.
    "attractTouchHint",
    # Barcode scans on the kiosk: "המוצר לא נמצא", and a prepaid voucher scanned (sent to the counter).
    "scanNotFound", "scanVoucherAtTill",
    # "איך תרצו לשלם?" (docs/SPEC_KIOSK.md §23): the method choice, the voucher, paying at the
    # till — its slip and its screen. {amount}: ₪ amount; {number}: the pickup number.
    "stepPayMethod", "payMethodTitle", "payMethodSubtitle", "payCardLabel", "payCardSub",
    "payVoucherLabel", "payVoucherSub", "payCashLabel", "payCashSub", "remainingToPay",
    "voucherTitle", "voucherHint", "voucherApply", "voucherOffline", "voucherApplied", "voucherNoMatch",
    "voucherForfeit", "cashSlipTitle", "cashSlipFooter", "cashSlipPending", "cashDoneTitle", "cashDoneBody",
)
SCREEN_IMAGE_KEYS = ("service", "catalogHeader", "cart", "pay", "success", "paused")
#: "welcome" ("ברוכים הבאים", attract.welcome): its place among the blocks; a list without it shows
#: the block first, as before.
ATTRACT_SECTIONS = ("hero", "promos", "categories", "club", "welcome")
MESSAGE_KINDS = ("banner", "notice", "closed")
MESSAGE_SCREENS = ("attract", "service", "catalog", "cart", "pay", "success", "paused")
MESSAGE_STYLES = ("info", "promo", "warning", "success")
#: "card" on the external pinpad; "voucher" — a prepaid voucher redeemed online, the rest by
#: another method; "cash_at_till" — no document on the kiosk: a slip, and the till takes the
#: money (§23). Bare "cash" is refused (`cash_not_supported`): a kiosk has no cash hardware.
PAYMENT_METHODS = ("card", "voucher", "cash_at_till")
#: The methods that can pay what a voucher leaves: a voucher alone is never enough.
REMAINDER_METHODS = ("card", "cash_at_till")
CASH_AT_TILL_EXPIRY_MIN = (5, 240)
RECEIPT_POLICIES = ("always", "ask", "never")
CUSTOMER_FIELD_MODES = ("off", "optional", "required")
#: "סוג שירות": "types" — as `serviceTypes` says (asked with two, else every order is the one);
#: "none" — "ללא סוג שירות": never asked, and the order carries no service at all (no word on
#: the screens, the slip, the bon, the receipt or the KDS). `serviceTypes` is kept as it was.
SERVICE_MODES = ("types", "none")
#: "לקחת / לשבת": after "הזמינו כאן" (the current flow) or as two big buttons on the attract screen.
SERVICE_PLACEMENTS = ("after_start", "attract")
#: "לאכול כאן או לקחת?": a tap picks and "להמשך" goes on (default), or a tap goes on at once.
SERVICE_SELECTS = ("confirm", "instant")
#: When the kiosk asks the customer's name / phone / table: after the service choice, before
#: the cart, before payment (the current flow), or after payment.
DETAILS_STEPS = ("after_service", "before_cart", "before_pay", "after_pay")
#: "סדר השלבים לפני התשלום": the steps between the basket's review and the payment — the tip and
#: the customer's details (the name / phone window). Only their order: each is on by its own
#: settings (`tipEnabled`; the customer fields with `detailsStep` before_pay). "payMethod" — "איך
#: תרצו לשלם?", shown when more than one payment method is on — is always the last, right before
#: the payment (`repair` and the clients put it there).
CHECKOUT_STEPS = ("tip", "details", "payMethod")
#: "חובה / רשות / כבוי" per step (docs/SPEC_KIOSK_INSIGHTS.md §4) — the customer fields'
#: modes (CUSTOMER_FIELD_MODES: `customerName`, `customerPhone`, `tableNumber`) extended to the
#: other steps of the order: the service choice, the tip, "איך תרצו לשלם?" and the upsell
#: windows at each moment (after an item is added, at a step before the basket, before payment).
#: required — shown, and the customer must answer; optional — shown, may be passed with the
#: default answer; off — never shown (the default answer is taken). Each still needs its own
#: switch on (`tipEnabled`, `upsellEnabled`, more than one service / payment method).
STEP_MODE_KEYS = ("service", "tip", "payMethod", "upsellItem", "upsellSteps", "upsellCheckout")
#: "הגדלת מכירה" on the kiosk: the rules are the menu's (`upsell_rules`, place "kiosk" —
#: docs/SPEC_KIOSK.md §21); the kiosk keeps only its cap, the windows in one order.
UPSELL_MAX_SHOWN = 5
#: Keys a kiosk layer no longer has: dropped when read or sent, never refused (the kiosk's
#: own upsell rules of 06.10.2026, replaced by the menu's rules).
RETIRED_KEYS = (("upsell", "rules"), ("upsell", "when"))
SUCCESS_MESSAGE_MAX = 300
#: "לוגו במסך התשלום": the business's logo above the card step — as it is ("plain", for a
#: transparent PNG) or on a rounded light plate ("plate", for a logo with its own background).
WAIT_LOGO_STYLES = ("plain", "plate")
BON_MODES = ("routing", "single")
PICKUP_SCOPES = ("kiosk", "shop")
MEDIA_KINDS = ("image", "video", "font")

TEXT_MAX = 200
MESSAGES_MAX = 30
MESSAGE_TITLE_MAX = 80
MESSAGE_BODY_MAX = 300
PLAYLIST_MAX = 20
FEATURED_MAX = 12
HOURS_RANGES_MAX = 14
TIP_PRESETS_MAX = 4
URL_MAX = 1000
ID_LIST_MAX = 1000
ID_MAX = 64
PICKUP_PREFIX_MAX = 3
MIN_ORDER_MAX = 100_000_000

_HEX_COLOR = re.compile(r"^#[0-9A-Fa-f]{6}$")
_HHMM = re.compile(r"^([01][0-9]|2[0-3]):[0-5][0-9]$")
_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_MESSAGE_ID = re.compile(r"^[A-Za-z0-9_-]{1,40}$")
_PICKUP_PREFIX = re.compile(r"^[A-Za-z0-9א-ת-]{0,3}$")
_UUID = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")


# ── The defaults (contract §1, exactly) ──────────────────────────────────────

DEFAULT_CONFIG: Dict[str, Any] = {
    "general": {
        "fulfillmentMode": "BON",
        "serviceTypes": ["take_away", "eat_in"],
        # "ללא סוג שירות" is "none"; absent (every config stored before it) reads as "types".
        "serviceMode": "types",
        "askTableNumber": False,
        "languages": ["he"],
        "skipCart": "off",
        "upsellEnabled": True,
        # "לקחת / לשבת": after "הזמינו כאן" (default), or two big buttons on the attract screen.
        "servicePlacement": "after_start",
        # "לאכול כאן או לקחת?": a tap picks and "להמשך" goes on (default), or a tap goes on at once.
        "serviceSelect": "confirm",
        "searchEnabled": False,
        "notesEnabled": True,
        "quickNotesEnabled": True,
        "showAllergens": True,
        # "הצג סימוני תזונה ואלרגנים": the dietary badges (vegan, dairy…) and the allergens chip.
        "showDietary": True,
        # Accessibility: no add-to-cart flight, no bounces, no counting up.
        "reduceMotion": False,
        # "מצב שאין אינטרנט": a short sound on the kiosk when it loses the internet (off by default).
        "offlineSound": False,
        # No internet never stops the kiosk by itself (docs/SPEC_KIOSK.md §17): the order, the
        # documents and the Z are local, the card goes to the pinpad. "חסימת הזמנות כשאין
        # אינטרנט" brings back the old rule (no orders, no payment while offline); off.
        "blockWhenOffline": False,
        # "הודעה ללקוח כשאין אינטרנט": a quiet line to the customer while offline; off.
        "offlineNotice": False,
        "soldOutMode": "disable",
        # "מנוע תצוגה בקיוסק אנדרואיד": the Android kiosk's built-in screens ("native", default)
        # or the web screens bundle ("web"); admin, payments and printing stay native, and the
        # kiosk falls back to the built-in screens by itself if the web ones fail.
        "renderer": "native",
    },
    "theme": {
        "mode": "light",
        "font": "system",
        "primaryColor": "#1F6FEB",
        "accentColor": "#16A34A",
        "backgroundColor": None,
        "surfaceColor": None,
        "textColor": None,
        "buttonColor": None,
        "buttonTextColor": None,
        "backgroundImage": None,
        # "רקע הקיוסק": the picture veiled at 70 % (the attract screen at half), behind every screen.
        "backgroundOverlay": BACKGROUND_OVERLAY_DEFAULT,
        "backgroundScope": "all",
        "logo": None,
        "cornerRadius": 20,
        "cardStyle": "elevated",
        "buttonShape": "pill",
        "gridDensity": "comfortable",
        "imageRatio": "4:3",
        "categoryStyle": "chips",
        "categoryLayout": "side",
        "uiStyle": "wolt",
        "typeScale": "normal",
        "typeWeight": "bold",
        "cartStyle": "bar",
        "animation": "lively",
        "showDescriptions": True,
        # "גודל טקסט": every element as drawn today.
        "textSizes": {key: TEXT_SIZE_DEFAULT for key in TEXT_SIZE_KEYS},
    },
    "texts": {},
    "screenImages": {},
    "attract": {
        "sections": ["hero", "promos", "categories"],
        "playlist": [],
        "videoMuted": True,
        "showHelp": True,
        # The call to action ("הזמינו כאן" — its label is texts.attractCta). The defaults are
        # the "wolt" style's (UI_PRESET_CTA): the look the button had before it was configurable.
        "cta": {
            "size": "l", "widthPct": 80, "heightDp": 88,
            "position": "bottom_center", "x": 50, "y": 85,
            "fillColor": None, "textColor": None,
            "fontSize": 24, "fontWeight": "bold",
            # 0 square … 100 pill (percent of half the height); null: the theme's button shape.
            "radius": None,
            "borderColor": None, "borderWidth": 0, "shadow": True,
            "icon": "none", "iconPosition": "end",
            "animation": "pulse",
            "subtitle": "",
            # "כל המסך פותח הזמנה": a tap anywhere on the attract screen starts, as well as the button.
            "tapAnywhere": True,
            # The button is drawn; hidden, the whole screen starts (tapAnywhere must be on), with a
            # small line in its place (texts.attractTouchHint) unless `touchHint` is off.
            "visible": True,
            "touchHint": True,
        },
        # "ברוכים הבאים": the title block as it always was (kiosk_layout.WELCOME_DEFAULTS).
        "welcome": copy.deepcopy(layouts.WELCOME_DEFAULTS),
    },
    "catalog": {
        "categoryOrder": [],
        "hiddenCategories": [],
        "productOrder": {},
        "hiddenProducts": [],
        "categoryImages": {},
        "featuredProductIds": [],
        # "הצג כל מחלקה בנפרד": one category at a time, chosen from the rail (else one long list).
        "oneCategory": True,
        # A category's icon from the built-in set, by category id; none — suggested by its name.
        "categoryIconIds": {},
    },
    "messages": [],
    "hours": {
        "enabled": False,
        "ranges": [{"days": [0, 1, 2, 3, 4, 5, 6], "open": "08:00", "close": "23:00"}],
    },
    "payment": {
        "methods": ["card"],
        "tipEnabled": False,
        "tipPresets": [10, 12, 15],
        "receiptPolicy": "ask",
        "customerName": "optional",
        "customerPhone": "off",
        # The table number: asked of an eat-in order only. (`general.askTableNumber`, the older
        # switch, still asks it as optional.)
        "tableNumber": "off",
        # When name / phone / table are asked: after_service | before_cart | before_pay | after_pay.
        "detailsStep": "before_pay",
        "minOrderAgorot": 0,
        # "סכום אחר": a tip of the customer's own, in shekels, besides the presets.
        "tipOther": True,
        # The basket's review → these, in this order → the payment (each on by its own settings).
        "checkoutSteps": ["tip", "details", "payMethod"],
        # "חובה / רשות / כבוי" for the steps that are not a customer field (STEP_MODE_KEYS).
        "stepModes": {
            "service": "required", "tip": "optional", "payMethod": "required",
            "upsellItem": "optional", "upsellSteps": "optional", "upsellCheckout": "optional",
        },
        # "תשלום בקופה" (§23): an open order not paid at a till within this many minutes expires.
        "cashAtTillExpiryMin": 30,
        # "שלח למטבח לפני תשלום": the kiosk prints the bon of an order to pay at the till at once
        # (off: the till sends it when it takes the money).
        "cashAtTillKitchenBeforePay": False,
        # "לוגו במסך התשלום": its own upload (POST /kiosks/media), shown at the top of the screens
        # that wait for the payment; no picture — nothing shows.
        "waitLogo": {"media": None, "style": "plain"},
    },
    # "הגדלת מכירה": the menu's rules for the kiosk (§21); at most `maxShown` windows in one order.
    "upsell": {"maxShown": 2},
    # "הודעת סיום": shown on the success screen for `timers.successSec`.
    "success": {"message": "", "image": None},
    # "הנפשות ומעברים": the "wolt" style's (UI_PRESET_MOTION) — the category slides in and its
    # dishes pop in one after another; the add-to-cart is the pop-and-fly.
    "motion": {
        "categorySwitch": "slide", "itemsEnter": "cascade", "screenChange": "slide",
        "sheet": "scale", "addToCart": "fly", "speed": "normal",
        # "אפקטים": the device decides (MOTION_EFFECTS); no style sets it.
        "effects": "auto",
        # "מנוע הנפשות" (kiosk_motion.py): Runner Standard for a new kiosk (a kiosk from before the
        # engine is stamped "legacy" by migration b3e7c1a9d5f2); the global speed follows `speed`
        # until a level sets one; no event of its own.
        "preset": motion_engine.DEFAULT_PRESET,
        "globalSpeed": None,
        "speedMultiplier": 1.0,
        "events": {},
    },
    # "כיתוב רץ": off; once on, on the menu and the basket, under the header, slowly (readable),
    # in the theme's button colours (null), medium text; a finger on it does not stop it.
    "ticker": {
        "enabled": False, "items": [], "screens": ["catalog", "cart"], "position": "top",
        "speed": "slow", "backgroundColor": None, "textColor": None, "size": "m", "pauseOnTouch": False,
    },
    "printing": {
        "bonMode": "routing",
        "bonPrinterId": None,
        "bonCopies": 1,
        "receiptPrinterId": None,
        # The small customer slip with the pickup number, on the receipt printer —
        # independent of `payment.receiptPolicy`.
        "pickupSlip": True,
        # An unprinted bon prints again by itself when the printer comes back — once, and only
        # when younger than this many minutes (docs/SPEC_KIOSK.md §16.8); 0: never by itself.
        "bonAutoRetryMin": 10,
        # "בון מטבח במדפסת הקיוסק" (docs/SPEC_KIOSK.md §5, the owner 07.10.2026): may the kiosk's own
        # printer take its kitchen bon — when it has no kitchen printer (its USB printer, §14), and the
        # routing's share for "this till"? Off by default, so every kiosk — an existing one too — gets
        # it off: the bon never prints on the kiosk; a kitchen printer that does not answer keeps it in
        # its queue and the staff's alert. `bonMode: "single"` with a named printer is unchanged.
        "bonOnKiosk": False,
    },
    "pickup": {"scope": "kiosk", "prefix": "", "start": 1, "max": 999},
    "timers": {"inactivitySec": 60, "warningSec": 20, "successSec": 12, "attractSlideSec": 8},
    "club": {"enabled": False, "joinUrl": "", "title": "", "body": ""},
    "operations": {"autoCloseAt": "", "pausedTitle": "", "pausedBody": "", "closeWithShopZ": False},
    # "התראות לקופות" (docs/SPEC_KIOSK.md §16): where the kiosk's alerts go — the printer
    # (bon / receipt: offline, no paper, USB detached), the card terminal (no connection,
    # not ready, a card result left for staff) and the customer's "בקשת עזרה". Per kind:
    # which tills (`main` — the shop's main till if it has one, else all its tills; `all`;
    # `selected` — `machineIds`) and who sees it (`everyone` signed in, or `managers` only).
    "alerts": {
        "printer": {"tills": "main", "machineIds": [], "audience": "everyone"},
        "terminal": {"tills": "main", "machineIds": [], "audience": "everyone"},
        "help": {"tills": "main", "machineIds": [], "audience": "everyone", "clearAfterMin": 10},
        # "סוללה חלשה" of any device of the shop (a handheld, a tablet, a kiosk with a battery).
        "battery": {"tills": "main", "machineIds": [], "audience": "everyone"},
    },
    # "מבנה הקיוסק" (kiosk_layout.py): standard — the layout of today.
    "layout": copy.deepcopy(layouts.LAYOUT_DEFAULTS),
    # Every customer text in the other languages (`textsByLang[lang][key]`); the first language is `texts`.
    "textsByLang": {},
}


def default_config() -> Dict[str, Any]:
    return copy.deepcopy(DEFAULT_CONFIG)


#: "סגנון ממשק" presets (the dashboard's src/lib/kioskConfig.ts KIOSK_UI_PRESETS and the till's
#: domain/KioskAppConfig.kt KioskUiPresets mirror this table). Each sets the theme's layout and
#: shape keys — and a few colours where the style is about them — between the defaults and
#: the layers. "wolt" is the look kiosks had before presets existed.
UI_PRESETS: Dict[str, Dict[str, Any]] = {
    "ios": {
        "mode": "light", "font": "system",
        "primaryColor": "#0A84FF", "accentColor": "#34C759",
        "backgroundColor": "#F2F2F7", "surfaceColor": "#FFFFFF", "textColor": None,
        "cornerRadius": 16, "cardStyle": "elevated", "buttonShape": "rounded",
        "gridDensity": "comfortable", "imageRatio": "4:3",
        "categoryStyle": "tabs", "categoryLayout": "side",
        "typeScale": "large", "typeWeight": "regular",
        "cartStyle": "bar", "animation": "subtle", "showDescriptions": True,
    },
    "wolt": {
        "mode": "light", "font": "system",
        "primaryColor": "#1F6FEB", "accentColor": "#16A34A",
        "backgroundColor": None, "surfaceColor": None, "textColor": None,
        "cornerRadius": 20, "cardStyle": "elevated", "buttonShape": "pill",
        "gridDensity": "comfortable", "imageRatio": "4:3",
        "categoryStyle": "chips", "categoryLayout": "side",
        "typeScale": "normal", "typeWeight": "bold",
        "cartStyle": "bar", "animation": "lively", "showDescriptions": True,
    },
    "classic": {
        "mode": "light", "font": "heebo",
        "primaryColor": "#E11D48", "accentColor": "#F59E0B",
        "backgroundColor": "#FFFFFF", "surfaceColor": "#FFFFFF", "textColor": "#000000",
        "cornerRadius": 6, "cardStyle": "outlined", "buttonShape": "square",
        "gridDensity": "large", "imageRatio": "1:1",
        "categoryStyle": "images", "categoryLayout": "side",
        "typeScale": "xlarge", "typeWeight": "bold",
        "cartStyle": "panel", "animation": "subtle", "showDescriptions": False,
    },
    "minimal_dark": {
        "mode": "dark", "font": "assistant",
        "primaryColor": "#C9A227", "accentColor": "#C9A227",
        "backgroundColor": "#0B0B0D", "surfaceColor": "#16161A", "textColor": "#F5F5F4",
        "cornerRadius": 8, "cardStyle": "flat", "buttonShape": "rounded",
        "gridDensity": "comfortable", "imageRatio": "4:3",
        "categoryStyle": "tabs", "categoryLayout": "side",
        "typeScale": "normal", "typeWeight": "light",
        "cartStyle": "bar", "animation": "subtle", "showDescriptions": True,
    },
    # "טכנולוגי": near-black, one electric accent (the brand colour, dark words on it), a semi-tone
    # surface for the panels, 1 dp outlines instead of shadows, sharp corners.
    "tech": {
        "mode": "dark", "font": "heebo",
        "primaryColor": "#22E1FF", "accentColor": "#22E1FF",
        "backgroundColor": "#0B0F14", "surfaceColor": "#111821", "textColor": "#E6EDF3",
        "cornerRadius": 10, "cardStyle": "outlined", "buttonShape": "rounded",
        "gridDensity": "comfortable", "imageRatio": "4:3",
        "categoryStyle": "tabs", "categoryLayout": "side",
        "typeScale": "normal", "typeWeight": "regular",
        "cartStyle": "bar", "animation": "subtle", "showDescriptions": True,
    },
}

#: The theme keys a preset decides (unless a layer sets them).
PRESET_THEME_KEYS = tuple(UI_PRESETS["wolt"].keys())

#: Each style's call to action on the attract screen ("כפתור מסך הפתיחה"): the keys it decides
#: (the rest are the defaults'). Explicit values in any layer win, as for the theme.
UI_PRESET_CTA: Dict[str, Dict[str, Any]] = {
    "ios": {
        "size": "l", "position": "bottom_center", "fontSize": 22, "fontWeight": "bold",
        "shadow": False, "icon": "none", "iconPosition": "end", "animation": "none",
        "borderColor": None, "borderWidth": 0,
    },
    "wolt": {
        "size": "l", "position": "bottom_center", "fontSize": 24, "fontWeight": "bold",
        "shadow": True, "icon": "none", "iconPosition": "end", "animation": "pulse",
        "borderColor": None, "borderWidth": 0,
    },
    "classic": {
        "size": "xl", "position": "bottom_center", "fontSize": 34, "fontWeight": "black",
        "shadow": True, "icon": "cart", "iconPosition": "start", "animation": "bounce",
        "borderColor": None, "borderWidth": 0,
    },
    "minimal_dark": {
        "size": "m", "position": "bottom_center", "fontSize": 22, "fontWeight": "regular",
        "shadow": False, "icon": "arrow", "iconPosition": "end", "animation": "glow",
        "borderColor": "#C9A227", "borderWidth": 1,
    },
    # Crisp and still: the attract screen's idle motion is the style's scan line (the clients' chrome).
    "tech": {
        "size": "l", "position": "bottom_center", "fontSize": 22, "fontWeight": "bold",
        "shadow": False, "icon": "arrow", "iconPosition": "end", "animation": "none",
        "borderColor": None, "borderWidth": 0,
    },
}
PRESET_CTA_KEYS = tuple(UI_PRESET_CTA["wolt"].keys())

#: Each style's transitions ("הנפשות ומעברים"; the dashboard's KIOSK_UI_PRESET_MOTION and the
#: till's KioskMotionConfig.PRESETS). In every style the category's grid moves and its dishes pop
#: in; the add-to-cart stays the pop-and-fly (docs/SPEC_KIOSK.md §18). Explicit values win.
UI_PRESET_MOTION: Dict[str, Dict[str, Any]] = {
    "ios": {"categorySwitch": "slide", "itemsEnter": "pop", "screenChange": "slide", "sheet": "slide_up", "addToCart": "fly", "speed": "normal"},
    "wolt": {"categorySwitch": "slide", "itemsEnter": "cascade", "screenChange": "slide", "sheet": "scale", "addToCart": "fly", "speed": "normal"},
    "classic": {"categorySwitch": "push", "itemsEnter": "pop", "screenChange": "fade", "sheet": "scale", "addToCart": "fly", "speed": "normal"},
    "minimal_dark": {
        "categorySwitch": "fade_scale", "itemsEnter": "cascade", "screenChange": "fade", "sheet": "fade",
        "addToCart": "fly", "speed": "normal",
    },
    # Crisp and cheap: opacity for the screens and the category, the cards in one after another.
    "tech": {
        "categorySwitch": "fade", "itemsEnter": "cascade", "screenChange": "fade", "sheet": "scale",
        "addToCart": "fly", "speed": "normal",
    },
}
PRESET_MOTION_KEYS = tuple(UI_PRESET_MOTION["wolt"].keys())


def style_of(*layers: Optional[Dict[str, Any]]) -> str:
    """The "סגנון ממשק" the layers pick, the last that says; the default style otherwise."""
    style = DEFAULT_CONFIG["theme"]["uiStyle"]
    for layer in layers:
        picked = ((layer or {}).get("theme") or {}).get("uiStyle")
        if picked in UI_PRESETS:
            style = picked
    return style


def preset_layer(style: str) -> Dict[str, Any]:
    """The style's preset as a layer: its theme keys, its attract button and its transitions."""
    default = DEFAULT_CONFIG["theme"]["uiStyle"]
    theme = UI_PRESETS.get(style) or UI_PRESETS[default]
    cta = UI_PRESET_CTA.get(style) or UI_PRESET_CTA[default]
    motion = UI_PRESET_MOTION.get(style) or UI_PRESET_MOTION[default]
    return {"theme": copy.deepcopy(theme), "attract": {"cta": copy.deepcopy(cta)}, "motion": copy.deepcopy(motion)}


# ── Errors ───────────────────────────────────────────────────────────────────


@dataclass
class Issue:
    path: str
    code: str
    message: str

    def to_wire(self) -> Dict[str, str]:
        return {"path": self.path, "code": self.code, "message": self.message}


class KioskConfigInvalid(ValueError):
    """The config (or a layer) does not validate; `errors` is the list for the 422."""

    def __init__(self, errors: List[Issue]):
        super().__init__("invalid_kiosk_config")
        self.errors = errors

    def detail(self) -> Dict[str, Any]:
        return {"code": "invalid_kiosk_config", "errors": [e.to_wire() for e in self.errors]}


def _join(path: str, key: str) -> str:
    return f"{path}.{key}" if path else key


def _index(path: str, i: int) -> str:
    return f"{path}[{i}]"


# ── The schema ───────────────────────────────────────────────────────────────


class Node:
    """A schema node. `check` validates a complete value; returns it normalised."""

    nullable: bool = False
    #: Objects and maps deep-merge; everything else replaces.
    merges: bool = False

    def check(self, value: Any, path: str, errors: List[Issue]) -> Any:  # pragma: no cover - abstract
        raise NotImplementedError

    def check_layer(self, value: Any, path: str, errors: List[Issue]) -> Any:
        """A layer's value at this node: complete for a leaf; partial for an object / map."""
        return self.check(value, path, errors)


_INVALID = object()


def _fail(errors: List[Issue], path: str, code: str, message: str) -> Any:
    errors.append(Issue(path, code, message))
    return _INVALID


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


class Bool(Node):
    def check(self, value, path, errors):
        if not isinstance(value, bool):
            return _fail(errors, path, "invalid_type", "must be true or false")
        return value


class Int(Node):
    def __init__(self, lo: int, hi: int, nullable: bool = False, step: int = 1):
        self.lo, self.hi, self.nullable, self.step = lo, hi, nullable, step

    def check(self, value, path, errors):
        if value is None and self.nullable:
            return None
        if not _is_int(value):
            return _fail(errors, path, "invalid_type", "must be an integer")
        if not self.lo <= value <= self.hi:
            return _fail(errors, path, "out_of_range", f"must be between {self.lo} and {self.hi}")
        if self.step > 1 and (value - self.lo) % self.step:
            return _fail(errors, path, "invalid_step", f"must be in steps of {self.step}")
        return value


class Str(Node):
    def __init__(self, max_len: int, *, min_len: int = 0, pattern: Optional[re.Pattern] = None,
                 pattern_message: str = "invalid format", nullable: bool = False):
        self.max_len, self.min_len, self.pattern = max_len, min_len, pattern
        self.pattern_message, self.nullable = pattern_message, nullable

    def check(self, value, path, errors):
        if value is None and self.nullable:
            return None
        if not isinstance(value, str):
            return _fail(errors, path, "invalid_type", "must be a string")
        if len(value) > self.max_len:
            return _fail(errors, path, "too_long", f"at most {self.max_len} characters")
        if len(value) < self.min_len:
            return _fail(errors, path, "required", f"at least {self.min_len} characters")
        if self.pattern is not None and not self.pattern.match(value):
            return _fail(errors, path, "invalid_format", self.pattern_message)
        return value


class Enum(Node):
    def __init__(self, values: Sequence[str], nullable: bool = False):
        self.values, self.nullable = tuple(values), nullable

    def check(self, value, path, errors):
        if value is None and self.nullable:
            return None
        if not isinstance(value, str) or value not in self.values:
            return _fail(errors, path, "invalid_value", f"must be one of: {', '.join(self.values)}")
        return value


class Color(Node):
    def __init__(self, nullable: bool = False):
        self.nullable = nullable

    def check(self, value, path, errors):
        if value is None and self.nullable:
            return None
        if not isinstance(value, str) or not _HEX_COLOR.match(value):
            return _fail(errors, path, "invalid_color", "must be a colour #RRGGBB")
        return value


class HHMM(Node):
    def __init__(self, allow_empty: bool = False, nullable: bool = False):
        self.allow_empty = allow_empty
        self.nullable = nullable

    def check(self, value, path, errors):
        if self.allow_empty and value == "":
            return value
        if self.nullable and value is None:
            return value
        if not isinstance(value, str) or not _HHMM.match(value):
            return _fail(errors, path, "invalid_time", "must be a time HH:MM" + (' or ""' if self.allow_empty else ""))
        return value


class IsoDateTime(Node):
    def __init__(self, nullable: bool = True):
        self.nullable = nullable

    def check(self, value, path, errors):
        if value is None and self.nullable:
            return None
        if not isinstance(value, str) or not value:
            return _fail(errors, path, "invalid_datetime", "must be an ISO date-time")
        try:
            datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return _fail(errors, path, "invalid_datetime", "must be an ISO date-time")
        return value


def _http_url_ok(value: Any) -> bool:
    return (
        isinstance(value, str)
        and 0 < len(value) <= URL_MAX
        and (value.startswith("https://") or value.startswith("http://"))
        and len(value) > len("https://")
        and not any(ch.isspace() for ch in value)
    )


class Media(Node):
    """MediaRef = {url (http/https, ≤1000), kind, sha256 (64 lowercase hex) | null, bytes | null}."""

    merges = False
    KEYS = ("url", "kind", "sha256", "bytes")

    def __init__(self, kinds: Sequence[str], nullable: bool = False):
        self.kinds, self.nullable = tuple(kinds), nullable

    def check(self, value, path, errors):
        if value is None and self.nullable:
            return None
        if not isinstance(value, dict):
            return _fail(errors, path, "invalid_media", "must be a media reference {url, kind, sha256, bytes}")
        before = len(errors)
        for key in value:
            if key not in self.KEYS:
                _fail(errors, _join(path, str(key)), "unknown_key", "unknown key")
        url = value.get("url")
        if not _http_url_ok(url):
            _fail(errors, _join(path, "url"), "invalid_url", f"must be an http(s) URL of at most {URL_MAX} characters")
        kind = value.get("kind")
        if kind not in self.kinds:
            _fail(errors, _join(path, "kind"), "invalid_value", f"must be one of: {', '.join(self.kinds)}")
        sha = value.get("sha256")
        if sha is not None and (not isinstance(sha, str) or not _SHA256.match(sha)):
            _fail(errors, _join(path, "sha256"), "invalid_sha256", "must be 64 lowercase hex characters or null")
        size = value.get("bytes")
        if size is not None and (not _is_int(size) or size < 0):
            _fail(errors, _join(path, "bytes"), "invalid_type", "must be a non-negative integer or null")
        if len(errors) > before:
            return _INVALID
        return {"url": url, "kind": kind, "sha256": sha, "bytes": size}


class UList(Node):
    """A list (replaced whole by a layer). `unique` refuses duplicates."""

    def __init__(self, item: Node, *, min_len: int = 0, max_len: int = ID_LIST_MAX, unique: bool = False):
        self.item, self.min_len, self.max_len, self.unique = item, min_len, max_len, unique

    def check(self, value, path, errors):
        if not isinstance(value, list):
            return _fail(errors, path, "invalid_type", "must be a list")
        before = len(errors)
        if len(value) > self.max_len:
            _fail(errors, path, "too_many", f"at most {self.max_len} items")
        if len(value) < self.min_len:
            _fail(errors, path, "too_few", f"at least {self.min_len} item(s)")
        out = []
        seen = set()
        for i, item in enumerate(value):
            cleaned = self.item.check(item, _index(path, i), errors)
            if cleaned is _INVALID:
                continue
            if self.unique:
                marker = json.dumps(cleaned, sort_keys=True)
                if marker in seen:
                    _fail(errors, _index(path, i), "duplicate", "duplicate value")
                    continue
                seen.add(marker)
            out.append(cleaned)
        if len(errors) > before:
            return _INVALID
        return out


class Obj(Node):
    """
    An object with fixed keys. Complete (`check`): every key required unless it has a
    `fill` default (list items), unknown keys refused. As a layer (`check_layer`): every
    key optional, `null` = inherit (dropped), unknown keys refused.
    """

    merges = True

    def __init__(self, fields: Dict[str, Node], *, fill: Optional[Dict[str, Any]] = None, merges: bool = True):
        self.fields = fields
        self.fill = fill or {}
        self.merges = merges

    def check(self, value, path, errors):
        if not isinstance(value, dict):
            return _fail(errors, path, "invalid_type", "must be an object")
        before = len(errors)
        out: Dict[str, Any] = {}
        for key in value:
            if key not in self.fields:
                _fail(errors, _join(path, str(key)), "unknown_key", "unknown key")
        for key, node in self.fields.items():
            if key in value:
                raw = value[key]
            elif key in self.fill:
                raw = copy.deepcopy(self.fill[key])
            else:
                _fail(errors, _join(path, key), "required", "required")
                continue
            cleaned = node.check(raw, _join(path, key), errors)
            if cleaned is not _INVALID:
                out[key] = cleaned
        if len(errors) > before:
            return _INVALID
        return out

    def check_layer(self, value, path, errors):
        if not isinstance(value, dict):
            return _fail(errors, path, "invalid_type", "must be an object")
        out: Dict[str, Any] = {}
        for key, raw in value.items():
            node = self.fields.get(key)
            if node is None:
                _fail(errors, _join(path, str(key)), "unknown_key", "unknown key")
                continue
            if raw is None:
                continue  # inherit
            cleaned = node.check_layer(raw, _join(path, key), errors) if node.merges else node.check(
                raw, _join(path, key), errors
            )
            if cleaned is not _INVALID:
                out[key] = cleaned
        return out


class Map(Node):
    """An id-keyed object (`texts`, `screenImages`, `productOrder`, `categoryImages`)."""

    merges = True

    def __init__(self, value: Node, *, keys: Optional[Sequence[str]] = None, max_keys: int = ID_LIST_MAX):
        self.value, self.keys, self.max_keys = value, tuple(keys) if keys else None, max_keys

    def _key_ok(self, key: Any) -> bool:
        if self.keys is not None:
            return key in self.keys
        return isinstance(key, str) and 0 < len(key) <= ID_MAX

    def _walk(self, value, path, errors, layer: bool):
        if not isinstance(value, dict):
            return _fail(errors, path, "invalid_type", "must be an object")
        before = len(errors)
        if len(value) > self.max_keys:
            _fail(errors, path, "too_many", f"at most {self.max_keys} keys")
        out: Dict[str, Any] = {}
        for key, raw in value.items():
            if not self._key_ok(key):
                _fail(errors, _join(path, str(key)), "unknown_key", "unknown key")
                continue
            if raw is None and (layer or self.value.nullable):
                if not layer:
                    out[key] = None
                continue  # in a layer: inherit
            # A map of maps (`textsByLang`): in a layer the inner one is partial too.
            if layer and self.value.merges:
                cleaned = self.value.check_layer(raw, _join(path, key), errors)
            else:
                cleaned = self.value.check(raw, _join(path, key), errors)
            if cleaned is not _INVALID:
                out[key] = cleaned
        if not layer and len(errors) > before:
            return _INVALID
        return out

    def check(self, value, path, errors):
        return self._walk(value, path, errors, layer=False)

    def check_layer(self, value, path, errors):
        return self._walk(value, path, errors, layer=True)


class Num(Node):
    """A number (int or float, never a bool) in [lo, hi]; kept as a float."""

    def __init__(self, lo: float, hi: float, nullable: bool = False):
        self.lo, self.hi, self.nullable = lo, hi, nullable

    def check(self, value, path, errors):
        if value is None and self.nullable:
            return None
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return _fail(errors, path, "invalid_type", "must be a number")
        if not self.lo <= value <= self.hi:
            return _fail(errors, path, "out_of_range", f"must be between {self.lo} and {self.hi}")
        return float(value)


class PrunedObj(Obj):
    """An object whose layer drops a child object it leaves empty (`{"events": {"addToCart": {}}}` sets nothing)."""

    def check_layer(self, value, path, errors):
        out = super().check_layer(value, path, errors)
        if isinstance(out, dict):
            out = {k: v for k, v in out.items() if not (isinstance(v, dict) and v == {} and isinstance(self.fields.get(k), Obj))}
        return out


class PartialObj(PrunedObj):
    """An object every key of which is optional, also when complete (an event's own values: only what is set)."""

    def check(self, value, path, errors):
        if not isinstance(value, dict):
            return _fail(errors, path, "invalid_type", "must be an object")
        before = len(errors)
        out: Dict[str, Any] = {}
        for key, raw in value.items():
            node = self.fields.get(key)
            if node is None:
                _fail(errors, _join(path, str(key)), "unknown_key", "unknown key")
                continue
            if raw is None:
                continue
            cleaned = node.check(raw, _join(path, key), errors)
            if cleaned is not _INVALID:
                out[key] = cleaned
        if len(errors) > before:
            return _INVALID
        return out


def _motion_event_node(event: str) -> PartialObj:
    """`motion.events.<event>`: the parameters of kiosk_motion.PARAMS, its own kinds, its own ranges."""
    fields: Dict[str, Node] = {}
    narrow = motion_engine.EVENT_PARAM_RANGES.get(event, {})
    for name, (kind, lo, hi) in motion_engine.PARAMS.items():
        lo, hi = narrow.get(name, (lo, hi))
        if kind == "bool":
            fields[name] = Bool()
        elif kind == "type":
            fields[name] = Enum(motion_engine.EVENT_TYPES[event])
        elif kind == "enum":
            fields[name] = Enum(lo)
        elif kind == "int":
            fields[name] = Int(lo, hi)
        else:
            fields[name] = Num(lo, hi)
    return PartialObj(fields)


ID = Str(ID_MAX, min_len=1)
PRINTER_ID = Str(36, min_len=36, pattern=_UUID, pattern_message="must be a printer id (UUID)", nullable=True)

#: "התראות לקופות": one route per alert kind (printer / terminal / help).
ALERT_ROUTE_FIELDS = {
    "tills": Enum(ALERT_TILLS),
    "machineIds": UList(
        Str(36, min_len=36, pattern=_UUID, pattern_message="must be a till id (UUID)"),
        max_len=ALERT_MACHINES_MAX, unique=True,
    ),
    "audience": Enum(ALERT_AUDIENCES),
}
ALERT_ROUTE = Obj(dict(ALERT_ROUTE_FIELDS))

MESSAGE = Obj(
    {
        "id": Str(40, min_len=1, pattern=_MESSAGE_ID, pattern_message="1-40 characters of A-Z a-z 0-9 _ -"),
        "kind": Enum(MESSAGE_KINDS),
        "enabled": Bool(),
        "title": Str(MESSAGE_TITLE_MAX),
        "body": Str(MESSAGE_BODY_MAX),
        "image": Media(("image",), nullable=True),
        "screens": UList(Enum(MESSAGE_SCREENS), max_len=len(MESSAGE_SCREENS), unique=True),
        "style": Enum(MESSAGE_STYLES),
        "productId": Str(ID_MAX, min_len=1, nullable=True),
        "startsAt": IsoDateTime(),
        "endsAt": IsoDateTime(),
    },
    fill={
        "enabled": True, "title": "", "body": "", "image": None, "screens": ["attract", "catalog"],
        "style": "promo", "productId": None, "startsAt": None, "endsAt": None,
    },
    merges=False,
)

#: One text of "כיתוב רץ": its hours of the day (`to` before `from` runs past midnight, as the
#: opening hours), its days and, as a message, its dates — all optional.
TICKER_ITEM = Obj(
    {
        "id": Str(40, min_len=1, pattern=_MESSAGE_ID, pattern_message="1-40 characters of A-Z a-z 0-9 _ -"),
        "text": Str(TICKER_TEXT_MAX),
        "enabled": Bool(),
        "from": HHMM(nullable=True),
        "to": HHMM(nullable=True),
        "days": UList(Int(0, 6), min_len=1, max_len=7, unique=True),
        "startsAt": IsoDateTime(),
        "endsAt": IsoDateTime(),
    },
    fill={
        "enabled": True, "from": None, "to": None, "days": [0, 1, 2, 3, 4, 5, 6],
        "startsAt": None, "endsAt": None,
    },
    merges=False,
)

PLAYLIST_ITEM = Obj(
    {"media": Media(("image", "video")), "durationSec": Int(2, 120)},
    fill={"durationSec": 8},
    merges=False,
)

HOURS_RANGE = Obj(
    {
        "days": UList(Int(0, 6), min_len=1, max_len=7, unique=True),
        "open": HHMM(),
        #: null: "פתיחה אוטומטית" with no closing time — it opens, and never closes by itself.
        "close": HHMM(nullable=True),
    },
    merges=False,
)

SCHEMA = Obj({
    "general": Obj({
        "fulfillmentMode": Enum(FULFILLMENT_MODES),
        "serviceTypes": UList(Enum(SERVICE_TYPES), min_len=1, max_len=len(SERVICE_TYPES), unique=True),
        "serviceMode": Enum(SERVICE_MODES),
        "askTableNumber": Bool(),
        "languages": UList(Enum(LANGUAGES), min_len=1, max_len=len(LANGUAGES), unique=True),
        "skipCart": Enum(SKIP_CART),
        "upsellEnabled": Bool(),
        "servicePlacement": Enum(SERVICE_PLACEMENTS),
        "serviceSelect": Enum(SERVICE_SELECTS),
        "searchEnabled": Bool(),
        "notesEnabled": Bool(),
        "quickNotesEnabled": Bool(),
        "showAllergens": Bool(),
        "showDietary": Bool(),
        "reduceMotion": Bool(),
        "offlineSound": Bool(),
        "blockWhenOffline": Bool(),
        "offlineNotice": Bool(),
        "soldOutMode": Enum(SOLD_OUT_MODES),
        "renderer": Enum(RENDERERS),
    }),
    "theme": Obj({
        "mode": Enum(THEME_MODES),
        "font": Enum(tuple(FONTS_BY_ID)),
        "primaryColor": Color(),
        "accentColor": Color(),
        "backgroundColor": Color(nullable=True),
        "surfaceColor": Color(nullable=True),
        "textColor": Color(nullable=True),
        "buttonColor": Color(nullable=True),
        "buttonTextColor": Color(nullable=True),
        "backgroundImage": Media(("image",), nullable=True),
        "backgroundOverlay": Int(BACKGROUND_OVERLAY_MIN, BACKGROUND_OVERLAY_MAX),
        "backgroundScope": Enum(BACKGROUND_SCOPES),
        "logo": Media(("image",), nullable=True),
        "cornerRadius": Int(0, 40),
        "cardStyle": Enum(CARD_STYLES),
        "buttonShape": Enum(BUTTON_SHAPES),
        "gridDensity": Enum(GRID_DENSITIES),
        "imageRatio": Enum(IMAGE_RATIOS),
        "categoryStyle": Enum(CATEGORY_STYLES),
        "categoryLayout": Enum(CATEGORY_LAYOUTS),
        "uiStyle": Enum(UI_STYLES),
        "typeScale": Enum(TYPE_SCALES),
        "typeWeight": Enum(TYPE_WEIGHTS),
        "cartStyle": Enum(CART_STYLES),
        "animation": Enum(ANIMATIONS),
        "showDescriptions": Bool(),
        "textSizes": Obj({key: Int(TEXT_SIZE_MIN, TEXT_SIZE_MAX, step=TEXT_SIZE_STEP) for key in TEXT_SIZE_KEYS}),
    }),
    # The first language's texts: the keys of before, and every text of the registry (kiosk_layout.py).
    "texts": Map(Str(TEXT_MAX), keys=TEXT_KEYS + tuple(k for k in layouts.text_keys() if k not in TEXT_KEYS)),
    # The other languages: `textsByLang[lang][key]` (its own `max` and placeholders: _texts_cross_field).
    "textsByLang": Map(Map(Str(TEXT_MAX, nullable=True), keys=layouts.text_keys() or ("_",)), keys=layouts.TEXT_LANGUAGES),
    "screenImages": Map(Media(("image",), nullable=True), keys=SCREEN_IMAGE_KEYS),
    "attract": Obj({
        "sections": UList(Enum(ATTRACT_SECTIONS), max_len=len(ATTRACT_SECTIONS), unique=True),
        "playlist": UList(PLAYLIST_ITEM, max_len=PLAYLIST_MAX),
        "videoMuted": Bool(),
        "showHelp": Bool(),
        "cta": Obj({
            "size": Enum(CTA_SIZES),
            "widthPct": Int(20, 100),
            "heightDp": Int(56, 200),
            "position": Enum(CTA_POSITIONS),
            "x": Int(0, 100),
            "y": Int(0, 100),
            "fillColor": Color(nullable=True),
            "textColor": Color(nullable=True),
            "fontSize": Int(14, 64),
            "fontWeight": Enum(CTA_WEIGHTS),
            "radius": Int(0, 100, nullable=True),
            "borderColor": Color(nullable=True),
            "borderWidth": Int(0, 8),
            "shadow": Bool(),
            "icon": Enum(CTA_ICONS),
            "iconPosition": Enum(CTA_ICON_POSITIONS),
            "animation": Enum(CTA_ANIMATIONS),
            "subtitle": Str(80),
            "tapAnywhere": Bool(),
            "visible": Bool(),
            "touchHint": Bool(),
        }),
        # "ברוכים הבאים" (kiosk_layout.WELCOME_DEFAULTS).
        "welcome": Obj({
            "enabled": Bool(),
            "position": Enum(layouts.WELCOME_POSITIONS),
            "align": Enum(layouts.WELCOME_ALIGNS),
            "size": Enum(layouts.WELCOME_SIZES),
            "weight": Enum(layouts.WELCOME_WEIGHTS),
            "titleColor": Color(nullable=True),
            "subtitleColor": Color(nullable=True),
            "backdrop": Enum(layouts.WELCOME_BACKDROPS),
            "showSubtitle": Bool(),
            "maxWidthPct": Int(*layouts.WELCOME_WIDTH_PCT),
        }),
    }),
    "catalog": Obj({
        "categoryOrder": UList(ID, unique=True),
        "hiddenCategories": UList(ID, unique=True),
        "productOrder": Map(UList(ID, unique=True)),
        "hiddenProducts": UList(ID, unique=True),
        "categoryImages": Map(Media(("image",))),
        "featuredProductIds": UList(ID, max_len=FEATURED_MAX, unique=True),
        "oneCategory": Bool(),
        "categoryIconIds": Map(Enum(layouts.category_icon_ids() or ("dine",))),
    }),
    "messages": UList(MESSAGE, max_len=MESSAGES_MAX),
    "hours": Obj({
        "enabled": Bool(),
        "ranges": UList(HOURS_RANGE, max_len=HOURS_RANGES_MAX),
    }),
    "payment": Obj({
        # "cash" is refused with its own code (`_cross_field`), before the enum would.
        "methods": UList(Str(32, min_len=1), min_len=1, max_len=4, unique=True),
        "tipEnabled": Bool(),
        "tipPresets": UList(Int(1, 50), max_len=TIP_PRESETS_MAX, unique=True),
        "receiptPolicy": Enum(RECEIPT_POLICIES),
        "customerName": Enum(CUSTOMER_FIELD_MODES),
        "customerPhone": Enum(CUSTOMER_FIELD_MODES),
        "tableNumber": Enum(CUSTOMER_FIELD_MODES),
        "detailsStep": Enum(DETAILS_STEPS),
        "minOrderAgorot": Int(0, MIN_ORDER_MAX),
        "tipOther": Bool(),
        "checkoutSteps": UList(Enum(CHECKOUT_STEPS), max_len=len(CHECKOUT_STEPS), unique=True),
        "stepModes": Obj({key: Enum(CUSTOMER_FIELD_MODES) for key in STEP_MODE_KEYS}),
        "cashAtTillExpiryMin": Int(*CASH_AT_TILL_EXPIRY_MIN),
        "cashAtTillKitchenBeforePay": Bool(),
        "waitLogo": Obj({
            "media": Media(("image",), nullable=True),
            "style": Enum(WAIT_LOGO_STYLES),
        }),
    }),
    "upsell": Obj({
        "maxShown": Int(1, UPSELL_MAX_SHOWN),
    }),
    "success": Obj({
        "message": Str(SUCCESS_MESSAGE_MAX),
        "image": Media(("image",), nullable=True),
    }),
    "motion": PrunedObj({
        "categorySwitch": Enum(MOTION_CATEGORY_SWITCH),
        "itemsEnter": Enum(MOTION_ITEMS_ENTER),
        "screenChange": Enum(MOTION_SCREEN_CHANGE),
        "sheet": Enum(MOTION_SHEET),
        "addToCart": Enum(MOTION_ADD_TO_CART),
        "speed": Enum(MOTION_SPEEDS),
        "effects": Enum(MOTION_EFFECTS),
        # "מנוע הנפשות" (kiosk_motion.py). A config stored before it has none of these (filled).
        "preset": Enum(MOTION_PRESETS),
        "globalSpeed": Enum(MOTION_GLOBAL_SPEEDS, nullable=True),
        "speedMultiplier": Num(motion_engine.MULTIPLIER_MIN, motion_engine.MULTIPLIER_MAX),
        "events": PrunedObj(
            {e: _motion_event_node(e) for e in motion_engine.EVENTS},
            fill={e: {} for e in motion_engine.EVENTS},
        ),
    }, fill={
        "preset": motion_engine.DEFAULT_PRESET, "globalSpeed": None, "speedMultiplier": 1.0, "events": {},
    }),
    "ticker": Obj({
        "enabled": Bool(),
        # A list replaces whole, as `messages` (a level sets all of its texts, or inherits them).
        "items": UList(TICKER_ITEM, max_len=TICKER_ITEMS_MAX),
        "screens": UList(Enum(TICKER_SCREENS), max_len=len(TICKER_SCREENS), unique=True),
        "position": Enum(TICKER_POSITIONS),
        "speed": Enum(TICKER_SPEEDS),
        "backgroundColor": Color(nullable=True),
        "textColor": Color(nullable=True),
        "size": Enum(TICKER_SIZES),
        "pauseOnTouch": Bool(),
    }),
    "printing": Obj({
        "bonMode": Enum(BON_MODES),
        "bonPrinterId": PRINTER_ID,
        "bonCopies": Int(1, 3),
        "receiptPrinterId": PRINTER_ID,
        "pickupSlip": Bool(),
        "bonAutoRetryMin": Int(0, 120),
        "bonOnKiosk": Bool(),
    }),
    "pickup": Obj({
        "scope": Enum(PICKUP_SCOPES),
        "prefix": Str(PICKUP_PREFIX_MAX, pattern=_PICKUP_PREFIX, pattern_message="up to 3 of A-Z a-z 0-9 א-ת -"),
        "start": Int(1, 9998),
        "max": Int(2, 9999),
    }),
    "timers": Obj({
        "inactivitySec": Int(15, 600),
        "warningSec": Int(5, 120),
        "successSec": Int(4, 120),
        "attractSlideSec": Int(3, 60),
    }),
    "club": Obj({
        "enabled": Bool(),
        "joinUrl": Str(URL_MAX),
        "title": Str(MESSAGE_TITLE_MAX),
        "body": Str(MESSAGE_BODY_MAX),
    }),
    "operations": Obj({
        "autoCloseAt": HHMM(allow_empty=True),
        "pausedTitle": Str(MESSAGE_TITLE_MAX),
        "pausedBody": Str(MESSAGE_BODY_MAX),
        # "סגירה יחד עם ה-Z הסניפי": the shop's Z closes the kiosk's shift and its own Z.
        "closeWithShopZ": Bool(),
    }),
    "alerts": Obj({
        "printer": ALERT_ROUTE,
        "terminal": ALERT_ROUTE,
        "help": Obj({**ALERT_ROUTE_FIELDS, "clearAfterMin": Int(HELP_CLEAR_MIN, HELP_CLEAR_MAX)}),
        "battery": ALERT_ROUTE,
    }),
    # "מבנה הקיוסק" (kiosk_layout.py): where things sit and how the order goes.
    "layout": Obj({
        "template": Enum(layouts.LAYOUT_TEMPLATE_IDS),
        "catalog": Enum(layouts.LAYOUT_CATALOGS, nullable=True),
        "categoryIcons": Enum(layouts.LAYOUT_CATEGORY_ICONS, nullable=True),
        "railSize": Enum(layouts.LAYOUT_RAIL_SIZES),
        "landingColumns": Int(min(layouts.LAYOUT_LANDING_COLUMNS), max(layouts.LAYOUT_LANDING_COLUMNS)),
        "productSize": Enum(layouts.LAYOUT_PRODUCT_SIZES),
        "landingShowCounts": Bool(),
        "hero": Enum(layouts.LAYOUT_HEROES),
        "magazineFeed": Bool(),
        "card": Enum(layouts.LAYOUT_CARDS, nullable=True),
        "flow": Enum(layouts.LAYOUT_FLOWS),
        "itemView": Enum(layouts.LAYOUT_ITEM_VIEWS),
        "quickAdd": Enum(layouts.LAYOUT_QUICK_ADDS),
        "mealView": Enum(layouts.LAYOUT_MEAL_VIEWS),
        "mealUpsell": Enum(layouts.LAYOUT_MEAL_UPSELLS),
        "basket": Enum(layouts.LAYOUT_BASKETS, nullable=True),
        "service": Enum(layouts.LAYOUT_SERVICES),
        "name": Enum(layouts.LAYOUT_NAMES),
        "nameAvatars": UList(Str(layouts.NAME_AVATAR_MAX, min_len=1), max_len=layouts.NAME_AVATARS_MAX, unique=True),
        "reach": Enum(layouts.LAYOUT_REACHES),
        "reachToggle": Bool(),
    }),
})


def limits() -> Dict[str, Any]:
    """The ranges and vocabularies validation uses, for the dashboard's form (`GET /kiosks/defaults`)."""
    return {
        "theme": {
            "cornerRadius": {"min": 0, "max": 40},
            "backgroundOverlay": {"min": BACKGROUND_OVERLAY_MIN, "max": BACKGROUND_OVERLAY_MAX},
            "textSize": {"min": TEXT_SIZE_MIN, "max": TEXT_SIZE_MAX, "step": TEXT_SIZE_STEP, "keys": list(TEXT_SIZE_KEYS)},
        },
        "timers": {
            "inactivitySec": {"min": 15, "max": 600},
            "warningSec": {"min": 5, "max": 120, "lessThan": "inactivitySec"},
            "successSec": {"min": 4, "max": 120},
            "attractSlideSec": {"min": 3, "max": 60},
        },
        "attract": {"playlistMax": PLAYLIST_MAX, "durationSec": {"min": 2, "max": 120}},
        "catalog": {"featuredMax": FEATURED_MAX, "idListMax": ID_LIST_MAX},
        "messages": {
            "max": MESSAGES_MAX, "titleMax": MESSAGE_TITLE_MAX, "bodyMax": MESSAGE_BODY_MAX,
            "idPattern": _MESSAGE_ID.pattern,
        },
        "texts": {"max": TEXT_MAX},
        "hours": {"rangesMax": HOURS_RANGES_MAX},
        "upsell": {"maxShown": {"min": 1, "max": UPSELL_MAX_SHOWN}},
        "success": {"messageMax": SUCCESS_MESSAGE_MAX},
        "payment": {
            "tipPresets": {"min": 1, "max": 50, "maxCount": TIP_PRESETS_MAX},
            "minOrderAgorot": {"min": 0, "max": MIN_ORDER_MAX},
        },
        "printing": {"bonCopies": {"min": 1, "max": 3}},
        "pickup": {"start": {"min": 1}, "max": {"max": 9999}, "prefixMax": PICKUP_PREFIX_MAX,
                   "prefixPattern": _PICKUP_PREFIX.pattern},
        "operations": {"pausedTitleMax": MESSAGE_TITLE_MAX, "pausedBodyMax": MESSAGE_BODY_MAX},
        "alerts": {
            "kinds": list(ALERT_KINDS),
            "tills": list(ALERT_TILLS),
            "audiences": list(ALERT_AUDIENCES),
            "machinesMax": ALERT_MACHINES_MAX,
            "helpClearAfterMin": {"min": HELP_CLEAR_MIN, "max": HELP_CLEAR_MAX},
        },
        "club": {"titleMax": MESSAGE_TITLE_MAX, "bodyMax": MESSAGE_BODY_MAX},
        "ticker": {
            "itemsMax": TICKER_ITEMS_MAX, "textMax": TICKER_TEXT_MAX,
            "screens": list(TICKER_SCREENS), "positions": list(TICKER_POSITIONS),
            "speeds": list(TICKER_SPEEDS), "sizes": list(TICKER_SIZES),
        },
        "media": {"urlMax": URL_MAX, "kinds": list(MEDIA_KINDS)},
        "enums": {
            "fulfillmentMode": list(FULFILLMENT_MODES),
            "serviceTypes": list(SERVICE_TYPES),
            "serviceMode": list(SERVICE_MODES),
            "languages": list(LANGUAGES),
            "skipCart": list(SKIP_CART),
            "soldOutMode": list(SOLD_OUT_MODES),
            "renderer": list(RENDERERS),
            "themeMode": list(THEME_MODES),
            "backgroundScope": list(BACKGROUND_SCOPES),
            "cardStyle": list(CARD_STYLES),
            "buttonShape": list(BUTTON_SHAPES),
            "gridDensity": list(GRID_DENSITIES),
            "imageRatio": list(IMAGE_RATIOS),
            "categoryStyle": list(CATEGORY_STYLES),
            "categoryLayout": list(CATEGORY_LAYOUTS),
            "uiStyle": list(UI_STYLES),
            "typeScale": list(TYPE_SCALES),
            "typeWeight": list(TYPE_WEIGHTS),
            "cartStyle": list(CART_STYLES),
            "animation": list(ANIMATIONS),
            "ctaSize": list(CTA_SIZES),
            "ctaPosition": list(CTA_POSITIONS),
            "ctaWeight": list(CTA_WEIGHTS),
            "ctaIcon": list(CTA_ICONS),
            "ctaAnimation": list(CTA_ANIMATIONS),
            "attractSections": list(ATTRACT_SECTIONS),
            "messageKinds": list(MESSAGE_KINDS),
            "messageScreens": list(MESSAGE_SCREENS),
            "messageStyles": list(MESSAGE_STYLES),
            "paymentMethods": list(PAYMENT_METHODS),
            "receiptPolicy": list(RECEIPT_POLICIES),
            "customerFieldModes": list(CUSTOMER_FIELD_MODES),
            "bonMode": list(BON_MODES),
            "pickupScope": list(PICKUP_SCOPES),
            "servicePlacement": list(SERVICE_PLACEMENTS),
            "waitLogoStyle": list(WAIT_LOGO_STYLES),
            "serviceSelect": list(SERVICE_SELECTS),
            "detailsStep": list(DETAILS_STEPS),
            "checkoutSteps": list(CHECKOUT_STEPS),
            "stepModes": list(STEP_MODE_KEYS),
            "motionCategorySwitch": list(MOTION_CATEGORY_SWITCH),
            "motionItemsEnter": list(MOTION_ITEMS_ENTER),
            "motionScreenChange": list(MOTION_SCREEN_CHANGE),
            "motionSheet": list(MOTION_SHEET),
            "motionAddToCart": list(MOTION_ADD_TO_CART),
            "motionSpeed": list(MOTION_SPEEDS),
            "motionEffects": list(MOTION_EFFECTS),
            "motionPreset": list(MOTION_PRESETS),
            "motionGlobalSpeed": list(MOTION_GLOBAL_SPEEDS),
            "fonts": [f.id for f in FONT_CATALOG],
        },
        # "מנוע הנפשות": the events, the kinds each can play, every parameter's range (kiosk_motion.py).
        "motionEngine": {
            "events": list(motion_engine.EVENTS),
            "eventTypes": {e: list(t) for e, t in motion_engine.EVENT_TYPES.items()},
            "directions": list(motion_engine.DIRECTIONS),
            "easings": list(motion_engine.EASINGS),
            "fallbacks": list(motion_engine.FALLBACKS),
            "speedFactors": dict(motion_engine.SPEED_FACTORS),
            "speedMultiplier": {"min": motion_engine.MULTIPLIER_MIN, "max": motion_engine.MULTIPLIER_MAX},
            "params": {
                name: {"min": lo, "max": hi}
                for name, (kind, lo, hi) in motion_engine.PARAMS.items() if kind in ("int", "num")
            },
            "eventParams": {e: {n: {"min": lo, "max": hi} for n, (lo, hi) in r.items()} for e, r in motion_engine.EVENT_PARAM_RANGES.items()},
        },
        "textKeys": list(TEXT_KEYS),
        # "מבנה הקיוסק": the vocabulary, the templates, which ones the clients draw, "ברוכים הבאים".
        "layout": {
            "vocabulary": {k: list(v) for k, v in layouts.LAYOUT_VOCABULARY.items()},
            "templates": layouts.LAYOUT_TEMPLATES,
            "ready": list(layouts.LAYOUT_TEMPLATES_READY),
            "nameAvatarsMax": layouts.NAME_AVATARS_MAX,
            "welcome": {
                "positions": list(layouts.WELCOME_POSITIONS), "aligns": list(layouts.WELCOME_ALIGNS),
                "sizes": list(layouts.WELCOME_SIZES), "weights": list(layouts.WELCOME_WEIGHTS),
                "backdrops": list(layouts.WELCOME_BACKDROPS), "maxWidthPct": list(layouts.WELCOME_WIDTH_PCT),
            },
        },
        "categoryIconIds": list(layouts.category_icon_ids()),
        "textRegistryKeys": list(layouts.text_keys()),
        "screenImageKeys": list(SCREEN_IMAGE_KEYS),
    }


# ── Cross-field rules (on a complete config) ─────────────────────────────────


def _get(cfg: Dict[str, Any], *keys: str) -> Any:
    node: Any = cfg
    for key in keys:
        if not isinstance(node, dict):
            return None
        node = node.get(key)
    return node


def _cross_field(cfg: Dict[str, Any], errors: List[Issue]) -> None:
    if _get(cfg, "general", "fulfillmentMode") == "KDS" and not kds_available():
        errors.append(Issue("general.fulfillmentMode", "kds_not_available", "kds_not_available"))

    # The attract button hidden: only the whole screen can start an order.
    if _get(cfg, "attract", "cta", "visible") is False and _get(cfg, "attract", "cta", "tapAnywhere") is not True:
        errors.append(Issue("attract.cta.tapAnywhere", "required_when_hidden", "a hidden button needs the whole screen to start an order"))

    methods = _get(cfg, "payment", "methods")
    if isinstance(methods, list):
        for i, method in enumerate(methods):
            if method == "cash":
                errors.append(Issue(_index("payment.methods", i), "cash_not_supported", "cash_not_supported"))
            elif method not in PAYMENT_METHODS:
                errors.append(Issue(
                    _index("payment.methods", i), "invalid_value", f"must be one of: {', '.join(PAYMENT_METHODS)}"
                ))
        # A voucher pays what it covers; the rest needs card or the till (§23).
        if "voucher" in methods and not any(m in REMAINDER_METHODS for m in methods):
            errors.append(Issue("payment.methods", "voucher_needs_method", "voucher needs card or cash_at_till too"))

    if _get(cfg, "payment", "tipEnabled") is True and _get(cfg, "payment", "tipPresets") == []:
        errors.append(Issue("payment.tipPresets", "too_few", "at least one preset when tips are on"))

    inactivity, warning = _get(cfg, "timers", "inactivitySec"), _get(cfg, "timers", "warningSec")
    if _is_int(inactivity) and _is_int(warning) and warning >= inactivity:
        errors.append(Issue("timers.warningSec", "must_be_less", "must be less than timers.inactivitySec"))

    start, top = _get(cfg, "pickup", "start"), _get(cfg, "pickup", "max")
    if _is_int(start) and _is_int(top) and start >= top:
        errors.append(Issue("pickup.start", "must_be_less", "must be less than pickup.max"))

    if _get(cfg, "printing", "bonMode") == "single" and not _get(cfg, "printing", "bonPrinterId"):
        errors.append(Issue("printing.bonPrinterId", "required", "required when bonMode is single"))

    club = _get(cfg, "club")
    if isinstance(club, dict) and club.get("enabled") is True:
        url = club.get("joinUrl")
        if not url:
            errors.append(Issue("club.joinUrl", "required", "required when the club is enabled"))
        elif isinstance(url, str) and not _http_url_ok(url):
            errors.append(Issue("club.joinUrl", "invalid_url", "must be an http(s) URL when the club is enabled"))

    messages = _get(cfg, "messages")
    if isinstance(messages, list):
        seen = set()
        for i, message in enumerate(messages):
            if not isinstance(message, dict):
                continue
            mid = message.get("id")
            if mid in seen:
                errors.append(Issue(_index("messages", i) + ".id", "duplicate", "duplicate message id"))
            seen.add(mid)
            if message.get("productId") is not None and message.get("kind") != "banner":
                errors.append(Issue(_index("messages", i) + ".productId", "banner_only", "only a banner opens a product"))
            starts, ends = _parse_dt(message.get("startsAt")), _parse_dt(message.get("endsAt"))
            if starts is not None and ends is not None:
                try:
                    later = ends > starts
                except TypeError:  # one naive, one aware
                    later = ends.replace(tzinfo=None) > starts.replace(tzinfo=None)
                if not later:
                    errors.append(Issue(_index("messages", i) + ".endsAt", "must_be_after", "must be after startsAt"))

    ranges = _get(cfg, "hours", "ranges")
    if isinstance(ranges, list):
        for i, r in enumerate(ranges):
            if isinstance(r, dict) and r.get("open") is not None and r.get("open") == r.get("close"):
                errors.append(Issue(_index("hours.ranges", i) + ".close", "must_differ", "must differ from open"))
    if _get(cfg, "hours", "enabled") is True and ranges == []:
        errors.append(Issue("hours.ranges", "too_few", "at least one range when hours are enabled"))

    # "התראות לקופות": a chosen list must name at least one till.
    for kind in ALERT_KINDS:
        if _get(cfg, "alerts", kind, "tills") == "selected" and not _get(cfg, "alerts", kind, "machineIds"):
            errors.append(Issue(f"alerts.{kind}.machineIds", "too_few", "choose at least one till"))

    _ticker_cross_field(cfg, errors)
    _texts_cross_field(cfg, errors)


def _texts_cross_field(cfg: Dict[str, Any], errors: List[Issue]) -> None:
    """`textsByLang`: each text within its own `max` (the registry's) and only its own placeholders."""
    by_lang = _get(cfg, "textsByLang")
    if not isinstance(by_lang, dict):
        return
    registry = layouts.text_registry()
    for lang, texts in by_lang.items():
        if not isinstance(texts, dict):
            continue
        for key, value in texts.items():
            definition = registry.get(key)
            if definition is None or not isinstance(value, str):
                continue
            path = f"textsByLang.{lang}.{key}"
            limit = int(definition.get("max") or TEXT_MAX)
            if len(value) > limit:
                errors.append(Issue(path, "too_long", f"at most {limit} characters"))
            unknown = [p for p in layouts.placeholders_in(value) if p not in (definition.get("placeholders") or [])]
            if unknown:
                errors.append(Issue(path, "unknown_placeholder", f"unknown placeholder {{{unknown[0]}}}"))


def _ticker_cross_field(cfg: Dict[str, Any], errors: List[Issue]) -> None:
    """"כיתוב רץ": one id per text, an hour window that is not empty, dates in order."""
    items = _get(cfg, "ticker", "items")
    if not isinstance(items, list):
        return
    seen = set()
    for i, item in enumerate(items):
        if not isinstance(item, dict):
            continue
        path = _index("ticker.items", i)
        tid = item.get("id")
        if tid in seen:
            errors.append(Issue(path + ".id", "duplicate", "duplicate ticker text id"))
        seen.add(tid)
        if item.get("from") is not None and item.get("from") == item.get("to"):
            errors.append(Issue(path + ".to", "must_differ", "must differ from from"))
        starts, ends = _parse_dt(item.get("startsAt")), _parse_dt(item.get("endsAt"))
        if starts is not None and ends is not None:
            try:
                later = ends > starts
            except TypeError:  # one naive, one aware
                later = ends.replace(tzinfo=None) > starts.replace(tzinfo=None)
            if not later:
                errors.append(Issue(path + ".endsAt", "must_be_after", "must be after startsAt"))


def _parse_dt(value: Any) -> Optional[datetime]:
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


# ── Public: validate, merge, effective ───────────────────────────────────────


def validate_layer(overrides: Any) -> Tuple[Dict[str, Any], List[Issue]]:
    """
    A partial layer as the dashboard sends it: `(cleaned, errors)`. `cleaned` has the
    `null`s dropped (inherit) and list items normalised; invalid parts are left out.
    """
    errors: List[Issue] = []
    cleaned = SCHEMA.check_layer(_without_retired(overrides), "", errors)
    if cleaned is _INVALID:
        cleaned = {}
    return _prune_empty(cleaned), errors


def _without_retired(layer: Any) -> Any:
    """The layer without RETIRED_KEYS (a copy; the rest untouched)."""
    if not isinstance(layer, dict):
        return layer
    out = dict(layer)
    for section, key in RETIRED_KEYS:
        part = out.get(section)
        if isinstance(part, dict) and key in part:
            out[section] = {k: v for k, v in part.items() if k != key}
    return out


def _prune_empty(layer: Dict[str, Any]) -> Dict[str, Any]:
    """Drop objects a layer left empty (`{"theme": {}}` overrides nothing)."""
    out = {}
    for key, value in layer.items():
        node = SCHEMA.fields.get(key)
        if isinstance(value, dict) and value == {} and isinstance(node, Obj):
            continue
        out[key] = value
    return out


def validate_config(cfg: Any) -> List[Issue]:
    """A complete config (the effective one): every rule, cross-field ones included."""
    errors: List[Issue] = []
    SCHEMA.check(cfg, "", errors)
    _cross_field(cfg if isinstance(cfg, dict) else {}, errors)
    return _dedupe(errors)


def _dedupe(errors: Iterable[Issue]) -> List[Issue]:
    seen, out = set(), []
    for e in errors:
        key = (e.path, e.code)
        if key not in seen:
            seen.add(key)
            out.append(e)
    return out


def _merge_node(node: Node, base: Any, layer: Any) -> Any:
    if isinstance(node, Obj) and node.merges and isinstance(base, dict) and isinstance(layer, dict):
        out = dict(base)
        for key, value in layer.items():
            child = node.fields.get(key)
            if child is None or value is None:
                continue
            out[key] = _merge_node(child, base.get(key), value) if key in base else copy.deepcopy(value)
        return out
    if isinstance(node, Map) and isinstance(base, dict) and isinstance(layer, dict):
        out = dict(base)
        for key, value in layer.items():
            if value is None:
                continue
            # A map of maps (`textsByLang`): each language merges key by key, as the dashboard's.
            if node.value.merges and isinstance(base.get(key), dict) and isinstance(value, dict):
                out[key] = _merge_node(node.value, base[key], value)
            else:
                out[key] = copy.deepcopy(value)
        return out
    return copy.deepcopy(layer)


def merge(base: Dict[str, Any], *layers: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """base ⊕ layers, in order: objects deep-merge, lists / MediaRefs / scalars replace, null inherits."""
    out = copy.deepcopy(base)
    for layer in layers:
        if layer:
            out = _merge_node(SCHEMA, out, layer)
    return out


def sanitize_stored_layer(overrides: Any) -> Dict[str, Any]:
    """A stored layer with whatever no longer validates dropped (never raises)."""
    if not isinstance(overrides, dict):
        return {}
    cleaned, _errors = validate_layer(overrides)
    return cleaned


def step_mode(cfg: Dict[str, Any], key: str) -> str:
    """
    A step's effective mode ("חובה / רשות / כבוי", STEP_MODE_KEYS or a customer field): its own
    switch first — one service type, tips off, one payment method, upsell off — then its mode.
    The kiosks apply the same rule (KioskStepModes.kt, kioskConfig.ts `stepMode`).
    """
    general, payment = cfg.get("general") or {}, cfg.get("payment") or {}
    if key in ("customerName", "customerPhone", "tableNumber"):
        mode = payment.get(key)
        return mode if mode in CUSTOMER_FIELD_MODES else "off"
    mode = (payment.get("stepModes") or {}).get(key)
    mode = mode if mode in CUSTOMER_FIELD_MODES else DEFAULT_CONFIG["payment"]["stepModes"].get(key, "optional")
    if key == "service" and (len(general.get("serviceTypes") or []) <= 1 or general.get("serviceMode") == "none"):
        return "off"
    if key == "tip" and not (payment.get("tipEnabled") and (payment.get("tipPresets") or payment.get("tipOther", True))):
        return "off"
    if key == "payMethod":
        methods = payment.get("methods") or ["card"]
        if len(methods) <= 1 and methods[0] == "card":
            return "off"
    if key.startswith("upsell") and general.get("upsellEnabled") is False:
        return "off"
    return mode


def repair(cfg: Dict[str, Any]) -> Dict[str, Any]:
    """
    Fix the cross-field rules a parent layer's later change can break below it, so what a
    kiosk receives always validates. The dashboard still sees the stored layers as they are.
    """
    general, timers, pickup = cfg["general"], cfg["timers"], cfg["pickup"]
    printing, club, payment = cfg["printing"], cfg["club"], cfg["payment"]
    if general.get("fulfillmentMode") == "KDS" and not kds_available():
        general["fulfillmentMode"] = "BON"
    if timers["warningSec"] >= timers["inactivitySec"]:
        timers["warningSec"] = max(5, timers["inactivitySec"] - 1)
    if pickup["start"] >= pickup["max"]:
        pickup["start"], pickup["max"] = DEFAULT_CONFIG["pickup"]["start"], DEFAULT_CONFIG["pickup"]["max"]
    if printing["bonMode"] == "single" and not printing.get("bonPrinterId"):
        printing["bonMode"] = "routing"
    if club.get("enabled") and not _http_url_ok(club.get("joinUrl") or ""):
        club["enabled"] = False
    methods = [m for m in payment.get("methods") or [] if m in PAYMENT_METHODS]
    if not any(m in REMAINDER_METHODS for m in methods):
        methods = ["card"] + methods
    payment["methods"] = methods
    # "איך תרצו לשלם?" is always the last step, right before the payment.
    steps = [s for s in payment.get("checkoutSteps") or [] if s in CHECKOUT_STEPS and s != "payMethod"]
    payment["checkoutSteps"] = steps + ["payMethod"]
    if payment.get("tipEnabled") and not payment.get("tipPresets"):
        payment["tipPresets"] = list(DEFAULT_CONFIG["payment"]["tipPresets"])
    if cfg["hours"].get("enabled") and not cfg["hours"].get("ranges"):
        cfg["hours"]["enabled"] = False
    for kind in ALERT_KINDS:
        route = (cfg.get("alerts") or {}).get(kind)
        if isinstance(route, dict) and route.get("tills") == "selected" and not route.get("machineIds"):
            route["tills"] = "main"
    # "מבנה הקיוסק": its cross-field rules, and theme.categoryLayout / cartStyle for an older kiosk.
    layouts.repair_layout(cfg)
    # …and the engine's own add-to-cart kind: reach low never flies a copy across the display half.
    add = ((cfg.get("motion") or {}).get("events") or {}).get("addToCart")
    if (cfg.get("layout") or {}).get("reach") == "low" and isinstance(add, dict) and add.get("animationType") == "flyToCart":
        add["animationType"] = "bounce"
    return cfg


def resolve(*stored_layers: Any) -> Dict[str, Any]:
    """
    DEFAULTS ⊕ the style's preset ⊕ the layout's template (kiosk_layout.py) ⊕ the stored layers
    (sanitised), repaired: what a kiosk gets. A key a layer sets explicitly beats the preset and the
    template, whatever level set it.
    """
    layers = [sanitize_stored_layer(layer) for layer in stored_layers]
    cfg = merge(
        DEFAULT_CONFIG,
        preset_layer(style_of(*layers)),
        layouts.layout_template_layer(layouts.template_of(*layers)),
        *layers,
    )
    return repair(cfg)


def explicit_layers(*stored_layers: Any) -> Dict[str, Any]:
    """The stored layers merged over nothing: only what they set explicitly (no defaults, no preset)."""
    return merge({}, *[sanitize_stored_layer(layer) for layer in stored_layers])


def config_version(cfg: Dict[str, Any]) -> str:
    """First 16 hex chars of the SHA-256 of the canonical JSON (contract §1.1)."""
    canonical = json.dumps(cfg, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16]


def font_of(cfg: Dict[str, Any]) -> Dict[str, Any]:
    """The wire font object of `theme.font` (the system font for an unknown id)."""
    font_id = _get(cfg, "theme", "font")
    return FONTS_BY_ID.get(font_id, FONTS_BY_ID["system"]).to_wire()


def _media_refs(cfg: Dict[str, Any]) -> List[Dict[str, Any]]:
    refs: List[Any] = [_get(cfg, "theme", "backgroundImage"), _get(cfg, "theme", "logo")]
    screen_images = _get(cfg, "screenImages") or {}
    refs += [screen_images.get(key) for key in SCREEN_IMAGE_KEYS]
    refs += [item.get("media") for item in (_get(cfg, "attract", "playlist") or []) if isinstance(item, dict)]
    # A category the kiosk hides needs no picture on its disk.
    category_images = _get(cfg, "catalog", "categoryImages") or {}
    hidden = set(_get(cfg, "catalog", "hiddenCategories") or [])
    refs += [category_images[key] for key in sorted(category_images) if key not in hidden]
    refs += [m.get("image") for m in (_get(cfg, "messages") or []) if isinstance(m, dict)]
    refs.append(_get(cfg, "success", "image"))
    refs.append(_get(cfg, "payment", "waitLogo", "media"))
    return [r for r in refs if isinstance(r, dict) and r.get("url")]


def media_manifest(cfg: Dict[str, Any]) -> List[Dict[str, Any]]:
    """
    Every MediaRef in the config plus the selected font's files (kind "font"), deduped by
    url — what the kiosk downloads to its local cache.
    """
    out: List[Dict[str, Any]] = []
    seen = set()
    candidates = [
        {"url": r["url"], "kind": r.get("kind"), "sha256": r.get("sha256"), "bytes": r.get("bytes")}
        for r in _media_refs(cfg)
    ]
    font = FONTS_BY_ID.get(_get(cfg, "theme", "font"))
    if font is not None:
        candidates += [{"url": url, "kind": "font", "sha256": None, "bytes": None} for url in font.files()]
    for ref in candidates:
        if ref["url"] in seen:
            continue
        seen.add(ref["url"])
        out.append(ref)
    return out


# ── Layers from the database ─────────────────────────────────────────────────


def _layer_row(db: Session, level: str, entity_id) -> Any:
    from app.models.kiosk import KioskSettings

    if entity_id is None:
        return None
    column = {
        "company": KioskSettings.company_id,
        "shop": KioskSettings.shop_id,
        "machine": KioskSettings.machine_id,
    }[level]
    return db.query(KioskSettings).filter(KioskSettings.level == level, column == entity_id).first()


def layer_row(db: Session, level: str, entity_id):
    """The stored `kiosk_settings` row of this level and entity, or None."""
    return _layer_row(db, level, entity_id)


def _overrides(row) -> Dict[str, Any]:
    return row.overrides if row is not None and isinstance(row.overrides, dict) else {}


@dataclass
class Layers:
    """The stored layers along one kiosk's path (any may be empty)."""

    company: Dict[str, Any] = field(default_factory=dict)
    shop: Dict[str, Any] = field(default_factory=dict)
    machine: Dict[str, Any] = field(default_factory=dict)


def layers_for(db: Session, *, company_id=None, shop_id=None, machine_id=None) -> Layers:
    return Layers(
        company=_overrides(_layer_row(db, "company", company_id)),
        shop=_overrides(_layer_row(db, "shop", shop_id)),
        machine=_overrides(_layer_row(db, "machine", machine_id)),
    )


def machine_layers(db: Session, machine) -> Layers:
    shop = getattr(machine, "shop", None)
    return layers_for(
        db,
        company_id=shop.company_id if shop is not None else None,
        shop_id=machine.shop_id,
        machine_id=machine.id,
    )


def effective_config(db: Session, machine) -> Dict[str, Any]:
    """What this kiosk gets: DEFAULTS ⊕ company ⊕ shop ⊕ machine (sanitised, repaired)."""
    layers = machine_layers(db, machine)
    return resolve(layers.company, layers.shop, layers.machine)


def effective_bundle(db: Session, machine) -> Dict[str, Any]:
    """`{configVersion, config, font, media}` — `GET /kiosks/{id}/effective` and the kiosk sync."""
    cfg = effective_config(db, machine)
    return {
        "configVersion": config_version(cfg),
        "config": cfg,
        "font": font_of(cfg),
        "media": media_manifest(cfg) + _upsell_media(db, machine, media_manifest(cfg)),
    }


def _upsell_media(db: Session, machine, have: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    The pictures of the menu's upsell rules offered on the kiosk (a special's own picture,
    docs/SPEC_KIOSK.md §21): downloaded with the rest, so the window shows them from disk.
    """
    from app.models.menu import UpsellRule, upsell_places_of
    from app.services.menu import upsell_image_url

    seen = {m["url"] for m in have}
    out: List[Dict[str, Any]] = []
    rows = (
        db.query(UpsellRule)
        .filter(UpsellRule.tenant_id == machine.tenant_id, UpsellRule.is_active.is_(True), UpsellRule.image_url.isnot(None))
        .all()
    )
    for r in rows:
        url = upsell_image_url(r.image_url)
        if url and url not in seen and "kiosk" in upsell_places_of(r.place):
            seen.add(url)
            out.append({"url": url, "kind": "image", "sha256": None, "bytes": None})
    return out
