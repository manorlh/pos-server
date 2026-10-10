"""
The 019 SMS adapter — implemented ONLY from 019's published documentation:

* https://docs.019sms.co.il/sms/                 — POST JSON/XML to https://019sms.co.il/api;
                                                   https://019sms.co.il/api/test "will look the
                                                   same as the real request but won't submit
                                                   the actions".
* https://docs.019sms.co.il/guide/               — the API token; headers
                                                   `Content-Type: application/json` and
                                                   `Authorization: Bearer <token>` (documented
                                                   there for the token call; TODO(019): confirm
                                                   on the test endpoint that `sms` / `dlr`
                                                   requests take the same header — open question).
* https://docs.019sms.co.il/sms/send-sms.html    — `{"sms": {"user": {"username"}, "source",
                                                   "destinations": {"phone": [{"$": {"id"}, "_"}]},
                                                   "message"}}` → `{"status", "message",
                                                   "shipment_id"}`; source ≤ 11 English letters /
                                                   digits; message ≤ 1005 chars; phone
                                                   `5xxxxxxxx` / `05xxxxxxxx`.
* https://docs.019sms.co.il/sms/reports.html     — `{"dlr": {"user": {"username"}, "transactions":
                                                   {"external_id": [...]}, "from", "to"}}` (dates
                                                   `dd/mm/yy hh:mm`, ≤ 1 week, ≤ 1000 ids).
* https://docs.019sms.co.il/sms/errors-and-status.html — request error codes and DLR statuses
                                                   (mapped below).
* https://docs.019sms.co.il/otp/sms-otp.html     — NOT used: its response returns the code to
                                                   the caller; we keep OTP local (club/otp.py).

Modes and the hard safety gates
-------------------------------
* `mock` — `MockTransport`: no network, ever. The default.
* `test` — 019's `/api/test` (sends nothing), and only with a configured token.
* `live` — `/api`, and only when the server-wide switch
  `NOTIFICATIONS_LIVE_SENDING_ENABLED` is on **and** the caller passes `live_allowed=True`
  (the worker adds the allow-listed test-number rule on top). `HttpTransport` itself refuses
  any URL but these two, and the live one without the flag.

The token is never logged, never put in an exception message and never returned.
"""
from __future__ import annotations

import itertools
import logging
import threading
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Deque, Dict, List, Optional, Protocol, Sequence

from app.models.notifications import (
    MODE_LIVE,
    MODE_MOCK,
    MODE_TEST,
    ST_DELIVERED,
    ST_FAILED_PERMANENT,
    ST_PROVIDER_ACCEPTED,
    ST_SUPPRESSED,
)
from app.services.notifications.phone import mask_phone, to_019_destination

logger = logging.getLogger(__name__)

PROD_URL = "https://019sms.co.il/api"
TEST_URL = "https://019sms.co.il/api/test"
ALLOWED_URLS = frozenset({PROD_URL, TEST_URL})

#: Israel time: 019's documented dates carry no zone (open question; see the spec).
PROVIDER_TZ = "Asia/Jerusalem"
DLR_MAX_IDS = 1000
DLR_MAX_RANGE = timedelta(days=7)

# ── Results ───────────────────────────────────────────────────────────────────

OUTCOME_ACCEPTED = "accepted"
OUTCOME_REJECTED = "rejected"
OUTCOME_RETRYABLE = "retryable"
OUTCOME_UNKNOWN = "unknown"


@dataclass
class SendResult:
    outcome: str
    provider_status: Optional[str] = None
    shipment_id: Optional[str] = None
    message: Optional[str] = None
    http_status: Optional[int] = None
    error_class: Optional[str] = None
    #: A provider-account problem the dashboard must show: token_rejected | no_credit |
    #: unverified_source | provider_blocked.
    alert: Optional[str] = None
    #: The number is blocked at the provider — the notification becomes Suppressed.
    suppressed: bool = False


