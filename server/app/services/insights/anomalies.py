"""
Till anomalies ("חריגות בקופות", docs/SPEC_INSIGHTS.md §10.1): each till against its peers —
the other tills of the same shop (or of the same event), of the same kind (a kiosk against
kiosks, a till against tills) — over the same window.

Three rules, each judged against the peers' **median** with a robust spread (the median
absolute deviation, MAD) — never the mean, which one busy till drags:

* `till_low_sales` — "קופה כמעט לא מוכרת": net (or documents) per open hour far below the
  peers' median while it was open.
* `till_avg_ticket` — "ממוצע עסקה חריג": the average ticket far above or below the peers'.
* `till_cash` — "מזומן חריג — מצריך בדיקה": the cash share of the till's takings, or its cash
  per cash document, far from the peers'. Refunds, voided lines, cancelled baskets and
  drawer openings without a sale are shown beside it as supporting evidence.

A rule needs enough to judge (`minPeers` peers, `minDocs` sale documents, `minOpenHours`
open): a small or a quiet till is never flagged on noise. A ratio threshold decides; from
four peers the modified z-score (0.6745·(x − median) / MAD, Iglewicz & Hoaglin) must agree
too, so a till that is merely the lowest of a widely spread group is not called out.

Pure: plain numbers in (money in integer agorot), plain dicts out. The thresholds are the
tenant's (`tenants.settings.insightAnomalies`), an event's own (`report_events.thresholds`,
prefixed `anomaly…`) over them, each falling back to `DEFAULT_THRESHOLDS`.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from fastapi import HTTPException, status

#: The rules' thresholds (docs/SPEC_INSIGHTS.md §10.1).
DEFAULT_THRESHOLDS: Dict[str, Any] = {
    # A till at or under this % of its peers' median (net or documents per open hour).
    "lowSalesPct": 35,
    # An average ticket this % above the peers' median (or the same factor below it).
    "ticketDeviationPct": 50,
    # A cash share this many percentage points away from the peers' median.
    "cashSharePoints": 25,
    # Cash per cash document this % above the peers' median (or the same factor below).
    "cashAvgDeviationPct": 60,
    # From `ROBUST_MIN_PEERS` peers, the modified z-score must reach this too.
    "robustZ": 3.5,
    # Fewer peers than this, and the till is not judged.
    "minPeers": 2,
    # Sale documents a till needs to be judged or to be a peer (ticket and cash rules).
    "minDocs": 20,
    # Hours a till must have been open to be judged on its sales per hour.
    "minOpenHours": 2,
}

#: key → (minimum, maximum, integer)
LIMITS: Dict[str, Tuple[float, float, bool]] = {
    "lowSalesPct": (5, 90, False),
    "ticketDeviationPct": (10, 500, False),
    "cashSharePoints": (5, 90, False),
    "cashAvgDeviationPct": (10, 500, False),
    "robustZ": (1, 10, False),
    "minPeers": (1, 20, True),
    "minDocs": (1, 1000, True),
    "minOpenHours": (0, 48, False),
}

#: From this many peers the robust z-score is required as well as the ratio.
ROBUST_MIN_PEERS = 4
#: The MAD's consistency constant for a normal spread (modified z-score).
MAD_K = 0.6745
#: A shift counts at most this long (a shift left open overnight is not "open").
MAX_SHIFT_HOURS = 16.0

TENANT_SETTINGS_KEY = "insightAnomalies"
EVENT_PREFIX = "anomaly"

RULES = ("till_low_sales", "till_avg_ticket", "till_cash")


def event_key(key: str) -> str:
    """`lowSalesPct` → `anomalyLowSalesPct`, the key in an event's `thresholds`."""
    return EVENT_PREFIX + key[0].upper() + key[1:]


#: The same limits under an event's keys — the event's validator accepts them.
EVENT_LIMITS: Dict[str, Tuple[float, float, bool]] = {event_key(k): v for k, v in LIMITS.items()}


