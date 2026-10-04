"""
The till's card terminal (Agamento) beside the number it must be on.

The till reports what its Agamento says in the heartbeat's `terminal` block; the cloud
holds `expectedTerminalNumber` (and `forceTerminalNumber`) in the settings layers. This
module stores the one, resolves the other per till, and says whether they agree — the
same comparison the till makes before it lets anyone sell.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any, Dict, Iterable, List, Optional

from sqlalchemy.orm import Session

from app.models.company import Company
from app.models.shop import Shop
from app.models.shop_area import ShopArea
from app.models.tenant import Tenant
from app.services.settings_merge import merge_all_settings_layers, settings_sources

if TYPE_CHECKING:
    from app.models.pos_machine import POSMachine
    from app.schemas.terminal import HeartbeatTerminal

MATCH = "match"
MISMATCH = "mismatch"
UNKNOWN = "unknown"
NOT_REQUIRED = "not_required"


def apply_terminal_block(
    machine: "POSMachine", block: Optional["HeartbeatTerminal"], *, now: Optional[datetime] = None
) -> None:
    """
    The heartbeat's `terminal` block: a snapshot of what Agamento reports. No block, no
    change — an older till sends none, and that must not wipe the last reading. The last
    write is kept until the till reports a newer one: a till that restarted and has no
    write to tell of has not undone the one it made.
    """
    if block is None:
        return
    machine.terminal_number = block.terminal_number
    machine.terminal_clearing_server = block.clearing_server
    machine.terminal_offline_mode = block.offline_mode
    machine.terminal_reported_at = now or datetime.now(timezone.utc)
    if block.last_write is not None:
        machine.terminal_last_write = block.last_write.as_json()
    # Kept once seen, like the last write: the terminal names them only in some replies.
    if block.merchant_name is not None:
        machine.terminal_merchant_name = block.merchant_name
    if block.supplier_number is not None:
        machine.terminal_supplier_number = block.supplier_number


def normalize_terminal_number(value: Any) -> Optional[str]:
    """
    The terminal number as the till compares it: trimmed, leading zeros dropped
    ("01807770" is "1807770"). None for blank; all zeros is "0".
    """
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    return text.lstrip("0") or "0"


def terminal_status(reported: Any, reported_at: Optional[datetime], expected: Any) -> str:
    """
    "not_required" when no level sets an expected number (or sets ""), "unknown" when the
    till never reported one, else "match" / "mismatch" ignoring leading zeros.
    """
    want = normalize_terminal_number(expected)
    if want is None:
        return NOT_REQUIRED
    have = normalize_terminal_number(reported) if reported_at is not None else None
    if have is None:
        return UNKNOWN
    return MATCH if have == want else MISMATCH


@dataclass
class TerminalSettings:
    """What the till's settings layers say about its terminal."""

    expected: Optional[str] = None
    force: bool = False
    #: The level `forceTerminalNumber` comes from; None = no level sets it (off).
    force_source: Optional[str] = None


def _by_id(db: Session, model, ids: Iterable[Any]) -> Dict[Any, Any]:
    wanted = {i for i in ids if i is not None}
    if not wanted:
        return {}
    return {row.id: row for row in db.query(model).filter(model.id.in_(list(wanted))).all()}


def terminal_settings_for(db: Session, machines: List["POSMachine"]) -> Dict[Any, TerminalSettings]:
    """
    Per till, its effective terminal settings. The parents are loaded once for the whole
    list (four queries however many tills), then each till is merged in memory.
    """
    if not machines:
        return {}
    shops = _by_id(db, Shop, (m.shop_id for m in machines))
    companies = _by_id(db, Company, (s.company_id for s in shops.values()))
    tenants = _by_id(db, Tenant, (c.tenant_id for c in companies.values()))
    areas = _by_id(db, ShopArea, (getattr(m, "area_id", None) for m in machines))
    out: Dict[Any, TerminalSettings] = {}
    for m in machines:
        shop = shops.get(m.shop_id)
        company = companies.get(shop.company_id) if shop is not None else None
        if company is None:
            # No shop, no company: no layer above the till's own. Its own may still say.
            layers = [("machine", m.settings)]
            merged = dict(m.settings or {}) if isinstance(m.settings, dict) else {}
        else:
            tenant = tenants.get(company.tenant_id)
            area = areas.get(getattr(m, "area_id", None))
            merged = merge_all_settings_layers(company, shop, tenant, m, area)
            layers = [
                ("tenant", tenant.settings if tenant is not None else None),
                ("company", company.settings),
                ("shop", shop.settings),
                ("area", area.settings if area is not None else None),
                ("machine", m.settings),
            ]
        sources = settings_sources(layers)
        expected = merged.get("expectedTerminalNumber")
        out[m.id] = TerminalSettings(
            expected=expected if isinstance(expected, str) and expected.strip() else None,
            force=merged.get("forceTerminalNumber") is True,
            force_source=sources.get("forceTerminalNumber"),
        )
    return out


def machine_terminal_fields(machine: "POSMachine", settings: TerminalSettings) -> Dict[str, Any]:
    """The terminal fields of a machine's list/detail response."""
    return {
        "terminalNumber": machine.terminal_number,
        "terminalClearingServer": machine.terminal_clearing_server,
        "terminalOfflineMode": machine.terminal_offline_mode,
        "terminalReportedAt": machine.terminal_reported_at,
        "terminalLastWrite": machine.terminal_last_write,
        "terminalMerchantName": machine.terminal_merchant_name,
        "terminalSupplierNumber": machine.terminal_supplier_number,
        "expectedTerminalNumber": settings.expected,
        "forceTerminalNumber": settings.force,
        "forceTerminalNumberSource": settings.force_source,
        "terminalStatus": terminal_status(
            machine.terminal_number, machine.terminal_reported_at, settings.expected
        ),
    }
