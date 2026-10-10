"""
"דוח התאמה" — transactions ↔ Zs ↔ card transmissions (docs/SPEC_REPORTS.md §6).

"תכין דוח גם שמבצע התאמה בין העסקאות לבין הזדים ולבין השידורים". Seven checks over a window of
local days and the shops / tills chosen, each row with a status and the reason:

1. `documents_z` — every document belongs to a Z: per till and day the documents in a Z
   (תואם), and apart those that are not — no shift, the shift still open (ממתין), the shift
   closed but in no Z (חסר), or landed after its Z was built (הפרש: not in the Z's figures).
2. `z_totals` — each Z's per-till section against its documents now (`shift_totals.compute_totals`
   over the section's shifts, the very function the Z was built with): count, sales, refunds,
   VAT, tips and every payment method. A difference is explained when it can be (documents
   that arrived or changed after the Z) and flagged "לא מוסבר" when it cannot.
3. `document_numbers` — per till and number series (320 / 330 / 400, prefix + 7 digits):
   gaps (חסר) and duplicates (הפרש) in the window, continuity with the till's last number
   before it, and a prefix that changed. A gap names the cloud's refusals of that till's
   documents in the window, when there were any (a refused document never lands).
4. `z_numbers` — Z numbering strictly sequential: per shop (shop Zs) and per till run (till
   Zs, a new run starting at 1), with the Z before the window for continuity.
5. `card_legs` — per till and day: card sales in the documents (as the terminal charged them,
   card tips included) against what the transmissions carried — named by the terminal (verified)
   or assumed into a batch that named none; the rest pending (< 24 h), not transmitted (≥ 24 h,
   ≥ 7 days: the card companies may refuse it), declined by an offline-authorisation run, or
   from before the till's tracking began. The till's card integration is named on every row.
6. `transmissions` — every transmission report in the window: a success's reported amount
   against the card sales marked into it; a failure or unknown resolved by a later success (or
   not: חסר); a report that reached the cloud late; and a till with card sales whose
   transmissions never arrived at all.
7. `refused_documents` — "מסמך שנדחה בענן": every till document the cloud refused
   (`document_refusals`): still refused (חסר) whenever it started, or landed since (תואם).
8. `repaired_tills` — a till whose device was re-paired as a new machine: its open shift, its
   shifts no Z took, the documents it reported unsent at the re-pair (docs/SHIFTS_API.md §1.2c-bis).
9. `numbering_conflicts` — "same number, different id" (§1.2d): every one a red row.
10. `z_completeness` — a Z waiting for documents the cloud knows are missing, a till whose next
    Z will, and corrections of documents an earlier Z counted waiting for the next Z.
11. `ingest_notes` — what ingest noted (tenders that do not add up, filed by time, …).
12. `cloud_card_refunds` — card refunds the cloud made through Z-Credit against their credit
    notes (a till issues those): the note issued (תואם), still to come (ממתין), never coming (חסר),
    or an outcome unknown at Z-Credit / a note of another total (הפרש).

Every row also carries `gapType`, `action` (`{label, href}` — what the owner does) and, for
the documents, `container` / `zMode`: where they belong — the till's shift and the shop Z, or
the till's own Z — by its Z mode when they were issued.

Statuses: `match` (תואם), `difference` (הפרש), `missing` (חסר) — and `pending` (ממתין) only
for what is not due yet (an open shift, a sale transmitted within 24 h).
"""
from __future__ import annotations

import uuid
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set, Tuple

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.card_transmission import CardTransmission, CardTransmissionItem, TransmissionStatus
from app.models.pos_machine import POSMachine
from app.models.shift import Shift, ShiftStatus
from app.models.shop import Shop
from app.models.transaction import Transaction, TransactionStatus
from app.models.transaction_payment import TransactionPayment
from app.models.z_report import ZOrigin, ZReport
from app.services.dashboard_stats import SALE_STATUSES
from app.services.document_prefix import document_number_of, document_prefix_of, document_series_of
from app.services.extra_reports import find_gaps
from app.services.reports import ReportWindow, _load_zoneinfo
from app.services.tenders import is_refund_document

MATCH = "match"
DIFFERENCE = "difference"
MISSING = "missing"
PENDING = "pending"
STATUSES = (MATCH, DIFFERENCE, MISSING, PENDING)
STATUS_LABELS = {MATCH: "תואם", DIFFERENCE: "הפרש", MISSING: "חסר", PENDING: "ממתין"}

CHECKS = (
    "documents_z", "z_totals", "document_numbers", "z_numbers", "card_legs", "transmissions",
    "refused_documents", "repaired_tills", "numbering_conflicts", "z_completeness", "ingest_notes",
    "cloud_card_refunds",
)
CHECK_LABELS = {
    "documents_z": "מסמכים ↔ Z",
    "z_totals": "סכומי Z ↔ מסמכים",
    "document_numbers": "רציפות מספרי מסמכים",
    "z_numbers": "רציפות מספרי Z",
    "card_legs": "עסקאות אשראי ↔ שידורים",
    "transmissions": "שידורים",
    "refused_documents": "מסמכים שנדחו בענן",
    "repaired_tills": "קופות ששויכו מחדש",
    "numbering_conflicts": "מספר מסמך כפול בקופה",
    "z_completeness": "Z שממתין למסמכים ותיקונים ל-Z קודם",
    "ingest_notes": "הערות קליטה ותיוק",
    "cloud_card_refunds": "זיכויי אשראי מהענן ↔ מסמכי זיכוי",
}
#: The subject of a refused document's row, in the owner's words.
REFUSED_SUBJECT = "מסמך שנדחה בענן"

SERIES_LABELS = {320: "חשבונית מס קבלה (320)", 330: "חשבונית זיכוי (330)", 400: "קבלה (400)"}

#: A card sale untransmitted this long is overdue; this long, the card companies may refuse it.
OVERDUE = timedelta(hours=24)
CRITICAL = timedelta(days=7)
#: A report that reached the cloud this long after the attempt finished is "late".
LATE_REPORT = timedelta(hours=1)
#: Money is equal to the agora.
TOLERANCE = Decimal("0.01")
#: Document rows listed one by one for a state (beyond, one summary row says how many more).
DOCUMENT_ROWS_MAX = 200
#: The documents one reconciliation reads; a wider window is refused, never cut short.
DOCUMENTS_MAX = 200_000

ZERO = Decimal("0")
CENT = Decimal("0.01")


def _d(value: Any) -> Decimal:
    if value is None or value == "":
        return ZERO
    try:
        return Decimal(str(value))
    except Exception:  # noqa: BLE001 - a stored figure we cannot read is zero here
        return ZERO


def _f(value: Optional[Decimal]) -> Optional[float]:
    return None if value is None else float(Decimal(value).quantize(CENT))


def _utc(moment: Optional[datetime]) -> Optional[datetime]:
    if moment is None:
        return None
    return moment if moment.tzinfo is not None else moment.replace(tzinfo=timezone.utc)


def _iso(moment: Optional[datetime]) -> Optional[str]:
    m = _utc(moment)
    return m.isoformat() if m is not None else None


class _Ctx:
    """What every check reads: the window, the tills in scope and their labels."""

    def __init__(self, db: Session, window: ReportWindow, machines: Sequence[POSMachine], now: datetime):
        self.db = db
        self.window = window
        self.tz = _load_zoneinfo(window.tz_name)
        self.now = now
        self.machines = {m.id: m for m in machines}
        shop_ids = {m.shop_id for m in machines if m.shop_id}
        self.shops = {s.id: s for s in db.query(Shop).filter(Shop.id.in_(list(shop_ids))).all()} if shop_ids else {}
        self._terminal: Dict[uuid.UUID, Optional[str]] = {}

    def day(self, moment: Optional[datetime]) -> Optional[str]:
        m = _utc(moment)
        return m.astimezone(self.tz).date().isoformat() if m is not None else None

    def terminal(self, machine_id) -> Optional[str]:
        """The till's card integration in words (Nayax LAN, Agamento built-in, SynqPay, Z-Credit)."""
        if machine_id in self._terminal:
            return self._terminal[machine_id]
        label = None
        machine = self.machines.get(machine_id)
        if machine is not None:
            try:
                from app.models.pos_machine import device_has_builtin_terminal
                from app.routers.settings import _machine_parents
                from app.services import payment_integration as PI

                area, shop, company, tenant = _machine_parents(self.db, machine)
                res = PI.resolve(
                    PI.settings_layers(tenant, company, shop, area, machine),
                    device_has_builtin_terminal(getattr(machine, "device_model", None)),
                    synqpay_device=PI.is_synqpay_device(machine),
                )
                label = PI.LABELS_HE.get(res.integration, res.integration)
            except Exception:  # noqa: BLE001 - a label must never fail the report
                label = None
        self._terminal[machine_id] = label
        return label

    def row(self, check: str, status: str, *, machine_id=None, shop_id=None, **fields) -> Dict[str, Any]:
        machine = self.machines.get(machine_id) if machine_id else None
        shop = self.shops.get(shop_id or (machine.shop_id if machine else None))
        out = {
            "check": check,
            "checkLabel": CHECK_LABELS[check],
            "status": status,
            "statusLabel": STATUS_LABELS[status],
            "shopId": str(shop.id) if shop else None,
            "shopName": shop.name if shop else None,
            "machineId": str(machine_id) if machine_id else None,
            "machineName": machine.name if machine else None,
            "posNumber": machine.pos_number if machine else None,
            "terminal": None,
            "day": None,
            "zReportId": None,
            "zNumber": None,
            "zType": None,
            "subject": None,
            "expected": None,
            "actual": None,
            "difference": None,
            "count": None,
            "reason": None,
            # What the gap is (a stable code) and what the owner does about it
            # (`{label, href}` — a dashboard link when there is one), or None.
            "gapType": None,
            "action": None,
        }
        out.update(fields)
        if out["difference"] is None and out["expected"] is not None and out["actual"] is not None:
            out["difference"] = round(float(out["actual"]) - float(out["expected"]), 2)
        return out


