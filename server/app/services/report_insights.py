"""
The insights of a report, in Hebrew, made on the server (P:/specs/reports-designed-pdf.md §1.3, §7.4).

Pure: the report's columns and rows (as the dashboard sends them to `POST /reports/pdf`), the
compared period's rows, the KPI cards — in; up to seven sentences out, each with its kind
(`leader` 🏆, `up` 📈, `down` 📉, `alert` ⚠, `tip` 💡). **Nothing to say, nothing out**: an empty
or one-row report, a flat one, no comparison — no sentence is made up to fill the box.

What is said, each only when the figures carry it:

* **leader** — what leads and its share of the total;
* **change** — the total against the compared period, the biggest riser and faller
  (`previousRows`), and the KPI cards' own comparisons;
* **outliers** — a cashier, a till or a row far from its peers: the modified z-score against the
  median and its absolute deviation (MAD), as the tills' anomalies (app/services/insights/
  anomalies.py) — never the mean, which one busy row drags;
* **concentration** — how much of the total comes from the top 20% of the rows;
* **peak and low hours** — for a report by the hour;
* **risks** — refunds, voids, discounts, OTH, cancellations above the report's own rate for one
  row; card transmissions not sent, failures.

Which of these applies is the report type's family (`resolve_type`, the table in §7.4); a type
not known is `generic` (leader, concentration, outliers).
"""
from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence, Tuple

from app.services import report_pdf as P
from app.services.insights.anomalies import median, robust_z
from app.services.report_design import Chart, Insight, Kpi, Series, better_of, format_value, icon_of

MAX_INSIGHTS = 7
#: The modified z-score from which a row is "far from the rest" (anomalies.py's default).
ROBUST_Z = 3.5
#: …and at least this far from the median, as a ratio.
OUTLIER_RATIO = 0.5
MIN_OUTLIER_ROWS = 4

# ── Report types ─────────────────────────────────────────────────────────────

RANKING, MIX, PEOPLE, HOURLY, TIMELINE, RISK, GENERIC = "ranking", "mix", "people", "hourly", "timeline", "risk", "generic"

FAMILY_OF: Dict[str, str] = {
    "product-sales": RANKING, "live-items": RANKING, "menu-reports": RANKING, "menus": RANKING,
    "upsells": RANKING, "promotions": RANKING, "prepaid-vouchers": RANKING, "events": RANKING,
    "event-compare": RANKING, "stock": RANKING, "targets": RANKING, "products-by-day": RANKING,
    "department-sales": MIX, "area-sales": MIX, "card-brands": MIX, "sales-by-payment": MIX,
    "cashier-sales": PEOPLE, "tips": PEOPLE, "tips-distribution": PEOPLE, "attendance": PEOPLE,
    "hourly-sales": HOURLY,
    "day-summary": TIMELINE, "z-reports": TIMELINE, "z-report": TIMELINE, "shift": TIMELINE, "shifts": TIMELINE,
    "compare": TIMELINE, "all-in-one": TIMELINE, "insights": TIMELINE, "kiosk-insights": TIMELINE,
    "cash-variance": RISK, "cash-drawer": RISK, "exceptions": RISK, "approvals": RISK, "transmissions": RISK,
    "reconciliation": RISK, "document-sequence": RISK, "offline-transactions": RISK, "transactions": RISK,
    "tables": RISK,
    "generic": GENERIC,
}
ALIASES: Dict[str, str] = {
    "promotions-report": "promotions", "stock-quick": "stock", "cash-drawer-timeline": "cash-drawer",
    "cash-drawer-movements": "cash-drawer", "exceptions-log": "exceptions", "zcredit-reconciliation": "reconciliation",
    "kiosk insights": "kiosk-insights", "kiosks": "kiosk-insights", "insights-kiosks": "kiosk-insights",
    "prepaid vouchers": "prepaid-vouchers", "menu": "menus", "event": "events", "payments": "sales-by-payment",
    "payment-methods": "sales-by-payment", "products": "product-sales", "departments": "department-sales",
    "cashiers": "cashier-sales", "hourly": "hourly-sales", "areas": "area-sales", "sales-by-area": "area-sales",
}

