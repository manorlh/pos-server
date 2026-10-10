"""
The matching of "התאמת אשראי מול Z-Credit" (docs/SPEC_ZCREDIT.md "חלק ג׳") — pure: Z-Credit's
rows and our legs in, one item per transaction out. No database, no gateway, no clock: the
service (app/services/zcredit_reconcile.py) loads both sides and stores what this returns.

**Pairing.** A Z-Credit row and a leg of ours are the same transaction when the leg's stored
reference (`ReferenceNumber`, what the till kept as `zcreditReferenceNumber` / `uid`) is the
row's; else when a status query by our `TransactionUniqueID` ("R2M-<till>-<vuid>") answered
with the row's reference. Nothing else pairs: an amount, a card or a time only *suggests*
(`related`), it never pairs.

**Categories** (one per item; when several apply the first of amount → status → deposit wins
and every reason is kept):

* ✅ `matched` — same amount, consistent status, consistent deposit.
* ⚠️ `amount_mismatch` — the gateway's `TransactionSum` is not what our leg charged (the leg
  plus the document's card tip, as the terminal charges it).
* ⚠️ `status_mismatch` — voided / refunded / partly refunded at Z-Credit (3 / 4 / 6) while ours
  took nothing back on the card, or ours cancelled / refunded on the card while Z-Credit's is whole
  (1 / 2).
* ❌ `zcredit_only` — a row at Z-Credit and no document of ours.
* ❌ `ours_only` — a leg of ours and no row at Z-Credit (nor found by a status query).
* ⚠️ `duplicate` — one reference on two legs of ours, or listed twice by Z-Credit.
* ⚠️ `deposit_mismatch` — deposited at Z-Credit (status 2 / a `DepositID`) and not transmitted in
  ours, transmitted in ours and not deposited at Z-Credit, or in another batch.
"""
from __future__ import annotations

from dataclasses import dataclass, field, replace
from datetime import datetime, timedelta
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from app.models.zcredit_reconciliation import ZCreditReconCategory as C
from app.services.zcredit_reports import ReportTransaction

#: Z-Credit `StatusCode`.
APPROVED_NOT_DEPOSITED = 1
APPROVED_DEPOSITED = 2
VOIDED = 3
REFUNDED = 4
PARTIALLY_REFUNDED = 6
STATUS_LABELS = {
    1: "מאושרת, טרם הופקדה",
    2: "מאושרת, הופקדה",
    3: "בוטלה",
    4: "זוכתה",
    6: "זוכתה חלקית",
}

#: A Z-Credit charge with no document: our legs this close in time are its "צור זיכוי" candidates.
CANDIDATE_WINDOW = timedelta(minutes=30)
#: … and a documented charge of the same card and amount this close is a possible double charge.
DOUBLE_CHARGE_WINDOW = timedelta(minutes=10)
CANDIDATES_MAX = 5

NONE, PARTIAL, FULL = "none", "partial", "full"


@dataclass(frozen=True)
class OurLeg:
    """A Z-Credit card leg of ours, as the service loaded it."""

    payment_id: Any
    transaction_id: Any
    machine_id: Any
    shop_id: Any
    document_number: Optional[str]
    document_type: Optional[int]
    is_refund: bool
    #: The document's status: completed / refunded / partial_refund / cancelled.
    status: str
    #: Local wall clock (the terminal's zone), naive — comparable with `SaveDate`.
    local_time: datetime
    created_at: Optional[datetime]
    #: What the terminal charged on this leg (the leg + the document's card tip), agorot.
    amount_agorot: int
    reference: Optional[str]
    unique_id: Optional[str]
    card_last4: Optional[str]
    transmission_id: Any = None
    batch: Optional[str] = None
    #: Card money our side took back on this sale: credit notes' Z-Credit card legs and cloud
    #: card refunds whose note has not landed yet (agorot).
    taken_back_agorot: int = 0

    @property
    def cancelled(self) -> bool:
        return self.status == "cancelled"

    @property
    def transmitted(self) -> bool:
        return self.transmission_id is not None


