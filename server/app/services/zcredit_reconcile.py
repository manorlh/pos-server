"""
"התאמת אשראי מול Z-Credit" (docs/SPEC_ZCREDIT.md "חלק ג׳") — per Z-Credit terminal and business
day, our Z-Credit card legs against the terminal's own transactions report, transaction by
transaction, and the day's deposits against our transmissions.

The owner (09.10.2026): "יש אפשרות ב-Z-Credit לעשות התאמה בין העסקאות אשראי שלנו מול מסוף
Z-Credit?" — yes: `GetTransactionsReport` and `GetDepositReport`, both read-only.

**Terminals.** Every active till whose card integration resolves to Z-Credit on its settings
layers, grouped by its terminal number; the credentials are resolved exactly as a cloud card
refund resolves them (`cloud_card_refunds.credentials_for`: the most specific layer wins). Tills
sharing a terminal are one run.

**One run** (`run_terminal`): Z-Credit's report for the day ±`MARGIN` (a sale at 23:59 may be
saved at 00:00), our legs for the same span, a status query for each leg of the day the report
did not list (by its reference, else by our `TransactionUniqueID`, at most `LOOKUP_MAX`), the
matching (app/services/zcredit_recon_match.py), the deposits, and the result stored — one row per
transaction, a "טופל" of an earlier run of the same terminal and day carried over. Every ❌ not
handled raises an exception (`zcredit_recon`) in the exceptions log, which the alerts read.

**When.** Nightly per terminal for the previous business day at `zcreditReconcileTime` (local,
default 06:00 — after the night's deposit), while `zcreditReconcileEnabled` (default on) is on for
any of its tills; up to `NIGHTLY_ATTEMPTS` tries a day when Z-Credit cannot be read. And on demand
("הרץ התאמה עכשיו").

**Read-only toward Z-Credit.** Only the calls of app/services/zcredit_reports.py: nothing here
refunds, voids, releases or deposits; "צור זיכוי" in the dashboard opens the existing remote
credit / cloud card refund flows, which ask the user themselves.
"""
from __future__ import annotations

import hashlib
import logging
import uuid
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta, timezone
from decimal import ROUND_HALF_UP, Decimal
from typing import Any, Callable, Dict, Iterable, List, Optional, Sequence, Tuple

from sqlalchemy import String, cast, or_
from sqlalchemy.orm import Session

from app.models.card_transmission import CardTransmission, TransmissionStatus
from app.models.pos_machine import POSMachine
from app.models.transaction import Transaction, TransactionStatus
from app.models.transaction_payment import TransactionPayment
from app.models.zcredit_reconciliation import (
    HARD_CATEGORIES,
    RECON_CATEGORIES,
    ZCreditReconCategory as C,
    ZCreditReconItem,
    ZCreditReconRun,
    ZCreditReconRunStatus as RS,
    ZCreditReconTrigger as TR,
)
from app.services import zcredit_gateway as zg
from app.services import zcredit_recon_match as M
from app.services import zcredit_reports as zr

logger = logging.getLogger(__name__)

# ── Parameters (dynamic till/shop parameters, app/services/till_parameters.py) ──

PARAM_ENABLED = "zcreditReconcileEnabled"
PARAM_TIME = "zcreditReconcileTime"
DEFAULT_TIME = "06:00"
PARAMETER_SPECS = (
    dict(
        key=PARAM_ENABLED,
        label="התאמת אשראי מול Z-Credit",
        value_type="boolean",
        default_value=True,
        description=(
            "כשמופעל (ברירת המחדל): בכל לילה, לכל מסוף Z-Credit שהקופות האלה סולקות בו, הענן משווה את "
            "עסקאות האשראי של יום העסקים הקודם מול דוח העסקאות ודוח ההפקדות של Z-Credit — עסקה מול עסקה "
            "— ומתריע על חיוב בלי מסמך ועל מסמך בלי חיוב. קריאה בלבד: לא מזכה, לא מבטל ולא מפקיד. "
            "חל רק במקום ש-Z-Credit מוגדר. נקבע לחברה, לסניף, לנקודת מכירה או לקופה."
        ),
    ),
    dict(
        key=PARAM_TIME,
        label="שעת התאמת אשראי מול Z-Credit",
        value_type="string",
        default_value=DEFAULT_TIME,
        description=(
            "השעה (HH:MM, שעון מקומי) שבה רצה בכל לילה התאמת האשראי מול Z-Credit ליום העסקים הקודם — "
            "אחרי שעת ההפקדה של המסוף. ברירת מחדל 06:00. כשכמה קופות על אותו מסוף — השעה המאוחרת מביניהן."
        ),
    ),
)

#: The exception every ❌ raises (app/services/exceptions.py RULES, the log's kind).
EXCEPTION_TYPE = "zcredit_recon"

#: Around the business day, both sides are read this much wider: pairing across midnight.
MARGIN = timedelta(minutes=30)
#: Status queries per run, for legs the report did not list.
LOOKUP_MAX = 40
#: Deposits are read from the day's start until this long after its end (the night's deposit).
DEPOSIT_AFTER = timedelta(hours=12)
#: A nightly run that could not read Z-Credit is tried again after this, up to this many times a day.
NIGHTLY_ATTEMPTS = 3
RETRY_AFTER = timedelta(minutes=30)
#: A run still `running` this long after it started died with its process.
STALE_RUNNING = timedelta(minutes=15)
#: "הרץ התאמה עכשיו": terminals per request.
MANUAL_TERMINALS_MAX = 10