#: Type → (the rows, plural; what is measured) for the sentences.
NOUNS: Dict[str, Tuple[str, str]] = {
    "product-sales": ("הפריטים", "המכירות"), "live-items": ("הפריטים", "המכירות"),
    "menu-reports": ("הפריטים", "המכירות"), "menus": ("הפריטים", "המכירות"), "upsells": ("ההצעות", "המכירות"),
    "promotions": ("המבצעים", "הסכום"), "prepaid-vouchers": ("השוברים", "הסכום"), "events": ("השורות", "המכירות"),
    "stock": ("הפריטים", "הכמות"), "targets": ("היעדים", "הסכום"), "products-by-day": ("הפריטים", "המכירות"),
    "department-sales": ("המחלקות", "המכירות"), "area-sales": ("נקודות המכירה", "המכירות"),
    "card-brands": ("המותגים", "הסכום"), "sales-by-payment": ("אמצעי התשלום", "הסכום"),
    "cashier-sales": ("העובדים", "המכירות"), "tips": ("העובדים", "הטיפים"), "attendance": ("העובדים", "השעות"),
}

_TOKEN = re.compile(r"[^a-z0-9]+")


def resolve_type(report_type: Optional[str]) -> Tuple[str, str]:
    """(the canonical type, its family). Matched exactly, by alias, then by prefix; else generic."""
    raw = (report_type or "").strip().lower()
    if not raw:
        return "generic", GENERIC
    raw = ALIASES.get(raw, raw)
    if raw in FAMILY_OF:
        return raw, FAMILY_OF[raw]
    for sep in (".", ":", "/"):
        head = raw.split(sep, 1)[0]
        head = ALIASES.get(head, head)
        if head in FAMILY_OF:
            return head, FAMILY_OF[head]
    # "prepaid-vouchers-reports.settlement" → the longest known type it starts with.
    for known in sorted(FAMILY_OF, key=len, reverse=True):
        if raw.startswith(known):
            return known, FAMILY_OF[known]
    return "generic", GENERIC


# ── The columns' roles ───────────────────────────────────────────────────────

VALUE_KEYS = (
    "net", "netsales", "amount", "total", "sales", "revenue", "value", "netamount", "totalamount", "gross",
    "tips", "variance", "difference", "hours", "count", "documents", "transactions", "quantity", "units",
    "unitsnet", "unitssold", "qty",
)
COUNT_WORDS = ("units", "qty", "quantity", "count", "documents", "transactions", "orders", "items")
HOUR_KEYS = ("hour", "hourlabel", "hourofday", "h")
EMPLOYEE_WORDS = ("cashier", "employee", "waiter", "worker", "user", "staff")
RISK_WORDS = (
    "refund", "void", "discount", "oth", "cancel", "variance", "shortage", "failed", "untransmitted", "declined",
    "gap", "difference", "abandon", "duplicate",
)
URGENT_WORDS = ("untransmitted", "failed", "declined", "duplicate", "gap")
TARGET_WORDS = ("target", "achiev", "progress", "goal", "יעד", "עמידה")


def _norm(key: str) -> str:
    return _TOKEN.sub("", (key or "").lower())


@dataclass
class Roles:
    label: Optional[int] = None
    value: Optional[int] = None
    count: Optional[int] = None
    hour: Optional[int] = None
    employee: Optional[int] = None
    date: Optional[int] = None
    id: Optional[int] = None
    risk: List[int] = field(default_factory=list)
    target: Optional[int] = None