# ── 1. Documents ↔ Z ─────────────────────────────────────────────────────────


def _documents(ctx: _Ctx, machine_ids: Sequence[uuid.UUID]) -> List[Transaction]:
    from fastapi import HTTPException, status

    q = ctx.db.query(Transaction).filter(
        Transaction.machine_id.in_(list(machine_ids)),
        Transaction.created_at >= ctx.window.start,
        Transaction.created_at < ctx.window.end,
    )
    if q.count() > DOCUMENTS_MAX:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"יותר מ-{DOCUMENTS_MAX:,} מסמכים בטווח — צמצמו את טווח התאריכים או בחרו סניף/קופה",
        )
    return q.order_by(Transaction.created_at.asc()).all()


def check_documents_z(ctx: _Ctx, docs: Sequence[Transaction], superseded: Optional[Set[Any]] = None) -> List[Dict[str, Any]]:
    """`superseded`: tills whose device was re-paired as a new machine (an open shift of
    such a till will never be closed by it)."""
    from app.services.document_filing import CONTAINER_LABELS, MODE_TILL, is_cloud_built, is_waiting, mode_at
    from app.services.late_documents import is_carry

    superseded = superseded or set()
    counted = [d for d in docs if d.status in SALE_STATUSES or d.status == TransactionStatus.CANCELLED]
    shift_ids = {d.shift_id for d in counted if d.shift_id}
    shifts = {s.id: s for s in ctx.db.query(Shift).filter(Shift.id.in_(list(shift_ids))).all()} if shift_ids else {}
    z_ids = {s.z_report_id for s in shifts.values() if s.z_report_id}
    zs = {z.id: z for z in ctx.db.query(ZReport).filter(ZReport.id.in_(list(z_ids))).all()} if z_ids else {}

    # Each document's container: the Z kind its till was in when it was issued (the owner,
    # 2026-10-07: "אם למשמרת של הקופה, לזד עצמאי") — the till's shift and the shop Z, or
    # the till's own Z (per-till / independent). `document_filing.mode_at`.
    groups: Dict[Tuple[Any, str, str, str], List[Transaction]] = defaultdict(list)
    for d in counted:
        mode = mode_at(ctx.machines.get(d.machine_id), d.created_at)
        shift = shifts.get(d.shift_id) if d.shift_id else None
        if d.shift_id is None or shift is None:
            state = "no_shift"
        elif str(shift.machine_id) != str(d.machine_id):
            state = "other_till_shift"
        elif shift.z_report_id is not None:
            z = zs.get(shift.z_report_id)
            received = _utc(d.server_received_at)
            built = _utc(z.created_at) if z is not None else None
            state = "late" if (received and built and received > built and not is_carry(shift) and not is_waiting(shift)) else "in_z"
            z_kind = MODE_TILL if z is not None and (z.origin or ZOrigin.CLOUD) == ZOrigin.TILL else "cloud"
            if state == "in_z" and z is not None and z.machine_id is None and z.per_machine is None:
                pass  # a legacy Z keeps no kind to compare
            elif state == "in_z" and z_kind != mode:
                # In a Z of the other kind: only the shop Z of a till that joined it since
                # takes its own-Z documents that arrived late (it has no run of its own).
                state = "in_z_joined" if (is_cloud_built(shift) and mode == MODE_TILL) else "wrong_container"
        elif is_waiting(shift):
            state = "waiting"
        elif is_carry(shift):
            state = "carried"
        elif shift.status == ShiftStatus.OPEN or shift.closed_at is None:
            state = "open_shift_repaired" if d.machine_id in superseded else "open_shift"
        else:
            state = "no_z"
        groups[(d.machine_id, ctx.day(d.created_at), state, mode)].append(d)

    reasons = {
        "in_z": (MATCH, "המסמכים נכללו ב-Z"),
        "in_z_joined": (
            MATCH,
            "המסמכים הונפקו כשהקופה הפיקה Z משלה והגיעו אחרי שהצטרפה ל-Z הסניפי — נכללו ב-Z הסניפי, בסעיף משלהם",
        ),
        "wrong_container": (DIFFERENCE, "המסמכים נכללו ב-Z מסוג אחר מזה שהקופה הייתה בו בעת ההפקה — לבדיקה"),
        "late": (DIFFERENCE, "המסמך הגיע לענן אחרי הפקת ה-Z — לא נכלל בסכומי ה-Z (מסמך מאוחר)"),
        "open_shift": (PENDING, "המשמרת עדיין פתוחה — המסמך ייכלל ב-Z הבא"),
        "open_shift_repaired": (
            MISSING,
            "המכשיר של הקופה שויך מחדש כקופה חדשה והמשמרת נשארה פתוחה — הקופה לא תסגור אותה, "
            "ולכן המסמכים שבה לא ייכללו באף Z עד שתיסגר",
        ),
        "no_z": (MISSING, "המשמרת נסגרה אך לא נכללה באף Z — יש להפיק Z"),
        "no_shift": (MISSING, "מסמך ללא משמרת (נקלט לפני כלל התיוק של 07.10.2026) — לא ייכלל באף Z"),
        "other_till_shift": (MISSING, "המסמך שמור במשמרת של קופה אחרת — לא נספר באף X או Z"),
        "waiting": (PENDING, "\"מסמכים שהמתינו למשמרת\" של הקופה — ייכללו ב-Z הבא של הקופה, בסעיף משלהם"),
        "carried": (PENDING, "מסמך מאוחר שהועבר ל-Z הבא של הקופה (ה-Z שלו כבר הופק)"),
    }
    actions = {
        "no_z": lambda m: _action("הפיקו Z", "/dashboard/z-reports"),
        "open_shift": lambda m: None,
        "wrong_container": lambda m: _action("פנו לתמיכה — המסמך נכלל ב-Z מסוג אחר", f"/dashboard/machines/{m}"),
        "open_shift_repaired": lambda m: _action(
            "סגרו את המשמרת בסגירה מנהלית (שחזור קופה מתה, עמוד הקופה) ואז הפיקו Z", f"/dashboard/machines/{m}",
        ),
        "waiting": lambda m: _action("הפיקו את ה-Z הבא של הקופה", "/dashboard/z-reports"),
        "carried": lambda m: _action("הפיקו את ה-Z הבא של הקופה", "/dashboard/z-reports"),
        "no_shift": lambda m: _action("פנו לתמיכה לתיוק המסמך במשמרת", f"/dashboard/machines/{m}"),
        "other_till_shift": lambda m: _action("פנו לתמיכה לתיוק המסמך במשמרת", f"/dashboard/machines/{m}"),
    }
    rows: List[Dict[str, Any]] = []
    for (machine_id, day, state, mode), group in sorted(groups.items(), key=lambda kv: (str(kv[0][0]), kv[0][1] or "", kv[0][2], kv[0][3])):
        status, reason = reasons[state]
        container = CONTAINER_LABELS.get(mode)
        if mode == MODE_TILL and state in ("no_z", "waiting", "carried", "open_shift"):
            reason = reason.replace("יש להפיק Z", "יש להפיק את ה-Z של הקופה (Z עצמאי) בקופה או לבקש אותו מהדשבורד")
            reason += " · המקום שלהם: ה-Z העצמאי של הקופה"
        elif state in ("no_z", "waiting", "carried", "open_shift"):
            reason += " · המקום שלהם: משמרת הקופה ← ה-Z הסניפי"
        action = actions.get(state, lambda m: None)(machine_id)
        amount = sum((_d(d.total_amount) * (-1 if is_refund_document(document_type=d.document_type, refund_of_transaction_id=d.refund_of_transaction_id) else 1)
                      for d in group if d.status in SALE_STATUSES and not getattr(d, "duplicate_copy", False)), ZERO)
        zs_of = sorted({zs[shifts[d.shift_id].z_report_id].z_number for d in group
                        if d.shift_id in shifts and shifts[d.shift_id].z_report_id in zs
                        and zs[shifts[d.shift_id].z_report_id].z_number is not None})
        rows.append(ctx.row(
            "documents_z", status, machine_id=machine_id, day=day,
            subject="מסמכים" if state in ("in_z", "in_z_joined") else "מסמכים שלא נכללו ב-Z",
            count=len(group), actual=_f(amount),
            zNumber=", ".join(str(n) for n in zs_of) or None,
            reason=reason, gapType=state, action=action, container=container, zMode=mode,
        ))
        if state in ("in_z", "in_z_joined"):
            continue
        for d in group[:DOCUMENT_ROWS_MAX]:
            rows.append(ctx.row(
                "documents_z", status, machine_id=machine_id, day=day,
                subject=f"מסמך {document_number_of(d)}",
                count=1, actual=_f(_d(d.total_amount)), reason=reason,
                transactionId=str(d.id), gapType=state, action=action, container=container, zMode=mode,
            ))
    return rows