CATEGORY_LABELS = {
    C.MATCHED: "תואם",
    C.AMOUNT_MISMATCH: "הפרש סכום",
    C.STATUS_MISMATCH: "הפרש סטטוס",
    C.ZCREDIT_ONLY: "חיוב ב-Z-Credit בלי מסמך שלנו",
    C.OURS_ONLY: "מסמך שלנו בלי עסקה ב-Z-Credit",
    C.DUPLICATE: "כפילות",
    C.DEPOSIT_MISMATCH: "הפקדה מול שידור",
}
#: ✅ ok · ⚠️ warning · ❌ error.
CATEGORY_SEVERITY = {
    C.MATCHED: "ok",
    C.AMOUNT_MISMATCH: "warning",
    C.STATUS_MISMATCH: "warning",
    C.ZCREDIT_ONLY: "error",
    C.OURS_ONLY: "error",
    C.DUPLICATE: "warning",
    C.DEPOSIT_MISMATCH: "warning",
}

ZERO = Decimal("0")
CENT = Decimal("0.01")


# ── The gateway (tests swap the factory; nothing else ever builds one) ────────


def _default_reports() -> zr.ZCreditReports:
    return zr.HttpZCreditReports()


reports_factory: Callable[[], zr.ZCreditReports] = _default_reports


# ── Small things ──────────────────────────────────────────────────────────────


def _utc(moment: Optional[datetime]) -> Optional[datetime]:
    if moment is None:
        return None
    return moment if moment.tzinfo is not None else moment.replace(tzinfo=timezone.utc)


def _agorot(value: Any) -> int:
    try:
        d = Decimal(str(value if value is not None else 0))
    except Exception:  # noqa: BLE001
        return 0
    return int((d * 100).quantize(Decimal(1), rounding=ROUND_HALF_UP))


def shekels(agorot: Optional[int]) -> Optional[float]:
    return None if agorot is None else float((Decimal(int(agorot)) / 100).quantize(CENT))


def terminal_key(tenant_id: Any, terminal_number: str) -> str:
    """An opaque, stable name for a terminal in the dashboard — never the number itself."""
    raw = f"{tenant_id}:{(terminal_number or '').strip()}".encode("utf-8")
    return hashlib.sha256(raw).hexdigest()[:16]


def last4(terminal_number: Optional[str]) -> Optional[str]:
    digits = "".join(c for c in (terminal_number or "") if c.isdigit())
    return digits[-4:] if digits else None


def masked(last_four: Optional[str]) -> str:
    return f"••••{last_four}" if last_four else "••••"


def _zone(db: Session, tenant_id) -> Tuple[str, Any]:
    from app.services.block_durations import zone_of
    from app.services.reports import resolve_report_timezone

    try:
        name = resolve_report_timezone(db, tenant_id, None)
    except Exception:  # noqa: BLE001
        name = "Asia/Jerusalem"
    return name, zone_of(name)


def day_bounds(day: date, zone) -> Tuple[datetime, datetime]:
    """The business day as local wall-clock times (naive): [00:00, next 00:00)."""
    start = datetime.combine(day, time(0, 0))
    return start, start + timedelta(days=1)


def _to_utc(local: datetime, zone) -> datetime:
    return local.replace(tzinfo=zone).astimezone(timezone.utc)


def _to_local(moment: Optional[datetime], zone) -> Optional[datetime]:
    m = _utc(moment)
    return m.astimezone(zone).replace(tzinfo=None) if m is not None else None


# ── Terminals ─────────────────────────────────────────────────────────────────


@dataclass
class Terminal:
    tenant_id: Any
    number: str
    credentials: zg.Credentials
    machines: List[POSMachine] = field(default_factory=list)

    @property
    def key(self) -> str:
        return terminal_key(self.tenant_id, self.number)

    @property
    def last4(self) -> Optional[str]:
        return last4(self.number)

    @property
    def machine_ids(self) -> List[Any]:
        return [m.id for m in self.machines]

    @property
    def shop_ids(self) -> List[Any]:
        return sorted({m.shop_id for m in self.machines if m.shop_id}, key=str)

    @property
    def active(self) -> bool:
        return any(getattr(m, "is_active", True) for m in self.machines)


@dataclass
class TerminalProblem:
    machine: POSMachine
    code: str
    message: str


def _tenants_with_zcredit(db: Session) -> List[Any]:
    """Tenants where some settings layer mentions Z-Credit — the nightly pass looks only there."""
    from app.models.company import Company
    from app.models.shop import Shop
    from app.models.shop_area import ShopArea
    from app.models.tenant import Tenant

    def like(col):
        return cast(col, String).like("%zcredit%")

    out = set()
    out |= {t for (t,) in db.query(Tenant.id).filter(like(Tenant.settings)).all()}
    out |= {t for (t,) in db.query(Company.tenant_id).filter(like(Company.settings)).all() if t}
    out |= {
        t for (t,) in db.query(Company.tenant_id).join(Shop, Shop.company_id == Company.id).filter(like(Shop.settings)).all() if t
    }
    out |= {
        t for (t,) in db.query(Company.tenant_id)
        .join(Shop, Shop.company_id == Company.id)
        .join(ShopArea, ShopArea.shop_id == Shop.id)
        .filter(like(ShopArea.settings)).all() if t
    }
    out |= {t for (t,) in db.query(POSMachine.tenant_id).filter(like(POSMachine.settings)).all() if t}
    return sorted(out, key=str)


