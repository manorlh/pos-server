"""
The insights feed: the analyses turned into a short list of cards a manager can act on.

A card is data, never prose: `type` picks the Hebrew template in the dashboard's
messages (`insights.cards.<type>`), `params` fills it, `severity` colours and orders it,
`section` is where the page shows the detail. Keeping the words out of the server keeps
every string in one place (he.json) and the arithmetic here testable.

Severity, most urgent first: critical (act today: stock out, a day collapsing) → warning
(look into it: dead items, outlier employees, falling sales) → opportunity (money left
on the table: weak hours, plowhorses, bundles) → positive (what works) → info.
Within a severity, `score` — the money at stake in agorot where it can be estimated.
"""
from __future__ import annotations

from typing import Dict, List, Optional

from . import analytics as A
from . import service as S

SEVERITY_ORDER = ("critical", "warning", "opportunity", "positive", "info")
MAX_CARDS = 24

WEEK_CHANGE_PCT = 10.0
AVG_CHECK_CHANGE_PCT = 5.0
SEATED_CHANGE_PCT = 15.0
SPEND_PER_COVER_CHANGE_PCT = 8.0
REFUNDS_UP_RATIO = 1.5
REFUNDS_MIN_PCT = 1.0
DISCOUNT_UP_POINTS = 2.0
ABC_TAIL_ITEM_SHARE = 30.0


def card(type_: str, severity: str, section: str, score: float = 0.0, **params) -> dict:
    key = params.pop("key", None)
    return {
        "id": f"{type_}:{key}" if key else type_,
        "type": type_,
        "severity": severity,
        "section": section,
        "score": round(float(score or 0), 2),
        "params": params,
    }


def _safe(builder, ctx) -> Optional[dict]:
    """A section that cannot be built leaves its cards out; the feed itself never fails."""
    try:
        return builder(ctx)
    except Exception:  # noqa: BLE001 - one analysis must not take the whole feed down
        import logging

        logging.getLogger(__name__).exception("insights section %s failed", getattr(builder, "__name__", builder))
        return None


def build_feed(ctx: S.InsightsContext) -> dict:
    cards: List[dict] = []
    sections: Dict[str, Optional[dict]] = {}
    for name, builder in (
        ("forecast", S.forecast),
        ("trends", S.trends),
        ("slow", S.slow),
        ("stock", S.stock),
        ("heatmap", S.heatmap),
        ("menu", S.menu_engineering),
        ("abc", S.abc),
        ("baskets", S.baskets),
        ("cashiers", S.cashiers),
        ("tablesLive", S.tables_live),
        ("tables", S.tables),
        ("customers", S.customers),
    ):
        sections[name] = _safe(builder, ctx)
    kpis = S.kpis(ctx)

    cards += _pace_cards(sections.get("forecast"))
    cards += _trend_cards(sections.get("trends"))
    cards += _kpi_cards(kpis)
    cards += _stock_cards(sections.get("stock"))
    cards += _slow_cards(sections.get("slow"))
    cards += _product_trend_cards(sections.get("trends"))
    cards += _heatmap_cards(sections.get("heatmap"))
    cards += _menu_cards(sections.get("menu"))
    cards += _abc_cards(sections.get("abc"))
    cards += _basket_cards(sections.get("baskets"))
    cards += _cashier_cards(sections.get("cashiers"))
    cards += _table_cards(sections.get("tablesLive"), sections.get("tables"))
    cards += _forecast_cards(sections.get("forecast"))
    cards += _customer_cards(sections.get("customers"))

    cards.sort(key=lambda c: (SEVERITY_ORDER.index(c["severity"]), -c["score"]))
    counts = {s: sum(1 for c in cards if c["severity"] == s) for s in SEVERITY_ORDER}
    return {
        **S.meta_block(ctx),
        "availability": S.availability(ctx),
        "kpis": kpis,
        "counts": counts,
        "cards": cards[:MAX_CARDS],
        "truncated": len(cards) > MAX_CARDS,
    }