def _action(label: str, href: Optional[str] = None) -> Dict[str, Any]:
    """The owner's action on a row: what to do, and where (a dashboard link) when there is one."""
    return {"label": label, "href": href}


# ── 2. Z totals ↔ documents ──────────────────────────────────────────────────

_Z_FIELDS = (
    ("transactionsCount", "מספר מסמכים", lambda t: Decimal(t.transactions_count), False),
    ("totalSales", "מכירות", lambda t: t.total_sales, True),
    ("totalRefunds", "זיכויים", lambda t: t.total_refunds, True),
    ("vatTotal", "מע״מ", lambda t: t.vat_total, True),
    ("totalTips", "טיפים", lambda t: t.total_tips, True),
)


def check_z_totals(ctx: _Ctx, zs: Sequence[ZReport], z_types: Dict[uuid.UUID, str]) -> List[Dict[str, Any]]:
    from app.services.shift_totals import compute_totals

    rows: List[Dict[str, Any]] = []
    for z in zs:
        sections = [s for s in (z.per_machine or []) if isinstance(s, dict)]
        if not sections:
            continue  # a legacy Z keeps no sections to compare
        for s in sections:
            shift_ids = []
            for raw in s.get("shiftIds") or []:
                try:
                    shift_ids.append(uuid.UUID(str(raw)))
                except (TypeError, ValueError):
                    continue
            machine_id = None
            try:
                machine_id = uuid.UUID(str(s.get("machineId"))) if s.get("machineId") else None
            except (TypeError, ValueError):
                machine_id = None
            now = compute_totals(ctx.db, shift_ids)
            # Corrections of earlier Zs' documents this Z carried (`z_adjustments`) are in its
            # figures and in no shift of it: added to the documents' side as the Z added them.
            carried_in = s.get("adjustments")
            if isinstance(carried_in, dict) and carried_in.get("delta"):
                from app.services.shift_totals import DocumentTotals

                now.add(DocumentTotals.from_delta_json(carried_in["delta"]))
            diffs: List[str] = []
            for key, label, getter, money in _Z_FIELDS:
                stored = s.get(key)
                if stored is None:
                    continue
                current = getter(now)
                if current is None:
                    continue
                if abs(_d(stored) - _d(current)) >= (TOLERANCE if money else Decimal("1")):
                    diffs.append(f"{label}: ב-Z {_d(stored):,.2f}, במסמכים {_d(current):,.2f}" if money
                                 else f"{label}: ב-Z {int(_d(stored))}, במסמכים {int(_d(current))}")
            stored_pay = {k: _d(v) for k, v in (s.get("paymentBreakdown") or {}).items()}
            for method in sorted(set(stored_pay) | set(now.payment_breakdown)):
                a, b = stored_pay.get(method, ZERO), now.payment_breakdown.get(method, ZERO)
                if abs(a - b) >= TOLERANCE:
                    diffs.append(f"אמצעי תשלום {method}: ב-Z {a:,.2f}, במסמכים {b:,.2f}")
            z_net = _d(s.get("totalSales")) - _d(s.get("totalRefunds"))
            doc_net = now.total_sales - now.total_refunds
            if not diffs:
                status, reason = MATCH, "סכומי ה-Z תואמים את המסמכים"
            else:
                late = int(z.late_documents or 0)
                amended = int(z.amended_documents or 0)
                why = []
                if late:
                    why.append(f"{late} מסמכים הגיעו אחרי הפקת ה-Z")
                if amended:
                    why.append(f"{amended} מסמכים עודכנו אחרי הפקת ה-Z")
                    carried_out = [c for c in (z.header or {}).get("adjustmentsCarried") or [] if isinstance(c, dict)]
                    into = sorted({str(c.get("intoZNumber")) for c in carried_out if c.get("intoZReportId")})
                    waiting = sum(1 for c in carried_out if not c.get("intoZReportId"))
                    if into:
                        why.append("ההפרש הועבר כהתאמה ל-Z " + ", ".join(into))
                    if waiting:
                        why.append(f"{waiting} תיקונים ממתינים ל-Z הבא של הקופה")
                status = DIFFERENCE
                reason = ("; ".join(why) + " — " if why else "הפרש לא מוסבר — לבדיקה: ") + " · ".join(diffs)
            rows.append(ctx.row(
                "z_totals", status, machine_id=machine_id, shop_id=z.shop_id,
                day=z.business_date.isoformat() if z.business_date else None,
                zReportId=str(z.id), zNumber=z.z_number, zType=z_types.get(z.id),
                subject=f"Z {z.z_number or '—'} · קופה {s.get('posNumber') or '—'}",
                expected=_f(z_net), actual=_f(doc_net), count=now.transactions_count, reason=reason,
            ))
    return rows


# ── 3. Document numbers ──────────────────────────────────────────────────────


def _refusals(ctx: _Ctx, machine_ids: Sequence[uuid.UUID]) -> Dict[uuid.UUID, Dict[str, int]]:
    """
    Per till: the cloud's refusals of its documents in the window that never landed, by
    reason — from the refusal record (`document_refusals`), and from `sync_logs` for
    refusals from before it (a document refused then and stored since is not counted).
    """
    from app.models.document_refusal import DocumentRefusal
    from app.models.sync_log import SyncLog, SyncStatus

    out: Dict[uuid.UUID, Dict[str, int]] = defaultdict(dict)
    seen: Set[Tuple[Any, Any]] = set()
    try:
        for machine_id, document_id, ref, note in (
            ctx.db.query(DocumentRefusal.machine_id, DocumentRefusal.document_id, DocumentRefusal.document_ref,
                         DocumentRefusal.reason)
            .filter(
                DocumentRefusal.machine_id.in_(list(machine_ids)),
                DocumentRefusal.landed_at.is_(None),
                DocumentRefusal.last_seen_at >= ctx.window.start - timedelta(days=1),
            )
            .all()
        ):
            seen.add((machine_id, document_id or ref))
            reason = (note or "refused").split(":")[0][:60]
            out[machine_id][reason] = out[machine_id].get(reason, 0) + 1
    except Exception:  # noqa: BLE001 - an explanation must never fail the report
        ctx.db.rollback()
    try:
        rows = (
            ctx.db.query(SyncLog.machine_id, SyncLog.entity_id, SyncLog.conflict_note)
            .filter(
                SyncLog.machine_id.in_(list(machine_ids)),
                SyncLog.status == SyncStatus.FAILED,
                SyncLog.created_at >= ctx.window.start - timedelta(days=1),
                SyncLog.created_at < ctx.window.end + timedelta(days=1),
            )
            .all()
        )
    except Exception:  # noqa: BLE001 - an explanation must never fail the report
        return out
    entity_ids = {e for _m, e, _n in rows if e is not None}
    stored = {
        r[0] for r in ctx.db.query(Transaction.id).filter(Transaction.id.in_(list(entity_ids))).all()
    } if entity_ids else set()
    for machine_id, entity_id, note in rows:
        if (machine_id, entity_id) in seen or entity_id in stored:
            continue
        seen.add((machine_id, entity_id))
        reason = (note or "refused").split(":")[0][:60]
        out[machine_id][reason] = out[machine_id].get(reason, 0) + 1
    return out


def _previous_number(ctx: _Ctx, machine_id, series: int, before: datetime) -> Optional[str]:
    """The till's last number in [series] before the window (by when it was issued)."""
    q = ctx.db.query(Transaction.transaction_number, Transaction.document_type, Transaction.refund_of_transaction_id).filter(
        Transaction.machine_id == machine_id,
        Transaction.created_at < before,
        Transaction.created_at >= before - timedelta(days=31),
    )
    for number, doc_type, refund_of in q.order_by(Transaction.created_at.desc()).limit(400).all():
        if document_series_of(doc_type, refund_of) == series and number and str(number).isdigit():
            return str(number)
    return None