def is_zcredit_till(db: Session, machine: POSMachine) -> bool:
    from app.models.pos_machine import device_has_builtin_terminal
    from app.routers.settings import _machine_parents
    from app.services import payment_integration as PI

    area, shop, company, tenant = _machine_parents(db, machine)
    res = PI.resolve(
        PI.settings_layers(tenant, company, shop, area, machine),
        device_has_builtin_terminal(getattr(machine, "device_model", None)),
        synqpay_device=PI.is_synqpay_device(machine),
    )
    return res.integration == PI.ZCREDIT


def terminals_of(
    db: Session, tenant_id: Any, machines: Optional[Sequence[POSMachine]] = None,
) -> Tuple[List[Terminal], List[TerminalProblem]]:
    """
    The tenant's Z-Credit terminals with every till charging on each — inactive ones too: a till
    switched off mid-day still has that day's sales — and the active Z-Credit tills whose terminal
    cannot be read (no terminal number / no password).
    """
    from app.services.cloud_card_refunds import credentials_for

    if machines is None:
        machines = db.query(POSMachine).filter(POSMachine.tenant_id == tenant_id).all()
    by_number: Dict[str, Terminal] = {}
    problems: List[TerminalProblem] = []
    for machine in sorted(machines, key=lambda m: (not getattr(m, "is_active", True), m.name or "", str(m.id))):
        try:
            if not is_zcredit_till(db, machine):
                continue
        except Exception:  # noqa: BLE001 - one till's broken settings never stop the rest
            logger.exception("zcredit recon: resolving %s", machine.id)
            continue
        creds, refusal = credentials_for(db, machine)
        if creds is None:
            if getattr(machine, "is_active", True):
                code, message = refusal or ("zcredit_credentials_missing", "חסרים פרטי מסוף Z-Credit")
                problems.append(TerminalProblem(machine, code, message))
            continue
        t = by_number.get(creds.terminal_number)
        if t is None:
            t = by_number[creds.terminal_number] = Terminal(tenant_id=tenant_id, number=creds.terminal_number, credentials=creds)
        t.machines.append(machine)
    return list(by_number.values()), problems


# ── Parameters ────────────────────────────────────────────────────────────────


def machine_schedule(db: Session, machine: POSMachine) -> Tuple[bool, str]:
    from app.services.block_durations import parse_hhmm
    from app.services.till_parameters import till_parameters_for_machine

    try:
        params = till_parameters_for_machine(db, machine).parameters
    except Exception:  # noqa: BLE001 - a parameter we cannot read is its default
        params = {}
    enabled = params.get(PARAM_ENABLED, True)
    enabled = enabled is not False and str(enabled).strip().lower() not in ("false", "0", "no", "off")
    at = params.get(PARAM_TIME)
    at = at.strip() if isinstance(at, str) and parse_hhmm(at) is not None else DEFAULT_TIME
    return enabled, at


def terminal_schedule(db: Session, terminal: Terminal) -> Tuple[bool, str]:
    """On when on for any of its tills; at the latest of their times (every deposit done)."""
    active = [m for m in terminal.machines if getattr(m, "is_active", True)]
    enabled_times = [t for on, t in (machine_schedule(db, m) for m in active) if on]
    if not enabled_times:
        return False, DEFAULT_TIME
    return True, max(enabled_times)


def validate_time(value: Any) -> Any:
    """`zcreditReconcileTime`: HH:MM (00:00–23:59)."""
    from app.services.block_durations import parse_hhmm

    if value is None:
        return value
    if not isinstance(value, str) or parse_hhmm(value) is None:
        raise ValueError("שעת ההתאמה בפורמט HH:MM (למשל 06:00)")
    t = parse_hhmm(value)
    return f"{t.hour:02d}:{t.minute:02d}"


# ── Our side ─────────────────────────────────────────────────────────────────


_STATUSES = (
    TransactionStatus.COMPLETED,
    TransactionStatus.REFUNDED,
    TransactionStatus.PARTIAL_REFUND,
    TransactionStatus.CANCELLED,
)


def _status_text(value: Any) -> str:
    return str(getattr(value, "value", value) or "")


def load_legs(db: Session, terminal: Terminal, start_utc: datetime, end_utc: datetime, zone) -> List[M.OurLeg]:
    """Our Z-Credit card legs of the terminal's tills created in [start, end)."""
    from app.services import cloud_card_refunds as ccr
    from app.services.document_prefix import document_number_of
    from app.services.tenders import is_refund_document
    from app.services.transmissions import _charged_expr, card_last4_of

    ids = terminal.machine_ids
    if not ids:
        return []
    rows = (
        db.query(TransactionPayment, Transaction, _charged_expr())
        .join(Transaction, Transaction.id == TransactionPayment.transaction_id)
        .filter(
            Transaction.machine_id.in_(ids),
            Transaction.created_at >= start_utc,
            Transaction.created_at < end_utc,
            TransactionPayment.method == "card",
            Transaction.status.in_(_STATUSES),
        )
        .all()
    )
    picked: List[Tuple[TransactionPayment, Transaction, Any]] = []
    for leg, tx, charged in rows:
        if bool(getattr(leg, "no_money_movement", False)):
            continue
        meta = leg.nayax_meta if isinstance(leg.nayax_meta, dict) else {}
        if ccr.leg_provider(meta) != ccr.PROVIDER:
            continue
        on = ccr.leg_terminal(meta)
        if on and on.strip() != terminal.number:
            continue
        picked.append((leg, tx, charged))

    batches = {}
    tids = {leg.transmission_id for leg, _, _ in picked if leg.transmission_id}
    if tids:
        batches = {
            tid: batch for tid, batch in db.query(CardTransmission.id, CardTransmission.batch_number)
            .filter(CardTransmission.id.in_(list(tids))).all()
        }
    taken = _taken_back(db, [tx for _, tx, _ in picked], ids)
    out: List[M.OurLeg] = []
    for leg, tx, charged in picked:
        meta = leg.nayax_meta if isinstance(leg.nayax_meta, dict) else {}
        refund = is_refund_document(document_type=tx.document_type, refund_of_transaction_id=tx.refund_of_transaction_id)
        try:
            number = document_number_of(tx)
        except Exception:  # noqa: BLE001
            number = tx.transaction_number
        out.append(M.OurLeg(
            payment_id=leg.id,
            transaction_id=tx.id,
            machine_id=tx.machine_id,
            shop_id=tx.shop_id,
            document_number=number,
            document_type=tx.document_type,
            is_refund=refund,
            status=_status_text(tx.status),
            local_time=_to_local(tx.created_at, zone),
            created_at=_utc(tx.created_at),
            amount_agorot=_agorot(charged),
            reference=ccr.leg_reference(meta),
            unique_id=zr.unique_id_for(tx.machine_id, meta.get("vuid")),
            card_last4=card_last4_of(meta),
            transmission_id=leg.transmission_id,
            batch=leg.transmitted_batch or batches.get(leg.transmission_id),
            taken_back_agorot=0 if refund else taken.get(tx.id, 0),
        ))
    return out