# ── Today, yesterday, the week ───────────────────────────────────────────────


def _pace_cards(fc: Optional[dict]) -> List[dict]:
    pace = (fc or {}).get("pace")
    if not pace or not pace.get("judgeable") or pace.get("pacePct") is None:
        return []
    p = pace["pacePct"]
    if abs(p) < A.PACE_PCT:
        return []
    params = dict(
        weekday=pace["weekday"], hour=pace["asOfHour"], actual=pace["actual"], expected=pace["expectedSoFar"],
        pacePct=p, projected=pace["projected"], expectedFull=pace["expectedFull"],
    )
    gap = abs(pace["expectedSoFar"] - pace["actual"])
    if p < 0:
        return [card("today_slow", "critical" if p <= -40 else "warning", "forecast", gap, **params)]
    return [card("today_strong", "positive", "forecast", gap, **params)]


def _trend_cards(tr: Optional[dict]) -> List[dict]:
    if not tr:
        return []
    out = []
    y = tr.get("yesterday")
    if y:
        sev = "warning" if y["deviationPct"] < 0 else "positive"
        out.append(card("yesterday_low" if y["deviationPct"] < 0 else "yesterday_high", sev, "trends",
                        abs(y["net"] - y["baseline"]), weekday=y["weekday"], date=y["date"], net=y["net"],
                        baseline=y["baseline"], deviationPct=y["deviationPct"], weeks=y["weeks"]))
    wow = tr.get("weekOverWeek")
    if wow and wow.get("netChangePct") is not None and abs(wow["netChangePct"]) >= WEEK_CHANGE_PCT and wow["netPrev"] > 0:
        up = wow["netChangePct"] > 0
        out.append(card("week_up" if up else "week_down", "positive" if up else "warning", "trends",
                        abs(wow["net"] - wow["netPrev"]), net=wow["net"], netPrev=wow["netPrev"],
                        changePct=wow["netChangePct"], salesChangePct=wow["salesChangePct"]))
    if wow and wow.get("avgCheckChangePct") is not None and abs(wow["avgCheckChangePct"]) >= AVG_CHECK_CHANGE_PCT and wow["salesPrev"] >= 20:
        up = wow["avgCheckChangePct"] > 0
        out.append(card("avg_check_up" if up else "avg_check_down", "positive" if up else "warning", "baskets",
                        abs(wow["avgCheck"] - wow["avgCheckPrev"]) * max(wow["sales"], 1),
                        avgCheck=wow["avgCheck"], avgCheckPrev=wow["avgCheckPrev"], changePct=wow["avgCheckChangePct"]))
    return out


def _kpi_cards(k: dict) -> List[dict]:
    cur, prev = k.get("current"), k.get("previous")
    if not cur or not prev:
        return []
    out = []
    if prev["refunds"] > 0 and cur["refunds"] >= REFUNDS_UP_RATIO * prev["refunds"] and (cur["refundPct"] or 0) >= REFUNDS_MIN_PCT:
        out.append(card("refunds_up", "warning", "cashiers", cur["refunds"] - prev["refunds"],
                        refunds=cur["refunds"], refundsPrev=prev["refunds"], refundPct=cur["refundPct"],
                        count=cur["refundsCount"]))
    if cur["discountPct"] is not None and prev["discountPct"] is not None and cur["discountPct"] - prev["discountPct"] >= DISCOUNT_UP_POINTS:
        out.append(card("discounts_up", "warning", "cashiers", cur["discounts"] - prev["discounts"],
                        discountPct=cur["discountPct"], discountPctPrev=prev["discountPct"], discounts=cur["discounts"]))
    return out


# ── Products and stock ───────────────────────────────────────────────────────


