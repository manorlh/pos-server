"""
Z-Credit's gateway web service ("ZCreditWS") — the READ-ONLY reports the card reconciliation
needs (docs/SPEC_ZCREDIT.md "חלק ג׳ — התאמת אשראי מול Z-Credit"):

* `GetTransactionsReport` (`POST /Reports/GetTransactionsReport`) — the terminal's transactions
  between two local times (`FromDate` / `ToDate`, `yyyy-MM-dd HH:mm:ss`). Each element has the
  shape of `GetTransactionStatusByReferenceId`: `ReferenceNumber`, `TransactionSum` (shekels),
  `StatusCode`, `DealTypeCode` ("01" sale / "51" refund), `J`, `CardNumber` (last 4 — never
  more is kept), `CardBrandCode`, `NumberOfPayments`, `DepositID`, `SaveDate`… No
  `TransactionUniqueID` comes back: matching by our id goes through
  `GetTransactionStatusByTransactionUniqueIdForQuery`.
* `GetDepositReport` (`POST /Terminal/GetDepositReport`) — the deposits (Shva transmissions)
  between two local times, or one by `DepositID` (-1 = by dates): `ReferenceNumber`,
  `TotalDebit` / `TotalCredit` (agorot), `TotalNumber`.
* `GetTransactionStatusByTransactionUniqueIdForQuery` / `GetTransactionStatusByReferenceId` —
  one transaction, for a leg of ours the report did not list.

**Read-only.** This module has no way to charge, refund, void, release or deposit: the
reconciliation reads Z-Credit and never acts on it (the owner's rule). A test pins that no
write path appears here.

**Reuses the gateway's helpers** (app/services/zcredit_gateway.py — the host, the credentials
type, the reply readers, `GatewayError`) without changing it. Like the gateway, the real client
is HTTPS to the one documented host, never retried, never redirected, **never logs a body**
(each carries the terminal password), and refuses to be built inside a pytest run: tests use
a fake (tests/test_zcredit_reconcile.py) built from the documented examples.
"""
from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, List, Optional, Protocol

from app.services import zcredit_gateway as zg

logger = logging.getLogger(__name__)

TRANSACTIONS_REPORT = "/Reports/GetTransactionsReport"
DEPOSIT_REPORT = "/Terminal/GetDepositReport"
STATUS_BY_UNIQUE_ID = "/Transaction/GetTransactionStatusByTransactionUniqueIdForQuery"

#: The only calls this module makes — every one of them reads.
READ_ONLY_PATHS = (TRANSACTIONS_REPORT, DEPOSIT_REPORT, STATUS_BY_UNIQUE_ID, zg.STATUS_BY_REFERENCE)

#: A day's report can be long; the documentation names no limit and no paging.
REPORT_TIMEOUT_S = 60.0
#: `FromDate` / `ToDate` as the documentation writes them (the terminal's local time).
DATE_FORMAT = "%Y-%m-%d %H:%M:%S"

#: `DealTypeCode`.
DEAL_SALE = "01"
DEAL_REFUND = "51"


@dataclass(frozen=True)
class ReportTransaction:
    """One row of `GetTransactionsReport`, as much as the reconciliation keeps — never the
    token, the holder id, the customer's details, the expiry or the slips."""

    reference_number: Optional[str]
    amount_agorot: Optional[int]
    status_code: Optional[int]
    deal_type: Optional[str]
    j: Optional[int] = None
    card_last4: Optional[str] = None
    card_brand_code: Optional[int] = None
    card_name: Optional[str] = None
    issuer_code: Optional[int] = None
    financer_code: Optional[int] = None
    payments: Optional[int] = None
    credit_type: Optional[int] = None
    currency: Optional[int] = None
    deposit_id: Optional[str] = None
    approval_number: Optional[str] = None
    voucher_number: Optional[str] = None
    #: `SaveDate`, the terminal's local wall clock (no zone in the reply).
    save_date: Optional[datetime] = None
    pan_entry_mode: Optional[str] = None
    payment_method: Optional[int] = None

    @property
    def is_refund(self) -> bool:
        return (self.deal_type or "").strip() == DEAL_REFUND

    @property
    def is_authorization_only(self) -> bool:
        """J2 (a card check) and J5 (a hold) charge nothing."""
        return self.j in (2, 5)