def _taken_back(db: Session, sales: Sequence[Transaction], machine_ids: Sequence[Any]) -> Dict[Any, int]:
    """Per sale: card money our side took back through Z-Credit (agorot)."""
    from app.models.cloud_card_refund import CloudCardRefund, CloudCardRefundStatus
    from app.services import cloud_card_refunds as ccr
    from app.services.transmissions import _charged_expr

    sale_ids = [tx.id for tx in sales]
    out: Dict[Any, int] = {}
    if not sale_ids:
        return out
    for start in range(0, len(sale_ids), 500):
        chunk = sale_ids[start:start + 500]
        for leg, tx, charged in (
            db.query(TransactionPayment, Transaction, _charged_expr())
            .join(Transaction, Transaction.id == TransactionPayment.transaction_id)
            .filter(
                Transaction.refund_of_transaction_id.in_(chunk),
                TransactionPayment.method == "card",
                Transaction.status.in_(_STATUSES[:3]),
            )
            .all()
        ):
            if bool(getattr(leg, "no_money_movement", False)):
                continue
            if ccr.leg_provider(leg.nayax_meta) != ccr.PROVIDER:
                continue
            out[tx.refund_of_transaction_id] = out.get(tx.refund_of_transaction_id, 0) + _agorot(charged)
        for row in (
            db.query(CloudCardRefund)
            .filter(
                CloudCardRefund.original_transaction_id.in_(chunk),
                CloudCardRefund.status == CloudCardRefundStatus.REFUNDED,
                CloudCardRefund.credit_transaction_id.is_(None),
            )
            .all()
        ):
            out[row.original_transaction_id] = out.get(row.original_transaction_id, 0) + _agorot(row.amount)
    return out


def cloud_refunds_by_reference(db: Session, terminal: Terminal) -> Dict[str, Dict[str, Any]]:
    """The cloud card refunds of these tills by their refund's reference at Z-Credit."""
    from app.models.cloud_card_refund import CloudCardRefund

    ids = terminal.machine_ids
    if not ids:
        return {}
    rows = (
        db.query(CloudCardRefund)
        .filter(
            CloudCardRefund.refund_reference.isnot(None),
            or_(CloudCardRefund.original_machine_id.in_(ids), CloudCardRefund.terminal_number == terminal.number),
        )
        .all()
    )
    return {
        r.refund_reference: {
            "id": str(r.id),
            "originalTransactionId": str(r.original_transaction_id),
            "originalPaymentId": str(r.original_payment_id),
            "originalDocumentNumber": r.original_document_number,
            "creditTransactionId": str(r.credit_transaction_id) if r.credit_transaction_id else None,
        }
        for r in rows
    }


# ── Deposits ─────────────────────────────────────────────────────────────────


