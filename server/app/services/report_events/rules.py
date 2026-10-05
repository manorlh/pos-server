"""
The event report's insight rules (docs/SPEC_EVENTS.md §4) — a small rules engine.

Every rule reads the report as `app.services.report_events.report` built it (plain dicts,
money in shekels) and returns insights:

    {"id", "code", "level": "info" | "warning" | "alert", "text" (Hebrew), "params",
     "ref": {"kind": "till" | "item" | "document" | "shift" | "cashier" | "z" | "batch", "id", "name"} | None}

The texts are made here, not in the dashboard's messages, because the same text goes into
the Excel export and into the frozen snapshot a confirmed event keeps.

The thresholds are the event's own (`thresholds`), each falling back to
`DEFAULT_THRESHOLDS`; `normalize_thresholds` is the one validator.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from fastapi import HTTPException, status

LEVELS = ("alert", "warning", "info")
_LEVEL_ORDER = {level: i for i, level in enumerate(LEVELS)}

#: The rules' thresholds. `highTipAmount` None = only the percentage applies.
DEFAULT_THRESHOLDS: Dict[str, Any] = {
    "weakTillPct": 60,
    "highTipPct": 20,
    "highTipAmount": None,
    "idleGapMinutes": 30,
    "minActiveMinutes": 30,
}

#: key → (minimum, maximum, integer)
_LIMITS = {
    "weakTillPct": (1, 100, False),
    "highTipPct": (1, 1000, False),
    "highTipAmount": (1, 100000, False),
    "idleGapMinutes": (5, 24 * 60, True),
    "minActiveMinutes": (0, 24 * 60, True),
}

#: A till or a cashier whose tip / refund rate is this many times the event's is flagged.
OUTLIER_FACTOR = 2.0
#: …and only above these, so one ₪5 tip on a quiet till is not "far above".
TIP_OUTLIER_MIN_AMOUNT = 50.0
REFUND_OUTLIER_MIN_COUNT = 2
#: Refunds at or above this share of the sales make the refund summary a warning.
REFUND_WARNING_PCT = 2.0
#: A till with this many exceptions or more, and twice the event's average, is flagged.
EXCEPTIONS_OUTLIER_MIN = 3
#: A cash difference at close at or above this is an alert (as `cash_difference` defaults).
CASH_DIFFERENCE_ALERT = 20.0
#: Listed one by one up to this many, then summed up.
MAX_LISTED = 10
#: "Sold on one till only": at least this many units, this share on one till.
SINGLE_TILL_MIN_UNITS = 5.0
SINGLE_TILL_SHARE = 0.9


def normalize_thresholds(raw: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """The event's thresholds, validated; unknown keys dropped, missing keys defaulted."""
    out = dict(DEFAULT_THRESHOLDS)
    if not raw:
        return out
    if not isinstance(raw, dict):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail={
            "code": "invalid_thresholds", "message": "הספים אינם תקינים",
        })
    for key, (low, high, integer) in _LIMITS.items():
        if key not in raw:
            continue
        value = raw[key]
        if value is None or value == "":
            if key == "highTipAmount":
                out[key] = None
                continue
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail={
                "code": "invalid_thresholds", "field": key, "message": f"חסר ערך לסף {key}",
            })
        try:
            number = float(value)
        except (TypeError, ValueError):
            number = float("nan")
        if not (low <= number <= high):
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail={
                "code": "invalid_thresholds", "field": key,
                "message": f"הסף {key} חייב להיות בין {low} ל-{high}",
            })
        out[key] = int(round(number)) if integer else round(number, 2)
    return out


# ── Formatting (Hebrew text) ─────────────────────────────────────────────────


def ils(value: float) -> str:
    """₪ as a Hebrew report writes it: "1,234.50 ₪"."""
    return f"{value:,.2f} ₪"


def pct(value: Optional[float]) -> str:
    return "—" if value is None else f"{value:.1f}%"


def clock(iso: Optional[str], tz, with_date: bool) -> str:
    if not iso:
        return "—"
    moment = datetime.fromisoformat(iso).astimezone(tz)
    return moment.strftime("%d/%m %H:%M") if with_date else moment.strftime("%H:%M")