def _invalid(key: str, low: float, high: float) -> HTTPException:
    return HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail={
        "code": "invalid_thresholds", "field": key,
        "message": f"הסף {key} חייב להיות בין {low:g} ל-{high:g}",
    })


def clean_thresholds(raw: Any, *, strict: bool = True) -> Dict[str, Any]:
    """
    The keys `raw` sets, validated (unknown keys dropped). `strict`: a bad value is a 422;
    otherwise (reading what is stored) it is skipped and the default stays.
    """
    out: Dict[str, Any] = {}
    if not isinstance(raw, dict):
        if strict and raw is not None:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail={
                "code": "invalid_thresholds", "message": "הספים אינם תקינים",
            })
        return out
    for key, (low, high, integer) in LIMITS.items():
        if key not in raw or raw[key] is None or raw[key] == "":
            continue
        try:
            number = float(raw[key])
        except (TypeError, ValueError):
            number = float("nan")
        if not (low <= number <= high):
            if strict:
                raise _invalid(key, low, high)
            continue
        out[key] = int(round(number)) if integer else round(number, 2)
    return out


def effective_thresholds(*layers: Any) -> Dict[str, Any]:
    """Defaults, then each stored layer over them (widest first); bad stored values skipped."""
    out = dict(DEFAULT_THRESHOLDS)
    for layer in layers:
        out.update(clean_thresholds(layer, strict=False))
    return out


def from_event(thresholds: Any) -> Dict[str, Any]:
    """An event's `thresholds`, the anomaly keys only, unprefixed."""
    if not isinstance(thresholds, dict):
        return {}
    return {k: thresholds[event_key(k)] for k in LIMITS if event_key(k) in thresholds}


# ── Robust statistics ─────────────────────────────────────────────────────────


def median(values: Iterable[float]) -> Optional[float]:
    items = sorted(float(v) for v in values)
    n = len(items)
    if n == 0:
        return None
    mid = n // 2
    return items[mid] if n % 2 else (items[mid - 1] + items[mid]) / 2


def mad(values: Sequence[float], center: Optional[float] = None) -> Optional[float]:
    """The median absolute deviation from `center` (the median by default)."""
    if not values:
        return None
    c = median(values) if center is None else center
    return median(abs(float(v) - c) for v in values)


def robust_z(x: float, values: Sequence[float]) -> Optional[float]:
    """The modified z-score of `x` against `values`; None when they do not spread (MAD 0)."""
    c = median(values)
    spread = mad(values, c)
    if c is None or not spread:
        return None
    return MAD_K * (x - c) / spread


def _z_agrees(x: float, values: Sequence[float], th: Dict[str, Any], direction: int) -> Tuple[bool, Optional[float]]:
    """
    With few peers the ratio alone decides; from `ROBUST_MIN_PEERS` peers that spread, the
    z-score must reach `robustZ` in the same direction (−1 low, +1 high).
    """
    z = robust_z(x, values)
    if len(values) < ROBUST_MIN_PEERS or z is None:
        return True, z
    return (z * direction >= th["robustZ"]), z


def r1(value: Optional[float]) -> Optional[float]:
    return None if value is None else round(value, 1)


def r2(value: Optional[float]) -> Optional[float]:
    return None if value is None else round(value, 2)


# ── What one till did ─────────────────────────────────────────────────────────


