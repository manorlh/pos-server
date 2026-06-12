import uuid
from datetime import datetime, timezone
from unittest.mock import MagicMock

from app.services.settings_merge import (
    build_business_info,
    deep_merge_settings,
    effective_settings_updated_at,
    merge_settings,
    patch_settings_json,
)


def _ts() -> datetime:
    return datetime(2026, 5, 1, 12, 0, 0, tzinfo=timezone.utc)


def test_deep_merge_shop_overrides_company_nayax() -> None:
    merged = deep_merge_settings(
        {"globalTaxRate": 17, "nayaxDeviceHost": "10.0.0.1"},
        {"nayaxDeviceHost": "192.168.1.50", "nayaxDevicePort": "9090"},
    )
    assert merged["globalTaxRate"] == 17
    assert merged["nayaxDeviceHost"] == "192.168.1.50"
    assert merged["nayaxDevicePort"] == "9090"


def test_merge_settings_returns_managed_keys_only() -> None:
    company = MagicMock()
    company.settings = {"globalTaxRate": 18, "extra": "ignored"}
    shop = MagicMock()
    shop.settings = {"language": "en"}
    result = merge_settings(company, shop)
    assert result == {"globalTaxRate": 18, "language": "en"}
    assert "extra" not in result


def test_build_business_info_shop_wins_address_and_branch() -> None:
    company = MagicMock()
    company.name = "Acme Ltd"
    company.vat_number = "123456789"
    company.address = "Main St"
    company.city = "Tel Aviv"
    shop = MagicMock()
    shop.branch_id = "007"
    shop.address = "Branch Rd"
    shop.city = "Haifa"
    bi = build_business_info(company, shop)
    assert bi.company_name == "Acme Ltd"
    assert bi.vat_number == "123456789"
    assert bi.company_address == "Branch Rd"
    assert bi.company_city == "Haifa"
    assert bi.branch_id == "007"
    assert bi.has_branches is True


def test_effective_settings_updated_at_uses_max_timestamps() -> None:
    company = MagicMock()
    company.settings_updated_at = _ts()
    company.updated_at = datetime(2026, 4, 1, tzinfo=timezone.utc)
    shop = MagicMock()
    shop.settings_updated_at = datetime(2026, 6, 1, tzinfo=timezone.utc)
    shop.updated_at = datetime(2026, 3, 1, tzinfo=timezone.utc)
    assert effective_settings_updated_at(company, shop) == shop.settings_updated_at


def test_patch_settings_json_merges_business_info() -> None:
    current = {"globalTaxRate": 17, "businessInfo": {"companyZip": "12345"}}
    patched = patch_settings_json(current, {"businessInfo": {"companyRegNumber": "REG1"}})
    assert patched["globalTaxRate"] == 17
    assert patched["businessInfo"] == {"companyZip": "12345", "companyRegNumber": "REG1"}