@dataclass
class DlrRecord:
    external_id: str
    status: str
    shipment_id: Optional[str]
    event_at: Optional[datetime]
    payload: Dict[str, Any]


class TransportError(Exception):
    """[after_send]: the request may have reached the provider (timeout while reading)."""

    def __init__(self, kind: str, *, after_send: bool):
        super().__init__(kind)
        self.kind = kind
        self.after_send = after_send


class LiveSendingDisabled(Exception):
    pass


class Transport(Protocol):
    def post(self, url: str, body: Dict[str, Any], headers: Dict[str, str], *, live_allowed: bool) -> tuple:
        """`(http_status, parsed_json_or_None)`; raises TransportError."""


# ── Request error codes (errors-and-status.html → "Error codes") ──────────────

_TOKEN_CODES = {"3", "10", "11"}
_CREDIT_CODES = {"4", "12"}
_RETRYABLE_CODES = {"5", "6"}
_UNKNOWN_CODES = {"998", "999"}
_BLOCKED_ALL = {"8"}
_TEMP_BLOCKED = {"715"}
_UNVERIFIED_SOURCE = {"515"}


def classify_send_response(http_status: int, body: Any) -> SendResult:
    if http_status == 429:
        return SendResult(OUTCOME_RETRYABLE, http_status=http_status, error_class="http_429")
    if http_status in (401, 403):
        return SendResult(
            OUTCOME_REJECTED, http_status=http_status, error_class="http_auth", alert="token_rejected"
        )
    if http_status >= 500:
        # The request reached something that failed — whether 019 queued it is unknown.
        return SendResult(OUTCOME_UNKNOWN, http_status=http_status, error_class=f"http_{http_status}")
    if http_status >= 400:
        return SendResult(OUTCOME_REJECTED, http_status=http_status, error_class=f"http_{http_status}")
    if not isinstance(body, dict) or "status" not in body:
        return SendResult(OUTCOME_UNKNOWN, http_status=http_status, error_class="unparseable_response")
    code = str(body.get("status")).strip()
    message = sanitize_provider_message(body.get("message"))
    shipment = body.get("shipment_id")
    shipment = str(shipment)[:64] if shipment not in (None, "") else None
    base = dict(provider_status=code, message=message, http_status=http_status)
    if code == "0":
        return SendResult(OUTCOME_ACCEPTED, shipment_id=shipment, **base)
    if code in _TOKEN_CODES:
        return SendResult(OUTCOME_REJECTED, error_class="token_rejected", alert="token_rejected", **base)
    if code in _CREDIT_CODES:
        return SendResult(OUTCOME_RETRYABLE, error_class="no_credit", alert="no_credit", **base)
    if code in _RETRYABLE_CODES:
        return SendResult(OUTCOME_RETRYABLE, error_class="provider_busy", **base)
    if code in _UNKNOWN_CODES:
        return SendResult(OUTCOME_UNKNOWN, error_class="provider_unknown_error", **base)
    if code in _BLOCKED_ALL:
        return SendResult(OUTCOME_REJECTED, error_class="provider_blocked", suppressed=True, **base)
    if code in _TEMP_BLOCKED:
        return SendResult(OUTCOME_REJECTED, error_class="temporarily_blocked", suppressed=True, **base)
    if code in _UNVERIFIED_SOURCE:
        return SendResult(OUTCOME_REJECTED, error_class="unverified_source", alert="unverified_source", **base)
    return SendResult(OUTCOME_REJECTED, error_class="request_invalid", **base)


# ── DLR statuses (errors-and-status.html → "DLR statuses") ────────────────────

_DLR_DELIVERED = {"0", "102"}
_DLR_SUPPRESSED = {"17", "201"}
#: Informational: "-1" sent without delivery confirmation, "2" timeout — no change.
_DLR_NO_CHANGE = {"-1", "2"}
_DLR_FAILED = {
    "1", "3", "4", "5", "6", "7", "14", "15", "16", "18", "101", "103", "104", "105", "106",
    "107", "108", "747", "998", "999",
} | {str(n) for n in range(109, 133)}