@dataclass
class TillStats:
    machine_id: str
    name: str
    #: The peer group: an event's id, else the shop's id (and the kind).
    group: str
    group_name: Optional[str] = None
    shop_id: Optional[str] = None
    shop_name: Optional[str] = None
    kiosk: bool = False
    docs: int = 0
    sales: int = 0
    #: Agorot: net = sales − discounts − refunds; gross / discounts of the sales.
    net: int = 0
    gross: int = 0
    discounts: int = 0
    refunds: int = 0
    refunds_count: int = 0
    open_hours: float = 0.0
    #: Where `open_hours` came from: "shifts", "activity" (hours with a sale) or "none".
    open_source: str = "none"
    #: Cash taken on sales, every tender on sales (no exchange legs), and the sales with cash.
    cash: int = 0
    tendered: int = 0
    cash_docs: int = 0
    voids: int = 0
    cancels: int = 0
    no_sale_opens: int = 0
    extra: Dict[str, Any] = field(default_factory=dict)

    @property
    def avg_ticket(self) -> Optional[float]:
        return (self.gross - self.discounts) / self.sales if self.sales else None

    @property
    def net_per_hour(self) -> Optional[float]:
        return self.net / self.open_hours if self.open_hours > 0 else None

    @property
    def docs_per_hour(self) -> Optional[float]:
        return self.sales / self.open_hours if self.open_hours > 0 else None

    @property
    def cash_share(self) -> Optional[float]:
        return self.cash / self.tendered * 100 if self.tendered > 0 else None

    @property
    def cash_avg(self) -> Optional[float]:
        return self.cash / self.cash_docs if self.cash_docs else None

    def row(self) -> Dict[str, Any]:
        return {
            "machineId": self.machine_id,
            "name": self.name,
            "group": self.group,
            "groupName": self.group_name,
            "shopId": self.shop_id,
            "shopName": self.shop_name,
            "kiosk": self.kiosk,
            "documents": self.docs,
            "sales": self.sales,
            "net": self.net,
            "refunds": self.refunds,
            "refundsCount": self.refunds_count,
            "openHours": r1(self.open_hours),
            "openSource": self.open_source,
            "netPerHour": None if self.net_per_hour is None else round(self.net_per_hour),
            "salesPerHour": r1(self.docs_per_hour),
            "avgTicket": None if self.avg_ticket is None else round(self.avg_ticket),
            "cash": self.cash,
            "cashSharePct": r1(self.cash_share),
            "cashDocs": self.cash_docs,
            "cashAvg": None if self.cash_avg is None else round(self.cash_avg),
            "voids": self.voids,
            "cancels": self.cancels,
            "noSaleOpens": self.no_sale_opens,
        }


def _card(type_: str, severity: str, t: TillStats, score: float, **params: Any) -> Dict[str, Any]:
    return {
        "id": f"{type_}:{t.machine_id}",
        "type": type_,
        "severity": severity,
        "section": "anomalies",
        "score": round(float(max(score, 0.0)), 2),
        "params": {
            "machineId": t.machine_id,
            "name": t.name,
            "shopId": t.shop_id,
            "shopName": t.shop_name,
            "groupName": t.group_name,
            "kiosk": t.kiosk,
            **params,
        },
    }


def _groups(tills: Sequence[TillStats]) -> Dict[Tuple[str, bool], List[TillStats]]:
    out: Dict[Tuple[str, bool], List[TillStats]] = {}
    for t in tills:
        out.setdefault((t.group, t.kiosk), []).append(t)
    return out


# ── The rules ─────────────────────────────────────────────────────────────────