def _stock_cards(st: Optional[dict]) -> List[dict]:
    if not st or not st.get("hasStock"):
        return []
    out = []
    for r in st["rows"]:
        if r["status"] == "out":
            out.append(card("stock_out", "critical", "stock", r["perDay"] * 1000, key=f'{r["key"]}:{r["shopId"]}',
                            name=r["name"], shopName=r["shopName"], perDay=r["perDay"], suggested=r["suggestedOrder"]))
        elif r["status"] in ("critical", "low"):
            out.append(card("stock_low", "critical" if r["status"] == "critical" else "warning", "stock",
                            r["perDay"] * 100, key=f'{r["key"]}:{r["shopId"]}', name=r["name"], shopName=r["shopName"],
                            days=r["daysOfCover"], onHand=r["onHand"], suggested=r["suggestedOrder"]))
    return out[:4]


def _slow_cards(sl: Optional[dict]) -> List[dict]:
    if not sl:
        return []
    out = []
    dead = sl.get("dead", [])
    for r in dead[:3]:
        out.append(card("product_dead", "warning", "slow", (r["stockValue"] or 0) + (r["onHand"] or 0) * 100 + (r["daysSinceSale"] or 365),
                        key=r["key"], name=r["name"], days=r["daysSinceSale"], never=r["never"],
                        lookbackDays=r["lookbackDays"], onHand=r["onHand"], stockValue=r["stockValue"], action=r["action"]))
    if len(dead) > 3:
        out.append(card("products_dead_more", "info", "slow", len(dead), count=len(dead) - 3, total=len(dead),
                        days=(sl.get("thresholds") or {}).get("deadDays", A.DEAD_DAYS)))
    slow = sl.get("slow", [])
    if slow:
        out.append(card("products_slow", "opportunity", "slow", len(slow) * 100, count=len(slow),
                        names=[r["name"] for r in slow[:3]], fairShare=slow[0]["fairShare"]))
    for r in sl.get("declining", [])[:2]:
        out.append(card("product_declining", "warning", "slow", r["unitsPrev"] - r["units"], key=r["key"],
                        name=r["name"], units=r["units"], unitsPrev=r["unitsPrev"], changePct=r["changePct"]))
    return out


def _product_trend_cards(tr: Optional[dict]) -> List[dict]:
    if not tr:
        return []
    products = tr.get("products") or {}
    out = []
    for r in products.get("rising", [])[:2]:
        out.append(card("product_rising", "positive", "trends", r["netChange"], key=r["key"], name=r["name"],
                        changePct=r["changePct"], units=r["units"], unitsPrev=r["unitsPrev"]))
    for r in products.get("falling", [])[:2]:
        out.append(card("product_falling", "warning", "trends", -r["netChange"], key=r["key"], name=r["name"],
                        changePct=r["changePct"], units=r["units"], unitsPrev=r["unitsPrev"]))
    return out


# ── When it sells ────────────────────────────────────────────────────────────


def _heatmap_cards(hm: Optional[dict]) -> List[dict]:
    if not hm:
        return []
    out = []
    for r in hm.get("weak", [])[:2]:
        out.append(card("weak_slot", "opportunity", "heatmap", r["gapPerWeek"] * 4,
                        key=f'{r["weekday"]}-{r["fromHour"]}', weekday=r["weekday"], fromHour=r["fromHour"],
                        toHour=r["toHour"], deviationPct=r["deviationPct"], gapPerWeek=r["gapPerWeek"],
                        typicalNet=r["typicalNet"], usual=r["usual"]))
    for r in hm.get("peak", [])[:1]:
        out.append(card("peak_slot", "info", "heatmap", r["gapPerWeek"], key=f'{r["weekday"]}-{r["fromHour"]}',
                        weekday=r["weekday"], fromHour=r["fromHour"], toHour=r["toHour"], deviationPct=r["deviationPct"],
                        typicalNet=r["typicalNet"], usual=r["usual"]))
    return out


# ── Menu ─────────────────────────────────────────────────────────────────────


#: Below this a menu matrix is noise, not advice.
MENU_MIN_ITEMS = 5
MENU_MIN_UNITS = 50


