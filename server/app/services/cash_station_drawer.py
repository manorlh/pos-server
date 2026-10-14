"""
"מגירת העמדה" and "עמדות מזומן" in the shop Z (P:/specs/cash-paylink.md §5, §11.7, §11.9).

The money a kiosk takes in cash is physically in the cash station, not in any till's drawer: each station
keeps its own drawer, from its journal (the transactions) and its movements —

    expected = float + refills + accepted − change − refunds − collections (+ adjustments)

(`dump` moves money inside the unit, from a change dispenser to the cashbox: never in the total).

* **The reconciliation.** What the kiosks recorded in cash at the station — Σ their documents' `cash` legs
  whose `nayax_meta.cashDevice.stationId` is the station, plus each leg's `roundingAgorot` — against what the
  station kept net. The station's net also holds what it owes back: the change owed (paid out at a till) and the
  credits held in the unit. So: `difference = net − (kiosk cash + change owed + held)`; 0 when they agree.
* **The shop Z.** A shop Z takes every station transaction and movement of its shop not yet in a Z (each in
  exactly one: `z_report_id`) and freezes a "cash stations" block on its header (`cashStations`): per station
  the figures above and the reconciliation against that Z's own kiosk documents. Only a shop with cash
  stations gets the block — every other Z is byte for byte what it was. Presentation only: never a condition
  on the Z, never a figure of its own columns (the kiosks' cash legs are cash in the Z's tenders already).
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime
from decimal import ROUND_HALF_UP, Decimal
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from sqlalchemy.orm import Session

from app.models.cash_station import FINAL_STATES, CashStation, CashStationMovement, CashStationTx

logger = logging.getLogger(__name__)

Z_KEY = "cashStations"
Z_TITLE = "עמדות מזומן"
COUNTED_STATUSES = ("completed", "refunded", "partial_refund")

FIGURES = (
    "acceptedAgorot", "changeAgorot", "refundsAgorot", "netAgorot", "floatAgorot", "refillsAgorot",
    "collectionsAgorot", "adjustmentsAgorot", "expectedAgorot", "heldAgorot", "changeOwedAgorot",
)


def _agorot(amount: Any) -> int:
    try:
        return int((Decimal(str(amount or 0)) * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP))
    except Exception:  # noqa: BLE001
        return 0


def summarize(txs: Iterable[CashStationTx], movements: Iterable[CashStationMovement]) -> Dict[str, Any]:
    """The drawer of a set of (final) transactions and movements — pure."""
    out: Dict[str, Any] = {k: 0 for k in FIGURES}
    counts = {"txCount": 0, "paidCount": 0, "refundedCount": 0, "heldCount": 0, "nothingInsertedCount": 0}
    for tx in txs:
        if tx.state not in FINAL_STATES:
            continue
        counts["txCount"] += 1
        if tx.state == "HELD":
            counts["heldCount"] += 1
            out["heldAgorot"] += int(tx.held_agorot or 0)
        elif tx.outcome == "paid":
            counts["paidCount"] += 1
            out["changeOwedAgorot"] += int(tx.change_owed_agorot or 0)
        elif tx.outcome == "refunded":
            counts["refundedCount"] += 1
        elif tx.outcome == "nothing_inserted":
            counts["nothingInsertedCount"] += 1
        out["acceptedAgorot"] += int(tx.inserted_agorot or 0)
        out["changeAgorot"] += int(tx.change_paid_agorot or 0)
        out["refundsAgorot"] += int(tx.refund_paid_agorot or 0)
    last_count = None
    for m in sorted(movements, key=lambda m: (m.at, str(m.id))):
        amount = int(m.amount_agorot or 0)
        if m.kind == "float":
            out["floatAgorot"] += amount
        elif m.kind == "refill":
            out["refillsAgorot"] += amount
        elif m.kind == "collect":
            out["collectionsAgorot"] += amount
        elif m.kind == "adjust":
            out["adjustmentsAgorot"] += amount
        elif m.kind == "count":
            last_count = {
                "at": m.at.isoformat() if m.at is not None else None,
                "expectedAgorot": m.expected_agorot,
                "countedAgorot": m.counted_agorot,
                "varianceAgorot": (
                    int(m.counted_agorot) - int(m.expected_agorot)
                    if m.counted_agorot is not None and m.expected_agorot is not None else None
                ),
                "by": m.by,
            }
    out["netAgorot"] = out["acceptedAgorot"] - out["changeAgorot"] - out["refundsAgorot"]
    out["expectedAgorot"] = (
        out["floatAgorot"] + out["refillsAgorot"] + out["netAgorot"] - out["collectionsAgorot"] + out["adjustmentsAgorot"]
    )
    out.update(counts)
    out["lastCount"] = last_count
    return out


def reconciliation(summary: Dict[str, Any], kiosk_cash_agorot: int, kiosk_documents: int) -> Dict[str, Any]:
    expected_net = kiosk_cash_agorot + summary["changeOwedAgorot"] + summary["heldAgorot"]
    return {
        "kioskCashAgorot": kiosk_cash_agorot,
        "kioskDocuments": kiosk_documents,
        "stationNetAgorot": summary["netAgorot"],
        "changeOwedAgorot": summary["changeOwedAgorot"],
        "heldAgorot": summary["heldAgorot"],
        "expectedNetAgorot": expected_net,
        "differenceAgorot": summary["netAgorot"] - expected_net,
    }


def kiosk_cash_by_station(legs: Iterable[Tuple[Any, Any]]) -> Dict[str, Tuple[int, int]]:
    """(leg, document) pairs → per station id: (Σ leg in agorot + its rounding, documents)."""
    from app.services.cash_stations import cash_device_of

    out: Dict[str, List[Any]] = {}
    for leg, doc in legs:
        block = cash_device_of(leg)
        station = (block or {}).get("stationId")
        if not station:
            continue
        status = getattr(getattr(doc, "status", None), "value", getattr(doc, "status", None))
        if status not in COUNTED_STATUSES:
            continue
        rounding = block.get("roundingAgorot") if isinstance(block.get("roundingAgorot"), int) else 0
        total, docs = out.get(str(station), (0, set()))
        docs.add(doc.id)
        out[str(station)] = (total + _agorot(leg.amount) + rounding, docs)
    return {k: (v[0], len(v[1])) for k, v in out.items()}


def _cash_legs(db: Session, *filters) -> List[Tuple[Any, Any]]:
    from app.models.transaction import Transaction
    from app.models.transaction_payment import TransactionPayment

    return (
        db.query(TransactionPayment, Transaction)
        .join(Transaction, Transaction.id == TransactionPayment.transaction_id)
        .filter(TransactionPayment.method == "cash", *filters)
        .all()
    )


def station_block(station: CashStation, summary: Dict[str, Any], kiosk: Tuple[int, int],
                  host_name: Optional[str] = None) -> Dict[str, Any]:
    return {
        "stationId": str(station.id),
        "name": station.name,
        "location": station.location,
        "serial": station.serial or "",
        "hostId": str(station.host_machine_id) if station.host_machine_id else None,
        "hostName": host_name,
        **{k: v for k, v in summary.items()},
        "reconciliation": reconciliation(summary, kiosk[0], kiosk[1]),
    }


def _totals(blocks: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    out = {k: sum(int(b.get(k) or 0) for b in blocks) for k in FIGURES}
    out["txCount"] = sum(int(b.get("txCount") or 0) for b in blocks)
    out["kioskCashAgorot"] = sum(b["reconciliation"]["kioskCashAgorot"] for b in blocks)
    out["differenceAgorot"] = sum(b["reconciliation"]["differenceAgorot"] for b in blocks)
    return out


# ── The shop Z ─────────────────────────────────────────────────────────────────


class ZPart:
    """What a shop Z takes of the stations: the block for its header, and the rows it claims."""

    def __init__(self, block: Optional[Dict[str, Any]], txs: List[CashStationTx], movements: List[CashStationMovement]):
        self.block = block
        self.txs = txs
        self.movements = movements

    def claim(self, z_id: uuid.UUID) -> None:
        for row in self.txs:
            row.z_report_id = z_id
        for row in self.movements:
            row.z_report_id = z_id


def z_part(db: Session, *, shop_id: Any, shift_ids: Sequence[Any], now: datetime) -> Optional[ZPart]:
    """
    The "cash stations" block of a shop Z (None for a shop that never had one): every final transaction and
    every movement of the shop's stations not yet in a Z, up to now; and the Z's own kiosk documents' cash legs
    by station.
    """
    from app.models.pos_machine import POSMachine
    from app.models.transaction import Transaction

    stations = db.query(CashStation).filter(CashStation.shop_id == shop_id).order_by(CashStation.name, CashStation.id).all()
    if not stations:
        return None
    ids = [s.id for s in stations]
    txs = (
        db.query(CashStationTx)
        .filter(
            CashStationTx.station_id.in_(ids),
            CashStationTx.z_report_id.is_(None),
            CashStationTx.state.in_(FINAL_STATES),
            CashStationTx.done_at <= now,
        )
        .all()
    )
    movements = (
        db.query(CashStationMovement)
        .filter(
            CashStationMovement.station_id.in_(ids),
            CashStationMovement.z_report_id.is_(None),
            CashStationMovement.at <= now,
        )
        .all()
    )
    shifts = [s for s in shift_ids if s is not None]
    kiosk = kiosk_cash_by_station(_cash_legs(db, Transaction.shift_id.in_(shifts))) if shifts else {}
    hosts = {s.host_machine_id for s in stations if s.host_machine_id}
    host_names = {m.id: m.name for m in db.query(POSMachine).filter(POSMachine.id.in_(list(hosts))).all()} if hosts else {}
    blocks = []
    for station in stations:
        mine_tx = [t for t in txs if t.station_id == station.id]
        mine_mv = [m for m in movements if m.station_id == station.id]
        legs = kiosk.get(str(station.id), (0, 0))
        if not station.is_active and not mine_tx and not mine_mv and not legs[1]:
            continue
        blocks.append(station_block(station, summarize(mine_tx, mine_mv), legs, host_names.get(station.host_machine_id)))
    if not blocks:
        return ZPart(None, txs, movements)
    return ZPart({"stations": blocks, "totals": _totals(blocks)}, txs, movements)


# ── The dashboard's drawer ─────────────────────────────────────────────────────


def drawer(db: Session, station: CashStation, *, date_from: Optional[datetime], date_to: Optional[datetime]) -> Dict[str, Any]:
    """
    `GET /cash-stations/{id}/drawer?from=&to=`: the period's drawer (transactions done and movements made in
    it, the kiosk documents of the period against them), the balance through `to` (everything since the
    station began: what should be in it now), and the Zs that took this period's transactions.
    """
    from app.models.transaction import Transaction
    from app.models.z_report import ZReport

    tq = db.query(CashStationTx).filter(CashStationTx.station_id == station.id, CashStationTx.state.in_(FINAL_STATES))
    mq = db.query(CashStationMovement).filter(CashStationMovement.station_id == station.id)
    if date_to is not None:
        tq = tq.filter(CashStationTx.done_at < date_to)
        mq = mq.filter(CashStationMovement.at < date_to)
    all_txs, all_movements = tq.all(), mq.all()

    def within(moment: Optional[datetime]) -> bool:
        if moment is None:
            return False
        from app.services.cash_stations import _aware

        m = _aware(moment)
        return (date_from is None or m >= _aware(date_from)) and (date_to is None or m < _aware(date_to))

    txs = [t for t in all_txs if within(t.done_at)]
    movements = [m for m in all_movements if within(m.at)]
    filters = [Transaction.shop_id == station.shop_id]
    if date_from is not None:
        filters.append(Transaction.created_at >= date_from)
    if date_to is not None:
        filters.append(Transaction.created_at < date_to)
    kiosk = kiosk_cash_by_station(_cash_legs(db, *filters)).get(str(station.id), (0, 0))
    summary = summarize(txs, movements)
    z_ids = {t.z_report_id for t in txs if t.z_report_id} | {m.z_report_id for m in movements if m.z_report_id}
    zs = []
    for z in db.query(ZReport).filter(ZReport.id.in_(list(z_ids))).order_by(ZReport.closed_at).all() if z_ids else []:
        part = next(
            (b for b in ((z.header or {}).get(Z_KEY) or {}).get("stations") or [] if b.get("stationId") == str(station.id)),
            None,
        )
        zs.append({
            "zReportId": str(z.id),
            "zNumber": getattr(z, "z_number", None),
            "closedAt": z.closed_at.isoformat() if z.closed_at else None,
            "station": part,
        })
    return {
        "stationId": str(station.id),
        "from": date_from.isoformat() if date_from else None,
        "to": date_to.isoformat() if date_to else None,
        "summary": summary,
        "reconciliation": reconciliation(summary, kiosk[0], kiosk[1]),
        "balanceAgorot": summarize(all_txs, all_movements)["expectedAgorot"],
        "zReports": zs,
    }


# ── On paper (app/services/z_print.py) ────────────────────────────────────────


def _money(agorot: Any) -> Decimal:
    return (Decimal(int(agorot or 0)) / 100).quantize(Decimal("0.01"))


def print_rows(block: Dict[str, Any]) -> List[Tuple[str, Decimal]]:
    """One station's lines (label, ₪), in the order the paper lists them."""
    rec = block.get("reconciliation") or {}
    return [
        ("התקבל", _money(block.get("acceptedAgorot"))),
        ("עודף", _money(block.get("changeAgorot"))),
        ("החזרים", _money(block.get("refundsAgorot"))),
        ("נטו", _money(block.get("netAgorot"))),
        ("קרן ומילויים", _money(int(block.get("floatAgorot") or 0) + int(block.get("refillsAgorot") or 0))),
        ("ריקונים", _money(block.get("collectionsAgorot"))),
        ("צפוי בעמדה", _money(block.get("expectedAgorot"))),
        ("מוחזק", _money(block.get("heldAgorot"))),
        ("עודף חייב", _money(block.get("changeOwedAgorot"))),
        ("מזומן בקיוסקים", _money(rec.get("kioskCashAgorot"))),
        ("הפרש", _money(rec.get("differenceAgorot"))),
    ]