def minutes_text(minutes: float) -> str:
    minutes = int(round(minutes))
    if minutes < 60:
        return f"{minutes} דק׳"
    hours, rest = divmod(minutes, 60)
    return f"{hours}:{rest:02d} שע׳"


# ── Helpers ───────────────────────────────────────────────────────────────────


def weighted_median(pairs: Iterable[Tuple[float, float]]) -> Optional[float]:
    """The weighted median of (value, weight) pairs; None when there are none."""
    items = sorted((v, w) for v, w in pairs if w > 0)
    if not items:
        return None
    total = sum(w for _v, w in items)
    running = 0.0
    for index, (value, weight) in enumerate(items):
        running += weight
        if abs(running - total / 2) < 1e-9 and index + 1 < len(items):
            # Exactly half the weight on each side: the midpoint, as an ordinary median.
            return (value + items[index + 1][0]) / 2
        if running > total / 2:
            return value
    return items[-1][0]


def _insight(code: str, level: str, text: str, *, ref: Optional[Dict[str, Any]] = None,
             key: Optional[str] = None, **params: Any) -> Dict[str, Any]:
    ident = f"{code}:{key or (ref or {}).get('id') or ''}"
    return {"id": ident, "code": code, "level": level, "text": text, "params": params, "ref": ref}


def till_ref(row: Dict[str, Any]) -> Dict[str, Any]:
    return {"kind": "till", "id": row["machineId"], "name": row["name"]}


@dataclass
class DocFact:
    """What the tip rule needs of one document."""

    id: str
    number: Optional[str]
    machine_id: str
    machine_name: str
    cashier: Optional[str]
    created_at: str
    collected: float
    tip: float
    refund: bool


# ── Flags on the till rows (weak / idle / no sales) ───────────────────────────


def flag_tills(tills: List[Dict[str, Any]], th: Dict[str, Any]) -> Optional[float]:
    """
    Mark `weak`, `idle` and `noSales` on each till row; the weighted median of sales/hour
    the weak rule compared with (None when fewer than two tills qualify).
    """
    qualifying = [
        t for t in tills
        if t["salesCount"] > 0 and t["spanMinutes"] >= th["minActiveMinutes"]
    ]
    median = None
    if len(qualifying) >= 2:
        median = weighted_median((t["salesPerHour"], t["spanMinutes"]) for t in qualifying)
    for t in tills:
        t["noSales"] = t["documentsCount"] == 0
        t["idle"] = bool(t.get("idleGaps"))
        t["weak"] = False
        t["weakRatioPct"] = None
        if median and median > 0 and t in qualifying:
            ratio = t["salesPerHour"] / median * 100
            t["weakRatioPct"] = round(ratio, 1)
            t["weak"] = ratio < th["weakTillPct"]
    return median


# ── The rules ─────────────────────────────────────────────────────────────────


def rule_tills(report: Dict[str, Any], th: Dict[str, Any], median: Optional[float], tz, multi_day: bool) -> List[Dict[str, Any]]:
    out = []
    for t in report["tills"]:
        if t["noSales"]:
            out.append(_insight(
                "no_sales_till", "alert",
                f"לקופה {t['name']} אין אף מכירה בחלון האירוע — האם הופעלה? האם מסמכיה סונכרנו?",
                ref=till_ref(t),
            ))
            continue
        if t["weak"] and median:
            ratio = t["weakRatioPct"] or 0
            level = "alert" if ratio < th["weakTillPct"] / 2 else "warning"
            out.append(_insight(
                "weak_till", level,
                f"קופה חלשה: {t['name']} מכרה {ils(t['salesPerHour'])} לשעה — {ratio:.0f}% מהחציון "
                f"של קופות האירוע ({ils(median)} לשעה; הסף {th['weakTillPct']}%).",
                ref=till_ref(t), salesPerHour=t["salesPerHour"], median=round(median, 2), ratioPct=ratio,
            ))
        gaps = t.get("idleGaps") or []
        if gaps:
            longest = max(gaps, key=lambda g: g["minutes"])
            kinds = {"gap": "ללא מכירות", "lateStart": "התחילה למכור באיחור", "earlyStop": "הפסיקה למכור מוקדם"}
            out.append(_insight(
                "idle_till", "warning",
                f"קופה שקטה: ב-{t['name']} {len(gaps)} פערים ארוכים מ-{th['idleGapMinutes']} דק׳; "
                f"הארוך: {minutes_text(longest['minutes'])} {kinds.get(longest['kind'], '')} "
                f"({clock(longest['from'], tz, multi_day)}–{clock(longest['to'], tz, multi_day)}).",
                ref=till_ref(t), gaps=len(gaps), longestMinutes=longest["minutes"],
            ))
    return out


