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
from app.services.payment_terminal import merged_pinpad_host, pinpad_required
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


#: The card lock's reasons (the till's CardLockReason, docs/SPEC_KIOSK.md §20).
LOCK_MISMATCH = "mismatch"
LOCK_NOT_CONFIGURED = "not_configured"
LOCK_UNKNOWN = "unknown"


def card_lock_of(
    integration: Optional[str],
    expected: Any,
    expected_source: Optional[str],
    force: bool,
    reported: Any,
    reported_at: Optional[datetime],
) -> Optional[str]:
    """
    The till's card lock (domain/CardLock.kt) as the cloud can tell it from the last report.

    A network pinpad (nayax_lan — every kiosk's) or an external SynqPay terminal (synqpay, LAN or
    USB — docs/SPEC_SYNQPAY.md §2.1): the expected number must be set on the machine itself, never
    inherited; unset → "not_configured", unreported → "unknown", another number → "mismatch". The
    built-in terminal (agamento — on a SynqPay terminal, SynqPay's own): the effective number,
    inherited included; locked only on another number with no forced setup on its way. Z-Credit
    and others: not this rule (None).
    """
    want = normalize_terminal_number(expected)
    have = normalize_terminal_number(reported) if reported_at is not None else None
    if integration in ("nayax_lan", "synqpay"):
        if want is None or expected_source != "machine":
            return LOCK_NOT_CONFIGURED
        if have is None:
            return LOCK_UNKNOWN
        return None if have == want else LOCK_MISMATCH
    if integration == "agamento":
        if want is None or force or have is None:
            return None
        return None if have == want else LOCK_MISMATCH
    return None


def card_lock_unbypassed(machine: "POSMachine", settings: "TerminalSettings") -> Optional[str]:
    """The lock the terminal-number check puts on, as if "עקיפת בדיקת מספר מסוף" were off."""
    integration = getattr(settings.integration, "integration", None)
    return card_lock_of(
        integration, settings.expected, settings.expected_source, settings.force,
        machine.terminal_number, machine.terminal_reported_at,
    )


def card_lock_status(machine: "POSMachine", settings: "TerminalSettings") -> Optional[str]:
    """
    The till's card lock — none while "עקיפת בדיקת מספר מסוף" (`terminalNumberCheckBypass`) is
    on for it (docs/SPEC_KIOSK.md §20.1): the till does not lock, so neither does the cloud's view.
    """
    if getattr(settings, "number_check_bypass", False):
        return None
    return card_lock_unbypassed(machine, settings)