def check_document_numbers(ctx: _Ctx, docs: Sequence[Transaction]) -> List[Dict[str, Any]]:
    groups: Dict[Tuple[Any, int], List[Transaction]] = defaultdict(list)
    for d in docs:
        if not d.transaction_number:
            continue
        series = int(getattr(d, "document_series", None) or document_series_of(d.document_type, d.refund_of_transaction_id))
        groups[(d.machine_id, series)].append(d)
    refusals = _refusals(ctx, list({k[0] for k in groups}))
    rows: List[Dict[str, Any]] = []
    for (machine_id, series), group in sorted(groups.items(), key=lambda kv: (str(kv[0][0]), kv[0][1])):
        numbers = [str(d.transaction_number).strip() for d in group]
        gaps, dups, non_numeric = find_gaps(numbers)
        numeric = sorted({int(n) for n in numbers if n.isdigit()})
        prefixes = sorted({document_prefix_of(d) or "" for d in group})
        previous = _previous_number(ctx, machine_id, series, ctx.window.start)
        before_gap = None
        if previous is not None and numeric and int(previous) + 1 < numeric[0]:
            before_gap = (int(previous) + 1, numeric[0] - 1)
        missing = sum(b - a + 1 for a, b in gaps) + (before_gap[1] - before_gap[0] + 1 if before_gap else 0)
        first = document_number_of(min(group, key=lambda d: (len(str(d.transaction_number)), str(d.transaction_number))))
        last = document_number_of(max(group, key=lambda d: (len(str(d.transaction_number)), str(d.transaction_number))))
        why: List[str] = []
        status = MATCH
        if missing:
            status = MISSING
            spans = ([before_gap] if before_gap else []) + list(gaps)
            shown = ", ".join(str(a) if a == b else f"{a}–{b}" for a, b in spans[:20])
            why.append(f"חסרים {missing} מספרים: {shown}" + (" …" if len(spans) > 20 else ""))
            refused = refusals.get(machine_id) or {}
            if refused:
                why.append("הענן דחה מסמכים מהקופה: " + ", ".join(f"{k} ×{v}" for k, v in refused.items())
                           + " — מסמך שנדחה לא נקלט")
            else:
                why.append("מסמך שלא הגיע לענן (בתור השליחה בקופה) או מספר שדולג")
        if dups:
            status = DIFFERENCE if status == MATCH else status
            why.append(f"מספרים כפולים: {', '.join(dups[:20])}")
        if len(prefixes) > 1:
            status = DIFFERENCE if status == MATCH else status
            why.append(f"קידומת המסמכים השתנתה בטווח: {', '.join(p or '—' for p in prefixes)}")
        if non_numeric:
            why.append(f"{non_numeric} מספרים לא מספריים")
        rows.append(ctx.row(
            "document_numbers", status, machine_id=machine_id,
            subject=f"{SERIES_LABELS.get(series, str(series))}: {first} – {last}",
            count=len(group), expected=float(len(group) + missing), actual=float(len(group)),
            difference=float(-missing) if missing else 0.0,
            reason="; ".join(why) or "רציף — ללא חוסרים וללא כפולים",
            series=series, firstNumber=first, lastNumber=last, previousNumber=previous,
            gapType="number_gap" if missing else ("number_duplicate" if dups else None),
            action=(
                _action("חברו את הקופה לרשת כדי שתשלח את המסמכים שבתור; ה-Z הבא שלה ימתין להם", f"/dashboard/machines/{machine_id}")
                if missing else
                _action("ראו \"מספר מסמך כפול בקופה\"", None) if dups else None
            ),
        ))
    return rows


# ── 3b. Refused documents ────────────────────────────────────────────────────


def check_refused_documents(ctx: _Ctx, machine_ids: Sequence[uuid.UUID]) -> List[Dict[str, Any]]:
    """
    "מסמך שנדחה בענן": every till document the cloud refused (`document_refusals`) — each
    one still refused (חסר), whenever it started, and those seen in the window that have
    landed since (תואם, for the history). Since 2026-10-07 only what is not a document at
    all is refused, so any row here is a document to look at.
    """
    from app.services.document_refusals import refusals_for

    try:
        refusals = refusals_for(ctx.db, list(machine_ids), since=ctx.window.start, until=ctx.window.end)
    except Exception:  # noqa: BLE001 - a missing record must never fail the report
        ctx.db.rollback()
        return []
    rows: List[Dict[str, Any]] = []
    for r in refusals:
        number = r.document_number or (str(r.document_id)[:8] if r.document_id else r.document_ref)
        series = SERIES_LABELS.get(abs(r.document_type)) if r.document_type else None
        why = [
            f"הענן דחה את המסמך: {r.reason}",
            f"{r.attempts} ניסיונות שליחה, לראשונה {_iso(r.first_seen_at)}, לאחרונה {_iso(r.last_seen_at)}",
        ]
        if r.landed_at is not None:
            status = MATCH
            why.append(f"המסמך נקלט בענן ב-{_iso(r.landed_at)}")
        else:
            status = MISSING
            why.append("המסמך עדיין לא נקלט — הוא ממתין בתור השליחה בקופה")
        rows.append(ctx.row(
            "refused_documents", status, machine_id=r.machine_id,
            day=ctx.day(r.issued_at or r.first_seen_at),
            subject=f"{REFUSED_SUBJECT} · מסמך {number}" + (f" ({series})" if series else ""),
            count=1, actual=_f(_d(r.total_amount)) if r.total_amount is not None else None,
            reason="; ".join(why),
            refusalId=str(r.id), documentRef=r.document_ref,
            documentNumber=r.document_number, documentType=r.document_type,
            attempts=r.attempts, firstSeenAt=_iso(r.first_seen_at), lastSeenAt=_iso(r.last_seen_at),
            landedAt=_iso(r.landed_at),
            gapType="refused_document",
            action=None if r.landed_at is not None else _action(
                "חברו את הקופה לרשת; אם הדחייה חוזרת — פנו לתמיכה (המסמך נשמר בקופה)", f"/dashboard/machines/{r.machine_id}",
            ),
            **({"transactionId": str(r.document_id)} if r.landed_at is not None and r.document_id else {}),
        ))
    return rows


# ── 4. Z numbers ─────────────────────────────────────────────────────────────


def _sequence_rows(ctx: _Ctx, label: str, numbers: List[int], previous: Optional[int], *, machine_id=None,
                   shop_id=None, run: Optional[int] = None) -> Dict[str, Any]:
    gaps, dups, _ = find_gaps([str(n) for n in numbers])
    ordered = sorted(set(numbers))
    before_gap = None
    if previous is not None and ordered and previous + 1 < ordered[0]:
        before_gap = (previous + 1, ordered[0] - 1)
    spans = ([before_gap] if before_gap else []) + list(gaps)
    missing = sum(b - a + 1 for a, b in spans)
    why = []
    status = MATCH
    if missing:
        status = MISSING
        why.append("חסרים מספרי Z: " + ", ".join(str(a) if a == b else f"{a}–{b}" for a, b in spans[:20])
                   + " — Z שלא הגיע לענן (Z לא מקוון בקופה) או קפיצה במספור")
    if dups:
        status = DIFFERENCE if status == MATCH else status
        why.append("מספרי Z כפולים: " + ", ".join(dups[:20]))
    return ctx.row(
        "z_numbers", status, machine_id=machine_id, shop_id=shop_id,
        subject=f"{label}: {ordered[0]} – {ordered[-1]}" if ordered else label,
        count=len(numbers), expected=float(len(numbers) + missing), actual=float(len(numbers)),
        difference=float(-missing) if missing else 0.0,
        reason="; ".join(why) or "מספור Z רציף",
        run=run, previousNumber=previous,
    )


def check_z_numbers(ctx: _Ctx, zs: Sequence[ZReport]) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    shop_runs: Dict[Any, List[ZReport]] = defaultdict(list)
    till_runs: Dict[Tuple[Any, int], List[ZReport]] = defaultdict(list)
    for z in zs:
        if (z.origin or ZOrigin.CLOUD) == ZOrigin.TILL and z.machine_sequence_number is not None:
            till_runs[(z.machine_id, int(z.machine_sequence_epoch or 0))].append(z)
        elif z.shop_sequence_number is not None:
            shop_runs[z.shop_id].append(z)
    for shop_id, group in shop_runs.items():
        numbers = [int(z.shop_sequence_number) for z in group]
        prev = (
            ctx.db.query(func.max(ZReport.shop_sequence_number))
            .filter(ZReport.shop_id == shop_id, ZReport.shop_sequence_number < min(numbers))
            .scalar()
        )
        rows.append(_sequence_rows(ctx, "Z סניפי", numbers, int(prev) if prev is not None else None, shop_id=shop_id))
    for (machine_id, epoch), group in till_runs.items():
        numbers = [int(z.machine_sequence_number) for z in group]
        prev = (
            ctx.db.query(func.max(ZReport.machine_sequence_number))
            .filter(
                ZReport.machine_id == machine_id,
                ZReport.machine_sequence_epoch == epoch,
                ZReport.machine_sequence_number < min(numbers),
            )
            .scalar()
        )
        machine = ctx.machines.get(machine_id)
        rows.append(_sequence_rows(
            ctx, f"Z קופה {machine.pos_number if machine and machine.pos_number else ''}".strip(), numbers,
            int(prev) if prev is not None else None, machine_id=machine_id,
            shop_id=machine.shop_id if machine else None, run=epoch,
        ))
    return rows


# ── 5. Card legs ↔ transmissions ─────────────────────────────────────────────