def rule_tips(report: Dict[str, Any], docs: Sequence[DocFact], th: Dict[str, Any], tz, multi_day: bool) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    high = []
    for d in docs:
        if d.refund or d.tip <= 0:
            continue
        share = d.tip / d.collected * 100 if d.collected > 0 else None
        by_pct = share is not None and share > th["highTipPct"]
        by_amount = th.get("highTipAmount") is not None and d.tip > float(th["highTipAmount"])
        if d.collected <= 0 or by_pct or by_amount:
            high.append((d, share))
    high.sort(key=lambda p: -p[0].tip)
    for d, share in high[:MAX_LISTED]:
        who = f", קופאי/ת {d.cashier}" if d.cashier else ""
        out.append(_insight(
            "high_tip", "warning",
            f"טיפ גבוה: {ils(d.tip)} על מכירה של {ils(d.collected)} ({pct(share)}) — "
            f"מסמך {d.number or '—'} ב-{d.machine_name}{who}, {clock(d.created_at, tz, multi_day)}.",
            ref={"kind": "document", "id": d.id, "name": d.number}, key=d.id,
            tip=d.tip, sale=d.collected, sharePct=None if share is None else round(share, 1),
        ))
    if len(high) > MAX_LISTED:
        rest = high[MAX_LISTED:]
        out.append(_insight(
            "high_tip_more", "warning",
            f"ועוד {len(rest)} טיפים גבוהים מהסף (סה״כ {ils(sum(d.tip for d, _s in rest))}).",
            count=len(rest),
        ))

    kpis = report["kpis"]
    if kpis.get("tipPct"):
        for kind, rows, name_key in (
            ("till", report["tills"], "name"),
            ("cashier", report["segments"]["byCashier"], "name"),
        ):
            for r in rows:
                if r.get("tipPct") is None or r.get("tips", 0) < TIP_OUTLIER_MIN_AMOUNT:
                    continue
                # Against the rest of the event (the event's own rate includes this row).
                others_sales = kpis["sales"] - r["sales"]
                if others_sales <= 0:
                    continue
                others = (kpis["tips"] - r["tips"]) / others_sales * 100
                if r["tipPct"] >= max(others, 0.01) * OUTLIER_FACTOR:
                    label = "הקופה" if kind == "till" else "הקופאי/ת"
                    ref_id = r.get("machineId") if kind == "till" else r.get("id")
                    out.append(_insight(
                        "tip_outlier", "warning",
                        f"אחוז טיפ חריג: ל{label} {r[name_key] or '—'} {pct(r['tipPct'])} טיפ "
                        f"({ils(r['tips'])}), מול {pct(others)} בשאר האירוע.",
                        ref={"kind": kind, "id": ref_id, "name": r[name_key]}, key=f"{kind}:{ref_id}",
                        tipPct=r["tipPct"], othersPct=round(others, 2),
                    ))
    return out