def compare_deposits(
    db: Session,
    terminal: Terminal,
    deposits: Sequence[zr.Deposit],
    day_rows: Sequence[zr.ReportTransaction],
    window_utc: Tuple[datetime, datetime],
) -> List[Dict[str, Any]]:
    """
    Each deposit the day touches — named by the day's Z-Credit rows or by our transmissions of the
    day — Z-Credit's totals against our transmission reports of that batch and the legs our side
    marked into them (the till marks every pending leg at a Z-Credit deposit, so the legs are the
    real check).
    """
    from app.services.tenders import is_refund_document
    from app.services.transmissions import _charged_by_leg

    ids = terminal.machine_ids
    by_ref = {d.reference_number: d for d in deposits if d.reference_number}
    named_by_rows: Dict[str, List[zr.ReportTransaction]] = {}
    for r in day_rows:
        if r.deposit_id:
            named_by_rows.setdefault(r.deposit_id, []).append(r)
    transmissions = (
        db.query(CardTransmission)
        .filter(
            CardTransmission.machine_id.in_(ids),
            CardTransmission.started_at >= window_utc[0],
            CardTransmission.started_at < window_utc[1],
            CardTransmission.status == TransmissionStatus.SUCCESS,
        )
        .all()
        if ids else []
    )
    ours_by_batch: Dict[str, List[CardTransmission]] = {}
    for t in transmissions:
        if t.batch_number:
            ours_by_batch.setdefault(str(t.batch_number).strip(), []).append(t)
    refs = sorted(set(named_by_rows) | set(ours_by_batch), key=str)
    names = {m.id: m.name for m in terminal.machines}

    out: List[Dict[str, Any]] = []
    for ref in refs:
        dep = by_ref.get(ref)
        mine = ours_by_batch.get(ref, [])
        legs = (
            db.query(TransactionPayment.id, Transaction.document_type, Transaction.refund_of_transaction_id)
            .join(Transaction, Transaction.id == TransactionPayment.transaction_id)
            .filter(TransactionPayment.transmission_id.in_([t.id for t in mine]))
            .all()
            if mine else []
        )
        charged = _charged_by_leg(db, [l[0] for l in legs])
        legs_net = 0
        for leg_id, doc_type, refund_of in legs:
            a = _agorot(charged.get(leg_id, ZERO))
            legs_net += -a if is_refund_document(document_type=doc_type, refund_of_transaction_id=refund_of) else a
        rows = named_by_rows.get(ref, [])
        rows_net = sum((-(r.amount_agorot or 0) if r.is_refund else (r.amount_agorot or 0)) for r in rows)
        reported_amount = sum((_agorot(t.amount) for t in mine if t.amount is not None), 0) if mine else None
        reported_count = sum((t.transaction_count or 0) for t in mine) if mine else None

        reasons: List[str] = []
        status = "match"
        if dep is None:
            status = "missing"
            reasons.append(
                "ההפקדה לא הופיעה בדוח ההפקדות של Z-Credit לטווח" if mine or rows
                else "ההפקדה לא נמצאה"
            )
        if not mine:
            status = "missing"
            reasons.append("אין אצלנו שידור (Z) שרשם את ההפקדה הזו — רגלי האשראי שלה לא סומנו כמשודרות")
        if dep is not None and mine:
            if dep.net_agorot is not None and dep.net_agorot != legs_net:
                status = "difference"
                reasons.append(
                    f"נטו ההפקדה ב-Z-Credit {M.shekels(dep.net_agorot)}, הרגליים שסומנו אצלנו בשידור {M.shekels(legs_net)}"
                )
            if dep.count is not None and dep.count != len(legs):
                status = "difference"
                reasons.append(f"מספר עסקאות בהפקדה {dep.count}, אצלנו סומנו {len(legs)}")
            if reported_amount is not None and dep.net_agorot is not None and reported_amount not in (dep.net_agorot, dep.debit_agorot):
                reasons.append(f"השידור שנרשם בקופה דיווח {M.shekels(reported_amount)}")
        if status == "match":
            reasons.append("ההפקדה תואמת את השידור ואת הרגליים שסומנו בו")
        out.append({
            "depositId": ref,
            "status": status,
            "reason": "; ".join(reasons),
            "zcredit": None if dep is None else {
                "debit": shekels(dep.debit_agorot), "credit": shekels(dep.credit_agorot),
                "net": shekels(dep.net_agorot), "count": dep.count,
            },
            "dayRows": {"count": len(rows), "net": shekels(rows_net)},
            "ours": {
                "transmissions": [
                    {
                        "id": str(t.id), "machineId": str(t.machine_id), "machineName": names.get(t.machine_id),
                        "startedAt": _utc(t.started_at).isoformat() if t.started_at else None,
                        "amount": float(t.amount) if t.amount is not None else None,
                        "count": t.transaction_count,
                    }
                    for t in mine
                ],
                "reportedAmount": shekels(reported_amount),
                "reportedCount": reported_count,
                "legsCount": len(legs),
                "legsNet": shekels(legs_net),
            },
        })
    return out


# ── A run ────────────────────────────────────────────────────────────────────


class ReconError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def _lookups(
    reports: zr.ZCreditReports, terminal: Terminal, legs: Sequence[M.OurLeg], known: set, core: Tuple[datetime, datetime],
) -> Dict[Any, M.Lookup]:
    out: Dict[Any, M.Lookup] = {}
    budget = LOOKUP_MAX
    for leg in sorted(legs, key=lambda l: l.local_time or datetime.min):
        if leg.reference and leg.reference in known:
            continue
        if leg.cancelled or not (core[0] <= leg.local_time < core[1]):
            continue
        if not (leg.reference or leg.unique_id):
            continue
        if budget <= 0:
            out[leg.payment_id] = M.Lookup("skipped")
            continue
        budget -= 1
        by = "reference" if leg.reference else "unique_id"
        try:
            reply = (
                reports.status_by_reference(terminal.credentials, leg.reference) if leg.reference
                else reports.status_by_unique_id(terminal.credentials, leg.unique_id)
            )
        except zg.GatewayError as e:
            out[leg.payment_id] = M.Lookup("error", by=by, message=str(e))
            continue
        if reply.found:
            out[leg.payment_id] = M.Lookup("found", transaction=reply.transaction, by=by)
        elif reply.not_found:
            out[leg.payment_id] = M.Lookup("not_found", by=by)
        else:
            out[leg.payment_id] = M.Lookup("error", by=by, message=reply.return_message or f"קוד {reply.return_code}")
    return out


def _fingerprint(key: str, day: date, item: M.Item) -> str:
    zc_ref = item.zc.reference_number if item.zc is not None and item.zc.reference_number else "-"
    if item.zc is not None and not item.zc.reference_number:
        zc_ref = f"~{item.zc.amount_agorot}:{item.zc.save_date.isoformat() if item.zc.save_date else '-'}"
    leg = str(item.leg.payment_id) if item.leg is not None else "-"
    return f"{key}:{day.isoformat()}:{item.category}:{zc_ref}:{leg}"[:160]