@dataclass(frozen=True)
class Lookup:
    """A status query for one leg the report did not list."""

    #: "found" | "not_found" | "error" | "skipped" (over the run's query budget).
    outcome: str
    transaction: Optional[ReportTransaction] = None
    by: Optional[str] = None  # "reference" | "unique_id"
    message: Optional[str] = None


@dataclass
class Item:
    category: str
    reasons: List[str] = field(default_factory=list)
    zc: Optional[ReportTransaction] = None
    zc_source: Optional[str] = None
    leg: Optional[OurLeg] = None
    related: List[Dict[str, Any]] = field(default_factory=list)

    @property
    def reason(self) -> str:
        return "; ".join(r for r in self.reasons if r)

    @property
    def time(self) -> Optional[datetime]:
        if self.zc is not None and self.zc.save_date is not None:
            return self.zc.save_date
        return self.leg.local_time if self.leg is not None else None

    def in_window(self, start: datetime, end: datetime) -> bool:
        """Either side inside the business day (the margins only help pairing)."""
        times = [t for t in (
            self.zc.save_date if self.zc is not None else None,
            self.leg.local_time if self.leg is not None else None,
        ) if t is not None]
        return any(start <= t < end for t in times)


def shekels(agorot: Optional[int]) -> str:
    if agorot is None:
        return "—"
    sign = "-" if agorot < 0 else ""
    a = abs(int(agorot))
    return f"{sign}₪{a // 100:,}.{a % 100:02d}"


def _leg_ref(leg: OurLeg) -> Dict[str, Any]:
    return {
        "transactionId": str(leg.transaction_id) if leg.transaction_id else None,
        "paymentId": str(leg.payment_id) if leg.payment_id else None,
        "machineId": str(leg.machine_id) if leg.machine_id else None,
        "documentNumber": leg.document_number,
        "amountAgorot": leg.amount_agorot,
        "cardLast4": leg.card_last4,
        "localTime": leg.local_time.isoformat(timespec="minutes") if leg.local_time else None,
        "reference": leg.reference,
    }


# ── Our side's state ─────────────────────────────────────────────────────────


def ours_taken(leg: OurLeg) -> str:
    if leg.cancelled or (leg.amount_agorot > 0 and leg.taken_back_agorot >= leg.amount_agorot):
        return FULL
    return PARTIAL if leg.taken_back_agorot > 0 else NONE


def zcredit_taken(row: ReportTransaction) -> Optional[str]:
    if row.status_code in (VOIDED, REFUNDED):
        return FULL
    if row.status_code == PARTIALLY_REFUNDED:
        return PARTIAL
    if row.status_code in (APPROVED_NOT_DEPOSITED, APPROVED_DEPOSITED):
        return NONE
    return None  # unknown / J5: no opinion


def zcredit_deposited(row: ReportTransaction) -> bool:
    return row.status_code == APPROVED_DEPOSITED or row.deposit_id is not None


# ── One pair ─────────────────────────────────────────────────────────────────


