"""
What the demo company is: its identity, its five bars, its people, its menu and its month.

Static data only — every number the product derives (totals, X, Z, VAT, reports, the
uniform file) is computed by the product from the documents the virtual tills send.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta
from typing import Dict, List, Optional, Tuple

# ── Identity ──────────────────────────────────────────────────────────────────

TENANT_NAME = "חברת הדגמה — סימולציה למס הכנסה"
TENANT_SLUG = "demo-income-tax-simulation"
COMPANY_NAME = "חברת הדגמה — סימולציה למס הכנסה"
#: Fictitious address and phone (the product keeps no phone of its own: it goes on the
#: receipt footer, a till parameter).
ADDRESS_STREET = "שדרות הסימולציה"
ADDRESS_NUMBER = "18"
ADDRESS_CITY = "תל אביב-יפו"
ADDRESS_ZIP = "6100001"
PHONE_TEXT = "טל׳ 03-0000000 (מספר פיקטיבי)"
FOOTER_DEMO = "חברת הדגמה — נתוני סימולציה בלבד"
SHOP_NAME = "סניף 1"
BRANCH_CODE = "1"
#: ח.פ. candidates: 51 + 6 digits + the Israeli check digit; the first one free in the DB.
VAT_PREFIX = "51"
VAT_SEED_BODY = 731_904  # the 6 digits after "51" tried first, then +1, +2 …

#: The system's own VAT setting for September 2026 (`globalTaxRate`, percent): 18% since
#: 1.1.2025. The product has no date table; the managed setting is the rate tills charge.
GLOBAL_TAX_RATE = 18

TIMEZONE = "Asia/Jerusalem"
RNG_SEED = 20260901

MONTH_FIRST = date(2026, 9, 1)
MONTH_LAST = date(2026, 9, 30)
#: The simulation clock before the month: the company is set up on this day.
SETUP_DAY = date(2026, 8, 27)

# ── Bars ──────────────────────────────────────────────────────────────────────

#: Python weekday(): Mon=0 … Sun=6.
MON, TUE, WED, THU, FRI, SAT, SUN = range(7)


@dataclass(frozen=True)
class Bar:
    index: int
    name: str
    #: The nights it does NOT open (weekday of the evening it would open).
    closed: Tuple[int, ...]
    #: Size relative to the others (documents per night).
    volume: float
    #: Menu emphasis: category key → weight multiplier.
    taste: Dict[str, float]
    opening_cash: int  # agorot, per till


BARS: List[Bar] = [
    Bar(1, "בר 1", (SUN, MON), 1.25, {"beer": 1.4, "shots": 1.2}, 50000),
    Bar(2, "בר 2", (MON, TUE), 1.05, {"cocktails": 1.3}, 50000),
    Bar(3, "בר 3", (SUN, TUE), 0.95, {"cocktails": 1.8, "spirits": 1.2}, 50000),
    Bar(4, "בר 4", (MON, WED), 0.85, {"wine": 2.2, "food": 1.4}, 40000),
    Bar(5, "בר 5", (SUN, WED), 0.75, {"beer": 1.8, "food": 1.3}, 40000),
]
TILLS_PER_BAR = 2

#: Nights every bar is closed (the evening's date): ערב ראש השנה, ליל ב׳ של ראש השנה,
#: ערב יום כיפור, ערב סוכות.
HOLIDAY_CLOSED = {date(2026, 9, 11), date(2026, 9, 12), date(2026, 9, 20), date(2026, 9, 25)}
#: Busier nights: מוצאי יום כיפור, חול המועד סוכות.
HOLIDAY_BOOST = {date(2026, 9, 21): 1.35, date(2026, 9, 26): 1.2, date(2026, 9, 27): 1.15,
                 date(2026, 9, 28): 1.1, date(2026, 9, 29): 1.1, date(2026, 9, 30): 1.1}

#: Documents per till on an ordinary night, before the weekday / bar / holiday factors.
BASE_DOCS_PER_TILL = 34
WEEKDAY_FACTOR = {MON: 0.7, TUE: 0.8, WED: 0.95, THU: 1.35, FRI: 1.5, SAT: 1.25, SUN: 0.75}
WEEKEND = (THU, FRI, SAT)


def opening_hours(day: date) -> Tuple[Tuple[int, int], Tuple[int, int]]:
    """(open hh:mm, close hh:mm next morning), Israel local time."""
    if day.weekday() in WEEKEND:
        return (19, 0), (3, 30)
    return (19, 0), (2, 30)


def nights(bar: Bar) -> List[date]:
    out = []
    d = MONTH_FIRST
    while d <= MONTH_LAST:
        if d.weekday() not in bar.closed and d not in HOLIDAY_CLOSED:
            out.append(d)
        d += timedelta(days=1)
    return out


# ── People ────────────────────────────────────────────────────────────────────

#: Job titles: the attendance roles (תפקיד עבודה, with a tip weight) and the till role
#: (הרשאות בקופה) each one gets. "ברמן" / "מלצר" / "אחמ״ש" are the product's suggested
#: attendance roles (`POST /attendance/roles/defaults`); "מנהל" is added with weight 0.
JOB_BARTENDER = "ברמן"
JOB_WAITER = "מלצר"
JOB_SHIFT_MANAGER = "אחמ״ש"
JOB_MANAGER = "מנהל"
TILL_ROLE_FOR_JOB = {JOB_BARTENDER: "cashier", JOB_WAITER: "waiter", JOB_SHIFT_MANAGER: "supervisor",
                     JOB_MANAGER: "manager"}


@dataclass
class Person:
    key: str           # username in the shop
    first: str
    last: str
    job: str
    worker_number: str
    bar: Optional[int]  # None: the two managers of the whole branch
    pos_role: str = "cashier"  # cashier | shop_manager
    pin: str = ""        # filled at run time (secrets), written only to the codes file
    id: Optional[str] = None

    @property
    def name(self) -> str:
        return f"{self.first} {self.last}"


_FIRST = ["נועה", "איתי", "מאיה", "עומר", "שירה", "יונתן", "תמר", "אורי", "רוני", "דניאל",
          "הילה", "גיא", "ליאור", "עדי", "נטע", "אלון", "יעל", "בן", "מיכל", "עידו",
          "ענבל", "אסף", "קרן", "רועי", "שני", "אביב", "דנה", "יואב", "גלי", "טל"]
_LAST = ["כהן", "לוי", "מזרחי", "פרץ", "ביטון", "אברהם", "פרידמן", "אזולאי", "דהן", "שפירא",
         "גבאי", "חדד", "אוחיון", "קליין", "סויסה", "אלמוג", "ברק", "שמעוני", "נחום", "רבינוביץ",
         "גולן", "אשכנזי", "יוסף", "זילברמן", "חיים", "ששון", "כץ", "בן דוד", "רוזן", "עמר"]
#: Per bar: 1 shift manager, 3 bartenders, 2 waiters.
_BAR_JOBS = [JOB_SHIFT_MANAGER, JOB_BARTENDER, JOB_BARTENDER, JOB_BARTENDER, JOB_WAITER, JOB_WAITER]


def people() -> List[Person]:
    out: List[Person] = []
    i = 0
    for bar in BARS:
        for j, job in enumerate(_BAR_JOBS, start=1):
            out.append(Person(key=f"bar{bar.index}-{j}", first=_FIRST[i], last=_LAST[i], job=job,
                              worker_number=f"{bar.index}{j:02d}", bar=bar.index))
            i += 1
    out.append(Person(key="manager-1", first="רחל", last="אדלר", job=JOB_MANAGER, worker_number="901",
                      bar=None, pos_role="shop_manager"))
    out.append(Person(key="manager-2", first="משה", last="גרינברג", job=JOB_MANAGER, worker_number="902",
                      bar=None, pos_role="shop_manager"))
    return out


# ── Menu (prices in ₪, VAT included) ──────────────────────────────────────────

@dataclass(frozen=True)
class Item:
    name: str
    price: int  # whole shekels
    weight: float = 1.0
    happy_hour: bool = False  # a beer the bartenders discount 20% before 20:30


CATEGORIES: List[Tuple[str, str, str, List[Item]]] = [
    ("beer", "בירות", "#EAB308", [
        Item("גולדסטאר מהחבית 0.5", 32, 3.0, True), Item("קרלסברג מהחבית 0.5", 34, 2.5, True),
        Item("גינס מהחבית 0.5", 38, 1.2), Item("בלו מון מהחבית 0.4", 36, 1.3, True),
        Item("היינקן בקבוק", 30, 1.5), Item("קורונה בקבוק", 32, 1.4), Item("מכבי בקבוק", 26, 0.8),
        Item("בירה ללא אלכוהול", 24, 0.5)]),
    ("cocktails", "קוקטיילים", "#DB2777", [
        Item("מוחיטו", 52, 1.6), Item("אפרול שפריץ", 48, 1.5), Item("נגרוני", 54, 1.0),
        Item("ג׳ין טוניק", 48, 1.6), Item("מוסקו מיול", 52, 1.0), Item("מרגריטה", 52, 1.1),
        Item("וויסקי סאוור", 54, 0.8), Item("אספרסו מרטיני", 56, 1.0)]),
    ("spirits", "חריפים וצ׳ייסרים", "#7C3AED", [
        Item("צ׳ייסר וודקה", 22, 2.0), Item("צ׳ייסר ערק", 20, 1.8), Item("צ׳ייסר טקילה", 24, 1.5),
        Item("ייגרמייסטר", 26, 1.2), Item("ג׳יימסון", 36, 1.0), Item("ג׳וני ווקר בלאק", 42, 0.7),
        Item("גלנפידיך 12", 54, 0.4), Item("ערק אשכוליות", 38, 1.0),
        Item("בקבוק וודקה 0.7", 480, 0.05), Item("בקבוק ערק 0.7", 380, 0.05)]),
    ("wine", "יין", "#991B1B", [
        Item("כוס יין לבן", 38, 1.4), Item("כוס יין אדום", 38, 1.3), Item("כוס רוזה", 40, 1.0),
        Item("כוס קאווה", 42, 0.8), Item("בקבוק יין לבן", 160, 0.15), Item("בקבוק יין אדום", 180, 0.15),
        Item("בקבוק פרוסקו", 170, 0.1)]),
    ("soft", "שתייה קלה", "#0EA5E9", [
        Item("קוקה קולה", 14, 1.5), Item("קוקה קולה זירו", 14, 1.2), Item("ספרייט", 14, 0.6),
        Item("מים מינרליים", 10, 1.2), Item("סודה", 10, 1.0), Item("רד בול", 22, 0.9),
        Item("לימונדה", 16, 0.7)]),
    ("food", "אוכל בר", "#B45309", [
        Item("צ׳יפס", 28, 1.6), Item("צ׳יפס בטטה", 32, 1.0), Item("כנפיים חריפות", 52, 1.0),
        Item("טבעות בצל", 32, 0.8), Item("אדממה", 26, 0.7), Item("פוקאצ׳ה", 34, 0.6),
        Item("מגש נקניקים וגבינות", 78, 0.4), Item("טאקו (3 יח׳)", 48, 0.6), Item("סליידרים (3 יח׳)", 58, 0.6),
        Item("נאצ׳וס", 44, 0.6)]),
]

#: Share of a basket's lines per category (before a bar's taste).
CATEGORY_WEIGHT = {"beer": 3.0, "cocktails": 1.6, "spirits": 1.8, "wine": 0.9, "soft": 1.0, "food": 1.1}
ON_THE_HOUSE_ITEMS = ("צ׳ייסר וודקה", "צ׳ייסר ערק", "צ׳ייסר טקילה")
OTH_REASONS = ("לקוח קבוע", "יום הולדת", "פיצוי על המתנה")

# ── Behaviour rates (per document unless noted) ───────────────────────────────

PAY_CASH, PAY_CARD, PAY_SPLIT = 0.22, 0.68, 0.10
CARD_TIP_RATE = 0.45         # card sales whose customer adds a tip on the terminal
SPLIT_TIP_RATE = 0.25
CASH_TIP_RATE = 0.30
CARD_TIP_PCTS = (8, 10, 10, 12, 15)
CASH_TIPS = (500, 1000, 1000, 1500, 2000)  # agorot
HAPPY_HOUR_DISCOUNT_RATE = 0.35   # of baskets before 20:30 with a happy-hour beer
BASKET_DISCOUNT_RATE = 0.03       # manual 10% / 15% on the basket
STAFF_MEAL_RATE = 0.004           # staff 50% (approved)
OTH_RATE = 0.012                  # one chaser on the house (approved)
REFUND_RATE = 0.006               # credit notes (330) per sale
FAILED_CARD_RATE = 0.012          # card attempts that fail before the basket is paid
LINE_VOID_PER_TILL_NIGHT = (0, 3)
BASKET_CANCEL_PER_TILL_NIGHT = (0, 2)
TRANSMISSION_FIRST_FAILS = 0.04
CARD_BRANDS = (("visa", "cal", 0.20), ("visa", "max", 0.15), ("mastercard", "max", 0.18),
               ("mastercard", "cal", 0.12), ("isracard", "isracard", 0.20), ("amex", "isracard", 0.08),
               ("diners", "diners", 0.07))
#: Each till's (fictitious) Nayax terminal number on the shop LAN: 09900<bar><till>.
def terminal_number(bar: int, till: int) -> str:
    return f"09900{bar}{till}"


def pinpad_host(bar: int, till: int) -> str:
    """A private address no device answers on: the virtual tills never connect to it."""
    return f"10.99.{bar}.{10 + till}"