@dataclass
class TerminalSettings:
    """What the till's settings layers say about its terminal."""

    expected: Optional[str] = None
    #: The level `expectedTerminalNumber` comes from ("machine", "shop"…); None = no level sets it.
    expected_source: Optional[str] = None
    force: bool = False
    #: The level `forceTerminalNumber` comes from; None = no level sets it (off).
    force_source: Optional[str] = None
    #: The merged `nayaxEnabled`: this till charges on a Nayax pinpad on the network.
    pinpad_enabled: bool = False
    #: The merged pinpad address (`nayaxDeviceHost`, `nayaxDevicePort`); None = not set.
    pinpad_host: Optional[str] = None
    pinpad_port: Optional[str] = None
    #: "סוג אינטגרציית אשראי" as resolved for this till (app/services/payment_integration.py).
    integration: Optional[Any] = None
    #: "עקיפת בדיקת מספר מסוף" in effect for this till (app/services/terminal_check_bypass.py),
    #: the level it comes from, and who set that level's value and when (null: unrecorded).
    number_check_bypass: bool = False
    number_check_bypass_source: Optional[str] = None
    number_check_bypass_change: Optional[Dict[str, Any]] = None


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
    # The integration's secrets (only whether they are set): one query for every layer.
    from app.services import payment_integration, payment_secrets

    secret_rows = payment_secrets.secrets_for_layers(
        db,
        [("tenant", t) for t in tenants]
        + [("company", c) for c in companies]
        + [("shop", s) for s in shops]
        + [("area", a) for a in areas]
        + [("machine", m.id) for m in machines],
    )
    # "עקיפת בדיקת מספר מסוף" per till: three queries for the whole list.
    from app.services import terminal_check_bypass

    bypasses = terminal_check_bypass.bypass_for_machines(db, machines)
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
        if company is None:
            id_layers = [("machine", m.id)]
        else:
            id_layers = payment_integration.secret_layers(tenant, company, shop, area, m)
        integration = payment_integration.resolve(
            layers,
            bool(getattr(m, "has_builtin_terminal", True)),
            secrets_set=list(payment_secrets.merged_secret_sources(id_layers, secret_rows)),
            # On a SynqPay terminal "synqpay" is its own terminal (docs/SPEC_SYNQPAY.md §1.5).
            synqpay_device=payment_integration.is_synqpay_device(m),
        )
        expected = merged.get("expectedTerminalNumber")
        port = merged.get("nayaxDevicePort")
        bypass = bypasses.get(m.id) or terminal_check_bypass.Bypass()
        out[m.id] = TerminalSettings(
            number_check_bypass=bypass.on,
            number_check_bypass_source=bypass.source if bypass.on else None,
            # Who turned it on (only looked up for the few tills it is on for).
            number_check_bypass_change=terminal_check_bypass.change_of(db, m, bypass) if bypass.on else None,
            expected=expected if isinstance(expected, str) and expected.strip() else None,
            expected_source=sources.get("expectedTerminalNumber"),
            force=merged.get("forceTerminalNumber") is True,
            force_source=sources.get("forceTerminalNumber"),
            pinpad_enabled=merged.get("nayaxEnabled") is True,
            pinpad_host=merged_pinpad_host(merged),
            pinpad_port=str(port).strip() if port is not None and str(port).strip() else None,
            integration=integration,
        )
    return out


def machine_terminal_fields(machine: "POSMachine", settings: TerminalSettings) -> Dict[str, Any]:
    """The terminal fields of a machine's list/detail response."""
    required = pinpad_required(machine.has_builtin_terminal, settings.pinpad_enabled)
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
        # "תנעל את האשראי, לא את הקופה" (docs/SPEC_KIOSK.md §20): whether the till locks card
        # payment on what it last reported, and where its expected number comes from.
        "expectedTerminalNumberSource": settings.expected_source,
        "cardLock": card_lock_status(machine, settings),
        # "עקיפת בדיקת מספר מסוף" (docs/SPEC_KIOSK.md §20.1): on for this till, from which level,
        # by whom; what the till reports it applies; and the lock it lifts now.
        **_bypass_fields(machine, settings),
        # The network pinpad (app/services/payment_terminal.py): whether this till charges
        # on one, where, and whether it still has no address, which the machines page
        # flags ("נדרשת כתובת IP למסופון") until someone types it at the till or here.
        "pinpadEnabled": settings.pinpad_enabled,
        "pinpadHost": settings.pinpad_host,
        "pinpadPort": settings.pinpad_port,
        "pinpadRequired": required,
        "pinpadAddressMissing": required and settings.pinpad_host is None,
        # "סוג אינטגרציית אשראי": what the till charges on, from which level, and what
        # it still lacks (the machines page's badge, "חסר: מספר מסוף").
        **_integration_fields(settings),
    }


def _bypass_fields(machine: "POSMachine", settings: TerminalSettings) -> Dict[str, Any]:
    from app.services import terminal_check_bypass

    bypass = terminal_check_bypass.Bypass(
        bool(getattr(settings, "number_check_bypass", False)),
        getattr(settings, "number_check_bypass_source", None),
    )
    return terminal_check_bypass.machine_fields(
        machine,
        bypass,
        card_lock_unbypassed(machine, settings) if bypass.on else None,
        getattr(settings, "number_check_bypass_change", None),
    )


def _integration_fields(settings: TerminalSettings) -> Dict[str, Any]:
    from app.services.payment_integration import machine_fields

    return machine_fields(settings.integration)