def compare(row: ReportTransaction, leg: OurLeg, *, source: str = "report") -> Item:
    item = Item(category=C.MATCHED, zc=row, zc_source=source, leg=leg)
    found: List[str] = []

    if row.amount_agorot is not None and row.amount_agorot != leg.amount_agorot:
        found.append(C.AMOUNT_MISMATCH)
        item.reasons.append(
            f"סכום שונה: ב-Z-Credit {shekels(row.amount_agorot)}, אצלנו {shekels(leg.amount_agorot)}"
            f" (הפרש {shekels(row.amount_agorot - leg.amount_agorot)})"
        )

    zc_state = zcredit_taken(row)
    if zc_state is not None and not row.is_refund and not leg.is_refund:
        mine = ours_taken(leg)
        if zc_state != mine:
            found.append(C.STATUS_MISMATCH)
            words = STATUS_LABELS.get(row.status_code, str(row.status_code))
            if zc_state in (FULL, PARTIAL) and mine == NONE:
                item.reasons.append(f"ב-Z-Credit העסקה {words}, אצלנו המסמך שלם (לא זוכה באשראי)")
            elif zc_state == NONE:
                ours_words = "בוטל" if leg.cancelled else ("זוכה באשראי במלואו" if mine == FULL else "זוכה חלקית באשראי")
                item.reasons.append(f"אצלנו המסמך {ours_words} ({shekels(leg.taken_back_agorot)}), ב-Z-Credit העסקה {words}")
            else:
                ours_words = "זוכה במלואו" if mine == FULL else "זוכה חלקית"
                item.reasons.append(f"ב-Z-Credit העסקה {words}, אצלנו {ours_words} ({shekels(leg.taken_back_agorot)})")

    # The deposit: only for a transaction still standing on both sides.
    if not leg.cancelled and row.status_code not in (VOIDED,):
        deposited = zcredit_deposited(row)
        if deposited and not leg.transmitted:
            found.append(C.DEPOSIT_MISMATCH)
            item.reasons.append(
                f"הופקד ב-Z-Credit (הפקדה {row.deposit_id or '—'}), אצלנו לא סומן כמשודר"
            )
        elif not deposited and leg.transmitted:
            found.append(C.DEPOSIT_MISMATCH)
            item.reasons.append(
                f"אצלנו סומן כמשודר (מנה {leg.batch or '—'}), ב-Z-Credit טרם הופקד"
            )
        elif deposited and leg.transmitted and row.deposit_id and leg.batch and row.deposit_id != leg.batch:
            found.append(C.DEPOSIT_MISMATCH)
            item.reasons.append(f"הופקד בהפקדה {row.deposit_id}, אצלנו סומן במנה {leg.batch}")

    if source == "lookup":
        item.reasons.append("לא הופיע בדוח העסקאות של היום — נמצא בשאילתה ל-Z-Credit")
    for category in (C.AMOUNT_MISMATCH, C.STATUS_MISMATCH, C.DEPOSIT_MISMATCH):
        if category in found:
            item.category = category
            break
    if item.category == C.MATCHED and not item.reasons:
        item.reasons.append("תואם: סכום, סטטוס והפקדה")
    return item


# ── The day ──────────────────────────────────────────────────────────────────


def _pairs_key(leg: OurLeg, lookups: Dict[Any, Lookup]) -> Optional[str]:
    if leg.reference:
        return leg.reference
    lk = lookups.get(leg.payment_id)
    if lk is not None and lk.outcome == "found" and lk.transaction is not None:
        return lk.transaction.reference_number
    return None