def _previous_handled(db: Session, run: ZCreditReconRun) -> Dict[str, ZCreditReconItem]:
    prev = (
        db.query(ZCreditReconRun)
        .filter(
            ZCreditReconRun.tenant_id == run.tenant_id,
            ZCreditReconRun.terminal_key == run.terminal_key,
            ZCreditReconRun.business_date == run.business_date,
            ZCreditReconRun.status == RS.DONE,
            ZCreditReconRun.id != run.id,
        )
        .order_by(ZCreditReconRun.started_at.desc())
        .first()
    )
    if prev is None:
        return {}
    return {
        i.fingerprint: i
        for i in db.query(ZCreditReconItem).filter(ZCreditReconItem.run_id == prev.id, ZCreditReconItem.handled_at.isnot(None)).all()
    }


def _store_item(run: ZCreditReconRun, item: M.Item, fingerprint: str) -> ZCreditReconItem:
    zc, leg = item.zc, item.leg
    return ZCreditReconItem(
        id=uuid.uuid4(),
        run_id=run.id,
        tenant_id=run.tenant_id,
        category=item.category,
        fingerprint=fingerprint,
        reason=item.reason or None,
        zc_reference=zc.reference_number if zc else None,
        zc_amount_agorot=zc.amount_agorot if zc else None,
        zc_status_code=zc.status_code if zc else None,
        zc_deal_type=zc.deal_type if zc else None,
        zc_deposit_id=zc.deposit_id if zc else None,
        zc_card_last4=zc.card_last4 if zc else None,
        zc_card_name=(zc.card_name or "")[:64] or None if zc else None,
        zc_payments=zc.payments if zc else None,
        zc_approval=(zc.approval_number or "")[:32] or None if zc else None,
        zc_save_date=zc.save_date if zc else None,
        zc_source=item.zc_source if zc else None,
        transaction_id=leg.transaction_id if leg else None,
        payment_id=leg.payment_id if leg else None,
        machine_id=leg.machine_id if leg else None,
        shop_id=leg.shop_id if leg else None,
        document_number=leg.document_number if leg else None,
        document_type=leg.document_type if leg else None,
        our_amount_agorot=(-leg.amount_agorot if leg.is_refund else leg.amount_agorot) if leg else None,
        our_status=leg.status if leg else None,
        our_card_last4=leg.card_last4 if leg else None,
        our_created_at=leg.created_at if leg else None,
        our_transmitted=leg.transmitted if leg else None,
        our_batch=leg.batch if leg else None,
        related=list(item.related or []),
    )


def _raise_exception(db: Session, run: ZCreditReconRun, row: ZCreditReconItem, terminal: Terminal, now: datetime) -> Optional[uuid.UUID]:
    """A ❌ in the exceptions log (idempotent by the item's fingerprint; the tills' rules may switch it off)."""
    from app.models.audit_exception import AuditException
    from app.services import exceptions as EX

    if EXCEPTION_TYPE not in EX.RULES_BY_TYPE:
        return None
    machine = None
    if row.machine_id is not None:
        machine = next((m for m in terminal.machines if m.id == row.machine_id), None) or db.get(POSMachine, row.machine_id)
    if machine is None:
        candidate = next((r.get("machineId") for r in (row.related or []) if isinstance(r, dict) and r.get("machineId")), None)
        machine = next((m for m in terminal.machines if str(m.id) == str(candidate)), None) if candidate else None
    if machine is None and terminal.machines:
        machine = terminal.machines[0]
    if machine is None:
        return None
    key = f"{EXCEPTION_TYPE}:{hashlib.sha256(row.fingerprint.encode('utf-8')).hexdigest()[:40]}"
    amount = row.zc_amount_agorot if row.zc_amount_agorot is not None else row.our_amount_agorot
    detector = EX.Detector(db)
    rule = detector.rules(machine).get(EXCEPTION_TYPE)
    if rule is None or not rule.enabled:
        return None
    what = CATEGORY_LABELS.get(row.category, row.category)
    summary = (
        f"התאמת אשראי Z-Credit ({masked(run.terminal_last4)}, {run.business_date.strftime('%d.%m.%Y')}): {what}"
        + (f" — אסמכתא {row.zc_reference}" if row.zc_reference else "")
        + (f" — מסמך {row.document_number}" if row.document_number else "")
    )
    try:
        with db.begin_nested():
            detector._record(machine, EX.Found(
                type=EXCEPTION_TYPE,
                key=key[:200],
                amount=None if amount is None else (Decimal(abs(int(amount))) / 100).quantize(CENT),
                occurred_at=now,
                transaction_id=row.transaction_id,
                severity="high",
                details={
                    "summary": summary,
                    "category": row.category,
                    "categoryLabel": what,
                    "runId": str(run.id),
                    "itemId": str(row.id),
                    "businessDate": run.business_date.isoformat(),
                    "terminal": masked(run.terminal_last4),
                    "reference": row.zc_reference,
                    "documentNumber": row.document_number,
                    "cardLast4": row.zc_card_last4 or row.our_card_last4,
                    "reason": row.reason,
                },
            ))
    except Exception:  # noqa: BLE001 - an alert that cannot be written never fails the run
        logger.exception("zcredit recon: exception for %s", row.id)
        return None
    hit = db.query(AuditException.id).filter(AuditException.dedupe_key == key[:200]).first()
    return hit[0] if hit else None