def detect_roles(columns: Sequence[P.Column], rows: Sequence[Sequence[Any]], hints: Optional[Dict[str, Any]] = None
                 ) -> Roles:
    hints = hints or {}
    keys = [c.key for c in columns]
    norm = [_norm(k) for k in keys]
    by_key = {k: i for i, k in enumerate(keys)}

    def hinted(name: str) -> Optional[int]:
        k = hints.get(name)
        return by_key.get(k) if isinstance(k, str) else None

    r = Roles()
    numeric = [i for i, c in enumerate(columns) if c.kind in ("money", "number")]
    r.hour = hinted("hour")
    if r.hour is None:
        r.hour = next((i for i, n in enumerate(norm) if n in HOUR_KEYS or columns[i].label.strip() == "שעה"), None)
    r.date = next((i for i, c in enumerate(columns) if c.kind in ("date", "datetime") or _norm(c.key) in ("day", "date", "daydate", "businessdate")), None)
    r.id = hinted("id")
    r.label = hinted("label")
    if r.label is None:
        for i, c in enumerate(columns):
            if c.kind != "text" or i in (r.hour,) or norm[i].endswith("id"):
                continue
            sample = [row[i] for row in rows[:50] if i < len(row) and row[i] not in (None, "")]
            if sample and sum(1 for v in sample if P._num(v) is None) >= len(sample) / 2:
                r.label = i
                break
    if r.label is None and r.date is not None:
        r.label = r.date
    if r.label is None and r.hour is not None:
        r.label = r.hour
    r.value = hinted("value")
    if r.value is None:
        for want in VALUE_KEYS:
            r.value = next((i for i in numeric if norm[i] == want and i != r.hour), None)
            if r.value is not None:
                break
    if r.value is None:
        r.value = next((i for i in numeric if columns[i].kind == "money" and not any(w in norm[i] for w in RISK_WORDS)), None)
    if r.value is None:
        r.value = next((i for i in numeric if i != r.hour and not any(w in norm[i] for w in RISK_WORDS)), None)
    r.count = hinted("count")
    if r.count is None:
        r.count = next((i for i in numeric if i != r.value and any(w in norm[i] for w in COUNT_WORDS)), None)
    r.employee = hinted("employee")
    if r.employee is None:
        r.employee = next((i for i, c in enumerate(columns) if c.kind == "text" and any(w in norm[i] for w in EMPLOYEE_WORDS)), None)
    r.risk = [i for i in numeric if i != r.value and any(w in norm[i] for w in RISK_WORDS)][:4]
    r.target = next(
        (i for i, c in enumerate(columns) if c.kind == "percent"
         and any(w in (norm[i] + c.label) for w in TARGET_WORDS)),
        None,
    )
    return r


# ── Helpers ──────────────────────────────────────────────────────────────────


def _f(value: Any) -> Optional[float]:
    d = P._num(value)
    return float(d) if d is not None else None


def _label_text(value: Any, column: Optional[P.Column] = None) -> str:
    if column is not None and column.kind in ("date", "datetime"):
        return P.format_date(value)
    return P.clean(value) if value not in (None, "") else P.DASH


def _pct(part: float, whole: float) -> float:
    return part / whole * 100.0 if whole else 0.0


def _p(value: float) -> str:
    """A share or a change, as a sentence prints it: 23%, 4.5%, 0.8%."""
    v = abs(value)
    if v >= 10 or v == int(v):
        return f"{v:.0f}%"
    return f"{v:.1f}%"


def parse_hour(value: Any) -> Optional[int]:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        h = int(value)
        return h if 0 <= h <= 23 else None
    m = re.match(r"\s*(\d{1,2})", str(value or ""))
    if not m:
        return None
    h = int(m.group(1))
    return h if 0 <= h <= 23 else None


def hour_range(h: int) -> str:
    return f"{h:02d}:00–{(h + 1) % 24:02d}:00"


@dataclass
class _Found:
    score: float
    insight: Insight


def _say(out: List[_Found], score: float, kind: str, text: str) -> None:
    out.append(_Found(score, Insight(kind, text)))


# ── The rules ────────────────────────────────────────────────────────────────


def table_insights(
    report_type: Optional[str],
    columns: Sequence[P.Column],
    rows: Sequence[Sequence[Any]],
    *,
    previous_rows: Optional[Sequence[Sequence[Any]]] = None,
    previous_label: str = "",
    kpis: Sequence[Kpi] = (),
    hints: Optional[Dict[str, Any]] = None,
) -> List[Insight]:
    """The report's sentences, best first, at most `MAX_INSIGHTS`; [] when there is nothing to say."""
    rtype, family = resolve_type(report_type)
    found: List[_Found] = []
    found += kpi_findings(kpis)
    if rows and columns:
        roles = detect_roles(columns, rows, hints)
        found += _table_findings(rtype, family, columns, rows, roles, previous_rows, previous_label)
    found.sort(key=lambda f: -f.score)
    seen = set()
    out: List[Insight] = []
    for f in found:
        if f.insight.text in seen:
            continue
        seen.add(f.insight.text)
        out.append(f.insight)
        if len(out) >= MAX_INSIGHTS:
            break
    return out