def _menu_cards(me: Optional[dict]) -> List[dict]:
    if not me or not me.get("items"):
        return []
    placed_units = sum(r["units"] for r in me["items"])
    if me["n"] < MENU_MIN_ITEMS or placed_units < MENU_MIN_UNITS:
        return []
    mode = me["mode"]
    by_q: Dict[str, List[dict]] = {q: [] for q in A.QUADRANTS}
    for r in me["items"]:
        by_q[r["quadrant"]].append(r)
    out = []
    if by_q["plowhorse"]:
        top = max(by_q["plowhorse"], key=lambda r: r["units"])
        # What a 5% price rise would add over the period, at the same volume.
        out.append(card("menu_plowhorse", "opportunity", "menu", top["net"] * 0.05, key=top["key"], name=top["name"],
                        mode=mode, menuMix=top["menuMix"], margin=top["margin"], foodCostPct=top["foodCostPct"],
                        avgPrice=top["avgPrice"], gain=round(top["net"] * 0.05)))
    if by_q["puzzle"]:
        top = max(by_q["puzzle"], key=lambda r: r["value"] or 0)
        out.append(card("menu_puzzle", "opportunity", "menu", (top["value"] or 0) * 10, key=top["key"], name=top["name"],
                        mode=mode, menuMix=top["menuMix"], margin=top["margin"], avgPrice=top["avgPrice"]))
    if by_q["dog"]:
        dogs = sorted(by_q["dog"], key=lambda r: r["units"])
        out.append(card("menu_dogs", "warning" if mode == "cost" else "info", "menu", len(dogs) * 50, mode=mode,
                        count=len(dogs), names=[r["name"] for r in dogs[:3]]))
    if by_q["star"]:
        stars = sorted(by_q["star"], key=lambda r: -(r["totalMargin"] or r["net"]))
        out.append(card("menu_stars", "positive", "menu", 1, mode=mode, count=len(stars), names=[r["name"] for r in stars[:3]]))
    missing = len(me.get("missingCost") or [])
    if mode == "price" or missing:
        out.append(card("missing_cost", "info", "menu", 0, mode=mode, count=missing if mode == "cost" else me["n"]))
    high_fc = [r for r in me["items"] if r["foodCostPct"] is not None and r["foodCostPct"] >= 45 and r["units"] > 0]
    if mode == "cost" and high_fc:
        top = max(high_fc, key=lambda r: r["units"] * (r["foodCostPct"] or 0))
        out.append(card("food_cost_high", "warning", "menu", top["net"] * 0.1, key=top["key"], name=top["name"],
                        foodCostPct=top["foodCostPct"]))
    return out


def _abc_cards(ab: Optional[dict]) -> List[dict]:
    if not ab or not ab.get("total"):
        return []
    classes = ab["classes"]
    n = sum(c["count"] for c in classes.values())
    if n < 8:
        return []
    out = [card("abc_concentration", "info", "abc", 0, aCount=classes["A"]["count"], aItemShare=classes["A"]["itemShare"],
                aShare=classes["A"]["share"], items=n)]
    if classes["C"]["itemShare"] >= ABC_TAIL_ITEM_SHARE:
        out.append(card("abc_tail", "opportunity", "abc", classes["C"]["count"] * 10, cCount=classes["C"]["count"],
                        cItemShare=classes["C"]["itemShare"], cShare=classes["C"]["share"]))
    return out


def _basket_cards(bk: Optional[dict]) -> List[dict]:
    if not bk:
        return []
    out = []
    pairs = bk.get("pairs") or []
    if pairs:
        top = max(pairs, key=lambda p: p["confidence"] * p["together"])
        out.append(card("pair_bundle", "opportunity", "baskets", top["together"] * 10, key=f'{top["a"]}+{top["b"]}',
                        a=top["aName"], b=top["bName"], confidence=top["confidence"], together=top["together"], lift=top["lift"]))
    sizes = bk.get("sizes") or {}
    single = sizes.get("singleItemShare")
    if single is not None and single >= 60 and (bk.get("sales") or 0) >= 100:
        out.append(card("single_item_baskets", "opportunity", "baskets", single, share=single))
    return out