def map_dlr_status(status: Any) -> Optional[str]:
    """The notification state a DLR status means; None = no change (or unknown status)."""
    code = str(status).strip()
    if code in _DLR_DELIVERED:
        return ST_DELIVERED
    if code in _DLR_SUPPRESSED:
        return ST_SUPPRESSED
    if code in _DLR_FAILED:
        return ST_FAILED_PERMANENT
    if code in _DLR_NO_CHANGE:
        return ST_PROVIDER_ACCEPTED
    return None


def sanitize_provider_message(message: Any) -> Optional[str]:
    """A provider message fit to store: digits runs (a number, a code) masked, capped."""
    if message is None:
        return None
    import re

    text = re.sub(r"\d{4,}", lambda m: "•" * len(m.group(0)), str(message))
    return text[:200]


def format_019_date(when: datetime) -> str:
    from zoneinfo import ZoneInfo

    local = when.astimezone(ZoneInfo(PROVIDER_TZ)) if when.tzinfo else when
    return local.strftime("%d/%m/%y %H:%M")


def parse_019_date(text: Any) -> Optional[datetime]:
    from zoneinfo import ZoneInfo

    if not text:
        return None
    for fmt in ("%d/%m/%y %H:%M:%S", "%d/%m/%y %H:%M"):
        try:
            return datetime.strptime(str(text).strip(), fmt).replace(tzinfo=ZoneInfo(PROVIDER_TZ)).astimezone(
                timezone.utc
            )
        except ValueError:
            continue
    return None


# ── Transports ────────────────────────────────────────────────────────────────


class HttpTransport:
    """httpx POST to one of the two documented URLs; never anything else."""

    def __init__(self, connect_timeout: float = 5.0, read_timeout: float = 15.0):
        self.connect_timeout = connect_timeout
        self.read_timeout = read_timeout

    def post(self, url: str, body: Dict[str, Any], headers: Dict[str, str], *, live_allowed: bool) -> tuple:
        import httpx

        if url not in ALLOWED_URLS:
            raise TransportError("url_not_allowed", after_send=False)
        if url == PROD_URL and not live_allowed:
            raise LiveSendingDisabled("live_sending_disabled")
        timeout = httpx.Timeout(self.read_timeout, connect=self.connect_timeout)
        try:
            response = httpx.post(url, json=body, headers=headers, timeout=timeout)
        except (httpx.ConnectError, httpx.ConnectTimeout):
            raise TransportError("connect_failed", after_send=False) from None
        except (httpx.ReadTimeout, httpx.WriteTimeout, httpx.RemoteProtocolError, httpx.ReadError):
            raise TransportError("timeout_after_send", after_send=True) from None
        except httpx.HTTPError:
            raise TransportError("http_error", after_send=True) from None
        try:
            parsed = response.json()
        except ValueError:
            parsed = None
        return response.status_code, parsed