def kpi_findings(kpis: Sequence[Kpi]) -> List[_Found]:
    """The KPI cards' comparisons: the moves of 5% and more, the first card's first."""
    out: List[_Found] = []
    for i, k in enumerate(kpis):
        pct = k.change_pct
        if pct is None or abs(pct) < 5 or k.direction in (None, "flat"):
            continue
        against = k.compare_label or "התקופה הקודמת"
        move = "עלייה" if k.direction == "up" else "ירידה"
        text = (f"{k.label}: {move} של {_p(pct)} מול {against} "
                f"(מ-{format_value(k.compare, k.kind, short=True)} ל-{format_value(k.value, k.kind, short=True)})")
        if k.good is False:
            kind = "alert" if k.direction == "up" else "down"
        else:
            kind = "up"
        score = (86 if i == 0 else 70) + min(10.0, abs(pct) / 10) + (6 if kind == "alert" else 0)
        _say(out, score, kind, text)
    return out[:4]


def _table_findings(rtype: str, family: str, columns: Sequence[P.Column], rows: Sequence[Sequence[Any]],
                    roles: Roles, previous_rows, previous_label: str) -> List[_Found]:
    out: List[_Found] = []
    noun, measure = NOUNS.get(rtype, ("השורות", "הסכום"))
    li, vi = roles.label, roles.value
    vcol = columns[vi] if vi is not None else None
    kind = vcol.kind if vcol is not None else "number"
    better = better_of(vcol.key if vcol else "")

    def cell(row, i):
        return row[i] if i is not None and i < len(row) else None

    # The rows that count: a label and a value (a total row a client left in is skipped).
    items: List[Tuple[str, float, Sequence[Any]]] = []
    if vi is not None:
        for row in rows:
            v = _f(cell(row, vi))
            if v is None:
                continue
            label = _label_text(cell(row, li), columns[li] if li is not None else None) if li is not None else ""
            if label.replace("״", '"') in (P.TOTAL_LABEL.replace("״", '"'), 'סה"כ', "Total", "total"):
                continue
            items.append((label, v, row))
    total = sum(v for _l, v, _r in items)
    positive = [(lbl, v, r) for lbl, v, r in items if v > 0]

    # Hours.
    if (family == HOURLY or roles.hour is not None) and vi is not None:
        hi = roles.hour if roles.hour is not None else li
        by_hour: Dict[int, float] = {}
        for _l, v, row in items:
            h = parse_hour(cell(row, hi))
            if h is not None:
                by_hour[h] = by_hour.get(h, 0.0) + v
        active = {h: v for h, v in by_hour.items() if v > 0}
        if len(active) >= 3 and total > 0:
            peak = max(active, key=lambda h: active[h])
            low = min(active, key=lambda h: active[h])
            share = _pct(active[peak], total)
            _say(out, 90, "leader", f"שעת השיא: {hour_range(peak)} — {format_value(active[peak], kind, short=True)} "
                                    f"({_p(share)} מ{measure})")
            _say(out, 62, "down", f"השעה החלשה: {hour_range(low)} — {format_value(active[low], kind, short=True)}")
            if share >= 15:
                _say(out, 36, "tip", f"כדאי לתגבר צוות ומלאי סביב {peak:02d}:00 — שעה אחת מביאה {_p(share)} מ{measure}")
        if family == HOURLY:
            return out

    # Days (a report by date).
    if family == TIMELINE and roles.date is not None and len(positive) >= 3:
        best = max(positive, key=lambda x: x[1])
        worst = min(positive, key=lambda x: x[1])
        avg = sum(v for _l, v, _r in positive) / len(positive)
        _say(out, 82, "leader", f"היום החזק: {best[0]} — {format_value(best[1], kind, short=True)}, "
                                f"{_p(_pct(best[1] - avg, avg))} מעל הממוצע")
        _say(out, 60, "down", f"היום החלש: {worst[0]} — {format_value(worst[1], kind, short=True)}")

    # The leader.
    if li is not None and len(positive) >= 2 and total > 0 and family not in (HOURLY,) and roles.date != li:
        top = max(positive, key=lambda x: x[1])
        share = _pct(top[1], total)
        if family == MIX:
            text = f"במקום הראשון: {top[0]} — {_p(share)} מ{measure} ({format_value(top[1], kind, short=True)})"
        else:
            text = f"במקום הראשון: {top[0]} — {format_value(top[1], kind, short=True)}, {_p(share)} מהסה״כ"
        _say(out, 88 if better == "up" else 40, "leader", text)

    # Concentration: the top 20% of the rows.
    if li is not None and len(positive) >= 5 and total > 0 and family in (RANKING, MIX, GENERIC, PEOPLE):
        ordered = sorted((v for _l, v, _r in positive), reverse=True)
        k = max(1, math.ceil(len(ordered) * 0.2))
        share = _pct(sum(ordered[:k]), total)
        if share >= 35:
            text = f"ריכוזיות: {k} מתוך {len(ordered)} {noun} (20% המובילים) מביאים {_p(share)} מ{measure}"
            if family == RANKING and share >= 60:
                _say(out, 66, "tip", text + " — כדאי לוודא שהם תמיד זמינים")
            else:
                _say(out, 58, "leader" if share < 60 else "tip", text)

    # The long tail of a menu.
    if rtype in ("product-sales", "live-items", "menu-reports", "menus") and len(positive) >= 10 and total > 0:
        tail = [x for x in positive if _pct(x[1], total) < 1.0]
        if len(tail) >= max(3, len(positive) * 0.3):
            _say(out, 30, "tip", f"{len(tail)} {noun} מביאים פחות מ-1% כל אחד — שווה לבדוק אם הם נחוצים בתפריט")

    # Against the compared period.
    if previous_rows and vi is not None:
        out += _compare_findings(columns, items, previous_rows, roles, kind, measure, previous_label, family, better)

    # Outliers (MAD), for people, tills and the generic report.
    if family in (PEOPLE, RISK, MIX, GENERIC) and li is not None and len(items) >= MIN_OUTLIER_ROWS:
        values = [v for _l, v, _r in items]
        med = median(values)
        flagged = 0
        for label, v, _row in sorted(items, key=lambda x: -abs(x[1] - (med or 0))):
            if flagged >= 2 or med is None or med <= 0:
                break
            z = robust_z(v, values)
            if z is None or abs(z) < ROBUST_Z or abs(v - med) / med < OUTLIER_RATIO:
                continue
            if v > med:
                text = f"חריג: {label} — {format_value(v, kind, short=True)}, מול חציון של {format_value(med, kind, short=True)}"
            else:
                text = (f"חריג כלפי מטה: {label} — {format_value(v, kind, short=True)}, "
                        f"מול חציון של {format_value(med, kind, short=True)}")
            _say(out, 76, "alert", text)
            flagged += 1

    # Risks: a row whose refunds / voids / discounts run far above the report's own rate.
    for ri in roles.risk:
        rcol = columns[ri]
        rk = _norm(rcol.key)
        values = [(lbl, _f(cell(r, ri)) or 0.0, v) for lbl, v, r in items] if items else [
            (_label_text(cell(r, li)) if li is not None else "", _f(cell(r, ri)) or 0.0, 0.0) for r in rows
        ]
        risk_total = sum(abs(x[1]) for x in values)
        if risk_total <= 0:
            continue
        if any(w in rk for w in URGENT_WORDS):
            _say(out, 95, "alert", f"{rcol.label}: {format_value(risk_total, rcol.kind, short=True)} — יש לבדוק")
            continue
        if li is None or len(values) < 3:
            continue
        overall = _pct(risk_total, total) if total > 0 else None
        best = None
        for label, rv, v in values:
            rv = abs(rv)
            if rv <= 0 or rv < risk_total * 0.15:
                continue
            if overall and v > 0:
                ratio = _pct(rv, v)
                if ratio >= overall * 2 and ratio - overall >= 2:
                    cand = (ratio / overall, label, rv, ratio)
                    if best is None or cand[0] > best[0]:
                        best = cand
        if best is not None:
            factor, label, rv, ratio = best
            _say(out, 78, "alert", f"{label}: {rcol.label} {format_value(rv, rcol.kind, short=True)} — "
                                   f"{_p(ratio)} מ{measure}, פי {factor:.1f} מהממוצע")
        elif overall is None:
            top = max(values, key=lambda x: abs(x[1]))
            share = _pct(abs(top[1]), risk_total)
            if share >= 50:
                _say(out, 64, "alert", f"{_p(share)} מ{rcol.label} אצל {top[0]} ({format_value(top[1], rcol.kind, short=True)})")

    # Targets.
    if roles.target is not None and li is not None:
        tvals = [(_label_text(cell(r, li)), _f(cell(r, roles.target))) for r in rows]
        tvals = [(lbl, v) for lbl, v in tvals if v is not None]
        if len(tvals) >= 2:
            met = sum(1 for _l, v in tvals if v >= 100)
            _say(out, 84, "leader", f"{met} מתוך {len(tvals)} עמדו ביעד")
            lowest = min(tvals, key=lambda x: x[1])
            if lowest[1] < 100:
                _say(out, 72, "down", f"הכי רחוק מהיעד: {lowest[0]} — {_p(lowest[1])}")
    return out