@dataclass(frozen=True)
class Deposit:
    """One element of `GetDepositReport.Data` (the `DepositTerminal` shape)."""

    reference_number: Optional[str]
    debit_agorot: Optional[int]
    credit_agorot: Optional[int]
    count: Optional[int]

    @property
    def net_agorot(self) -> Optional[int]:
        if self.debit_agorot is None and self.credit_agorot is None:
            return None
        return (self.debit_agorot or 0) - (self.credit_agorot or 0)


@dataclass
class TransactionsReply:
    has_error: bool
    return_code: Optional[int]
    return_message: Optional[str]
    transactions: List[ReportTransaction] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.has_error and self.return_code in (None, zg.Codes.OK)


@dataclass
class DepositsReply:
    has_error: bool
    return_code: Optional[int]
    return_message: Optional[str]
    deposits: List[Deposit] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.has_error and self.return_code in (None, zg.Codes.OK)


@dataclass
class LookupReply:
    """A one-transaction status query, read with the report's own row reader."""

    has_error: bool
    return_code: Optional[int]
    return_message: Optional[str]
    transaction: Optional[ReportTransaction] = None

    @property
    def found(self) -> bool:
        return (
            not self.has_error
            and self.return_code in (None, zg.Codes.OK)
            and self.transaction is not None
            and self.transaction.reference_number is not None
        )

    @property
    def not_found(self) -> bool:
        return self.return_code == zg.Codes.NOT_FOUND


class ZCreditReports(Protocol):
    def transactions_report(self, credentials: zg.Credentials, start: datetime, end: datetime) -> TransactionsReply:
        """`GetTransactionsReport` between two local times. Raises `zg.GatewayError`."""

    def deposit_report(self, credentials: zg.Credentials, start: datetime, end: datetime) -> DepositsReply:
        """`GetDepositReport` by dates. Raises `zg.GatewayError`."""

    def status_by_unique_id(self, credentials: zg.Credentials, unique_id: str) -> LookupReply:
        """`GetTransactionStatusByTransactionUniqueIdForQuery`. Raises `zg.GatewayError`."""

    def status_by_reference(self, credentials: zg.Credentials, reference_number: str) -> LookupReply:
        """`GetTransactionStatusByReferenceId`. Raises `zg.GatewayError`."""


# ── Our id at the gateway ────────────────────────────────────────────────────


def unique_id_for(machine_id: Any, vuid: Any) -> Optional[str]:
    """
    The `TransactionUniqueID` / `TransactionUniqueIdForQuery` a till sent with a sale:
    "R2M-<till>-<vuid>", the till part the first 12 letters/digits of its machine id
    (pos-android `zcreditUniqueId`, `tillTag = machineId`). None without a vuid.
    """
    v = zg._text(vuid)
    if not v:
        return None
    tag = "".join(c for c in str(machine_id or "") if c.isascii() and c.isalnum())[:12] or "till"
    return f"R2M-{tag}-{v}"


# ── Bodies (pure; they carry the password, so they are never logged) ─────────


def _local(moment: datetime) -> str:
    return moment.strftime(DATE_FORMAT)


def transactions_report_body(credentials: zg.Credentials, start: datetime, end: datetime) -> dict:
    """Successful transactions (`SearchType` 0), without J5 holds, between two local times."""
    if end <= start:
        raise ValueError("the report window is empty")
    return {
        "TerminalNumber": credentials.terminal_number,
        "Password": credentials.password,
        "FromDate": _local(start),
        "ToDate": _local(end),
        "IncludeJ5": False,
        "SearchType": 0,
    }


def deposit_report_body(credentials: zg.Credentials, start: datetime, end: datetime) -> dict:
    if end <= start:
        raise ValueError("the report window is empty")
    return {
        "TerminalNumber": credentials.terminal_number,
        "Password": credentials.password,
        "FromDate": _local(start),
        "ToDate": _local(end),
        "DepositID": -1,
    }


def status_by_unique_id_body(credentials: zg.Credentials, unique_id: str) -> dict:
    if not (unique_id or "").strip():
        raise ValueError("a query needs our unique id")
    return {
        "TerminalNumber": credentials.terminal_number,
        "Password": credentials.password,
        "UniqueQuery": unique_id.strip(),
    }


# ── Replies ──────────────────────────────────────────────────────────────────


def _load(raw: Any) -> Optional[dict]:
    if isinstance(raw, (str, bytes)):
        try:
            raw = json.loads(raw)
        except (ValueError, TypeError):
            return None
    return raw if isinstance(raw, dict) else None


