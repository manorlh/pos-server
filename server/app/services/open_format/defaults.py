"""Default OPEN FORMAT software/tax config for cloud exports."""

from dataclasses import dataclass
from typing import Literal


@dataclass
class SoftwareInfo:
    registration_number: str = "00000001"
    name: str = "POS Desktop"
    version: str = "0.2.5"
    manufacturer_id: str = "987654321"
    manufacturer_name: str = "Herzl50"
    software_type: Literal["single-year", "multi-year"] = "multi-year"


@dataclass
class TaxReportConfig:
    system_code: str = "&OF1.31&"
    accounting_type: str = "1"
    balancing_required: bool = True
    language_code: str = "0"
    charset: str = "1"
    compression_software: str = "zip"
    default_currency: str = "ILS"


DEFAULT_SOFTWARE_INFO = SoftwareInfo()
DEFAULT_TAX_REPORT_CONFIG = TaxReportConfig()
