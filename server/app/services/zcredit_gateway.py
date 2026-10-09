"""
Z-Credit's gateway web service ("ZCreditWS") from the cloud — only the two calls a cloud
card refund needs (docs/SPEC_REMOTE_CREDIT.md §11, docs/SPEC_ZCREDIT.md):

* `RefundTransaction` — refund (after the deposit) or void (before it) a sale by its gateway
  reference: `TransactionIdToCancelOrRefund` = the sale's `ReferenceNumber`, and
  `TransactionSum` (shekels, `##.##`). The same body the till sends
  (pos-android `ZCreditRequests.refund`).
* `GetTransactionStatusByReferenceId` — what became of a sale (`ReferenceID`): its
  `StatusCode` 1 approved / 2 deposited / 3 voided / 4 refunded / 6 partially refunded, and
  its `TransactionSum`. Read before a refund (is it still refundable?) and after a lost
  reply (did the refund happen?).

Both are documented in Z-Credit's public reference (https://docs.zcredit.co.il/docs/webservice,
OpenAPI at /specs/webservice) as docs/SPEC_ZCREDIT.md records it; nothing here is guessed
beyond what that spec and the till's tested client use.

**The adapter is an interface** (`ZCreditGateway`): the refund service never talks HTTP itself,
so it is tested against a fake (tests/test_cloud_card_refunds.py) and never against the real
gateway. `HttpZCreditGateway` is the real one: HTTPS to the one documented host, JSON, no
retries (a re-sent refund could refund twice — RefundTransaction carries no id of ours that
the gateway would dedupe by), no redirects, and **no body is ever logged** (every body carries
the terminal password). It refuses to be built inside a pytest run.

A transport failure says whether the request may have reached the gateway (`maybe_sent`):
a refund whose request may have gone out is an *unknown outcome*, resolved by the status
query, never by sending it again.
"""
from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass, field
from decimal import ROUND_HALF_UP, Decimal
from typing import Any, Optional, Protocol

logger = logging.getLogger(__name__)

#: The gateway's one host, for test and production terminals alike (docs/SPEC_ZCREDIT.md).
BASE_URL = "https://pci.zcredit.co.il/ZCreditWS/api"
REFUND_TRANSACTION = "/Transaction/RefundTransaction"
STATUS_BY_REFERENCE = "/Transaction/GetTransactionStatusByReferenceId"

#: As the till: a refund 60 s, a query 10 s.
REFUND_TIMEOUT_S = 60.0
QUERY_TIMEOUT_S = 10.0
CONNECT_TIMEOUT_S = 10.0


class Codes:
    """The gateway's return codes the refund acts on (docs/SPEC_ZCREDIT.md "קודי שגיאה")."""

    OK = 0
    PARTIAL_APPROVAL = 10
    #: "Transaction was not found" — undocumented, seen from the gateway (2026-10-05).
    NOT_FOUND = -80
    #: "לא ניתן לזיכוי".
    NOT_REFUNDABLE = -844

    @staticmethod
    def is_credentials(code: Optional[int]) -> bool:
        """-1 … -20: the terminal number or the password."""
        return code is not None and -20 <= code <= -1


class TxStatus:
    """A status query's `StatusCode`."""

    APPROVED_NOT_DEPOSITED = 1
    APPROVED_DEPOSITED = 2
    VOIDED = 3
    REFUNDED = 4
    PARTIALLY_REFUNDED = 6

    #: Charged and nothing taken back yet.
    UNTOUCHED = (1, 2)
    #: Something was taken back: voided, refunded, partially refunded.
    TAKEN_BACK = (3, 4, 6)


@dataclass(frozen=True)
class Credentials:
    """A terminal's number and password. The password never shows in a repr or a log."""

    terminal_number: str
    password: str = field(repr=False)
    #: The settings layer the password came from (tenant … machine), for the audit trail.
    source: Optional[str] = None

    @property
    def masked_terminal(self) -> str:
        return mask_terminal(self.terminal_number)