def _cashier_cards(cs: Optional[dict]) -> List[dict]:
    if not cs:
        return []
    out = []
    types = {"discount": "cashier_discounts", "refund": "cashier_refunds", "void": "cashier_voids"}
    for row in cs.get("rows", []):
        for f in row["flags"]:
            base = {"discount": row["discounts"], "refund": row["refunds"], "void": row["voids"]}[f["metric"]]
            excess = base * (1 - 1 / f["times"]) if f["times"] else base
            out.append(card(types[f["metric"]], "warning", "cashiers", excess, key=f'{row["cashierId"]}:{f["metric"]}',
                            name=row["name"] or row["cashierId"], rate=f["rate"], team=f["team"], times=f["times"],
                            level=f["level"]))
    out.sort(key=lambda c: -c["score"])
    return out[:4]


def _table_cards(live: Optional[dict], period: Optional[dict]) -> List[dict]:
    out = []
    if live and live.get("hasTables") and live.get("longOpen"):
        longest = live["longest"]
        out.append(card("table_long_open", "warning", "tables", longest["minutesOpen"] or 0, key=longest["tableId"],
                        number=longest["number"], name=longest["name"], zoneName=longest["zoneName"],
                        minutes=longest["minutesOpen"], count=live["longOpen"], total=longest["total"]))
    if period and period.get("hasTables") and period.get("previous"):
        cur, prev = period["current"], period["previous"]
        if cur["avgSeatedMinutes"] and prev["avgSeatedMinutes"]:
            ch = A.change_pct(cur["avgSeatedMinutes"], prev["avgSeatedMinutes"])
            if ch is not None and abs(ch) >= SEATED_CHANGE_PCT and cur["orders"] >= 20:
                out.append(card("seated_time_change", "info", "tables", abs(ch), minutes=cur["avgSeatedMinutes"],
                                minutesPrev=prev["avgSeatedMinutes"], changePct=A.r1(ch)))
        if cur["spendPerCover"] and prev["spendPerCover"]:
            ch = A.change_pct(cur["spendPerCover"], prev["spendPerCover"])
            if ch is not None and abs(ch) >= SPEND_PER_COVER_CHANGE_PCT and cur["covers"] >= 30:
                out.append(card("spend_per_cover_up" if ch > 0 else "spend_per_cover_down",
                                "positive" if ch > 0 else "warning", "tables", abs(cur["spendPerCover"] - prev["spendPerCover"]) * cur["covers"],
                                value=cur["spendPerCover"], prev=prev["spendPerCover"], changePct=A.r1(ch)))
    return out


def _forecast_cards(fc: Optional[dict]) -> List[dict]:
    if not fc or not fc.get("days"):
        return []
    out = []
    tomorrow = fc["days"][0]
    if tomorrow["net"] is not None and tomorrow["confidence"] in ("high", "medium"):
        peak = max(fc.get("tomorrowHourly") or [], key=lambda h: h["net"], default=None)
        out.append(card("forecast_tomorrow", "info", "forecast", 0, weekday=tomorrow["weekday"], date=tomorrow["date"],
                        net=tomorrow["net"], low=tomorrow["low"], high=tomorrow["high"],
                        peakHour=peak["hour"] if peak else None, accuracy=(fc.get("accuracy") or {}).get("accuracy")))
    if fc.get("nextWeekTotal") is not None and fc.get("nextWeekChangePct") is not None:
        out.append(card("forecast_week", "info", "forecast", 0, total=fc["nextWeekTotal"], lastWeek=fc["lastWeekTotal"],
                        changePct=fc["nextWeekChangePct"]))
    return out


def _customer_cards(cu: Optional[dict]) -> List[dict]:
    summary = (cu or {}).get("summary")
    if not summary or summary["customers"] < 10:
        return []
    return [card("repeat_customers", "info", "customers", 0, repeatPct=summary["repeatPct"],
                 repeatNetPct=summary["repeatNetPct"], customers=summary["customers"])]