def _close_stale(db: Session, tenant_id, key: str, day: date, now: datetime) -> Optional[ZCreditReconRun]:
    """A run of this terminal and day in progress (returned), or left by a crash (closed as failed)."""
    live = None
    for r in (
        db.query(ZCreditReconRun)
        .filter(
            ZCreditReconRun.tenant_id == tenant_id,
            ZCreditReconRun.terminal_key == key,
            ZCreditReconRun.business_date == day,
            ZCreditReconRun.status == RS.RUNNING,
        )
        .all()
    ):
        if now - _utc(r.started_at) > STALE_RUNNING:
            r.status = RS.FAILED
            r.error_code = "interrupted"
            r.error_message = "ההרצה נקטעה (השרת הופעל מחדש) — אפשר להריץ שוב"
            r.finished_at = now
        else:
            live = r
    return live


def run_terminal(
    db: Session,
    terminal: Terminal,
    day: date,
    *,
    trigger: str = TR.MANUAL,
    user: Any = None,
    reports: Optional[zr.ZCreditReports] = None,
    now: Optional[datetime] = None,
) -> ZCreditReconRun:
    """One terminal, one business day: read Z-Credit, compare, store. Commits."""
    now = now or datetime.now(timezone.utc)
    tz_name, zone = _zone(db, terminal.tenant_id)
    live = _close_stale(db, terminal.tenant_id, terminal.key, day, now)
    if live is not None:
        db.commit()
        return live
    run = ZCreditReconRun(
        id=uuid.uuid4(),
        tenant_id=terminal.tenant_id,
        terminal_number=terminal.number,
        terminal_key=terminal.key,
        terminal_last4=terminal.last4,
        credential_source=terminal.credentials.source,
        machine_ids=[str(i) for i in terminal.machine_ids],
        shop_ids=[str(i) for i in terminal.shop_ids],
        business_date=day,
        timezone=tz_name,
        trigger=trigger,
        status=RS.RUNNING,
        summary={},
        deposits=[],
        created_by_user_id=getattr(user, "id", None),
        started_at=now,
    )
    db.add(run)
    db.commit()

    try:
        _fill(db, run, terminal, day, zone, reports or reports_factory(), now)
        run.status = RS.DONE
    except ReconError as e:
        db.rollback()
        run = db.get(ZCreditReconRun, run.id)
        run.status, run.error_code, run.error_message = RS.FAILED, e.code, e.message
    except zg.GatewayError as e:
        db.rollback()
        run = db.get(ZCreditReconRun, run.id)
        run.status, run.error_code, run.error_message = RS.FAILED, "gateway_unreachable", str(e)
    except Exception as e:  # noqa: BLE001 - a run that breaks is recorded, never half-stored
        logger.exception("zcredit recon: run %s failed", run.id)
        db.rollback()
        run = db.get(ZCreditReconRun, run.id)
        run.status, run.error_code, run.error_message = RS.FAILED, "internal_error", type(e).__name__
    run.finished_at = now
    db.commit()
    return run


def _fill(db: Session, run: ZCreditReconRun, terminal: Terminal, day: date, zone, reports: zr.ZCreditReports, now: datetime) -> None:
    core = day_bounds(day, zone)
    wide = (core[0] - MARGIN, core[1] + MARGIN)
    reply = reports.transactions_report(terminal.credentials, wide[0], wide[1])
    if not reply.ok:
        if reply.has_error and zg.Codes.is_credentials(reply.return_code):
            raise ReconError("credentials_refused", f"Z-Credit דחה את פרטי המסוף (קוד {reply.return_code})")
        raise ReconError("report_error", f"Z-Credit החזיר שגיאה בדוח העסקאות: {reply.return_message or reply.return_code}")
    rows = reply.transactions
    deposits_reply = reports.deposit_report(terminal.credentials, core[0], core[1] + DEPOSIT_AFTER)
    deposits = deposits_reply.deposits if deposits_reply.ok else []

    legs = load_legs(db, terminal, _to_utc(wide[0], zone), _to_utc(wide[1], zone), zone)
    known = {r.reference_number for r in rows if r.reference_number}
    lookups = _lookups(reports, terminal, legs, known, core)
    items = M.match_day(
        rows, legs, lookups=lookups, cloud_refunds=cloud_refunds_by_reference(db, terminal), window=core,
    )
    day_rows = [r for r in rows if r.save_date is not None and core[0] <= r.save_date < core[1]]
    run.deposits = compare_deposits(
        db, terminal, deposits, day_rows, (_to_utc(core[0], zone), _to_utc(core[1] + DEPOSIT_AFTER, zone)),
    )
    if not deposits_reply.ok:
        run.deposits = [{"depositId": None, "status": "missing", "reason": f"דוח ההפקדות לא נקרא: {deposits_reply.return_message or deposits_reply.return_code}"}] + run.deposits

    handled = _previous_handled(db, run)
    stored: List[ZCreditReconItem] = []
    for item in items:
        fp = _fingerprint(run.terminal_key, day, item)
        row = _store_item(run, item, fp)
        before = handled.get(fp)
        if before is not None:
            row.handled_at, row.handled_by_user_id = before.handled_at, before.handled_by_user_id
            row.handled_by_name, row.handled_note = before.handled_by_name, before.handled_note
        db.add(row)
        stored.append(row)
    db.flush()
    for row in stored:
        if row.category in HARD_CATEGORIES and row.handled_at is None:
            row.exception_id = _raise_exception(db, run, row, terminal, now)

    run.summary = summary_of(items)
    run.zcredit_rows = len(day_rows)
    run.our_legs = sum(1 for l in legs if core[0] <= l.local_time < core[1])
    run.lookups = sum(1 for l in lookups.values() if l.outcome != "skipped")


