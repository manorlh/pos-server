"""
The production report ("דוח הפקה") of an open-format file — 1.31 §2.6.

At the end of a production the software shows (and lets the user print) what it wrote: the
business, where the files were saved, the period, and the totals the Tax Authority's
simulator asks to be typed in when the software is certified — per document type (C100
1203) the number of documents and their total (Σ 1223), and per record type the number of
records. Built from the very file the user downloaded (`TaxReportResult`), never from a
second run: the primary identifier (A000 1004), the path (1012) and the production time
(1026/1027) are that file's.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from app.services.open_format.defaults import SoftwareInfo
from app.services.open_format.tax_report_generator import PAYMENT_TYPE_NAMES, TaxReportResult

#: C100 1203 — the document types of 1.31 (נספח 1), by the names the report prints.
DOCUMENT_TYPE_NAMES: Dict[int, str] = {
    100: "הזמנה",
    200: "תעודת משלוח",
    205: "תעודת החזרה",
    300: "חשבונית / חשבונית עסקה",
    305: "חשבונית מס",
    310: "חשבונית ריכוז",
    320: "חשבונית מס קבלה",
    330: "חשבונית מס זיכוי",
    340: "חשבונית שריון",
    345: "חשבונית סוכן",
    400: "קבלה",
    405: "קבלה על תרומות",
    410: "יציאה מקופה",
    420: "הפקדת בנק",
    500: "הזמנת רכש",
    600: "תעודת משלוח רכש",
    610: "החזרת רכש",
    700: "חשבונית מס רכש",
    710: "זיכוי רכש",
    800: "יתרת פתיחה",
    810: "כניסה כללית למלאי",
    820: "יציאה כללית מהמלאי",
    830: "העברה בין מחסנים",
    840: "עדכון בעקבות ספירה",
    900: "דוח ייצור - כניסה",
    910: "דוח ייצור - יציאה",
}

#: The record types of 1.31, in file order, by the names the report prints.
RECORD_TYPE_NAMES: Dict[str, str] = {
    "A100": "רשומת פתיחה",
    "B100": "תנועה בהנהלת חשבונות",
    "B110": "חשבון בהנהלת חשבונות",
    "C100": "כותרת מסמך",
    "D110": "פרטי מסמך",
    "D120": "פרטי קבלות",
    "M100": "פריטים במלאי",
    "Z900": "רשומת סגירה",
}


def _shekels(agorot: int) -> str:
    sign = "-" if agorot < 0 else ""
    a = abs(int(agorot))
    return f"{sign}{a // 100}.{a % 100:02d}"


def build_production_report(
    result: TaxReportResult,
    business_info: Dict[str, Any],
    software_info: SoftwareInfo,
    date_range: Dict[str, Any],
    *,
    file_name: Optional[str] = None,
) -> Dict[str, Any]:
    """The §2.6 report of `result`, as JSON for the dashboard (amounts as shekel strings)."""
    documents: List[Dict[str, Any]] = []
    for code, t in result.document_totals.items():
        documents.append({
            "code": code,
            "name": DOCUMENT_TYPE_NAMES.get(code, ""),
            "count": t["count"],
            "total": _shekels(t["totalAgorot"]),
            "cancelledCount": t["cancelledCount"],
            "cancelledTotal": _shekels(t["cancelledAgorot"]),
        })
    records: List[Dict[str, Any]] = [
        {"code": code, "name": RECORD_TYPE_NAMES.get(code, ""), "count": count}
        for code, count in result.record_counts.items()
        if count > 0
    ]
    payments = [
        {"code": code, "name": PAYMENT_TYPE_NAMES.get(code, ""), "count": t["count"], "total": _shekels(t["totalAgorot"])}
        for code, t in result.payment_totals.items()
    ]
    produced = result.process_date
    address = " ".join(
        x for x in (business_info.get("companyAddress"), business_info.get("companyAddressNumber")) if x
    )
    return {
        "title": "הפקת קבצים במבנה אחיד",
        "business": {
            "vatNumber": business_info.get("vatNumber") or "",
            "name": business_info.get("companyName") or "",
            "address": address,
            "city": business_info.get("companyCity") or "",
        },
        "software": {
            "name": software_info.name,
            "version": software_info.version,
            "registrationNumber": software_info.registration_number,
            "manufacturerName": software_info.manufacturer_name,
            "manufacturerVatNumber": software_info.manufacturer_id,
        },
        "primaryId": result.unique_id,
        "outputPath": result.output_path,
        "fileName": file_name,
        "files": ["INI.TXT", "BKMVDATA.TXT"],
        "taxYear": date_range.get("year"),
        "periodFrom": result.period_start.isoformat() if result.period_start else None,
        "periodTo": result.period_end.isoformat() if result.period_end else None,
        "producedDate": produced.strftime("%Y-%m-%d") if produced else None,
        "producedTime": produced.strftime("%H:%M") if produced else None,
        "documents": documents,
        "documentsCount": sum(d["count"] for d in result.document_totals.values()),
        "records": records,
        # A000 1002 / Z900 1155: every BKMVDATA record, Z900 included.
        "recordsTotal": sum(result.record_counts.values()),
        "payments": payments,
        "unmappedTenders": [{"method": k, "count": v} for k, v in result.unmapped_tenders.items()],
    }
