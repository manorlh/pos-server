"""
"תצורת עבודה למכשיר" — the plan the dashboard sends (app/services/work_config.py,
docs/SPEC_DEVICE_WORK_CONFIG.md): a preset with its choices, and the advanced overrides.
A value left out (or null) is not touched — or, with a preset, is the preset's default.
"""
from __future__ import annotations

from typing import Any, Dict, List, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field


class WorkConfigIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    #: A preset id (`work_config.PRESETS`), "inherit" — the shop's default for the device's
    #: fiscal part ("לפי הסניף") — or null: only the values below.
    preset: Optional[str] = Field(None, max_length=32)
    #: "ניהול שולחנות" at the device's level: one of the preset's choices, or "inherit".
    tables_mode: Optional[str] = Field(None, alias="tablesMode", max_length=100)
    #: "לא משמש כשרת מקומי" — where the preset lets the operator choose (false: as the shop).
    lan_server_excluded: Optional[bool] = Field(None, alias="lanServerExcluded")
    #: A kiosk in the shop Z of a LAN shop: "מחובר ברשת המקומית" / "מרוחק (דרך הענן)".
    link: Optional[Literal["lan", "remote"]] = None
    #: "קופה ראשית (שרת מקומי)" in a shop whose "רשת מקומית" is off: turn it on too.
    enable_local_network: Optional[bool] = Field(None, alias="enableLocalNetwork")
    #: "מדפסת חשבוניות" at the device's level (the printers page's parameter), or "inherit".
    receipt_printer: Optional[str] = Field(None, alias="receiptPrinter", max_length=100)
    #: The workflow's fulfillment targets at the device's level (printer / kds / kds_view /
    #: expo / pickup_screen), or "inherit".
    workflow_targets: Optional[Union[Literal["inherit"], List[str]]] = Field(None, alias="workflowTargets")

    def plan(self) -> Dict[str, Any]:
        """As `work_config` takes it (and a pairing code stores it): camelCase, nulls left out."""
        return {k: v for k, v in self.model_dump(by_alias=True).items() if v is not None}


class WorkConfigPutIn(WorkConfigIn):
    #: The super admin moves the shop's Z production although its producer may still hold
    #: shop Zs the cloud does not (docs/SPEC_INDEPENDENT_TILL.md §8.10).
    force_producer_switch: bool = Field(False, alias="forceProducerSwitch")

    def plan(self) -> Dict[str, Any]:
        out = super().plan()
        out.pop("forceProducerSwitch", None)
        return out