def match_day(
    rows: Sequence[ReportTransaction],
    legs: Sequence[OurLeg],
    *,
    lookups: Optional[Dict[Any, Lookup]] = None,
    cloud_refunds: Optional[Dict[str, Dict[str, Any]]] = None,
    window: Optional[Tuple[datetime, datetime]] = None,
) -> List[Item]:
    """
    [rows]: the report (with margins around the day); [legs]: ours (the same margins);
    [lookups]: status queries by payment id for legs the report did not list; [cloud_refunds]:
    the cloud card refunds of these tills by their refund reference (a Z-Credit refund row of
    ours whose credit note has not landed yet); [window]: the business day, local — items with
    neither side inside it are dropped (the next / previous day's run owns them).
    """
    lookups = lookups or {}
    cloud_refunds = cloud_refunds or {}
    rows = [r for r in rows if not r.is_authorization_only]

    by_ref: Dict[str, List[ReportTransaction]] = {}
    unreferenced: List[ReportTransaction] = []
    for r in rows:
        if r.reference_number:
            by_ref.setdefault(r.reference_number, []).append(r)
        else:
            unreferenced.append(r)
    legs_by_ref: Dict[str, List[OurLeg]] = {}
    for leg in legs:
        key = _pairs_key(leg, lookups)
        if key and key in by_ref:
            legs_by_ref.setdefault(key, []).append(leg)

    items: List[Item] = []
    paired = set()
    for ref, zc_rows in by_ref.items():
        ours = legs_by_ref.get(ref, [])
        row = zc_rows[0]
        for leg in ours:
            paired.add(leg.payment_id)
        if len(zc_rows) > 1 or len(ours) > 1:
            item = Item(category=C.DUPLICATE, zc=row, zc_source="report", leg=ours[0] if ours else None)
            if len(zc_rows) > 1:
                item.reasons.append(f"האסמכתא {ref} מופיעה {len(zc_rows)} פעמים בדוח של Z-Credit")
            if len(ours) > 1:
                item.reasons.append(
                    f"עסקת Z-Credit אחת ({ref}, {shekels(row.amount_agorot)}) רשומה ב-{len(ours)} מסמכים שלנו: "
                    + ", ".join(l.document_number or "—" for l in ours)
                )
            item.related = [_leg_ref(l) for l in ours[1:]]
            items.append(item)
            continue
        if not ours:
            refund = cloud_refunds.get(ref)
            if refund is not None:
                item = Item(category=C.MATCHED, zc=row, zc_source="report")
                item.reasons.append(
                    f"זיכוי באשראי מהענן (מסמך {refund.get('originalDocumentNumber') or '—'})"
                    + ("" if refund.get("creditTransactionId") else " — מסמך הזיכוי עוד לא הגיע מהקופה")
                )
                item.related = [{
                    "transactionId": refund.get("originalTransactionId"),
                    "paymentId": refund.get("originalPaymentId"),
                    "documentNumber": refund.get("originalDocumentNumber"),
                    "cloudCardRefundId": refund.get("id"),
                    "kind": "cloud_card_refund",
                }]
                items.append(item)
                continue
            item = Item(category=C.ZCREDIT_ONLY, zc=row, zc_source="report")
            item.reasons.append(
                ("זיכוי" if row.is_refund else "חיוב")
                + f" ב-Z-Credit ({shekels(row.amount_agorot)}) בלי מסמך שלנו"
            )
            items.append(item)
            continue
        items.append(compare(row, ours[0]))

    for row in unreferenced:
        item = Item(category=C.ZCREDIT_ONLY, zc=row, zc_source="report")
        item.reasons.append(f"עסקה ב-Z-Credit בלי אסמכתא ({shekels(row.amount_agorot)}) — לא ניתן לשייך")
        items.append(item)

    for leg in legs:
        if leg.payment_id in paired:
            continue
        lk = lookups.get(leg.payment_id)
        if lk is not None and lk.outcome == "found" and lk.transaction is not None:
            items.append(compare(lk.transaction, leg, source="lookup"))
            continue
        if leg.cancelled and (lk is None or lk.outcome != "error"):
            # Cancelled in ours and nothing at Z-Credit: a void before the deposit leaves no row.
            continue
        item = Item(category=C.OURS_ONLY, leg=leg)
        what = "זיכוי באשראי" if leg.is_refund else "חיוב באשראי"
        item.reasons.append(f"{what} במסמך שלנו ({shekels(leg.amount_agorot)}) בלי עסקה ב-Z-Credit")
        if lk is None:
            item.reasons.append("אין למסמך אסמכתת Z-Credit ולא מזהה לשאילתה" if not (leg.reference or leg.unique_id) else "")
        elif lk.outcome == "not_found":
            item.reasons.append("גם שאילתה ל-Z-Credit " + ("לפי האסמכתא" if lk.by == "reference" else "לפי המזהה שלנו") + " לא מצאה אותה")
        elif lk.outcome == "error":
            item.reasons.append(f"השאילתה ל-Z-Credit נכשלה ({lk.message or 'שגיאה'}) — לא אומת")
        elif lk.outcome == "skipped":
            item.reasons.append("לא נשאל ב-Z-Credit (מכסת השאילתות של ההרצה נוצלה)")
        items.append(item)

    if window is not None:
        items = [i for i in items if i.in_window(*window)]
    _relate(items, legs)
    return items