def _save_date(value: Any) -> Optional[datetime]:
    text = zg._text(value)
    if not text:
        return None
    text = text.replace("T", " ").split(".")[0].strip()
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%d/%m/%Y %H:%M:%S", "%d/%m/%Y %H:%M"):
        try:
            return datetime.strptime(text, fmt)
        except ValueError:
            continue
    return None


def _deal(value: Any) -> Optional[str]:
    text = zg._text(value)
    if text is None:
        return None
    return text.zfill(2) if text.isdigit() else text


def parse_report_transaction(raw: Any) -> Optional[ReportTransaction]:
    """One report row; None when it is not an object. The card is cut to its last four."""
    if not isinstance(raw, dict):
        return None
    status = zg._int(raw.get("StatusCode"))
    return ReportTransaction(
        reference_number=zg._id_or_none(zg._text(raw.get("ReferenceNumber"))),
        amount_agorot=zg._agorot(raw.get("TransactionSum")),
        status_code=status if status is not None and status > 0 else None,
        deal_type=_deal(raw.get("DealTypeCode")),
        j=zg._int(raw.get("J")),
        card_last4=zg._last4(zg._text(raw.get("Card4Digits")), zg._text(raw.get("CardNumber"))),
        card_brand_code=zg._int(raw.get("CardBrandCode")),
        card_name=zg._text(raw.get("CardName")),
        issuer_code=zg._int(raw.get("CardIssuerCode")),
        financer_code=zg._int(raw.get("CardFinancerCode")),
        payments=zg._int(raw.get("NumberOfPayments")),
        credit_type=zg._int(raw.get("CreditTypeCode")),
        currency=zg._int(raw.get("CurrencyTypeCode")),
        # The documentation writes `DepositID`; a real reply came with `DepositId` (2026-10-05).
        deposit_id=zg._id_or_none(zg._text(raw.get("DepositID", raw.get("DepositId")))),
        approval_number=zg._text(raw.get("ApprovalNumber")),
        voucher_number=zg._text(raw.get("VoucherNumber")),
        save_date=_save_date(raw.get("SaveDate")),
        pan_entry_mode=zg._text(raw.get("PanEntryMode")),
        payment_method=zg._int(raw.get("PaymentMethod")),
    )


def parse_transactions_report(raw: Any) -> Optional[TransactionsReply]:
    """`GetTransactionsReport`'s body; None when it is not a JSON object."""
    body = _load(raw)
    if body is None:
        return None
    rows = body.get("Transactions")
    out = [t for t in (parse_report_transaction(r) for r in (rows if isinstance(rows, list) else [])) if t is not None]
    return TransactionsReply(
        has_error=zg._bool(body.get("HasError")),
        return_code=zg._int(body.get("ReturnCode")),
        return_message=zg._text(body.get("ReturnMessage")),
        transactions=out,
    )


def parse_lookup(raw: Any) -> Optional[LookupReply]:
    """A status query's body (the report row's shape at the top level)."""
    body = _load(raw)
    if body is None:
        return None
    has_error = zg._bool(body.get("HasError"))
    code = zg._int(body.get("ReturnCode"))
    row = parse_report_transaction(body) if not has_error and code in (None, zg.Codes.OK) else None
    return LookupReply(has_error=has_error, return_code=code, return_message=zg._text(body.get("ReturnMessage")), transaction=row)


def _whole(value: Any) -> Optional[int]:
    """`TotalDebit` / `TotalCredit` — agorot already (1035 = ₪10.35, as the example shows)."""
    if isinstance(value, bool) or value is None:
        return None
    try:
        return int(round(float(str(value).strip())))
    except (TypeError, ValueError):
        return None


def parse_deposit(raw: Any) -> Optional[Deposit]:
    if not isinstance(raw, dict):
        return None
    return Deposit(
        reference_number=zg._id_or_none(zg._text(raw.get("ReferenceNumber", raw.get("DepositID", raw.get("DepositId"))))),
        debit_agorot=_whole(raw.get("TotalDebit")),
        credit_agorot=_whole(raw.get("TotalCredit")),
        count=zg._int(raw.get("TotalNumber")),
    )


def parse_deposit_report(raw: Any) -> Optional[DepositsReply]:
    body = _load(raw)
    if body is None:
        return None
    rows = body.get("Data")
    out = [d for d in (parse_deposit(r) for r in (rows if isinstance(rows, list) else [])) if d is not None]
    return DepositsReply(
        has_error=zg._bool(body.get("HasError")),
        return_code=zg._int(body.get("ReturnCode")),
        return_message=zg._text(body.get("ReturnMessage")),
        deposits=out,
    )


