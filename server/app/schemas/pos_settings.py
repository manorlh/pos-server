"""POS till settings v1 — keys align with pos-desktop SQLite `settings` table."""
from datetime import datetime
from typing import Any, Dict, Literal, Optional

from pydantic import BaseModel, Field


class PosSettingsV1Patch(BaseModel):
    """Partial update for company/shop settings JSONB."""

    global_tax_rate: Optional[int] = Field(None, alias="globalTaxRate", ge=0, le=100)
    hide_out_of_stock_products: Optional[bool] = Field(None, alias="hideOutOfStockProducts")
    language: Optional[Literal["he", "en"]] = None
    nayax_enabled: Optional[bool] = Field(None, alias="nayaxEnabled")
    nayax_device_host: Optional[str] = Field(None, alias="nayaxDeviceHost")
    nayax_device_port: Optional[str] = Field(None, alias="nayaxDevicePort")
    nayax_spicy_path: Optional[str] = Field(None, alias="nayaxSpicyPath")
    business_info: Optional[Dict[str, Any]] = Field(None, alias="businessInfo")

    class Config:
        populate_by_name = True


class BusinessInfoSync(BaseModel):
    vat_number: str = Field(..., alias="vatNumber")
    company_name: str = Field(..., alias="companyName")
    company_address: str = Field(..., alias="companyAddress")
    company_address_number: str = Field("1", alias="companyAddressNumber")
    company_city: str = Field(..., alias="companyCity")
    company_zip: str = Field("", alias="companyZip")
    company_reg_number: Optional[str] = Field(None, alias="companyRegNumber")
    has_branches: bool = Field(False, alias="hasBranches")
    branch_id: Optional[str] = Field(None, alias="branchId")

    class Config:
        populate_by_name = True


class EntitySettingsResponse(BaseModel):
    settings: Dict[str, Any]
    settings_updated_at: datetime = Field(..., alias="settingsUpdatedAt")

    class Config:
        populate_by_name = True


class ShopSettingsResponse(EntitySettingsResponse):
    effective: Optional[Dict[str, Any]] = None


class SettingsSyncResponse(BaseModel):
    sync_type: Literal["full", "delta", "unchanged"] = Field(..., alias="syncType")
    server_time: datetime = Field(..., alias="serverTime")
    settings_updated_at: datetime = Field(..., alias="settingsUpdatedAt")
    settings: Dict[str, Any] = Field(default_factory=dict)
    business_info: Optional[BusinessInfoSync] = Field(None, alias="businessInfo")

    class Config:
        populate_by_name = True