def _near(a: Optional[datetime], b: Optional[datetime], span: timedelta) -> bool:
    return a is not None and b is not None and abs(a - b) <= span


def _relate(items: List[Item], legs: Sequence[OurLeg]) -> None:
    """
    A Z-Credit charge with no document: the documents of ours it may belong to — same amount,
    same card (when both are known), within `CANDIDATE_WINDOW` — first those Z-Credit lacks
    (likely the same charge, its reference lost), then documented ones (a possible double
    charge). And the reverse note on a document Z-Credit lacks.
    """
    ours_only = {i.leg.payment_id: i for i in items if i.category == C.OURS_ONLY and i.leg is not None}
    for item in items:
        if item.category != C.ZCREDIT_ONLY or item.zc is None or item.zc.is_refund:
            continue
        row = item.zc
        found: List[Tuple[int, timedelta, OurLeg]] = []
        for leg in legs:
            if leg.is_refund or leg.amount_agorot != row.amount_agorot:
                continue
            if row.card_last4 and leg.card_last4 and row.card_last4 != leg.card_last4:
                continue
            if not _near(row.save_date, leg.local_time, CANDIDATE_WINDOW):
                continue
            rank = 0 if leg.payment_id in ours_only else 1
            found.append((rank, abs(row.save_date - leg.local_time), leg))
        found.sort(key=lambda t: (t[0], t[1]))
        for rank, gap, leg in found[:CANDIDATES_MAX]:
            ref = _leg_ref(leg)
            ref["kind"] = "unmatched_document" if rank == 0 else "documented_charge"
            item.related.append(ref)
            if rank == 0:
                other = ours_only[leg.payment_id]
                other.related.append({
                    "zcReference": row.reference_number,
                    "amountAgorot": row.amount_agorot,
                    "cardLast4": row.card_last4,
                    "localTime": row.save_date.isoformat(timespec="minutes") if row.save_date else None,
                    "kind": "unmatched_zcredit",
                })
                other.reasons.append(
                    f"ייתכן שזו עסקת Z-Credit {row.reference_number} ({shekels(row.amount_agorot)}) שלא שויכה"
                )
        if found and found[0][0] == 0:
            item.reasons.append("ייתכן שזה החיוב של מסמך שלנו שלא שויך (אותו כרטיס וסכום, באותו זמן)")
        elif any(rank == 1 and gap <= DOUBLE_CHARGE_WINDOW for rank, gap, _ in found):
            item.reasons.append("ייתכן חיוב כפול: חיוב מתועד של אותו כרטיס ואותו סכום בסמוך")


# ── Totals ───────────────────────────────────────────────────────────────────


def summarize(items: Iterable[Item]) -> Dict[str, Any]:
    """Per category: how many, Z-Credit's sum and ours (agorot, refunds negative)."""
    from app.models.zcredit_reconciliation import RECON_CATEGORIES

    out: Dict[str, Any] = {c: {"count": 0, "zcreditAgorot": 0, "oursAgorot": 0} for c in RECON_CATEGORIES}
    for i in items:
        s = out[i.category]
        s["count"] += 1
        if i.zc is not None and i.zc.amount_agorot is not None:
            s["zcreditAgorot"] += -i.zc.amount_agorot if i.zc.is_refund else i.zc.amount_agorot
        if i.leg is not None:
            s["oursAgorot"] += -i.leg.amount_agorot if i.leg.is_refund else i.leg.amount_agorot
    return out


def with_lookup(item: Item, row: ReportTransaction) -> Item:
    return replace(item, zc=row)