def rule_refunds(report: Dict[str, Any]) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    k = report["kpis"]
    if k["refundsCount"] == 0:
        return out
    rate = k["refunds"] / k["sales"] * 100 if k["sales"] > 0 else None
    level = "warning" if rate is None or rate >= REFUND_WARNING_PCT else "info"
    out.append(_insight(
        "refunds", level,
        f"זיכויים: {k['refundsCount']} מסמכי זיכוי בסך {ils(k['refunds'])}"
        + (f" ({pct(rate)} מהמכירות)." if rate is not None else "."),
        key="summary", count=k["refundsCount"], amount=k["refunds"], ratePct=None if rate is None else round(rate, 2),
    ))
    if rate:
        for kind, rows in (("till", report["tills"]), ("cashier", report["segments"]["byCashier"])):
            for r in rows:
                if r.get("refundsCount", 0) < REFUND_OUTLIER_MIN_COUNT or r.get("sales", 0) <= 0:
                    continue
                own = r["refunds"] / r["sales"] * 100
                # Against the rest of the event, not the event itself (which includes it).
                others_sales = k["sales"] - r["sales"]
                if others_sales <= 0:
                    continue
                others = (k["refunds"] - r["refunds"]) / others_sales * 100
                if own >= REFUND_WARNING_PCT and own >= others * OUTLIER_FACTOR:
                    label = "הקופה" if kind == "till" else "הקופאי/ת"
                    ref_id = r.get("machineId") if kind == "till" else r.get("id")
                    out.append(_insight(
                        "refund_outlier", "warning",
                        f"זיכויים חריגים: ל{label} {r['name'] or '—'} {r['refundsCount']} זיכויים בסך "
                        f"{ils(r['refunds'])} — {pct(own)} מהמכירות, מול {pct(others)} בשאר האירוע.",
                        ref={"kind": kind, "id": ref_id, "name": r["name"]}, key=f"{kind}:{ref_id}",
                        ratePct=round(own, 2), othersPct=round(others, 2),
                    ))
    for t in report["tills"]:
        if t.get("overCredited"):
            out.append(_insight(
                "over_credited", "alert",
                f"ב-{t['name']} {t['overCredited']} זיכויים החזירו יותר ממה שהמכירה המקורית גבתה.",
                ref=till_ref(t), count=t["overCredited"],
            ))
    return out


#: An exception type in Hebrew, and the level its rows take in the insights.
EXCEPTION_LABELS = {
    "discount": ("הנחות", "info"),
    "refund": ("זיכויים", "info"),
    "drawer_open": ("פתיחות מגירה ללא מכירה", "warning"),
    "line_void": ("ביטולי שורה", "warning"),
    "basket_cancel": ("סלים מבוטלים", "warning"),
    "table_cancelled": ("ביטולי שולחן", "alert"),
    "reprint": ("הדפסות חוזרות", "warning"),
    "long_order": ("הזמנות ארוכות", "info"),
    "high_tip": ("טיפים גבוהים (כלל החריגות)", "info"),
    "high_amount": ("סכומים גבוהים", "info"),
    "cash_difference": ("הפרשי קופה", "alert"),
    "after_hours": ("מכירות מחוץ לשעות", "warning"),
    "price_override": ("שינויי מחיר", "warning"),
    "card_failures": ("כשלי אשראי", "warning"),
}


def exception_label(kind: str) -> str:
    return EXCEPTION_LABELS.get(kind, (kind, "info"))[0]


def rule_exceptions(report: Dict[str, Any]) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    ex = report["exceptions"]
    for row in ex["byType"]:
        label, level = EXCEPTION_LABELS.get(row["type"], (row["type"], "info"))
        if row["type"] in ("refund", "high_tip"):
            continue  # the refund and tip rules say it with the event's own thresholds
        tills = ", ".join(f"{n} ({c})" for n, c in row["tills"][:4])
        amount = f" (בסך {ils(row['amount'])})" if row.get("amount") else ""
        out.append(_insight(
            f"exception_{row['type']}", level,
            f"חריגות — {label}: {row['count']}{amount}" + (f". בקופות: {tills}." if tills else "."),
            key=row["type"], type=row["type"], count=row["count"],
        ))
    tills = [t for t in report["tills"] if t["documentsCount"] > 0 or t["exceptions"]]
    if len(tills) >= 2:
        total = sum(t["exceptions"] for t in tills)
        for t in tills:
            others = (total - t["exceptions"]) / (len(tills) - 1)
            if t["exceptions"] >= EXCEPTIONS_OUTLIER_MIN and t["exceptions"] >= others * OUTLIER_FACTOR:
                out.append(_insight(
                    "exceptions_outlier", "warning",
                    f"ב-{t['name']} {t['exceptions']} חריגות, מול ממוצע של {others:.1f} לקופה בשאר האירוע.",
                    ref=till_ref(t), count=t["exceptions"],
                ))
    return out