def _card_legs(ctx: _Ctx, machine_ids: Sequence[uuid.UUID]):
    from app.services.transmissions import TRANSMITTABLE_STATUSES, _charged_expr

    return (
        ctx.db.query(
            TransactionPayment.id,
            Transaction.id,
            Transaction.machine_id,
            Transaction.created_at,
            Transaction.document_type,
            Transaction.refund_of_transaction_id,
            TransactionPayment.terminal_uid,
            TransactionPayment.transmission_id,
            TransactionPayment.card_brand,
            _charged_expr(),
        )
        .join(Transaction, Transaction.id == TransactionPayment.transaction_id)
        .filter(
            Transaction.machine_id.in_(list(machine_ids)),
            Transaction.created_at >= ctx.window.start,
            Transaction.created_at < ctx.window.end,
            TransactionPayment.method == "card",
            Transaction.status.in_(TRANSMITTABLE_STATUSES),
        )
        .all()
    )


def _assumed_pairs(ctx: _Ctx, transmission_ids: Iterable[Any]) -> Set[Tuple[Any, str]]:
    ids = [t for t in set(transmission_ids) if t is not None]
    if not ids:
        return set()
    return {
        (tid, uid)
        for tid, uid in ctx.db.query(CardTransmissionItem.transmission_id, CardTransmissionItem.terminal_uid)
        .filter(CardTransmissionItem.transmission_id.in_(ids), CardTransmissionItem.assumed.is_(True))
        .all()
    }


def _offline_outcomes(ctx: _Ctx, pairs: Set[Tuple[Any, str]]) -> Dict[Tuple[Any, str], str]:
    from app.models.offline_authorization import OfflineAuthorizationItem, OfflineOutcome

    if not pairs:
        return {}
    machine_ids = list({m for m, _ in pairs})
    uids = list({u for _, u in pairs})
    out: Dict[Tuple[Any, str], str] = {}
    for start in range(0, len(uids), 500):
        for machine_id, uid, outcome in (
            ctx.db.query(OfflineAuthorizationItem.machine_id, OfflineAuthorizationItem.terminal_uid, OfflineAuthorizationItem.outcome)
            .filter(
                OfflineAuthorizationItem.machine_id.in_(machine_ids),
                OfflineAuthorizationItem.terminal_uid.in_(uids[start:start + 500]),
            )
            .all()
        ):
            key = (machine_id, uid)
            if outcome == OfflineOutcome.DECLINED or key not in out:
                out[key] = outcome
    return out


def check_card_legs(ctx: _Ctx, machine_ids: Sequence[uuid.UUID]) -> List[Dict[str, Any]]:
    legs = _card_legs(ctx, machine_ids)
    assumed = _assumed_pairs(ctx, (l[7] for l in legs))
    untransmitted_pairs = {(l[2], l[6]) for l in legs if l[7] is None and l[6]}
    offline = _offline_outcomes(ctx, untransmitted_pairs)

    acc: Dict[Tuple[Any, str], Dict[str, Any]] = {}
    for leg_id, tx_id, machine_id, created_at, doc_type, refund_of, uid, tid, brand, charged in legs:
        day = ctx.day(created_at)
        a = acc.setdefault((machine_id, day), {
            "legs": 0, "amount": ZERO, "verified": 0, "verifiedAmount": ZERO, "assumed": 0, "assumedAmount": ZERO,
            "pending": 0, "pendingAmount": ZERO, "overdue": 0, "overdueAmount": ZERO, "critical": 0,
            "declined": 0, "declinedAmount": ZERO, "untracked": 0, "untrackedAmount": ZERO, "noUid": 0,
            "offlineWaiting": 0, "brands": defaultdict(lambda: ZERO), "oldest": None,
        })
        sign = Decimal("-1") if is_refund_document(document_type=doc_type, refund_of_transaction_id=refund_of) else Decimal("1")
        amount = _d(charged) * sign
        a["legs"] += 1
        a["amount"] += amount
        a["brands"][brand or "other"] += amount
        machine = ctx.machines.get(machine_id)
        tracking = _utc(machine.transmission_tracking_started_at) if machine else None
        if tid is not None:
            if (tid, uid) in assumed:
                a["assumed"] += 1
                a["assumedAmount"] += amount
            else:
                a["verified"] += 1
                a["verifiedAmount"] += amount
            continue
        if not uid:
            a["noUid"] += 1
        outcome = offline.get((machine_id, uid)) if uid else None
        if outcome == "declined":
            a["declined"] += 1
            a["declinedAmount"] += amount
            continue
        if tracking is None or _utc(created_at) < tracking:
            a["untracked"] += 1
            a["untrackedAmount"] += amount
            continue
        age = ctx.now - _utc(created_at)
        if age < OVERDUE:
            a["pending"] += 1
            a["pendingAmount"] += amount
        else:
            a["overdue"] += 1
            a["overdueAmount"] += amount
            if age >= CRITICAL:
                a["critical"] += 1
        if outcome is None and machine is not None and getattr(machine, "terminal_offline_mode", None):
            a["offlineWaiting"] += 1
        oldest = _utc(created_at)
        a["oldest"] = oldest if a["oldest"] is None else min(a["oldest"], oldest)

    rows = []
    brand_names = {"visa": "ויזה", "mastercard": "מאסטרקארד", "isracard": "ישראכרט", "amex": "אמקס", "diners": "דיינרס", "other": "אחר"}
    for (machine_id, day), a in sorted(acc.items(), key=lambda kv: (str(kv[0][0]), kv[0][1] or "")):
        transmitted = a["verifiedAmount"] + a["assumedAmount"]
        why = []
        status = MATCH
        if a["declined"]:
            status = MISSING
            why.append(f"{a['declined']} עסקאות נדחו בהרצת אישור עסקאות לא מקוונות (₪{a['declinedAmount']:,.2f}) — הכסף לא יגיע")
        if a["overdue"]:
            status = MISSING
            why.append(f"{a['overdue']} עסקאות לא שודרו מעל 24 שעות (₪{a['overdueAmount']:,.2f})"
                       + (f", מהן {a['critical']} מעל 7 ימים — חברת האשראי עלולה לדחות" if a["critical"] else ""))
        if a["pending"]:
            status = PENDING if status == MATCH else status
            why.append(f"{a['pending']} עסקאות ממתינות לשידור (פחות מ-24 שעות, ₪{a['pendingAmount']:,.2f})")
        if a["offlineWaiting"]:
            why.append(f"המסוף במצב לא מקוון — {a['offlineWaiting']} עסקאות ייתכן שממתינות לאישור (Deferred)")
        if a["assumed"]:
            why.append(f"{a['assumed']} עסקאות שודרו במנה שהמסוף לא פירט — לא אומתו מול המסוף")
        if a["untracked"]:
            why.append(f"{a['untracked']} עסקאות מלפני תחילת מעקב השידורים בקופה")
        if a["noUid"]:
            why.append(f"{a['noUid']} עסקאות ללא מזהה עסקה מהמסוף — לא ניתן לשייך לשידור")
        if not why:
            why.append("כל עסקאות האשראי שודרו ואומתו")
        rows.append(ctx.row(
            "card_legs", status, machine_id=machine_id, day=day, terminal=ctx.terminal(machine_id),
            subject="אשראי במסמכים מול שידורים",
            expected=_f(a["amount"]), actual=_f(transmitted), count=a["legs"],
            reason="; ".join(why),
            transmittedLegs=a["verified"] + a["assumed"], assumedLegs=a["assumed"],
            untransmittedLegs=a["pending"] + a["overdue"], untransmittedAmount=_f(a["pendingAmount"] + a["overdueAmount"]),
            declinedLegs=a["declined"], oldestUntransmitted=_iso(a["oldest"]),
            brands=" · ".join(f"{brand_names.get(b, b)} ₪{v:,.2f}" for b, v in sorted(a["brands"].items(), key=lambda kv: -kv[1])),
        ))
    return rows


# ── 6. Transmissions ─────────────────────────────────────────────────────────