def _compare_findings(columns, items, previous_rows, roles: Roles, kind: str, measure: str, previous_label: str,
                      family: str, better: str) -> List[_Found]:
    out: List[_Found] = []
    li, vi = roles.label, roles.value
    key_i = roles.id if roles.id is not None else li
    if key_i is None:
        return out

    def cell(row, i):
        return row[i] if i is not None and i < len(row) else None

    prev: Dict[str, float] = {}
    prev_names: Dict[str, str] = {}
    for row in previous_rows:
        v = _f(cell(row, vi))
        k = P.clean(cell(row, key_i))
        if v is None or not k:
            continue
        prev[k] = prev.get(k, 0.0) + v
        prev_names.setdefault(k, _label_text(cell(row, li)) if li is not None else k)
    cur: Dict[str, float] = {}
    names: Dict[str, str] = {}
    for label, v, row in items:
        k = P.clean(cell(row, key_i))
        if not k:
            continue
        cur[k] = cur.get(k, 0.0) + v
        names.setdefault(k, label)
    against = previous_label or "התקופה הקודמת"
    t_cur, t_prev = sum(cur.values()), sum(prev.values())
    if t_prev > 0 and t_cur >= 0:
        pct = _pct(t_cur - t_prev, t_prev)
        if abs(pct) >= 3:
            up = pct > 0
            good = up == (better == "up")
            _say(out, 87, "up" if good else ("alert" if up else "down"),
                 f"סה״כ {measure.removeprefix('ה')}: {'עלייה' if up else 'ירידה'} של {_p(pct)} מול {against} "
                 f"(מ-{format_value(t_prev, kind, short=True)} ל-{format_value(t_cur, kind, short=True)})")
    changes = []
    for k in set(cur) | set(prev):
        c, p = cur.get(k, 0.0), prev.get(k, 0.0)
        changes.append((c - p, k, c, p))
    if len(changes) < 2:
        return out
    rise = max(changes)
    fall = min(changes)
    if rise[0] > 0 and rise[3] > 0:
        _say(out, 80, "up", f"העלייה הגדולה: {names.get(rise[1], prev_names.get(rise[1], rise[1]))} — "
                            f"מ-{format_value(rise[3], kind, short=True)} ל-{format_value(rise[2], kind, short=True)} "
                            f"({_p(_pct(rise[0], rise[3]))})")
    elif rise[0] > 0 and rise[3] == 0 and family in (RANKING, MIX):
        _say(out, 56, "up", f"חדש מול {against}: {names.get(rise[1], rise[1])} — {format_value(rise[2], kind, short=True)}")
    if fall[0] < 0:
        name = names.get(fall[1], prev_names.get(fall[1], fall[1]))
        if fall[2] > 0:
            _say(out, 79, "down", f"הירידה הגדולה: {name} — מ-{format_value(fall[3], kind, short=True)} "
                                  f"ל-{format_value(fall[2], kind, short=True)} ({_p(_pct(fall[0], fall[3]))})")
        elif family == RANKING:
            _say(out, 74, "alert", f"ללא מכירות הפעם: {name} (קודם: {format_value(fall[3], kind, short=True)})")
    return out