def rule_shifts(report: Dict[str, Any], ended: bool, tz) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for s in report["shifts"]:
        ref = {"kind": "shift", "id": s["shiftId"], "name": s["machineName"]}
        if s["status"] == "open":
            out.append(_insight(
                "open_shift", "alert" if ended else "warning",
                f"משמרת פתוחה ב-{s['machineName']} (נפתחה {clock(s['openedAt'], tz, True)}"
                + (f" ע״י {s['openedBy']}" if s.get("openedBy") else "") + ")"
                + (" — האירוע הסתיים והמשמרת עוד לא נסגרה." if ended else "."),
                ref=ref,
            ))
        diff = s.get("discrepancy")
        if diff is not None and abs(diff) >= 0.01:
            level = "alert" if abs(diff) >= CASH_DIFFERENCE_ALERT else "info"
            word = "עודף" if diff > 0 else "חוסר"
            out.append(_insight(
                "cash_difference", level,
                f"הפרש קופה בסגירת משמרת ב-{s['machineName']}: {word} של {ils(abs(diff))} "
                f"(צפוי {ils(s['expectedCash'] or 0)}, נספר {ils(s['countedCash'] or 0)}).",
                ref=ref, amount=diff,
            ))
    return out


def rule_highlights(report: Dict[str, Any], tz, multi_day: bool) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    k = report["kpis"]
    if k["salesCount"] == 0:
        return out
    rows = report["items"]["rows"]
    by_revenue = max(rows, key=lambda r: r["revenue"], default=None)
    by_units = max(rows, key=lambda r: r["quantity"], default=None)
    if by_revenue and by_revenue["revenue"] > 0:
        text = f"הפריט המוביל: {by_revenue['name']} — {ils(by_revenue['revenue'])} ({pct(by_revenue['sharePct'])} מההכנסות)"
        if by_units and by_units["key"] != by_revenue["key"]:
            text += f"; הנמכר ביותר בכמות: {by_units['name']} ({by_units['quantity']:g} יח׳)"
        out.append(_insight(
            "insight_best_seller", "info", text + ".",
            ref={"kind": "item", "id": by_revenue["key"], "name": by_revenue["name"]},
        ))
    peak = k.get("peakHour")
    if peak:
        out.append(_insight(
            "insight_peak_hour", "info",
            f"שעת השיא: {clock(peak['start'], tz, multi_day)}–{clock(peak['end'], tz, False)} — {ils(peak['net'])}, "
            f"{pct(peak['sharePct'])} מנטו האירוע.",
            key="peak",
        ))
    active = [t for t in report["tills"] if t["documentsCount"] > 0]
    if len(active) >= 2:
        best = max(active, key=lambda t: t["net"])
        out.append(_insight(
            "insight_strongest_till", "info",
            f"הקופה החזקה: {best['name']} — {ils(best['net'])} ({pct(best['sharePct'])} מהאירוע), "
            f"{ils(best['salesPerHour'])} לשעה.",
            ref=till_ref(best),
        ))
    base = k.get("baselineAvgTicket")
    if base and k.get("avgTicket"):
        change = (k["avgTicket"] - base) / base * 100
        direction = "גבוה" if change >= 0 else "נמוך"
        out.append(_insight(
            "insight_avg_ticket", "info",
            f"ממוצע לעסקה באירוע {ils(k['avgTicket'])} — {direction} ב-{abs(change):.0f}% מהממוצע הרגיל של הסניף "
            f"ב-28 הימים שלפני ({ils(base)}).",
            key="avg", changePct=round(change, 1),
        ))
    for item in report["items"].get("singleTill", [])[:5]:
        out.append(_insight(
            "insight_single_till_item", "info",
            f"{item['name']} נמכר כמעט רק ב-{item['machineName']} ({item['sharePct']:.0f}% מ-{item['quantity']:g} יח׳) — "
            "כדאי לבדוק אם הוא זמין בשאר הקופות.",
            ref={"kind": "item", "id": item["key"], "name": item["name"]},
        ))
    return out