def check_transmissions(ctx: _Ctx, machine_ids: Sequence[uuid.UUID], card_rows: Sequence[Dict[str, Any]]) -> List[Dict[str, Any]]:
    from app.services.transmissions import _charged_by_leg

    reports = (
        ctx.db.query(CardTransmission)
        .filter(
            CardTransmission.machine_id.in_(list(machine_ids)),
            CardTransmission.started_at >= ctx.window.start,
            CardTransmission.started_at < ctx.window.end,
        )
        .order_by(CardTransmission.started_at.asc())
        .all()
    )
    ids = [r.id for r in reports]
    legs_by_t: Dict[Any, List[Any]] = defaultdict(list)
    refund_legs: Set[Any] = set()
    if ids:
        for leg_id, tid, doc_type, refund_of in (
            ctx.db.query(
                TransactionPayment.id, TransactionPayment.transmission_id,
                Transaction.document_type, Transaction.refund_of_transaction_id,
            )
            .join(Transaction, Transaction.id == TransactionPayment.transaction_id)
            .filter(TransactionPayment.transmission_id.in_(ids))
            .all()
        ):
            legs_by_t[tid].append(leg_id)
            if is_refund_document(document_type=doc_type, refund_of_transaction_id=refund_of):
                refund_legs.add(leg_id)
    charged = _charged_by_leg(ctx.db, [leg for legs in legs_by_t.values() for leg in legs])
    # A credit note on the card is money back out of the batch.
    charged = {k: (-v if k in refund_legs else v) for k, v in charged.items()}
    assumed = defaultdict(int)
    named = defaultdict(int)
    if ids:
        for tid, is_assumed in (
            ctx.db.query(CardTransmissionItem.transmission_id, CardTransmissionItem.assumed)
            .filter(CardTransmissionItem.transmission_id.in_(ids))
            .all()
        ):
            (assumed if is_assumed else named)[tid] += 1
    later_success: Dict[Any, List[datetime]] = defaultdict(list)
    for r in reports:
        if r.status == TransmissionStatus.SUCCESS:
            later_success[r.machine_id].append(_utc(r.started_at))
    # A success after the window resolves a failure in it too.
    for machine_id in machine_ids:
        after = (
            ctx.db.query(func.min(CardTransmission.started_at))
            .filter(
                CardTransmission.machine_id == machine_id,
                CardTransmission.status == TransmissionStatus.SUCCESS,
                CardTransmission.started_at >= ctx.window.end,
            )
            .scalar()
        )
        if after is not None:
            later_success[machine_id].append(_utc(after))

    rows: List[Dict[str, Any]] = []
    for r in reports:
        legs = legs_by_t.get(r.id, [])
        legs_amount = sum((charged.get(leg, ZERO) for leg in legs), ZERO)
        why = []
        status = MATCH
        if r.status == TransmissionStatus.SUCCESS:
            reported = _d(r.amount) if r.amount is not None else None
            if reported is not None and abs(reported - legs_amount) >= TOLERANCE:
                status = DIFFERENCE
                why.append(
                    f"סכום המנה שדווח (₪{reported:,.2f}) שונה מסכום העסקאות שסומנו בה (₪{legs_amount:,.2f}) — "
                    "עסקאות שמסמכיהן טרם הגיעו לענן, ביטול/זיכוי במסוף, או עסקה שלא נקשרה"
                )
            if (r.transaction_count or 0) and not legs:
                status = DIFFERENCE
                why.append(f"המנה דיווחה {r.transaction_count} עסקאות אך אף עסקה בענן לא נקשרה אליה")
            if assumed.get(r.id):
                why.append(f"{assumed[r.id]} עסקאות שויכו למנה בהנחה — המסוף לא פירט את עסקאות המנה")
            if not why:
                why.append("שידור הצליח והעסקאות שבו תואמות")
        else:
            resolved = [t for t in later_success.get(r.machine_id, []) if t > _utc(r.started_at)]
            label = "נכשל" if r.status == TransmissionStatus.FAILED else "ללא תשובה מהמסוף"
            detail = r.error or r.status_message or r.status
            if resolved:
                why.append(f"שידור {label} ({detail}) — הושלם בשידור מוצלח מאוחר יותר ({_iso(min(resolved))})")
            else:
                status = MISSING
                why.append(f"שידור {label} ({detail}) ולא הושלם בשידור מוצלח — עסקאות ממתינות לשידור")
        finished = _utc(r.finished_at) or _utc(r.started_at)
        received = _utc(r.received_at)
        if finished and received and received - finished > LATE_REPORT:
            hours = (received - finished).total_seconds() / 3600
            why.append(f"הדיווח הגיע לענן באיחור של {hours:.1f} שעות")
        rows.append(ctx.row(
            "transmissions", status, machine_id=r.machine_id, day=ctx.day(r.started_at), terminal=ctx.terminal(r.machine_id),
            subject=f"שידור {r.trigger} · {r.status}" + (f" · מנה {r.batch_number}" if r.batch_number else ""),
            expected=_f(_d(r.amount)) if r.amount is not None else None, actual=_f(legs_amount),
            count=r.transaction_count, reason="; ".join(why),
            transmissionId=str(r.id), batchNumber=r.batch_number, trigger=r.trigger,
            transmissionStatus=r.status, startedAt=_iso(r.started_at), receivedAt=_iso(r.received_at),
            namedTransactions=named.get(r.id, 0), assumedTransactions=assumed.get(r.id, 0),
        ))

    # A till with card sales in the window whose transmissions never reached the cloud.
    reported_tills = {r.machine_id for r in reports}
    card_tills = defaultdict(lambda: [0, ZERO])
    for row in card_rows:
        if row.get("machineId"):
            key = uuid.UUID(row["machineId"])
            card_tills[key][0] += int(row.get("count") or 0)
            card_tills[key][1] += _d(row.get("expected"))
    for machine_id, (count, amount) in card_tills.items():
        if machine_id in reported_tills:
            continue
        machine = ctx.machines.get(machine_id)
        ever = ctx.db.query(func.max(CardTransmission.received_at)).filter(CardTransmission.machine_id == machine_id).scalar()
        if ever is None:
            reason = "לא התקבל בענן אף דיווח שידור מהקופה מעולם — בדקו את גרסת הקופה ואת החיבור לענן"
        else:
            reason = f"לא התקבל בענן דיווח שידור בטווח; הדיווח האחרון התקבל ב-{_iso(ever)}"
        pending = machine is not None and (machine.transmission_pending_count or 0) > 0
        rows.append(ctx.row(
            "transmissions", MISSING if pending or ever is None else PENDING, machine_id=machine_id,
            terminal=ctx.terminal(machine_id), subject="שידורים מהקופה",
            expected=_f(amount), actual=0.0, count=count,
            reason=reason + (f"; הקופה מדווחת {machine.transmission_pending_count} עסקאות ממתינות לשידור" if pending else ""),
        ))
    return rows


# ── 8. Tills re-paired as a new machine (docs/SHIFTS_API.md §1.2c-bis) ──────


def superseded_machines(db: Session, machine_ids: Sequence[uuid.UUID]) -> Dict[Any, POSMachine]:
    """Per till of `machine_ids` whose device was re-paired as a new machine: that new machine."""
    if not machine_ids:
        return {}
    rows = db.query(POSMachine).filter(POSMachine.predecessor_machine_id.in_(list(machine_ids))).all()
    out: Dict[Any, POSMachine] = {}
    for m in sorted(rows, key=lambda m: _utc(m.created_at) or datetime.min.replace(tzinfo=timezone.utc)):
        out[m.predecessor_machine_id] = m
    return out


def check_repaired_tills(ctx: _Ctx, machine_ids: Sequence[uuid.UUID]) -> List[Dict[str, Any]]:
    """
    A till whose device was re-paired as a new machine (an ordinary pairing code): what it
    still owes — its open shift, closed shifts no Z took, the documents it reported unsent at
    the re-pair — and what reached it through the new machine. And, on the new machine, that
    documents it delivered were filed under the till that issued them.
    """
    from app.services.shifts import find_open_shift

    rows: List[Dict[str, Any]] = []
    successors = superseded_machines(ctx.db, machine_ids)
    for old_id, new in successors.items():
        old = ctx.machines.get(old_id)
        if old is None:
            continue
        handover = new.repair_handover if isinstance(new.repair_handover, dict) else {}
        refiled = (
            ctx.db.query(func.count(Transaction.id))
            .filter(Transaction.machine_id == old.id, Transaction.pushed_by_machine_id == new.id)
            .scalar()
        ) or 0
        repaired_at = _utc(new.created_at)
        base = f"המכשיר של הקופה שויך מחדש כקופה חדשה ב-{_iso(repaired_at)}"
        open_shift = find_open_shift(ctx.db, old.id)
        if open_shift is not None:
            rows.append(ctx.row(
                "repaired_tills", MISSING, machine_id=old.id, day=ctx.day(open_shift.opened_at),
                subject=f"משמרת #{open_shift.sequence_number or '—'} פתוחה מאז {ctx.day(open_shift.opened_at)}",
                count=refiled,
                reason=(
                    f"{base} כשהמשמרת עוד פתוחה. {refiled} מסמכים שהונפקו בה ונשלחו אחרי השיוך מחדש תויקו בה "
                    "(תחת הקופה שהנפיקה אותם). הקופה לא תסגור את המשמרת — המסמכים שבה לא ייכללו באף Z עד שתיסגר."
                ),
                gapType="repaired_open_shift",
                action=_action(
                    "סגרו את המשמרת בסגירה מנהלית (שחזור קופה מתה, בעמוד הקופה), ואז הפיקו Z לסניף",
                    f"/dashboard/machines/{old.id}",
                ),
                shiftId=str(open_shift.id), successorMachineId=str(new.id),
            ))
        awaiting = (
            ctx.db.query(func.count(Shift.id))
            .filter(Shift.machine_id == old.id, Shift.status == ShiftStatus.CLOSED, Shift.z_report_id.is_(None))
            .scalar()
        ) or 0
        if awaiting:
            rows.append(ctx.row(
                "repaired_tills", MISSING, machine_id=old.id, subject="משמרות סגורות שלא נכללו ב-Z",
                count=awaiting, reason=f"{base}; {awaiting} משמרות סגורות שלה עוד לא נכללו באף Z",
                gapType="repaired_awaiting_z", action=_action("הפיקו Z לסניף של הקופה", "/dashboard/z-reports"),
            ))
        pending = handover.get("pendingDocuments")
        if isinstance(pending, int) and pending > 0:
            since = handover.get("pendingAt")
            q = ctx.db.query(func.count(Transaction.id)).filter(Transaction.machine_id == old.id)
            try:
                if since:
                    q = q.filter(Transaction.server_received_at > datetime.fromisoformat(since))
            except ValueError:
                pass
            arrived = q.scalar() or 0
            status = MATCH if arrived >= pending else MISSING
            rows.append(ctx.row(
                "repaired_tills", status, machine_id=old.id, subject="מסמכים שהקופה דיווחה כממתינים בעת השיוך מחדש",
                expected=float(pending), actual=float(min(arrived, pending)), count=pending,
                reason=(
                    f"{base}; היא דיווחה על {pending} מסמכים שטרם נשלחו, והגיעו מאז {arrived} "
                    + ("— כולם תויקו תחת הקופה" if status == MATCH else "— חסרים מסמכים שעוד בתור השליחה של המכשיר")
                ),
                gapType="repaired_pending_documents",
                action=None if status == MATCH else _action(
                    "חברו את המכשיר לרשת (בשיוך החדש) — המסמכים יתויקו תחת הקופה המקורית", f"/dashboard/machines/{new.id}",
                ),
            ))
        if not rows or all(r["machineId"] != str(old.id) for r in rows):
            rows.append(ctx.row(
                "repaired_tills", MATCH, machine_id=old.id, subject="שיוך מחדש — אין עבודה פתוחה",
                count=refiled, reason=f"{base}; {refiled} מסמכים שנשלחו אחרי השיוך מחדש תויקו תחת הקופה",
                gapType="repaired_clean",
            ))
    # The new machines in scope: their predecessor, and what they delivered for it.
    for machine in ctx.machines.values():
        pid = getattr(machine, "predecessor_machine_id", None)
        if pid is None:
            continue
        delivered = (
            ctx.db.query(func.count(Transaction.id))
            .filter(Transaction.pushed_by_machine_id == machine.id)
            .scalar()
        ) or 0
        if not delivered:
            continue
        rows.append(ctx.row(
            "repaired_tills", MATCH, machine_id=machine.id, subject="מסמכים של הקופה הקודמת של המכשיר",
            count=delivered,
            reason=(
                f"המכשיר היה קופה אחרת לפני ששויך כקופה הזו; {delivered} מסמכים שהונפקו לפני השיוך ונשלחו ממנו "
                "תויקו תחת הקופה שהנפיקה אותם (העסק, הסניף והמשמרת שלה) — לא כאן"
            ),
            gapType="delivered_for_predecessor",
        ))
    return rows