def summary_of(items: Iterable[M.Item]) -> Dict[str, Any]:
    raw = M.summarize(items)
    return {
        c: {"count": raw[c]["count"], "zcredit": shekels(raw[c]["zcreditAgorot"]), "ours": shekels(raw[c]["oursAgorot"])}
        for c in RECON_CATEGORIES
    }


# ── On demand and nightly ────────────────────────────────────────────────────


def terminals_in_scope(
    db: Session, tenant_id: Any, scope_ids: Iterable[Any],
) -> Tuple[List[Terminal], List[TerminalProblem]]:
    """The terminals a till of the user's scope charges on — each with ALL its tills (a terminal is
    read whole: another till's charge on it is not "a charge without a document")."""
    ids = {str(i) for i in scope_ids}
    terminals, problems = terminals_of(db, tenant_id)
    return (
        [t for t in terminals if ids & {str(m.id) for m in t.machines}],
        [p for p in problems if str(p.machine.id) in ids],
    )


def run_now(
    db: Session,
    user: Any,
    tenant_id: Any,
    scope_ids: Iterable[Any],
    day: date,
    *,
    key: Optional[str] = None,
    reports: Optional[zr.ZCreditReports] = None,
    now: Optional[datetime] = None,
) -> Tuple[List[ZCreditReconRun], List[TerminalProblem]]:
    """"הרץ התאמה עכשיו": the terminals of the user's tills [scope_ids], or the one [key]."""
    terminals, problems = terminals_in_scope(db, tenant_id, scope_ids)
    if key:
        terminals = [t for t in terminals if t.key == key]
    terminals = terminals[:MANUAL_TERMINALS_MAX]
    runs = [run_terminal(db, t, day, trigger=TR.MANUAL, user=user, reports=reports, now=now) for t in terminals]
    return runs, problems


def due_day(now: datetime, zone, at: str) -> Optional[date]:
    """The business day due now (yesterday, once today's run time has passed), else None."""
    from app.services.block_durations import _local_at, parse_hhmm

    local_today = _utc(now).astimezone(zone).date()
    due = _local_at(local_today, parse_hhmm(at) or parse_hhmm(DEFAULT_TIME), zone)
    return local_today - timedelta(days=1) if _utc(now) >= due else None


def _nightly_wanted(db: Session, tenant_id, key: str, day: date, now: datetime) -> bool:
    runs = (
        db.query(ZCreditReconRun.status, ZCreditReconRun.started_at)
        .filter(
            ZCreditReconRun.tenant_id == tenant_id,
            ZCreditReconRun.terminal_key == key,
            ZCreditReconRun.business_date == day,
            ZCreditReconRun.trigger == TR.NIGHTLY,
        )
        .all()
    )
    if any(s in (RS.DONE, RS.RUNNING) for s, _ in runs):
        return False
    failed = [_utc(at) for s, at in runs if s == RS.FAILED]
    if len(failed) >= NIGHTLY_ATTEMPTS:
        return False
    return not failed or now - max(failed) >= RETRY_AFTER


def run_due(db: Session, *, now: Optional[datetime] = None, reports: Optional[zr.ZCreditReports] = None) -> int:
    """The nightly pass: every enabled Z-Credit terminal whose run time passed, once a day. Runs made."""
    now = now or datetime.now(timezone.utc)
    made = 0
    for tenant_id in _tenants_with_zcredit(db):
        try:
            terminals, _ = terminals_of(db, tenant_id)
            _, zone = _zone(db, tenant_id)
            for t in terminals:
                if not t.active:
                    continue
                enabled, at = terminal_schedule(db, t)
                if not enabled:
                    continue
                day = due_day(now, zone, at)
                if day is None or not _nightly_wanted(db, tenant_id, t.key, day, now):
                    continue
                run_terminal(db, t, day, trigger=TR.NIGHTLY, reports=reports, now=now)
                made += 1
        except Exception:  # noqa: BLE001 - one tenant never stops the others
            logger.exception("zcredit recon: nightly pass for tenant %s", tenant_id)
            db.rollback()
    return made


# ── Handling ─────────────────────────────────────────────────────────────────


NOTE_MAX = 500


def mark_handled(db: Session, item: ZCreditReconItem, user: Any, note: Optional[str], *, now: Optional[datetime] = None) -> ZCreditReconItem:
    """"טופל" with a note; the item's exception is marked reviewed with the same note. Commits."""
    from app.models.audit_exception import AuditException

    now = now or datetime.now(timezone.utc)
    text = (note or "").strip()[:NOTE_MAX] or None
    item.handled_at = now
    item.handled_by_user_id = getattr(user, "id", None)
    item.handled_by_name = (getattr(user, "username", None) or getattr(user, "email", None) or None)
    item.handled_note = text
    if item.exception_id is not None:
        ex = db.get(AuditException, item.exception_id)
        if ex is not None and ex.status == "new":
            ex.status = "reviewed"
            ex.reviewed_at = now
            ex.reviewed_by_user_id = getattr(user, "id", None)
            ex.review_note = text or "טופל בהתאמת אשראי מול Z-Credit"
    db.commit()
    return item


def reopen(db: Session, item: ZCreditReconItem) -> ZCreditReconItem:
    item.handled_at = None
    item.handled_by_user_id = None
    item.handled_by_name = None
    item.handled_note = None
    db.commit()
    return item