def rule_reconciliation(report: Dict[str, Any], is_draft: bool) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    rec = report.get("reconciliation") or {}
    z = rec.get("z") or {}
    for row in z.get("rows", []):
        ref = {"kind": "z", "id": row["zReportId"], "name": row["label"]}
        if row["status"] == "mismatch":
            parts = ", ".join(f"{name} {ils(v)}" for name, v in row["diffText"])
            extra = ""
            if row.get("lateDocuments") or row.get("amendedDocuments"):
                extra = f" (ל-Z {row.get('lateDocuments', 0)} מסמכים מאוחרים ו-{row.get('amendedDocuments', 0)} מסמכים ששונו אחריו)"
            out.append(_insight(
                "z_mismatch", "alert",
                f"אי-התאמה: סכומי {row['label']} ל-{row['machineName']} אינם מסתכמים לעסקאות שלו — הפרש {parts}{extra}.",
                ref=ref, key=f"{row['zReportId']}:{row['machineId']}",
            ))
    for till in z.get("tills", []):
        pending = till.get("pendingZ") or {}
        if pending.get("count"):
            out.append(_insight(
                "z_pending", "warning",
                f"{pending['count']} מסמכים של {till['name']} בחלון (נטו {ils(pending['net'])}) עוד לא נכללו באף Z.",
                ref={"kind": "till", "id": till["machineId"], "name": till["name"]},
                key=f"pending:{till['machineId']}",
            ))
    tx = rec.get("transmissions") or {}
    for till in tx.get("tills", []):
        ref = {"kind": "till", "id": till["machineId"], "name": till["name"]}
        un = till["untransmitted"]
        if un["count"]:
            out.append(_insight(
                "tx_untransmitted", "warning" if is_draft else "info",
                f"{un['count']} מכירות אשראי של {till['name']} בחלון ({ils(un['amount'])}) עוד לא שודרו לשב״א.",
                ref=ref, key=f"untransmitted:{till['machineId']}",
            ))
        for batch in till["batches"]:
            bref = {"kind": "batch", "id": batch["id"], "name": batch.get("batchNumber")}
            if batch["status"] in ("failed", "unknown"):
                out.append(_insight(
                    "tx_failed", "alert",
                    f"שידור אשראי {'נכשל' if batch['status'] == 'failed' else 'ללא תשובה'} ב-{till['name']} "
                    f"({batch['startedAtText']})" + (f": {batch['message']}" if batch.get("message") else "."),
                    ref=bref,
                ))
            elif batch.get("compare") == "mismatch":
                out.append(_insight(
                    "tx_mismatch", "alert",
                    f"אי-התאמה בשידור {batch.get('batchNumber') or ''} של {till['name']}: הקופה דיווחה "
                    f"{batch.get('transactionCount')} עסקאות / {ils(batch.get('amount') or 0)}, "
                    f"ואצלנו {batch['legsCompared']} / {ils(batch['amountCompared'])}"
                    + (" (השוואה ברמת סכומים)." if batch["level"] == "amounts" else "."),
                    ref=bref,
                ))
    return out


def build_insights(
    report: Dict[str, Any],
    docs: Sequence[DocFact],
    th: Dict[str, Any],
    median: Optional[float],
    *,
    tz,
    ended: bool,
    is_draft: bool,
) -> List[Dict[str, Any]]:
    multi_day = report["event"]["startDate"] != report["event"]["endDate"]
    out: List[Dict[str, Any]] = []
    out += rule_reconciliation(report, is_draft)
    out += rule_tills(report, th, median, tz, multi_day)
    out += rule_shifts(report, ended, tz)
    out += rule_tips(report, docs, th, tz, multi_day)
    out += rule_refunds(report)
    out += rule_exceptions(report)
    out += rule_highlights(report, tz, multi_day)
    # Stable: by level, then in the order the rules produced them.
    indexed = list(enumerate(out))
    indexed.sort(key=lambda p: (_LEVEL_ORDER.get(p[1]["level"], 9), p[0]))
    return [i for _n, i in indexed]