# ── 9. Same number, different id (§1.2d) ─────────────────────────────────────


def check_numbering_conflicts(ctx: _Ctx, docs: Sequence[Transaction]) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    conflicts = [d for d in docs if getattr(d, "number_conflict_of", None) is not None]
    holders = {
        t.id: t for t in ctx.db.query(Transaction).filter(
            Transaction.id.in_([d.number_conflict_of for d in conflicts])
        ).all()
    } if conflicts else {}
    for d in conflicts:
        holder = holders.get(d.number_conflict_of)
        copy = bool(getattr(d, "duplicate_copy", False))
        rows.append(ctx.row(
            "numbering_conflicts", MISSING, machine_id=d.machine_id, day=ctx.day(d.created_at),
            subject=f"מסמך {document_number_of(d)} — מספר שכבר קיים בקופה",
            count=1, actual=_f(_d(d.total_amount)),
            reason=(
                f"שני מסמכים בקופה עם אותו מספר ({SERIES_LABELS.get(int(d.document_series or 320), d.document_series)}): "
                f"המסמך המקורי {str(d.number_conflict_of)[:8]}"
                + (f" מ-{_iso(holder.created_at)}" if holder is not None else "")
                + ". שניהם נשמרו. "
                + (
                    "זהו עותק כפול של אותו מסמך (אותו מועד ואותו תוכן) — לא נספר בסכומים, ונספר פעם אחת דרך המקורי."
                    if copy else
                    "התוכן שונה — זו מכירה נפרדת והיא נספרת ב-X וב-Z; בקובץ המבנה האחיד מספר כפול ייחסם עד בירור."
                )
            ),
            gapType="numbering_duplicate_copy" if copy else "numbering_conflict",
            action=_action(
                "בדקו את מונה המסמכים בקופה (התקנה מחדש / שחזור גיבוי) ופנו לתמיכה", f"/dashboard/machines/{d.machine_id}",
            ),
            transactionId=str(d.id), holderTransactionId=str(d.number_conflict_of), duplicateCopy=copy,
        ))
    return rows


# ── 10. Zs waiting for documents, tills whose next Z will, corrections ───────


def check_z_completeness(ctx: _Ctx, machine_ids: Sequence[uuid.UUID]) -> List[Dict[str, Any]]:
    from app.models.z_run import ZRun, ZRunItem, ZRunItemStatus, ZRunStatus
    from app.services import z_adjustments, z_completeness as ZC
    from app.services.z_builder import unreported_shifts

    rows: List[Dict[str, Any]] = []
    waiting_items = (
        ctx.db.query(ZRunItem, ZRun)
        .join(ZRun, ZRun.id == ZRunItem.run_id)
        .filter(
            ZRunItem.machine_id.in_(list(machine_ids)),
            ZRun.status == ZRunStatus.WAITING,
            ZRunItem.status == ZRunItemStatus.READY,
            ZRunItem.error_code == ZC.WAITING_DOCUMENTS,
        )
        .all()
    )
    waiting_tills = set()
    for item, run in waiting_items:
        waiting_tills.add(item.machine_id)
        rows.append(ctx.row(
            "z_completeness", MISSING, machine_id=item.machine_id, shop_id=run.shop_id,
            day=ctx.day(run.created_at), subject="Z ממתין למסמכים",
            reason=item.error_message or "ממתין למסמכים שהענן יודע שחסרים",
            gapType="z_waiting_documents",
            action=_action(
                "חברו את הקופה לרשת כדי שהמסמכים יעלו (ה-Z ייבנה מעצמו); או \"המשך בלי הקופה\"; לקופה שלא תחזור — Z מהענן ע״י התמיכה",
                f"/dashboard/machines/{item.machine_id}",
            ),
            runId=str(run.id),
        ))
    for machine_id in machine_ids:
        machine = ctx.machines.get(machine_id)
        if machine is None or machine_id in waiting_tills:
            continue
        shifts = unreported_shifts(ctx.db, machine_id)
        closed = [s for s in shifts if s.status == ShiftStatus.CLOSED]
        if closed:
            through = shifts.index(closed[-1]) + 1
            found = ZC.missing_for_z(ctx.db, machine, shifts[:through], takes_newest=True)
            if found["missing"]:
                rows.append(ctx.row(
                    "z_completeness", MISSING, machine_id=machine_id, subject="ה-Z הבא של הקופה ימתין למסמכים",
                    count=int(found["missing"]),
                    reason="; ".join(r["text"] for r in found["reasons"]) + " — Z לא ייבנה בלי המסמכים האלה",
                    gapType="z_will_wait",
                    action=_action("חברו את הקופה לרשת כדי שתשלח את המסמכים שבתור", f"/dashboard/machines/{machine_id}"),
                ))
        for entry in z_adjustments.pending(machine):
            rows.append(ctx.row(
                "z_completeness", PENDING, machine_id=machine_id, day=ctx.day(datetime.fromisoformat(entry["at"])) if entry.get("at") else None,
                zReportId=entry.get("sourceZReportId"), zNumber=entry.get("sourceZNumber"),
                subject=f"תיקון למסמך {entry.get('documentNumber') or ''} שנכלל ב-Z קודם",
                count=1,
                reason="המסמך נשלח שוב מהקופה עם סכומים אחרים אחרי שה-Z ספר אותו — ההפרש ייכלל ב-Z הבא של הקופה כהתאמה, בסעיף משלו",
                gapType="z_adjustment_pending",
                action=_action("הפיקו את ה-Z הבא של הקופה", "/dashboard/z-reports"),
                transactionId=entry.get("documentId"),
            ))
    return rows


# ── 11. What ingest noted about the documents ────────────────────────────────


INGEST_NOTE_ROWS = {
    "tenders_do_not_reconcile": (
        DIFFERENCE,
        "אמצעי התשלום שהקופה שלחה אינם מסתכמים לסכום המסמך. המסמך נספר לפי סכומו; בקובץ המבנה האחיד רשומות "
        "התשלום (D120) מחולקות לסכום המסמך ומסומנות — הקובץ עקבי",
        "בדקו את המסמך מול הקופה ומסוף האשראי",
    ),
    "refund_of_other_tenant": (DIFFERENCE, "הזיכוי מקושר למסמך של עסק אחר — נקלט; הקישור לא נשמר", "בדקו את המסמך"),
    "issued_before_pairing": (
        DIFFERENCE,
        "המסמך הונפק לפני שהקופה שויכה, והקופה שהנפיקה אותו לא זוהתה (אין קישור שיוך מחדש) — נקלט תחת הקופה ששלחה אותו",
        "פנו לתמיכה לתיוק המסמך תחת הקופה שהנפיקה אותו",
    ),
    "filed_under_issuing_till": (MATCH, "המסמך נשלח מהמכשיר אחרי ששויך מחדש — תויק תחת הקופה שהנפיקה אותו", None),
    "filed_by_time": (MATCH, "המסמך נשלח בלי משמרת (או עם משמרת של קופה אחרת) — תויק במשמרת שמכסה את מועד הפקתו", None),
}