# ── The real client ──────────────────────────────────────────────────────────


class HttpZCreditReports:
    """
    POSTs the read-only calls to `zg.BASE_URL`. Never retried, never redirected, never logged
    beyond the path and the outcome; never built inside a test.
    """

    def __init__(self, base_url: str = zg.BASE_URL):
        if os.environ.get("PYTEST_CURRENT_TEST"):
            raise RuntimeError("the real Z-Credit gateway is never used in a test")
        if not base_url.startswith("https://"):
            raise ValueError("Z-Credit is HTTPS only")
        self.base_url = base_url.rstrip("/")

    def _post(self, path: str, body: dict, timeout_s: float) -> str:
        import httpx

        if path not in READ_ONLY_PATHS:
            raise ValueError("the reconciliation only reads Z-Credit")
        try:
            with httpx.Client(
                timeout=httpx.Timeout(timeout_s, connect=zg.CONNECT_TIMEOUT_S),
                follow_redirects=False,
                transport=httpx.HTTPTransport(retries=0),
            ) as client:
                response = client.post(
                    self.base_url + path,
                    content=json.dumps(body),
                    headers={"Content-Type": "application/json; charset=utf-8", "Accept": "application/json"},
                )
        except (httpx.ConnectError, httpx.ConnectTimeout) as e:
            logger.warning("zcredit %s: no connection (%s)", path, type(e).__name__)
            raise zg.GatewayError(f"אין חיבור לשרת Z-Credit ({type(e).__name__})", maybe_sent=False) from None
        except httpx.HTTPError as e:
            logger.warning("zcredit %s: no reply (%s)", path, type(e).__name__)
            raise zg.GatewayError(f"לא התקבלה תשובה מ-Z-Credit ({type(e).__name__})", maybe_sent=True) from None
        if not 200 <= response.status_code < 300:
            logger.warning("zcredit %s: HTTP %s", path, response.status_code)
            raise zg.GatewayError(f"Z-Credit HTTP {response.status_code}", maybe_sent=True)
        return response.text or ""

    def transactions_report(self, credentials: zg.Credentials, start: datetime, end: datetime) -> TransactionsReply:
        text = self._post(TRANSACTIONS_REPORT, transactions_report_body(credentials, start, end), REPORT_TIMEOUT_S)
        reply = parse_transactions_report(text)
        if reply is None:
            logger.warning("zcredit %s: unreadable reply (%d chars)", TRANSACTIONS_REPORT, len(text))
            raise zg.GatewayError("תשובה לא קריאה מ-Z-Credit", maybe_sent=True)
        logger.info("zcredit %s: HasError=%s ReturnCode=%s rows=%d", TRANSACTIONS_REPORT,
                    reply.has_error, reply.return_code, len(reply.transactions))
        return reply

    def deposit_report(self, credentials: zg.Credentials, start: datetime, end: datetime) -> DepositsReply:
        text = self._post(DEPOSIT_REPORT, deposit_report_body(credentials, start, end), REPORT_TIMEOUT_S)
        reply = parse_deposit_report(text)
        if reply is None:
            logger.warning("zcredit %s: unreadable reply (%d chars)", DEPOSIT_REPORT, len(text))
            raise zg.GatewayError("תשובה לא קריאה מ-Z-Credit", maybe_sent=True)
        logger.info("zcredit %s: HasError=%s ReturnCode=%s deposits=%d", DEPOSIT_REPORT,
                    reply.has_error, reply.return_code, len(reply.deposits))
        return reply

    def _status(self, path: str, body: dict) -> LookupReply:
        text = self._post(path, body, zg.QUERY_TIMEOUT_S)
        reply = parse_lookup(text)
        if reply is None:
            logger.warning("zcredit %s: unreadable reply (%d chars)", path, len(text))
            raise zg.GatewayError("תשובה לא קריאה מ-Z-Credit", maybe_sent=True)
        logger.info("zcredit %s: HasError=%s ReturnCode=%s", path, reply.has_error, reply.return_code)
        return reply

    def status_by_unique_id(self, credentials: zg.Credentials, unique_id: str) -> LookupReply:
        return self._status(STATUS_BY_UNIQUE_ID, status_by_unique_id_body(credentials, unique_id))

    def status_by_reference(self, credentials: zg.Credentials, reference_number: str) -> LookupReply:
        return self._status(zg.STATUS_BY_REFERENCE, zg.status_body(credentials, reference_number))