def rule_low_sales(t: TillStats, members: Sequence[TillStats], th: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Net or documents per open hour at or under `lowSalesPct`% of the peers' median."""
    if t.open_hours < max(th["minOpenHours"], 1e-9):
        return None
    peers = [p for p in members if p is not t and p.open_hours >= max(th["minOpenHours"], 1e-9) and p.sales >= th["minDocs"]]
    if len(peers) < th["minPeers"]:
        return None
    best = None
    for metric, rate in (("net", lambda s: s.net_per_hour), ("documents", lambda s: s.docs_per_hour)):
        values = [rate(p) or 0.0 for p in peers]
        med = median(values)
        if not med or med <= 0:
            continue
        x = max(rate(t) or 0.0, 0.0)
        ratio = x / med
        if ratio * 100 > th["lowSalesPct"]:
            continue
        agrees, z = _z_agrees(x, values, th, -1)
        if not agrees:
            continue
        if best is None or ratio < best[1]:
            best = (metric, ratio, x, med, z)
    if best is None:
        return None
    metric, ratio, x, med, z = best
    severity = "critical" if ratio * 100 <= th["lowSalesPct"] / 2 else "warning"
    peer_net = median([p.net_per_hour or 0.0 for p in peers]) or 0.0
    lost = max(peer_net - (t.net_per_hour or 0.0), 0.0) * t.open_hours
    return _card(
        "till_low_sales", severity, t, lost,
        metric=metric,
        value=round(x) if metric == "net" else r1(x),
        median=round(med) if metric == "net" else r1(med),
        ratioPct=r1(ratio * 100),
        thresholdPct=th["lowSalesPct"],
        peers=len(peers),
        openHours=r1(t.open_hours),
        openSource=t.open_source,
        net=t.net,
        sales=t.sales,
        netPerHour=None if t.net_per_hour is None else round(t.net_per_hour),
        peersNetPerHour=round(peer_net),
        z=r2(z),
    )


def rule_avg_ticket(t: TillStats, members: Sequence[TillStats], th: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """The average ticket at least (1 + ticketDeviationPct%)× the peers' median, or that much under."""
    if t.sales < th["minDocs"] or t.avg_ticket is None:
        return None
    peers = [p for p in members if p is not t and p.sales >= th["minDocs"] and p.avg_ticket is not None]
    if len(peers) < th["minPeers"]:
        return None
    values = [p.avg_ticket for p in peers]
    med = median(values)
    if not med or med <= 0 or t.avg_ticket <= 0:
        return None
    factor = 1 + th["ticketDeviationPct"] / 100
    ratio = t.avg_ticket / med
    if 1 / factor < ratio < factor:
        return None
    direction = 1 if ratio >= factor else -1
    agrees, z = _z_agrees(t.avg_ticket, values, th, direction)
    if not agrees:
        return None
    extreme = ratio >= factor ** 2 or ratio <= 1 / factor ** 2
    return _card(
        "till_avg_ticket", "critical" if extreme else "warning", t,
        abs(t.avg_ticket - med) * t.sales,
        direction="high" if direction > 0 else "low",
        value=round(t.avg_ticket),
        median=round(med),
        ratioPct=r1(ratio * 100),
        deviationPct=r1((ratio - 1) * 100),
        thresholdPct=th["ticketDeviationPct"],
        peers=len(peers),
        sales=t.sales,
        z=r2(z),
    )


def _median_of(peers: Sequence[TillStats], pick) -> Optional[float]:
    return median([pick(p) for p in peers])


def rule_cash(t: TillStats, members: Sequence[TillStats], th: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Cash share (points) or cash per cash document (factor) far from the peers' median."""
    if t.sales < th["minDocs"] or t.tendered <= 0:
        return None
    peers = [p for p in members if p is not t and p.sales >= th["minDocs"] and p.tendered > 0]
    if len(peers) < th["minPeers"]:
        return None

    share_flag = None
    shares = [p.cash_share or 0.0 for p in peers]
    share_med = median(shares)
    x_share = t.cash_share or 0.0
    diff = x_share - (share_med or 0.0)
    if abs(diff) >= th["cashSharePoints"]:
        direction = 1 if diff > 0 else -1
        agrees, z = _z_agrees(x_share, shares, th, direction)
        if agrees:
            share_flag = {"direction": "high" if diff > 0 else "low", "z": r2(z)}

    avg_flag = None
    min_cash_docs = max(5, th["minDocs"] // 2)
    cash_peers = [p for p in peers if p.cash_docs >= min_cash_docs and p.cash_avg]
    avg_med = None
    if t.cash_docs >= min_cash_docs and t.cash_avg and len(cash_peers) >= th["minPeers"]:
        avgs = [p.cash_avg for p in cash_peers]
        avg_med = median(avgs)
        factor = 1 + th["cashAvgDeviationPct"] / 100
        if avg_med and avg_med > 0:
            ratio = t.cash_avg / avg_med
            if ratio >= factor or ratio <= 1 / factor:
                direction = 1 if ratio >= factor else -1
                agrees, z = _z_agrees(t.cash_avg, avgs, th, direction)
                if agrees:
                    avg_flag = {"direction": "high" if direction > 0 else "low", "ratioPct": r1(ratio * 100), "z": r2(z)}

    if share_flag is None and avg_flag is None:
        return None
    severity = "critical" if share_flag and avg_flag else "warning"
    score = abs(diff) / 100 * t.tendered if share_flag else abs((t.cash_avg or 0) - (avg_med or 0)) * t.cash_docs
    evidence = {
        "refundsCount": t.refunds_count,
        "refunds": t.refunds,
        "peersRefundsCount": r1(_median_of(peers, lambda p: p.refunds_count)),
        "voids": t.voids,
        "peersVoids": r1(_median_of(peers, lambda p: p.voids)),
        "cancels": t.cancels,
        "peersCancels": r1(_median_of(peers, lambda p: p.cancels)),
        "noSaleOpens": t.no_sale_opens,
        "peersNoSaleOpens": r1(_median_of(peers, lambda p: p.no_sale_opens)),
    }
    return _card(
        "till_cash", severity, t, score,
        cashSharePct=r1(x_share),
        peersCashSharePct=r1(share_med),
        shareDiffPoints=r1(diff),
        shareFlag=share_flag,
        cashAvg=None if t.cash_avg is None else round(t.cash_avg),
        peersCashAvg=None if avg_med is None else round(avg_med),
        avgFlag=avg_flag,
        cash=t.cash,
        cashDocs=t.cash_docs,
        sales=t.sales,
        peers=len(peers),
        thresholdPoints=th["cashSharePoints"],
        thresholdPct=th["cashAvgDeviationPct"],
        evidence=evidence,
    )


SEVERITY_ORDER = ("critical", "warning", "opportunity", "positive", "info")


def evaluate(tills: Sequence[TillStats], th: Dict[str, Any]) -> Dict[str, Any]:
    """
    The cards (most urgent first, then by the money at stake) and, per peer group, its
    tills with their figures and which rules flagged them.
    """
    cards: List[Dict[str, Any]] = []
    groups_out: List[Dict[str, Any]] = []
    for (group, kiosk), members in sorted(_groups(tills).items(), key=lambda kv: (kv[1][0].group_name or "", kv[0][1])):
        rows = []
        for t in sorted(members, key=lambda m: m.name or ""):
            flags = []
            for rule in (rule_low_sales, rule_avg_ticket, rule_cash):
                found = rule(t, members, th)
                if found is not None:
                    cards.append(found)
                    flags.append(found["type"])
            rows.append({**t.row(), "flags": flags})
        judged = [m for m in members if m.sales >= th["minDocs"]]
        groups_out.append({
            "group": group,
            "name": members[0].group_name,
            "kiosk": kiosk,
            "tills": rows,
            "judgeable": len(members) >= th["minPeers"] + 1,
            "median": {
                "netPerHour": _round(median([m.net_per_hour for m in members if m.net_per_hour is not None])),
                "avgTicket": _round(median([m.avg_ticket for m in judged if m.avg_ticket is not None])),
                "cashSharePct": r1(median([m.cash_share for m in judged if m.cash_share is not None])),
            },
        })
    cards.sort(key=lambda c: (SEVERITY_ORDER.index(c["severity"]), -c["score"]))
    counts = {s: sum(1 for c in cards if c["severity"] == s) for s in ("critical", "warning")}
    return {"cards": cards, "groups": groups_out, "counts": counts, "tills": len(tills)}


def _round(value: Optional[float]) -> Optional[int]:
    return None if value is None or math.isnan(value) else round(value)
