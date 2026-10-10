"""
The account mapping ("הגדרות הנהלת חשבונות"): company row, shop override, merged.

Stored shape (camelCase, as the dashboard sends it)::

    {
      "movementType": "ZZZ",            # Hashavshevet movement type code, ≤ 3 chars
      "branchCode": "1",                # the shop's code in the books (אסמכתא 2, סניף)
      "encoding": "cp1255" | "cp862",
      "method": "flexible" | "detailed",
      "accounts": {"cash": "1001", ...}, # one key per journal line, ACCOUNT_KEYS
      "cardBrands": {"visa": "1201"},   # optional: card receipts per brand (מותג)
      "cardAcquirers": {"max": "1210"}, # optional: per acquirer (חברת סליקה) — wins
      "voucherSalesAsLiability": false, # voucher sales to a liability, not to income
      "exportLevel": "company" | "shop",# company: one file; shop: a file per shop
      "consolidate": false,             # company level: one entry for all shops
      "costCenter": "12"                # the shop's cost centre (מרכז רווח), per line
    }

Card codes are those of `app.services.card_brands`. `exportLevel` and `consolidate` are
the company's choice (a shop row's are ignored); `costCenter` is usually set per shop.

A shop row holds only what it overrides; scalars are replaced, `accounts`,
`cardBrands` and `cardAcquirers` are merged key by key — the same inheritance as every other setting.
An empty string is "not set" at either level, so a shop cannot blank a company account.
"""
from __future__ import annotations

import uuid
from typing import Any, Dict, List, Optional

from sqlalchemy.orm import Session

from app.models.accounting import AccountingSettings

#: One key per journal line (spec §2.2), in the order the page shows them.
ACCOUNT_KEYS = (
    "cash",
    "card",
    "cardDeclined",
    "vouchers",
    "otherTenders",
    "incomeTaxable",
    "incomeExempt",
    "vatOutput",
    "tips",
    "voucherSales",
    "cashOverShort",
    "rounding",
)

#: Needed by every export, whatever the Zs hold. The rest are needed only when a Z
#: actually has that line (a shop with no tips needs no tips account).
CORE_ACCOUNT_KEYS = ("cash", "card", "incomeTaxable", "vatOutput")

ENCODINGS = ("cp1255", "cp862")
METHODS = ("flexible", "detailed")

DEFAULTS: Dict[str, Any] = {
    "movementType": "",
    "branchCode": "",
    "encoding": "cp1255",
    "method": "flexible",
    "accounts": {},
    "cardBrands": {},
    "cardAcquirers": {},
    "voucherSalesAsLiability": False,
    "exportLevel": "company",
    "consolidate": False,
    "costCenter": "",
}

EXPORT_LEVELS = ("company", "shop")

_SCALARS = (
    "movementType", "branchCode", "encoding", "method", "voucherSalesAsLiability",
    "exportLevel", "consolidate", "costCenter",
)
#: Code → account maps, merged key by key.
_MAPS = ("cardBrands", "cardAcquirers")


def _clean_map(value: Any) -> Dict[str, str]:
    if not isinstance(value, dict):
        return {}
    out: Dict[str, str] = {}
    for k, v in value.items():
        if v is None:
            continue
        text = str(v).strip()
        if text:
            out[str(k).strip()] = text
    return out


def normalize(raw: Optional[dict]) -> Dict[str, Any]:
    """Drop empties and unknown account keys; brand keys are lower-cased."""
    raw = raw or {}
    out: Dict[str, Any] = {}
    for key in _SCALARS:
        value = raw.get(key)
        if value is None:
            continue
        if isinstance(value, str):
            value = value.strip()
            if not value:
                continue
        out[key] = value
    accounts = {k: v for k, v in _clean_map(raw.get("accounts")).items() if k in ACCOUNT_KEYS}
    if accounts:
        out["accounts"] = accounts
    for name in _MAPS:
        codes = {k.lower(): v for k, v in _clean_map(raw.get(name)).items() if k}
        if codes:
            out[name] = codes
    if out.get("exportLevel") not in (None,) + EXPORT_LEVELS:
        out.pop("exportLevel")
    return out


def merge(company: Optional[dict], shop: Optional[dict]) -> Dict[str, Any]:
    """Company, then the shop's overrides on top, over the defaults."""
    merged: Dict[str, Any] = {**DEFAULTS, "accounts": {}, "cardBrands": {}, "cardAcquirers": {}}
    for level, layer in (("company", normalize(company)), ("shop", normalize(shop))):
        for key in _SCALARS:
            if key in layer:
                if level == "shop" and key in COMPANY_ONLY:
                    continue
                merged[key] = layer[key]
        merged["accounts"].update(layer.get("accounts", {}))
        for name in _MAPS:
            merged[name].update(layer.get(name, {}))
    return merged


#: How the company exports; a shop cannot choose for itself.
COMPANY_ONLY = ("exportLevel", "consolidate")


#: An exempt dealer (עוסק פטור) never has VAT or taxable income: its receipts carry no
#: VAT, so its entries are "הכנסות פטורות" (docs/SPEC_BUSINESS_TYPE.md).
EXEMPT_CORE_ACCOUNT_KEYS = ("cash", "card", "incomeExempt")


def missing_core(effective: Dict[str, Any], dealer_type: Optional[str] = None) -> List[str]:
    """What an export can never go without: the movement type and the core accounts."""
    missing: List[str] = []
    if not effective.get("movementType"):
        missing.append("movementType")
    accounts = effective.get("accounts") or {}
    core = EXEMPT_CORE_ACCOUNT_KEYS if dealer_type == "exempt" else CORE_ACCOUNT_KEYS
    missing += [f"accounts.{k}" for k in core if not accounts.get(k)]
    return missing


def load_row(
    db: Session, company_id: uuid.UUID, shop_id: Optional[uuid.UUID]
) -> Optional[AccountingSettings]:
    q = db.query(AccountingSettings).filter(AccountingSettings.company_id == company_id)
    if shop_id is None:
        q = q.filter(AccountingSettings.shop_id.is_(None))
    else:
        q = q.filter(AccountingSettings.shop_id == shop_id)
    return q.first()


def effective_for(
    db: Session, company_id: uuid.UUID, shop_id: Optional[uuid.UUID]
) -> Dict[str, Any]:
    company_row = load_row(db, company_id, None)
    shop_row = load_row(db, company_id, shop_id) if shop_id is not None else None
    return merge(
        company_row.settings if company_row else None,
        shop_row.settings if shop_row else None,
    )