# ── The chart and the cards a report gets when it sends none ─────────────────


def default_chart(report_type: Optional[str], columns: Sequence[P.Column], rows: Sequence[Sequence[Any]], *,
                  hints: Optional[Dict[str, Any]] = None, previous_rows: Optional[Sequence[Sequence[Any]]] = None,
                  previous_label: str = "") -> Optional[Chart]:
    """The main measure as a small chart (§1.4): by the hour, by the day, a donut or the top 10."""
    if not rows or not columns:
        return None
    rtype, family = resolve_type(report_type)
    roles = detect_roles(columns, rows, hints)
    li, vi = roles.label, roles.value
    if vi is None:
        return None
    vcol = columns[vi]
    kind = vcol.kind if vcol.kind in ("money", "number", "percent") else "number"

    def cell(row, i):
        return row[i] if i is not None and i < len(row) else None

    if family == HOURLY or roles.hour is not None:
        hi = roles.hour if roles.hour is not None else li
        acc: Dict[int, float] = {}
        prev: Dict[int, float] = {}
        for row in rows:
            h, v = parse_hour(cell(row, hi)), _f(cell(row, vi))
            if h is not None and v is not None:
                acc[h] = acc.get(h, 0.0) + v
        for row in previous_rows or ():
            h, v = parse_hour(cell(row, hi)), _f(cell(row, vi))
            if h is not None and v is not None:
                prev[h] = prev.get(h, 0.0) + v
        if len([v for v in acc.values() if v]) >= 2:
            hours = sorted(set(acc) | set(prev))
            hours = list(range(hours[0], hours[-1] + 1))
            series = [Series("נוכחי" if prev else "", [acc.get(h, 0.0) for h in hours])]
            if prev:
                series.append(Series(previous_label or "קודם", [prev.get(h, 0.0) for h in hours]))
            return Chart("bar", [f"{h:02d}" for h in hours], series, f"{vcol.label} לפי שעה", kind)
    if li is None:
        return None
    pairs = []
    for row in rows:
        v = _f(cell(row, vi))
        if v is None:
            continue
        label = _label_text(cell(row, li), columns[li])
        if label in (P.TOTAL_LABEL, 'סה"כ'):
            continue
        pairs.append((label, v, P.clean(cell(row, roles.id if roles.id is not None else li))))
    if len([p for p in pairs if p[1] > 0]) < 2:
        return None
    if roles.date is not None and roles.date == li:
        pairs = pairs[:31]
        try:
            pairs.sort(key=lambda p: tuple(reversed(p[0].split("."))))
        except Exception:  # noqa: BLE001
            pass
        ctype = "bar" if len(pairs) <= 14 else "line"
        labels = [p[0][:5] for p in pairs]
        return Chart(ctype, labels, [Series("", [p[1] for p in pairs])], f"{vcol.label} לפי יום", kind)
    if family == MIX and all(p[1] >= 0 for p in pairs):
        return Chart("donut", [p[0] for p in pairs], [Series("", [p[1] for p in pairs])],
                     f"{vcol.label} לפי {columns[li].label}", kind)
    top = sorted(pairs, key=lambda p: -p[1])[:10]
    series = [Series("נוכחי" if previous_rows else "", [p[1] for p in top])]
    if previous_rows:
        key_i = roles.id if roles.id is not None else li
        prev: Dict[str, float] = {}
        for row in previous_rows:
            v = _f(cell(row, vi))
            if v is not None:
                k = P.clean(cell(row, key_i))
                prev[k] = prev.get(k, 0.0) + v
        series.append(Series(previous_label or "קודם", [prev.get(p[2], 0.0) for p in top]))
    title = f"{vcol.label} — {len(top)} המובילים" if len(pairs) > len(top) else f"{vcol.label} לפי {columns[li].label}"
    return Chart("hbar", [p[0] for p in top], series, title, kind)


def auto_kpis(columns: Sequence[P.Column], totals: Any) -> List[Kpi]:
    """Up to four cards from the numeric totals (money first) when the report sends none."""
    if not totals:
        return []
    if isinstance(totals, dict):
        get = lambda i, c: totals.get(c.key)  # noqa: E731
    elif isinstance(totals, (list, tuple)):
        get = lambda i, c: totals[i] if i < len(totals) else None  # noqa: E731
    else:
        return []
    found: List[Tuple[int, int, Kpi]] = []
    order = {"money": 0, "number": 1, "percent": 2}
    for i, c in enumerate(columns):
        if c.kind not in order:
            continue
        v = _f(get(i, c))
        if v is None:
            continue
        found.append((order[c.kind], i, Kpi(key=c.key, label=c.label, value=v, kind=c.kind,
                                             better=better_of(c.key), icon=icon_of(c.key))))
    if any(f[0] < 2 for f in found):
        found = [f for f in found if f[0] < 2]
    found.sort(key=lambda f: (f[0], f[1]))
    return [f[2] for f in found[:4]]
