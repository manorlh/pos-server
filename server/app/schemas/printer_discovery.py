"""
Network printer discovery ("חיפוש מדפסות ברשת") and the per-zone printer redirect
("הפניית מדפסות לפי אזור שולחנות") — app/services/printer_discovery.py,
app/services/printer_zones.py.
"""
from __future__ import annotations

import ipaddress
from datetime import datetime
import uuid
from typing import Dict, List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.schemas.kitchen_printers import PRINTER_NAME_MAX

#: The most printers one scan report may carry (a /24 holds 254 hosts).
SCAN_RESULTS_MAX = 256
#: The most ports one result lists besides its own.
OTHER_PORTS_MAX = 8


def clean_ipv4(value) -> str:
    """A dotted IPv4 address, normalised ("192.168.001.050" is refused, as Android never sends it)."""
    if not isinstance(value, str):
        raise ValueError("host must be an IPv4 address")
    try:
        return str(ipaddress.IPv4Address(value.strip()))
    except ValueError as exc:
        raise ValueError("host must be an IPv4 address") from exc


def _short(value, limit: int) -> Optional[str]:
    if value is None:
        return None
    cleaned = " ".join(str(value).split())
    return cleaned[:limit] or None


class DiscoveredPrinterIn(BaseModel):
    """One printer a till found on its LAN."""

    model_config = ConfigDict(populate_by_name=True)

    host: str
    port: int = Field(..., ge=1, le=65535)
    #: The name it announces over mDNS (Bonjour), if any.
    name: Optional[str] = None
    #: Its make and model from the mDNS TXT record ("ty" / "product"), if any.
    model: Optional[str] = None
    #: escpos — answered the ESC/POS status query; other — a printer protocol the till does
    #: not print with (LPD 515 / IPP 631 only); unknown — a raw port that did not answer.
    kind: Literal["escpos", "other", "unknown"] = "unknown"
    response_ms: Optional[int] = Field(None, alias="responseMs", ge=0, le=60_000)
    #: From the ESC/POS paper sensor status, when it answered.
    paper: Optional[Literal["ok", "near_end", "out"]] = None
    offline: Optional[bool] = None
    other_ports: List[int] = Field(default_factory=list, alias="otherPorts", max_length=OTHER_PORTS_MAX)
    services: List[str] = Field(default_factory=list, max_length=8)

    @field_validator("host", mode="before")
    @classmethod
    def _host(cls, value):
        return clean_ipv4(value)

    @field_validator("name", "model", mode="before")
    @classmethod
    def _text(cls, value):
        return _short(value, PRINTER_NAME_MAX)

    @field_validator("other_ports", mode="before")
    @classmethod
    def _ports(cls, value):
        ports = []
        for raw in value or []:
            port = int(raw)
            if 1 <= port <= 65535 and port not in ports:
                ports.append(port)
        return sorted(ports)

    @field_validator("services", mode="before")
    @classmethod
    def _services(cls, value):
        return [s for s in (_short(v, 64) for v in value or []) if s]


class PrinterScanReportIn(BaseModel):
    """`POST /sync/{m}/printers/discovered`: what one scan found."""

    model_config = ConfigDict(populate_by_name=True)

    #: The dashboard's request this answers; absent for a scan run at the till.
    request_id: Optional[uuid.UUID] = Field(None, alias="requestId")
    status: Literal["done", "failed"] = "done"
    #: Why it failed: `not_on_lan`, `cancelled`, or the till's own words.
    error: Optional[str] = Field(None, max_length=500)
    subnet: Optional[str] = Field(None, max_length=64)
    lan_address: Optional[str] = Field(None, alias="lanAddress", max_length=64)
    duration_ms: Optional[int] = Field(None, alias="durationMs", ge=0, le=3_600_000)
    printers: List[DiscoveredPrinterIn] = Field(default_factory=list, max_length=SCAN_RESULTS_MAX)


class PrinterScanRequestIn(BaseModel):
    """`POST /shops/{id}/printer-scan`: optionally, the till to scan with."""

    model_config = ConfigDict(populate_by_name=True)

    machine_id: Optional[uuid.UUID] = Field(None, alias="machineId")


class TillNetworkPrinterIn(BaseModel):
    """
    `POST /sync/{m}/printers`: a printer found on the LAN, added from the till. Only what
    the person chose at the till; the rest are the shop's defaults (see
    `printer_discovery.add_from_till`).
    """

    model_config = ConfigDict(populate_by_name=True)

    name: str
    host: str
    port: int = Field(9100, ge=1, le=65535)
    purpose: Literal["kitchen", "receipt"] = "kitchen"

    @field_validator("host", mode="before")
    @classmethod
    def _host(cls, value):
        return clean_ipv4(value)

    @field_validator("name", mode="before")
    @classmethod
    def _name(cls, value):
        if not isinstance(value, str) or not value.strip():
            raise ValueError("name is required")
        cleaned = " ".join(value.split())
        if len(cleaned) > PRINTER_NAME_MAX:
            raise ValueError(f"name must be at most {PRINTER_NAME_MAX} characters")
        return cleaned


class ZoneRedirectsIn(BaseModel):
    """
    One table zone's redirect, whole: `{fromPrinterId: toPrinterId}`. An empty map clears
    it. Both printers must be kitchen printers of the zone's shop, and differ.
    """

    model_config = ConfigDict(populate_by_name=True)

    redirects: Dict[uuid.UUID, uuid.UUID] = Field(default_factory=dict)


class PrintRedirectIn(BaseModel):
    """
    `POST /sync/{m}/print-redirects`: the employee sent a ticket (or a receipt) to another
    printer because its own was not available ("מדפסת חלופית"). Idempotent by `id`.
    """

    model_config = ConfigDict(populate_by_name=True)

    id: uuid.UUID
    kind: Literal["kitchen", "receipt"] = "kitchen"
    #: The shop's printer ids; null for the till's own printer (or a receipt printer of
    #: the till's own parameters).
    from_printer_id: Optional[uuid.UUID] = Field(None, alias="fromPrinterId")
    from_name: Optional[str] = Field(None, alias="fromName")
    to_printer_id: Optional[uuid.UUID] = Field(None, alias="toPrinterId")
    to_name: Optional[str] = Field(None, alias="toName")
    ticket: Optional[str] = None
    error: Optional[str] = None
    #: "the next ones too" — until then.
    temporary_until: Optional[datetime] = Field(None, alias="temporaryUntil")
    pos_user_id: Optional[uuid.UUID] = Field(None, alias="posUserId")
    pos_user_name: Optional[str] = Field(None, alias="posUserName")
    occurred_at: Optional[datetime] = Field(None, alias="occurredAt")

    @field_validator("from_name", "to_name", "pos_user_name", mode="before")
    @classmethod
    def _names(cls, value):
        return _short(value, 100)

    @field_validator("ticket", mode="before")
    @classmethod
    def _ticket(cls, value):
        return _short(value, 200)

    @field_validator("error", mode="before")
    @classmethod
    def _error(cls, value):
        return _short(value, 500)