class MockTransport:
    """
    019 in-process: answers like the documented API, sends nothing, touches no network.

    Tests script it: `script_send(...)` queues the next send answers (a dict body, an
    `(http_status, body)` pair, or a `TransportError` to raise); `set_dlr(external_id,
    status)` sets what a DLR poll returns. Unscripted sends are accepted; an accepted
    message's DLR is "102" (delivered) unless set otherwise.

    The dev inbox (`inbox()`) keeps the last 50 messages *in this process only* so a
    developer can complete the sign-up flow locally; it is exposed only to a super admin
    and only when `NOTIFICATIONS_MOCK_INBOX` is on. Nothing here is logged.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._send_script: Deque[Any] = deque()
        self._dlr: Dict[str, str] = {}
        self._inbox: Deque[Dict[str, Any]] = deque(maxlen=50)
        self._ids = itertools.count(1)
        self.sent: List[Dict[str, Any]] = []
        self.dlr_requests: List[Dict[str, Any]] = []

    def reset(self) -> None:
        with self._lock:
            self._send_script.clear()
            self._dlr.clear()
            self._inbox.clear()
            self.sent.clear()
            self.dlr_requests.clear()

    def script_send(self, *answers: Any) -> None:
        with self._lock:
            self._send_script.extend(answers)

    def set_dlr(self, external_id: str, status: Optional[str]) -> None:
        with self._lock:
            if status is None:
                self._dlr.pop(external_id, None)
            else:
                self._dlr[external_id] = status

    def inbox(self) -> List[Dict[str, Any]]:
        with self._lock:
            return list(self._inbox)

    def post(self, url: str, body: Dict[str, Any], headers: Dict[str, str], *, live_allowed: bool) -> tuple:
        with self._lock:
            if "sms" in body:
                return self._send(body["sms"])
            if "dlr" in body:
                return self._dlr_answer(body["dlr"])
            return 200, {"status": 997, "message": "Not a valid command sent"}

    def _send(self, sms: Dict[str, Any]) -> tuple:
        answer: Any = self._send_script.popleft() if self._send_script else None
        phones = sms.get("destinations", {}).get("phone", [])
        record = {"source": sms.get("source"), "phones": phones, "message": sms.get("message")}
        if isinstance(answer, TransportError):
            if answer.after_send:
                self._accept(record, delivered=False)
            raise answer
        if isinstance(answer, tuple):
            status, payload = answer
        elif isinstance(answer, dict):
            status, payload = 200, answer
        else:
            status, payload = 200, None
        if payload is None:
            shipment = self._accept(record)
            payload = {"status": 0, "message": "SMS will be sent", "shipment_id": shipment}
        elif str(payload.get("status")) == "0":
            self._accept(record, shipment=payload.get("shipment_id"))
        return status, payload

    def _accept(self, record: Dict[str, Any], *, shipment: Optional[str] = None, delivered: bool = True) -> str:
        shipment = shipment or f"MOCK{next(self._ids):06d}"
        self.sent.append(record)
        for phone in record["phones"]:
            ext = (phone.get("$") or {}).get("id")
            if ext:
                # Delivered by default — also when the caller timed out after the request
                # reached the provider (`delivered=False`): 019 still sends it.
                self._dlr.setdefault(ext, "102")
            self._inbox.appendleft(
                {
                    "at": datetime.now(timezone.utc).isoformat(),
                    "to": mask_phone("+972" + str(phone.get("_", ""))[1:]) if str(phone.get("_", "")).startswith("0") else "",
                    "externalId": ext,
                    "text": record["message"],
                }
            )
        return shipment

    def _dlr_answer(self, dlr: Dict[str, Any]) -> tuple:
        self.dlr_requests.append(dlr)
        ids = dlr.get("transactions", {}).get("external_id", [])
        if isinstance(ids, str):
            ids = [ids]
        rows = []
        for ext in ids:
            status = self._dlr.get(ext)
            if status is None:
                continue
            rows.append(
                {
                    "external_id": ext,
                    "source": "Mock",
                    "phone": "5XXXXXXXX",
                    "status": status,
                    "en_message": "Delivered" if status == "102" else "Failed",
                    "shipment_id": "MOCK",
                    "date": format_019_date(datetime.now(timezone.utc)),
                }
            )
        return 200, {"status": 0, "message": "all is well!", "transactions": rows}


#: The one mock 019 of this process (shared by the worker, the tests and the dev inbox).
MOCK_019 = MockTransport()


# ── The adapter ───────────────────────────────────────────────────────────────


@dataclass
class Adapter019:
    mode: str
    username: Optional[str]
    token: Optional[str]
    sender: Optional[str]
    transport: Any = None
    live_allowed: bool = False
    _http: Any = field(default=None, repr=False)

    def __post_init__(self) -> None:
        if self.mode not in (MODE_MOCK, MODE_TEST, MODE_LIVE):
            raise ValueError("mode_invalid")
        if self.transport is None:
            self.transport = MOCK_019 if self.mode == MODE_MOCK else HttpTransport()

    # The token never appears in repr / str.
    def __repr__(self) -> str:  # pragma: no cover - trivial
        return f"Adapter019(mode={self.mode!r}, sender={self.sender!r})"

    @property
    def url(self) -> str:
        return PROD_URL if self.mode == MODE_LIVE else TEST_URL

    def config_problem(self) -> Optional[str]:
        """Why this adapter cannot send at all, or None."""
        if not self.sender or not is_valid_sender(self.sender):
            return "sender_invalid"
        if self.mode == MODE_MOCK:
            return None
        if not self.username:
            return "username_missing"
        if not self.token:
            return "token_missing"
        if self.mode == MODE_LIVE and not self.live_allowed:
            return "live_sending_disabled"
        return None

    def _headers(self) -> Dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        return headers

    def build_send_body(self, destination_e164: str, text: str, external_id: str) -> Dict[str, Any]:
        return {
            "sms": {
                "user": {"username": self.username or "mock"},
                "source": self.sender,
                "destinations": {"phone": [{"$": {"id": external_id}, "_": to_019_destination(destination_e164)}]},
                "message": text,
            }
        }

    def send(self, destination_e164: str, text: str, external_id: str) -> SendResult:
        problem = self.config_problem()
        if problem:
            return SendResult(OUTCOME_REJECTED, error_class=problem)
        body = self.build_send_body(destination_e164, text, external_id)
        try:
            status, parsed = self.transport.post(self.url, body, self._headers(), live_allowed=self.live_allowed)
        except LiveSendingDisabled:
            return SendResult(OUTCOME_REJECTED, error_class="live_sending_disabled")
        except TransportError as exc:
            if exc.after_send:
                return SendResult(OUTCOME_UNKNOWN, error_class=exc.kind)
            return SendResult(OUTCOME_RETRYABLE, error_class=exc.kind)
        return classify_send_response(status, parsed)

    def build_dlr_body(self, external_ids: Sequence[str], start: datetime, end: datetime) -> Dict[str, Any]:
        return {
            "dlr": {
                "user": {"username": self.username or "mock"},
                "transactions": {"external_id": list(external_ids)},
                "from": format_019_date(start),
                "to": format_019_date(end),
            }
        }

    def poll_dlr(self, external_ids: Sequence[str], start: datetime, end: datetime) -> List[DlrRecord]:
        """
        Delivery reports for these ids (≤ 1000, range ≤ 1 week, per reports.html).
        TODO(019): what `/api/test` answers to a `dlr` request is undocumented — in test
        mode the result is treated as informational only.
        """
        if self.config_problem():
            return []
        ids = [i for i in external_ids if i][:DLR_MAX_IDS]
        if not ids:
            return []
        if end - start > DLR_MAX_RANGE:
            start = end - DLR_MAX_RANGE
        try:
            status, parsed = self.transport.post(
                self.url, self.build_dlr_body(ids, start, end), self._headers(), live_allowed=self.live_allowed
            )
        except (TransportError, LiveSendingDisabled):
            return []
        if status != 200 or not isinstance(parsed, dict) or str(parsed.get("status")) != "0":
            return []
        out: List[DlrRecord] = []
        for row in parsed.get("transactions") or []:
            if not isinstance(row, dict) or not row.get("external_id"):
                continue
            payload = {k: v for k, v in row.items() if k not in ("phone",)}
            out.append(
                DlrRecord(
                    external_id=str(row["external_id"])[:64],
                    status=str(row.get("status", "")).strip(),
                    shipment_id=str(row.get("shipment_id") or "")[:64] or None,
                    event_at=parse_019_date(row.get("date")),
                    payload=payload,
                )
            )
        return out


def is_valid_sender(sender: Optional[str]) -> bool:
    """019 `source`: up to 11 characters, English letters and digits only (no "+")."""
    import re

    return bool(sender) and bool(re.fullmatch(r"[A-Za-z0-9]{1,11}", sender or ""))