def mask_terminal(number: Optional[str]) -> str:
    """`08******16`: the first two and last two digits, as the spec shows a terminal."""
    text = (number or "").strip()
    if len(text) <= 4:
        return "*" * len(text)
    return text[:2] + "*" * (len(text) - 4) + text[-2:]


@dataclass
class Reply:
    """A gateway reply, read tolerantly (numbers may come as text and text as numbers)."""

    has_error: bool
    return_code: Optional[int]
    return_message: Optional[str]
    reference_number: Optional[str] = None
    approval_number: Optional[str] = None
    voucher_number: Optional[str] = None
    card_last4: Optional[str] = None
    status_code: Optional[int] = None
    transaction_agorot: Optional[int] = None

    @property
    def ok(self) -> bool:
        return not self.has_error and (
            self.return_code is None or self.return_code in (Codes.OK, Codes.PARTIAL_APPROVAL)
        )

    @property
    def not_found(self) -> bool:
        return self.return_code == Codes.NOT_FOUND

    @property
    def credentials_refused(self) -> bool:
        return self.has_error and Codes.is_credentials(self.return_code)


class GatewayError(Exception):
    """
    No reply that can be read. `maybe_sent`: the request may have reached the gateway
    (a read timeout, a dropped connection, a 5xx, an unreadable body) — for a refund, an
    unknown outcome. False only when it surely never left (no connection was made).
    """

    def __init__(self, message: str, *, maybe_sent: bool):
        super().__init__(message)
        self.maybe_sent = maybe_sent


class ZCreditGateway(Protocol):
    def refund(self, credentials: Credentials, reference_number: str, amount_agorot: int) -> Reply:
        """`RefundTransaction`. Raises `GatewayError`."""

    def status_by_reference(self, credentials: Credentials, reference_number: str) -> Reply:
        """`GetTransactionStatusByReferenceId`. Raises `GatewayError`."""


# ── Bodies (pure; they carry the password, so they are never logged) ─────────


def shekels(agorot: int) -> Decimal:
    """1035 → 10.35."""
    return (Decimal(int(agorot)) / 100).quantize(Decimal("0.01"))


def refund_body(credentials: Credentials, reference_number: str, amount_agorot: int) -> dict:
    if not (reference_number or "").strip():
        raise ValueError("a refund needs the original reference")
    if int(amount_agorot) <= 0:
        raise ValueError("amount must be positive")
    return {
        "TerminalNumber": credentials.terminal_number,
        "Password": credentials.password,
        "TransactionIdToCancelOrRefund": reference_number.strip(),
        "TransactionSum": float(shekels(amount_agorot)),
    }


def status_body(credentials: Credentials, reference_number: str) -> dict:
    return {
        "TerminalNumber": credentials.terminal_number,
        "Password": credentials.password,
        "ReferenceID": reference_number.strip(),
    }


# ── Replies ──────────────────────────────────────────────────────────────────


def _text(value: Any) -> Optional[str]:
    if value is None or isinstance(value, (dict, list)):
        return None
    if isinstance(value, bool):
        return str(value).lower()
    if isinstance(value, (int, float)):
        d = Decimal(str(value))
        return str(int(d)) if d == d.to_integral_value() else str(d)
    text = str(value).strip()
    return text if text and text.lower() != "null" else None


def _int(value: Any) -> Optional[int]:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return int(value)
    if isinstance(value, str):
        try:
            return int(value.strip())
        except ValueError:
            return None
    return None


def _bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    return isinstance(value, str) and value.strip().lower() == "true"


def _agorot(value: Any) -> Optional[int]:
    try:
        d = Decimal(str(value).strip()) if isinstance(value, (int, float, str)) and not isinstance(value, bool) else None
    except Exception:  # noqa: BLE001 - a figure we cannot read is no figure
        return None
    if d is None:
        return None
    return int((d * 100).quantize(Decimal(1), rounding=ROUND_HALF_UP))


def _id_or_none(value: Optional[str]) -> Optional[str]:
    """The gateway's "none": blank, "0", all zeros."""
    return value if value and any(c != "0" for c in value) else None