def check_ingest_notes(ctx: _Ctx, docs: Sequence[Transaction]) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    for d in docs:
        for note in d.ingest_notes or []:
            code = note.get("code") if isinstance(note, dict) else None
            spec = INGEST_NOTE_ROWS.get(code)
            if spec is None:
                continue
            status, reason, action = spec
            rows.append(ctx.row(
                "ingest_notes", status, machine_id=d.machine_id, day=ctx.day(d.created_at),
                subject=f"מסמך {document_number_of(d)}", count=1, actual=_f(_d(d.total_amount)),
                reason=reason + (f" ({note.get('detail')})" if note.get("detail") else ""),
                gapType=code, action=_action(action, f"/dashboard/transactions?tx={d.id}") if action else None,
                transactionId=str(d.id),
            ))
    return rows


# ── 12. Cloud card refunds ↔ credit notes ────────────────────────────────────


def check_cloud_card_refunds(ctx: _Ctx, machine_ids: Sequence[uuid.UUID]) -> List[Dict[str, Any]]:
    """
    "זיכוי באשראי מהענן (Z-Credit)" (docs/SPEC_REMOTE_CREDIT.md §11): every card refund the cloud
    made (or may have made) in the window, of a sale of a till in scope, against its credit note.
    The money moved at Z-Credit; the fiscal document comes from a till — until it reaches the
    cloud the refund is a gap: ממתין while a till still has it to issue, חסר when no till will
    (refused, expired), הפרש when the outcome at Z-Credit is unknown or the note's total differs.
    A declined refund moved nothing and is not listed.
    """
    from app.models.cloud_card_refund import CloudCardRefund, CloudCardRefundStatus as CS
    from app.models.remote_credit import PENDING_REMOTE_CREDIT_STATUSES, RemoteCreditRequest
    from app.services.cloud_card_refunds import _stale

    try:
        refunds = (
            ctx.db.query(CloudCardRefund)
            .filter(
                CloudCardRefund.original_machine_id.in_(list(machine_ids)),
                CloudCardRefund.created_at >= ctx.window.start,
                CloudCardRefund.created_at < ctx.window.end,
                CloudCardRefund.status != CS.DECLINED,
            )
            .order_by(CloudCardRefund.created_at.asc())
            .all()
        )
    except Exception:  # noqa: BLE001 - a missing table must never fail the report
        ctx.db.rollback()
        return []
    rows: List[Dict[str, Any]] = []
    for r in refunds:
        req = (
            ctx.db.query(RemoteCreditRequest).filter(RemoteCreditRequest.id == r.remote_credit_request_id).first()
            if r.remote_credit_request_id
            else None
        )
        credit = (
            ctx.db.query(Transaction).filter(Transaction.id == r.credit_transaction_id).first()
            if r.credit_transaction_id
            else None
        )
        amount = _d(r.amount)
        subject = f"זיכוי באשראי מהענן · מסמך {r.original_document_number or str(r.original_transaction_id)[:8]}"
        if r.card_last4:
            subject += f" · ****{r.card_last4}"
        href = f"/dashboard/transactions?tx={r.original_transaction_id}"
        if r.status == CS.UNKNOWN or (r.status == CS.IN_FLIGHT and _stale(r, ctx.now)):
            status, gap = DIFFERENCE, "card_refund_unknown"
            why = "לא ידוע אם הכרטיס זוכה ב-Z-Credit — בדקו מול Z-Credit ורשמו את התוצאה"
            action = _action("בדקו את הזיכוי", href)
        elif r.status == CS.IN_FLIGHT:
            status, gap, why, action = PENDING, "card_refund_in_progress", "הזיכוי בביצוע מול Z-Credit", None
        elif credit is not None and credit.status != TransactionStatus.CANCELLED:
            got = abs(_d(credit.total_amount))
            if abs(got - amount) > TOLERANCE:
                status, gap = DIFFERENCE, "card_refund_document_differs"
                why = f"מסמך הזיכוי {document_number_of(credit)} על {_f(got)} ₪ והכרטיס זוכה ב-{_f(amount)} ₪"
                action = _action("פתחו את מסמך הזיכוי", f"/dashboard/transactions?tx={credit.id}")
            else:
                status, gap, action = MATCH, None, None
                why = f"הכרטיס זוכה ומסמך זיכוי {document_number_of(credit)} הופק בקופה"
        elif r.credit_transaction_id is not None:
            status, gap, action = PENDING, "card_refund_document_unsynced", None
            why = f"הקופה הפיקה את מסמך הזיכוי {r.credit_document_number or ''} — ממתין לסנכרון לענן".replace("  ", " ")
        elif req is not None and req.status in PENDING_REMOTE_CREDIT_STATUSES:
            status, gap, action = PENDING, "card_refund_document_pending", None
            why = "הכרטיס זוכה; מסמך הזיכוי ממתין להפקה בקופה"
        else:
            status, gap = MISSING, "card_refund_document_missing"
            why = "הכרטיס זוכה ב-Z-Credit אבל מסמך זיכוי לא הופק" + (
                f" ({req.error_message or req.error_code})" if req is not None and (req.error_message or req.error_code) else ""
            )
            action = _action("שלחו את מסמך הזיכוי לקופה", href)
        rows.append(ctx.row(
            "cloud_card_refunds", status, machine_id=r.original_machine_id, day=ctx.day(r.created_at),
            subject=subject, count=1, expected=_f(amount),
            actual=_f(abs(_d(credit.total_amount))) if credit is not None else None,
            reason=why, gapType=gap, action=action,
            transactionId=str(r.original_transaction_id), cardRefundId=str(r.id),
            **({"creditTransactionId": str(credit.id)} if credit is not None else {}),
        ))
    return rows


# ── The report ───────────────────────────────────────────────────────────────


def build_reconciliation(
    db: Session,
    user,
    tenant_id,
    window: ReportWindow,
    *,
    shop_ids: Sequence[uuid.UUID] = (),
    machine_ids: Sequence[uuid.UUID] = (),
    checks: Sequence[str] = CHECKS,
    now: Optional[datetime] = None,
) -> Dict[str, Any]:
    from app.services import z_table
    from app.services.all_in_one import machines_in_scope

    now = now or datetime.now(timezone.utc)
    machines = machines_in_scope(db, user, tenant_id, shop_ids, machine_ids)
    ctx = _Ctx(db, window, machines, now)
    head = {
        "window": window.to_schema().model_dump(by_alias=True, mode="json"),
        "generatedAt": now.isoformat(),
        "checks": [{"key": c, "label": CHECK_LABELS[c]} for c in CHECKS if c in checks],
        "statuses": [{"key": s, "label": STATUS_LABELS[s]} for s in STATUSES],
    }
    ids = list(ctx.machines)
    rows: List[Dict[str, Any]] = []
    if ids:
        docs = _documents(ctx, ids)
        zq = z_table.filtered_z_query(
            db, user, tenant_id, from_date=window.from_date, to_date=window.to_date,
            shop_ids=shop_ids, machine_ids=machine_ids,
        )
        zs = zq.order_by(ZReport.business_date.asc(), ZReport.closed_at.asc()).all() if zq is not None else []
        kiosks = z_table.kiosk_machine_ids(db, {z.machine_id for z in zs if z.machine_id})
        z_types = {z.id: z_table.z_type_of(z, kiosks) for z in zs}
        if "documents_z" in checks:
            rows += check_documents_z(ctx, docs, set(superseded_machines(db, ids)))
        if "z_totals" in checks:
            rows += check_z_totals(ctx, zs, z_types)
        if "document_numbers" in checks:
            rows += check_document_numbers(ctx, docs)
        if "z_numbers" in checks:
            rows += check_z_numbers(ctx, zs)
        card_rows = check_card_legs(ctx, ids) if ("card_legs" in checks or "transmissions" in checks) else []
        if "card_legs" in checks:
            rows += card_rows
        if "transmissions" in checks:
            rows += check_transmissions(ctx, ids, card_rows)
        if "refused_documents" in checks:
            rows += check_refused_documents(ctx, ids)
        if "repaired_tills" in checks:
            rows += check_repaired_tills(ctx, ids)
        if "numbering_conflicts" in checks:
            rows += check_numbering_conflicts(ctx, docs)
        if "z_completeness" in checks:
            rows += check_z_completeness(ctx, ids)
        if "ingest_notes" in checks:
            rows += check_ingest_notes(ctx, docs)
        if "cloud_card_refunds" in checks:
            rows += check_cloud_card_refunds(ctx, ids)

    summary = {c: {s: 0 for s in STATUSES} for c in CHECKS if c in checks}
    for r in rows:
        summary[r["check"]][r["status"]] += 1
    totals = {s: sum(v[s] for v in summary.values()) for s in STATUSES}
    return {**head, "summary": summary, "totals": totals, "rows": rows}