def _last4(card4: Optional[str], card_number: Optional[str]) -> Optional[str]:
    """The last four digits of whatever the gateway sent as the card; never more."""
    digits = "".join(c for c in (card4 or "") if c.isdigit())
    if len(digits) == 4:
        return digits
    digits = "".join(c for c in (card_number or "") if c.isdigit())
    return digits[-4:] if len(digits) >= 4 else None


def parse_reply(raw: Any) -> Optional[Reply]:
    """A reply body (text or dict) as a `Reply`; None when it is not a JSON object."""
    if isinstance(raw, (str, bytes)):
        try:
            raw = json.loads(raw)
        except (ValueError, TypeError):
            return None
    if not isinstance(raw, dict):
        return None
    amount = _agorot(raw.get("TransactionSum"))
    status = _int(raw.get("StatusCode"))
    return Reply(
        has_error=_bool(raw.get("HasError")),
        return_code=_int(raw.get("ReturnCode")),
        return_message=_text(raw.get("ReturnMessage")),
        reference_number=_id_or_none(_text(raw.get("ReferenceNumber"))),
        approval_number=_text(raw.get("ApprovalNumber")),
        voucher_number=_text(raw.get("VoucherNumber")),
        card_last4=_last4(_text(raw.get("Card4Digits")), _text(raw.get("CardNumber"))),
        status_code=status if status is not None and status > 0 else None,
        transaction_agorot=amount if amount is not None and amount > 0 else None,
    )


# ── The real gateway ─────────────────────────────────────────────────────────


class HttpZCreditGateway:
    """
    POSTs to `BASE_URL`. Never retried, never redirected, never logged beyond the path and
    the outcome. Only built when `ZCREDIT_CLOUD_REFUNDS_ENABLED` is on, and never in a test.
    """

    def __init__(self, base_url: str = BASE_URL):
        if os.environ.get("PYTEST_CURRENT_TEST"):
            raise RuntimeError("the real Z-Credit gateway is never used in a test")
        if not base_url.startswith("https://"):
            raise ValueError("Z-Credit is HTTPS only")
        self.base_url = base_url.rstrip("/")

    def _post(self, path: str, body: dict, timeout_s: float) -> Reply:
        import httpx

        try:
            with httpx.Client(
                timeout=httpx.Timeout(timeout_s, connect=CONNECT_TIMEOUT_S),
                follow_redirects=False,
                transport=httpx.HTTPTransport(retries=0),
            ) as client:
                response = client.post(
                    self.base_url + path,
                    content=json.dumps(body),
                    headers={"Content-Type": "application/json", "Accept": "application/json"},
                )
        except (httpx.ConnectError, httpx.ConnectTimeout) as e:
            logger.warning("zcredit %s: no connection (%s)", path, type(e).__name__)
            raise GatewayError(f"אין חיבור לשרת Z-Credit ({type(e).__name__})", maybe_sent=False) from None
        except httpx.HTTPError as e:
            logger.warning("zcredit %s: no reply (%s)", path, type(e).__name__)
            raise GatewayError(f"לא התקבלה תשובה מ-Z-Credit ({type(e).__name__})", maybe_sent=True) from None
        if not 200 <= response.status_code < 300:
            logger.warning("zcredit %s: HTTP %s", path, response.status_code)
            raise GatewayError(f"Z-Credit HTTP {response.status_code}", maybe_sent=response.status_code >= 500)
        reply = parse_reply(response.text)
        if reply is None:
            logger.warning("zcredit %s: unreadable reply (%d chars)", path, len(response.text or ""))
            raise GatewayError("תשובה לא קריאה מ-Z-Credit", maybe_sent=True)
        logger.info("zcredit %s: HasError=%s ReturnCode=%s", path, reply.has_error, reply.return_code)
        return reply

    def refund(self, credentials: Credentials, reference_number: str, amount_agorot: int) -> Reply:
        return self._post(REFUND_TRANSACTION, refund_body(credentials, reference_number, amount_agorot), REFUND_TIMEOUT_S)

    def status_by_reference(self, credentials: Credentials, reference_number: str) -> Reply:
        return self._post(STATUS_BY_REFERENCE, status_body(credentials, reference_number), QUERY_TIMEOUT_S)
