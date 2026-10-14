"""
"הדפסת חשבון וקבלה על המדפסת המובנית של קופה אחרת" (P:/specs/bill-print-other-till.md): a bill or a
receipt printed on another till's printer — its built-in head, or a USB / network / Bluetooth printer
only that till reaches. Relayed like the kitchen tickets: over the shop's LAN to the host's print port
first, else through the cloud relay (`kitchen_print_jobs`, app/services/printers.py) as a job of the
kind `document`.

* **Where** (§3.1) — a receipt printer of type `cloud` on the printers page: its host (a till of the
  shop that says `document_relay_v1` on its heartbeat, `CAPABILITY`) and how the host reaches it
  (`host_connection`: its own head, USB, network, Bluetooth). Narrowed to a point of sale or a till
  like any printer; listed to the tills it applies to (their receipt destinations: "המדפסת של <קופה>")
  and to its host, which then takes `document` jobs. Its drawer (`cash_drawer`, on the host's printer)
  opens only by a `drawer` job (§9: `remotePrintDrawer`, CASH_DRAWER.OPEN_REMOTE) — never by a document.
  From the dashboard's open tables (§7) a till may also be named by itself (`printOn`): it prints on its
  own receipt printer.
* **What travels** (§4) — the document as the sending till rendered it, at the host's paper width, one
  colour, compressed (`DocumentIn`): the host prints the image as it is and never reads the document.
  At most `IMAGE_MAX_BYTES` (413 `document_too_large`). The reference (type, number, copy, title) is
  for the messages and "בעיות" only: the document is the sender's, under its own numbering (§5).
* **The parameters** (§7א) — company → shop → point of sale → till like every till parameter, read by
  the till; the cloud holds a job to the same words (`settings_for`): `remotePrintEnabled` off — 409
  `remote_print_off`; a document `remotePrintDocuments` keeps local — 409 `document_not_remote`; a host
  outside `remotePrintHosts` (when it names any) — 409 `host_not_allowed`. Nothing set changes nothing:
  without a receipt printer of type cloud nothing is relayed anyway.
* **The job** — the sender's `remotePrintTimeoutSec` is how long the job waits for its host
  (`expires_at`); one its host took and never answered for is given up after `TAKEN_TTL` — a bill is
  no ticket the host keeps for hours (the sender may print it itself meanwhile, §5). Over — done,
  failed or expired — its image is dropped (`drop_image`): only the reference stays.
* **"לא הודפס"** (§6) — a document that failed or expired at its host is "<חשבון> לא הודפס בקופה X" on
  "בעיות" (`EXCEPTION_TYPE`, the devices group): an exception the host's rules may switch off ("הגדרות
  חריגות", per company, shop, point of sale or till), closed by itself when the host prints it after all.
"""
from __future__ import annotations

import base64
import binascii
import logging
import math
import struct
import uuid
import zlib
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional, Sequence, Tuple

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.pos_machine import POSMachine

logger = logging.getLogger(__name__)

#: What a till's heartbeat says when its build renders, relays and prints documents.
CAPABILITY = "document_relay_v1"


def relays_documents(machine: Optional[POSMachine]) -> bool:
    """The till's build relays and prints `document` jobs: its heartbeat said `document_relay_v1`."""
    if machine is None:
        return False
    words = list(getattr(machine, "capabilities", None) or [])
    reported = getattr(machine, "reported_capabilities", None) or {}
    if isinstance(reported, dict):
        words += list(reported.get("list") or [])
    return CAPABILITY in words


# ── The parameters (§7א) ─────────────────────────────────────────────────────

ENABLED_KEY = "remotePrintEnabled"
DOCUMENTS_KEY = "remotePrintDocuments"
FALLBACK_KEY = "remotePrintFallback"
TIMEOUT_KEY = "remotePrintTimeoutSec"
NOTICE_KEY = "remotePrintNotice"
HOSTS_KEY = "remotePrintHosts"
FROM_DASHBOARD_KEY = "remotePrintFromDashboard"

DOCUMENTS_BILL = "bill"
DOCUMENTS_BILL_RECEIPTS = "bill_receipts"
DOCUMENTS_ALL = "all"
DOCUMENTS_OPTIONS = (DOCUMENTS_BILL, DOCUMENTS_BILL_RECEIPTS, DOCUMENTS_ALL)
DOCUMENTS_LABELS = {
    DOCUMENTS_BILL: "חשבון שולחן וחשבון ביניים (ברירת מחדל)",
    DOCUMENTS_BILL_RECEIPTS: "גם קבלות וחשבוניות",
    DOCUMENTS_ALL: "גם העתקים, זיכויים ודוחות X/Z",
}

FALLBACK_ASK = "ask"
FALLBACK_LOCAL = "local"
FALLBACK_NONE = "none"
FALLBACK_OPTIONS = (FALLBACK_ASK, FALLBACK_LOCAL, FALLBACK_NONE)
FALLBACK_LABELS = {
    FALLBACK_ASK: "לשאול \"להדפיס כאן?\" (ברירת מחדל)",
    FALLBACK_LOCAL: "להדפיס כאן אוטומטית",
    FALLBACK_NONE: "רק התראה",
}

#: §9ב: the drawer of the host's printer with a document sent there — never (the default), asked at the
#: sending till ("לפתוח את המגירה ב<קופה>?"), or opened by itself with a cash payment.
DRAWER_KEY = "remotePrintDrawer"
DRAWER_NEVER = "never"
DRAWER_ASK = "ask"
DRAWER_AUTO = "auto"
DRAWER_OPTIONS = (DRAWER_NEVER, DRAWER_ASK, DRAWER_AUTO)
DRAWER_LABELS = {
    DRAWER_NEVER: "אף פעם (ברירת מחדל)",
    DRAWER_ASK: "לשאול בקופה השולחת",
    DRAWER_AUTO: "אוטומטית בתשלום מזומן",
}

TIMEOUT_DEFAULT = 20
TIMEOUT_MIN = 5
TIMEOUT_MAX = 120
#: The longest list of hosts a level names.
HOSTS_MAX = 50

#: The document classes (`DocumentIn.category`) each `remotePrintDocuments` sends to another till.
CATEGORIES = ("bill", "receipt", "other")
ALLOWED_CATEGORIES: Dict[str, Tuple[str, ...]] = {
    DOCUMENTS_BILL: ("bill",),
    DOCUMENTS_BILL_RECEIPTS: ("bill", "receipt"),
    DOCUMENTS_ALL: ("bill", "receipt", "other"),
}

#: The keys, in the order the printers page shows them.
KEYS: Tuple[str, ...] = (
    ENABLED_KEY, DOCUMENTS_KEY, FALLBACK_KEY, TIMEOUT_KEY, NOTICE_KEY, HOSTS_KEY, FROM_DASHBOARD_KEY, DRAWER_KEY,
)
#: Checked beyond their type on every write (app/services/till_parameters.py `validate_keyed_value`).
VALIDATED_KEYS = frozenset({DOCUMENTS_KEY, FALLBACK_KEY, TIMEOUT_KEY, HOSTS_KEY, DRAWER_KEY})

_LEVELS = "ניתן לקבוע לפי חברה, סניף, נקודת מכירה או קופה — כאן או בהגדרות ההדפסה בעמוד המדפסות."
_WHAT = (
    "\"מדפסת חשבוניות\" מסוג \"ענן\" בעמוד המדפסות: המדפסת של קופה אחרת בסניף (המובנית, או USB, רשת או "
    "Bluetooth שרק היא מגיעה אליהם). הקופה השולחת מרנדרת את המסמך לתמונה ושולחת אותו — קודם ברשת המקומית "
    "ואם אין תשובה דרך הענן."
)

#: The built-ins (app/services/till_parameters.py `BUILTIN_PARAMETERS`).
PARAMETER_SPECS: Tuple[Dict[str, Any], ...] = (
    dict(
        key=ENABLED_KEY,
        label="הדפסה בקופה אחרת",
        value_type="boolean",
        default_value=True,
        description=(
            f"כשמופעל, הקופה יכולה להדפיס חשבון או קבלה במדפסת של קופה אחרת: {_WHAT} "
            "כבוי — הקופה מדפיסה רק במדפסות שלה, ויעד מסוג \"המדפסת של <קופה>\" לא מוצג בה. "
            f"בלי מדפסת חשבוניות מסוג \"ענן\" אין שינוי ממילא. {_LEVELS}"
        ),
    ),
    dict(
        key=DOCUMENTS_KEY,
        label="הדפסה בקופה אחרת — אילו מסמכים",
        value_type="enum",
        enum_options=DOCUMENTS_OPTIONS,
        enum_labels=DOCUMENTS_LABELS,
        default_value=DOCUMENTS_BILL,
        description=(
            "אילו מסמכים יוצאים למדפסת של קופה אחרת. "
            f"«{DOCUMENTS_LABELS[DOCUMENTS_BILL]}» — חשבון שולחן וחשבון ביניים בלבד. "
            f"«{DOCUMENTS_LABELS[DOCUMENTS_BILL_RECEIPTS]}» — גם קבלות וחשבוניות. "
            f"«{DOCUMENTS_LABELS[DOCUMENTS_ALL]}» — כל מסמך. "
            "מסמך שלא נכלל מודפס במדפסת של הקופה עצמה, כמו היום. המסמך תמיד של הקופה השולחת, עם המספור "
            f"שלה; הדפסה חוזרת מסומנת \"העתק\". {_LEVELS}"
        ),
    ),
    dict(
        key=FALLBACK_KEY,
        label="הדפסה בקופה אחרת — כשלא הודפס",
        value_type="enum",
        enum_options=FALLBACK_OPTIONS,
        enum_labels=FALLBACK_LABELS,
        default_value=FALLBACK_ASK,
        description=(
            "מה הקופה השולחת עושה כשהמסמך לא הודפס בקופה האחרת בזמן, או שההדפסה נכשלה שם (אין נייר, תקלה). "
            f"«{FALLBACK_LABELS[FALLBACK_ASK]}» — מוצגת השאלה \"לא הודפס ב<קופה> — להדפיס כאן?\" (כשיש לקופה "
            f"מדפסת). «{FALLBACK_LABELS[FALLBACK_LOCAL]}» — מודפס בקופה השולחת בלי לשאול. "
            f"«{FALLBACK_LABELS[FALLBACK_NONE]}» — הודעה \"לא הודפס\" בלבד. מהדשבורד אין את מי לשאול: "
            f"«לשאול» נוהג שם כמו «רק התראה». {_LEVELS}"
        ),
    ),
    dict(
        key=TIMEOUT_KEY,
        label="הדפסה בקופה אחרת — זמן המתנה (שניות)",
        value_type="integer",
        default_value=TIMEOUT_DEFAULT,
        description=(
            "כמה שניות הקופה השולחת מחכה שהמסמך יודפס בקופה האחרת לפני שהיא מציגה \"לא הודפס\" "
            f"({TIMEOUT_MIN}–{TIMEOUT_MAX}, ברירת מחדל {TIMEOUT_DEFAULT}). מסמך שאף קופה לא לקחה עד אז לא "
            f"יודפס גם אם היא תתחבר מאוחר יותר. {_LEVELS}"
        ),
    ),
    dict(
        key=NOTICE_KEY,
        label="הדפסה בקופה אחרת — הודעה בקופה השולחת",
        value_type="boolean",
        default_value=True,
        description=(
            "כשמופעל, הקופה השולחת מציגה \"נשלח להדפסה ב<קופה>\" ואחריו \"הודפס\". כבוי — רק כשלא הודפס. "
            + _LEVELS
        ),
    ),
    dict(
        key=HOSTS_KEY,
        label="הדפסה בקופה אחרת — קופות מותרות",
        value_type="string",
        default_value="",
        description=(
            "לאילו קופות מותר לשלוח מסמכים להדפסה: מזהי הקופות, מופרדים בפסיק (בעמוד המדפסות בוחרים אותן "
            "ברשימה). ריק (ברירת מחדל) — כל קופה שהוגדרה כמארחת של מדפסת חשבוניות מסוג \"ענן\". "
            f"קופה שלא ברשימה לא מוצגת כיעד, והענן דוחה מסמך אליה. {_LEVELS}"
        ),
    ),
    dict(
        key=FROM_DASHBOARD_KEY,
        label="הדפסת חשבון מהדשבורד בקופה אחרת",
        value_type="boolean",
        default_value=True,
        description=(
            "בשולחנות הפתוחים בדשבורד, \"הדפס חשבון\" מציע גם להדפיס בקופה אחרת שיש לה מדפסת (בכפוף להרשאת "
            "הפעולות בשולחנות). ברירת המחדל נשארת הקופה שמחזיקה את השולחן. כבוי — רק בקופה שמחזיקה את "
            "השולחן, כמו היום. נקרא בקופה שמחזיקה את השולחן. " + _LEVELS
        ),
    ),
    dict(
        key=DRAWER_KEY,
        label="הדפסה בקופה אחרת — מגירה במדפסת שם",
        value_type="enum",
        enum_options=DRAWER_OPTIONS,
        enum_labels=DRAWER_LABELS,
        default_value=DRAWER_NEVER,
        description=(
            "כשחשבון או קבלה נשלחים להדפסה בקופה אחרת, ולמדפסת שם יש מגירה (מדפסת חשבוניות מסוג \"ענן\" עם "
            f"מגירה): «{DRAWER_LABELS[DRAWER_NEVER]}» — המגירה שם לא נפתחת, כמו היום. «{DRAWER_LABELS[DRAWER_ASK]}» — "
            "בתשלום מזומן הקופה השולחת שואלת \"לפתוח את המגירה ב...?\". "
            f"«{DRAWER_LABELS[DRAWER_AUTO]}» — נפתחת בכל תשלום מזומן. הפתיחה דורשת את ההרשאה \"פתיחת מגירה בקופה "
            "אחרת\" (או אישור), נרשמת בקופה השולחת עם העובד והמאשר, והקופה שם פותחת רק כשאינה באמצע תשלום משלה. "
            "\"פתיחת מגירה ב...\" מהתפריט (מסופון, P18, טלפון) לא תלויה בפרמטר הזה — רק בהרשאה. " + _LEVELS
        ),
    ),
)


def parse_hosts(value: Any) -> List[str]:
    """`remotePrintHosts` as machine ids (lower-case, unique, in order); anything that is not one is skipped."""
    if not isinstance(value, str):
        return []
    out: List[str] = []
    for part in value.replace(";", ",").replace("\n", ",").split(","):
        part = part.strip()
        if not part:
            continue
        try:
            ident = str(uuid.UUID(part))
        except ValueError:
            continue
        if ident not in out:
            out.append(ident)
    return out[:HOSTS_MAX]


def clean_value(key: str, value: Any) -> Any:
    """`value` as stored for `key` (the codes the till knows, the seconds' range, the hosts canonical), else ValueError."""
    if value is None or key not in VALIDATED_KEYS:
        return value
    if key == DOCUMENTS_KEY and value not in DOCUMENTS_OPTIONS:
        raise ValueError(f"{DOCUMENTS_KEY} must be one of {', '.join(DOCUMENTS_OPTIONS)}")
    if key == FALLBACK_KEY and value not in FALLBACK_OPTIONS:
        raise ValueError(f"{FALLBACK_KEY} must be one of {', '.join(FALLBACK_OPTIONS)}")
    if key == DRAWER_KEY and value not in DRAWER_OPTIONS:
        raise ValueError(f"{DRAWER_KEY} must be one of {', '.join(DRAWER_OPTIONS)}")
    if key == TIMEOUT_KEY and not (
        isinstance(value, int) and not isinstance(value, bool) and TIMEOUT_MIN <= value <= TIMEOUT_MAX
    ):
        raise ValueError(f"{TIMEOUT_KEY} must be {TIMEOUT_MIN}–{TIMEOUT_MAX} seconds")
    if key == HOSTS_KEY:
        if not isinstance(value, str):
            raise ValueError(f"{HOSTS_KEY} must be text")
        hosts: List[str] = []
        for part in value.replace(";", ",").replace("\n", ",").split(","):
            part = part.strip()
            if not part:
                continue
            try:
                ident = str(uuid.UUID(part))
            except ValueError:
                raise ValueError(f"{HOSTS_KEY} must be till ids separated by commas") from None
            if ident not in hosts:
                hosts.append(ident)
        if len(hosts) > HOSTS_MAX:
            raise ValueError(f"{HOSTS_KEY}: at most {HOSTS_MAX} tills")
        return ",".join(hosts)
    return value


@dataclass(frozen=True)
class Settings:
    enabled: bool = True
    documents: str = DOCUMENTS_BILL
    fallback: str = FALLBACK_ASK
    timeout: int = TIMEOUT_DEFAULT
    notice: bool = True
    #: Empty: any host configured.
    hosts: Tuple[str, ...] = ()
    from_dashboard: bool = True
    drawer: str = DRAWER_NEVER

    def allows(self, category: str) -> bool:
        return category in ALLOWED_CATEGORIES.get(self.documents, ALLOWED_CATEGORIES[DOCUMENTS_BILL])

    def may_reach(self, machine_id: Any) -> bool:
        return not self.hosts or str(machine_id).lower() in self.hosts


def settings_of(params: Dict[str, Any]) -> Settings:
    """A till's resolved parameters as these rules read them (pure); a missing or odd value is the default."""

    def flag(key: str, default: bool) -> bool:
        value = params.get(key)
        return value if isinstance(value, bool) else default

    documents = params.get(DOCUMENTS_KEY)
    fallback = params.get(FALLBACK_KEY)
    timeout = params.get(TIMEOUT_KEY)
    drawer = params.get(DRAWER_KEY)
    return Settings(
        enabled=flag(ENABLED_KEY, True),
        documents=documents if documents in DOCUMENTS_OPTIONS else DOCUMENTS_BILL,
        fallback=fallback if fallback in FALLBACK_OPTIONS else FALLBACK_ASK,
        timeout=(
            timeout if isinstance(timeout, int) and not isinstance(timeout, bool) and TIMEOUT_MIN <= timeout <= TIMEOUT_MAX
            else TIMEOUT_DEFAULT
        ),
        notice=flag(NOTICE_KEY, True),
        hosts=tuple(parse_hosts(params.get(HOSTS_KEY))),
        from_dashboard=flag(FROM_DASHBOARD_KEY, True),
        drawer=drawer if drawer in DRAWER_OPTIONS else DRAWER_NEVER,
    )


def settings_for(db: Session, machine: POSMachine) -> Settings:
    from app.services.till_parameters import till_parameters_for_machine

    return settings_of(till_parameters_for_machine(db, machine).parameters)


# ── The document ─────────────────────────────────────────────────────────────

#: The image's ceiling, as sent (compressed): a long 80 mm bill in one colour is far below it.
IMAGE_MAX_BYTES = 512 * 1024
_B64_MAX_CHARS = 4 * math.ceil(IMAGE_MAX_BYTES / 3)
_PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
_GZIP_MAGIC = b"\x1f\x8b"
_CHUNK = 64 * 1024

TOO_LARGE = "document_too_large"
BAD_IMAGE = "document_image_invalid"


def _too_large() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
        detail={"code": TOO_LARGE, "maxBytes": IMAGE_MAX_BYTES, "message": "המסמך גדול מדי (עד 512KB דחוס)"},
    )


def _bad(message: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail={"code": BAD_IMAGE, "message": message},
    )


def _raster_size(gz: bytes, expected: int) -> int:
    """The inflated size of a `raster_gzip` image, never inflating past `expected` + 1 (a bomb stops there)."""
    d = zlib.decompressobj(16 + zlib.MAX_WBITS)
    total = 0
    data = gz
    while True:
        try:
            chunk = d.decompress(data, _CHUNK)
        except zlib.error:
            raise _bad("the raster is not gzip")
        total += len(chunk)
        if total > expected:
            return total
        data = d.unconsumed_tail
        if d.eof:
            return total
        if not data and not chunk:
            raise _bad("the raster is cut short")


def check_image(document: Any) -> int:
    """
    The image's bytes as sent (compressed), after the checks: 413 past `IMAGE_MAX_BYTES`; 422 not base64,
    not the `encoding` it says, or not the size it says (a PNG's header, a raster's inflated length).
    """
    text = document.image or ""
    if any(c in text for c in " \t\r\n"):
        text = "".join(text.split())
    if len(text) > _B64_MAX_CHARS:
        raise _too_large()
    try:
        raw = base64.b64decode(text, validate=True)
    except (binascii.Error, ValueError):
        raise _bad("the image is not base64")
    if len(raw) > IMAGE_MAX_BYTES:
        raise _too_large()
    if not raw:
        raise _bad("the image is empty")
    width, height = document.width_dots, document.height_dots
    if document.encoding == "png":
        if not raw.startswith(_PNG_MAGIC) or len(raw) < 24 or raw[12:16] != b"IHDR":
            raise _bad("the image is not a PNG")
        w, h = struct.unpack(">II", raw[16:24])
        if (w, h) != (width, height):
            raise _bad(f"the PNG is {w}x{h}, not {width}x{height}")
    else:
        if not raw.startswith(_GZIP_MAGIC):
            raise _bad("the raster is not gzip")
        expected = math.ceil(width / 8) * height
        if _raster_size(raw, expected) != expected:
            raise _bad(f"the raster is not {width}x{height} dots")
    return len(raw)


def payload_of(document: Any, machine: POSMachine, size: int) -> Dict[str, Any]:
    """What the job keeps, and the host gets: the reference, the image, and who sent it."""
    from app.services.exception_alerts.watch import till_label

    return {
        "category": document.category,
        "type": document.doc_type,
        "number": document.number,
        "copy": bool(document.is_copy),
        "title": document.title,
        "paperWidth": document.paper_width,
        "widthDots": document.width_dots,
        "heightDots": document.height_dots,
        "encoding": document.encoding,
        "image": "".join((document.image or "").split()),
        "bytes": size,
        "sourceMachineId": str(machine.id),
        "sourceName": till_label(machine),
    }


def reference_of(payload: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """The document's reference, never its image (the sender's status, the dashboard)."""
    p = payload if isinstance(payload, dict) else {}
    return {
        "category": p.get("category"),
        "type": p.get("type"),
        "number": p.get("number"),
        "copy": bool(p.get("copy")),
        "title": p.get("title"),
        "paperWidth": p.get("paperWidth"),
        "sourceName": p.get("sourceName"),
    }


def drop_image(job: Any) -> None:
    """The job is over: its image goes (a new dict, so the JSON column is written)."""
    payload = job.payload if isinstance(job.payload, dict) else None
    if payload is None or "image" not in payload:
        return
    kept = {k: v for k, v in payload.items() if k != "image"}
    kept["imageDropped"] = True
    job.payload = kept


# ── The job's host ───────────────────────────────────────────────────────────

#: A document its host took and never answered for (a print in progress, an ack lost) is given up
#: after this: the sender may have printed it itself meanwhile.
TAKEN_TTL = timedelta(minutes=10)
#: The most image bytes one pending pull hands out (at least one document always goes).
PENDING_BYTES = 2 * 1024 * 1024


def _refused(code: str, status_code: int = status.HTTP_409_CONFLICT, **extra: Any) -> HTTPException:
    return HTTPException(status_code=status_code, detail={"code": code, **extra})


def is_document_printer(printer: Any) -> bool:
    """A receipt printer of type cloud: "המדפסת של <קופה>"."""
    return (getattr(printer, "purpose", None) or "kitchen") == "receipt" and printer.connection_type == "cloud"


def resolve_target(db: Session, machine: POSMachine, body: Any) -> Tuple[Optional[Any], POSMachine]:
    """
    `(printer, host)` of a document job from `machine`, or the refusal: a receipt printer of type cloud of
    its shop (404 unknown; 409 `printer_inactive`, `printer_not_document` for any other printer), or a till
    of its shop named by itself (`targetMachineId`; 404 `host_not_found`, 422 `host_is_sender`).
    """
    from app.models.printers import KitchenPrinter

    printer = None
    host: Optional[POSMachine] = None
    if body.printer_id is not None:
        printer = db.query(KitchenPrinter).filter(KitchenPrinter.id == body.printer_id).first()
        if printer is None or str(printer.shop_id) != str(machine.shop_id):
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Printer not found")
        if not is_document_printer(printer):
            raise _refused("printer_not_document")
        if not printer.is_active:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="printer_inactive")
        if printer.host_machine_id is None:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="printer_has_no_host")
        if body.target_machine_id is not None and str(body.target_machine_id) != str(printer.host_machine_id):
            raise _refused("target_not_printer_host", status.HTTP_422_UNPROCESSABLE_ENTITY)
        host = db.get(POSMachine, printer.host_machine_id)
    else:
        host = db.get(POSMachine, body.target_machine_id)
    if host is None or not host.is_active or str(host.shop_id) != str(machine.shop_id):
        raise _refused("host_not_found", status.HTTP_404_NOT_FOUND)
    if str(host.id) == str(machine.id):
        raise _refused("host_is_sender", status.HTTP_422_UNPROCESSABLE_ENTITY)
    return printer, host


def check_send(db: Session, machine: POSMachine, host: POSMachine, category: str) -> Settings:
    """The sender's parameters and the host's build allow it (the module's doc), else 409 with the code."""
    from app.services.exception_alerts.watch import till_label

    settings = settings_for(db, machine)
    if not settings.enabled:
        raise _refused("remote_print_off")
    if not settings.allows(category):
        raise _refused("document_not_remote", documents=settings.documents)
    if not settings.may_reach(host.id):
        raise _refused("host_not_allowed", host=till_label(host))
    if not relays_documents(host):
        raise _refused("host_needs_update", host=till_label(host))
    return settings


# ── The drawer on another till (§9ב–§9ג) ─────────────────────────────────────
#
# "פתיחת מגירה ב<קופה>": a `drawer` job, the relay's way (LAN first, else the cloud). `payment` — with a
# cash payment whose document went there (`remotePrintDrawer` ask / auto); `manual` — the menu's opening
# from a device with no drawer (CASH_DRAWER.OPEN_REMOTE, and the manual opening's rules). The host opens
# only when its printer has the drawer and it is not in a payment of its own (else `failed`). Kept with
# the job; on the host's answer the opening goes on the sending till's drawer log (`record_drawer_event`,
# REMOTE_SALE / REMOTE_MANUAL — one without a sale is "מגירה נפתחה ללא מכירה", as today).

#: A drawer job its host took and did not answer for is over soon: an opening minutes late is worse than none.
DRAWER_TAKEN_TTL = timedelta(minutes=2)
EVENT_REMOTE_SALE = "REMOTE_SALE"
EVENT_REMOTE_MANUAL = "REMOTE_MANUAL"
#: The till permission (app/services/till_permissions.py).
OPEN_REMOTE = "CASH_DRAWER.OPEN_REMOTE"


def _receipt_printers(db: Session, shop_id: Any) -> List[Any]:
    from app.models.printers import KitchenPrinter

    if shop_id is None:
        return []
    return (
        db.query(KitchenPrinter)
        .filter(KitchenPrinter.shop_id == shop_id, KitchenPrinter.purpose == "receipt", KitchenPrinter.is_active.is_(True))
        .order_by(KitchenPrinter.sort_order, KitchenPrinter.name)
        .all()
    )


def drawer_of(db: Session, machine: POSMachine, printers: Sequence[Any]) -> Tuple[bool, Optional[Any]]:
    """
    Whether `machine` opens a drawer, and its receipt printer of type cloud with the drawer (if any): one it
    hosts with `cash_drawer`, a receipt printer of its own (narrowed to it) with the drawer, or its own
    `cashDrawer` parameter on (its head's port, a printer of the parameter).
    """
    hosted = next(
        (p for p in printers if is_document_printer(p) and p.cash_drawer and str(p.host_machine_id) == str(machine.id)),
        None,
    )
    if hosted is not None:
        return True, hosted
    if any(
        p.cash_drawer and p.connection_type != "cloud" and p.machine_id is not None and str(p.machine_id) == str(machine.id)
        for p in printers
    ):
        return True, None
    from app.services.till_parameters import CASH_DRAWER_KEY, CASH_DRAWER_OFF, till_parameters_for_machine

    value = till_parameters_for_machine(db, machine).parameters.get(CASH_DRAWER_KEY)
    return (value is not None and value != CASH_DRAWER_OFF), None


def drawer_hosts(db: Session, machine: POSMachine) -> List[Dict[str, Any]]:
    """
    "פתיחת מגירה ב<קופה>" (§9ג): the tills `machine` may open a drawer on — of its shop, a build that relays
    (`document_relay_v1`), with a drawer (`drawer_of`), within its `remotePrintHosts`. None for a till whose
    own build does not relay, or with `remotePrintEnabled` off.
    """
    from app.services import printers as K
    from app.services.exception_alerts.watch import till_label

    if machine.shop_id is None or not relays_documents(machine):
        return []
    settings = settings_for(db, machine)
    if not settings.enabled:
        return []
    printers = _receipt_printers(db, machine.shop_id)
    out: List[Dict[str, Any]] = []
    for m in K.shop_machines(db, machine.shop_id):
        if str(m.id) == str(machine.id) or not relays_documents(m) or not settings.may_reach(m.id):
            continue
        has, printer = drawer_of(db, m, printers)
        if not has:
            continue
        lan = lan_of(db, m, machine)
        out.append({
            "machineId": str(m.id),
            "name": K.machine_label(m),
            "label": till_label(m),
            #: Its receipt printer of type cloud with the drawer — the job names it; null: the till's own.
            "printerId": str(printer.id) if printer is not None else None,
            "lanAddress": lan["address"] if lan else None,
            "lanPort": lan["port"] if lan else None,
        })
    return out


def check_drawer(db: Session, machine: POSMachine, host: POSMachine, printer: Optional[Any], drawer: Any) -> Settings:
    """
    The sender's parameters, the host's build and its drawer allow it, else 409: `remote_print_off`,
    `drawer_remote_off` (a payment's while `remotePrintDrawer` is never), `host_not_allowed`,
    `host_needs_update`, `printer_has_no_drawer` / `host_has_no_drawer`.
    """
    from app.services.exception_alerts.watch import till_label

    settings = settings_for(db, machine)
    if not settings.enabled:
        raise _refused("remote_print_off")
    if drawer.reason == "payment" and settings.drawer == DRAWER_NEVER:
        raise _refused("drawer_remote_off")
    if not settings.may_reach(host.id):
        raise _refused("host_not_allowed", host=till_label(host))
    if not relays_documents(host):
        raise _refused("host_needs_update", host=till_label(host))
    if printer is not None:
        if not printer.cash_drawer:
            raise _refused("printer_has_no_drawer")
    elif not drawer_of(db, host, _receipt_printers(db, host.shop_id))[0]:
        raise _refused("host_has_no_drawer", host=till_label(host))
    return settings


def _person(value: Any) -> Optional[Dict[str, Any]]:
    if value is None:
        return None
    out = {"id": value.id, "name": value.name, "method": value.method}
    return out if any(v is not None for v in out.values()) else None


def drawer_payload_of(drawer: Any, machine: POSMachine) -> Dict[str, Any]:
    """What a drawer job keeps, and the host gets: why, who asked, who approved, from which till."""
    from app.services.exception_alerts.watch import till_label

    return {
        "reason": drawer.reason,
        "documentType": drawer.document_type,
        "documentNumber": drawer.document_number,
        "amount": drawer.amount,
        "reasonCode": drawer.reason_code,
        "reasonNote": drawer.reason_note,
        "requestedBy": _person(drawer.requested_by),
        "approvedBy": _person(drawer.approved_by),
        "approvalRequestId": str(drawer.approval_request_id) if drawer.approval_request_id else None,
        "shiftId": str(drawer.shift_id) if drawer.shift_id else None,
        "sourceMachineId": str(machine.id),
        "sourceName": till_label(machine),
    }


def drawer_reference_of(payload: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    p = payload if isinstance(payload, dict) else {}
    return {
        "reason": p.get("reason"),
        "documentNumber": p.get("documentNumber"),
        "requestedBy": (p.get("requestedBy") or {}).get("name"),
        "approvedBy": (p.get("approvedBy") or {}).get("name"),
        "sourceName": p.get("sourceName"),
    }


def _uuid_or_none(value: Any) -> Optional[uuid.UUID]:
    try:
        return uuid.UUID(str(value)) if value else None
    except ValueError:
        return None


def record_drawer_event(db: Session, job: Any, now: datetime) -> Tuple[Optional[Any], bool]:
    """
    The host answered a drawer job (done / failed): the opening on the sending till's drawer log — "מגירה
    נפתחה מרחוק", who asked and who approved — under the job's id, so the sender's own upload of it is the
    same row. `(event, created)`; the caller runs the drawer's exception detection once it is committed.
    """
    from types import SimpleNamespace

    from app.models.cash_drawer import CashDrawerEvent
    from app.services import cash_drawer
    from app.services.exception_alerts.watch import till_label

    if job.kind != "drawer" or job.status not in ("done", "failed") or job.source_machine_id is None:
        return None, False
    sender = db.get(POSMachine, job.source_machine_id)
    if sender is None or sender.shop_id is None:
        return None, False
    existing = db.get(CashDrawerEvent, job.id)
    if existing is not None:
        return existing, False
    p = job.payload if isinstance(job.payload, dict) else {}
    by = p.get("requestedBy") or {}
    approver = p.get("approvedBy") or {}
    host = db.get(POSMachine, job.target_machine_id) if job.target_machine_id is not None else None
    body = SimpleNamespace(
        id=job.id, category="drawer",
        event_type=EVENT_REMOTE_SALE if p.get("reason") == "payment" else EVENT_REMOTE_MANUAL,
        permission=OPEN_REMOTE, decision="approval" if (approver.get("id") or approver.get("name")) else "allow",
        result="approved" if job.status == "done" else "failed",
        result_reason=job.error if job.status == "failed" else None,
        drawer_id=str(job.printer_id or job.target_machine_id), drawer_name=job.printer_name,
        device_id=None, shift_id=_uuid_or_none(p.get("shiftId")),
        employee_id=by.get("id"), employee_name=by.get("name"), employee_role=None,
        approver_id=approver.get("id"), approver_name=approver.get("name"), approver_method=approver.get("method"),
        table_id=None, sale_id=None, payment_id=None, original_sale_id=None,
        reason=p.get("reasonCode"), reason_note=p.get("reasonNote"), movement_id=None, cash_movement_type=None,
        amount=p.get("amount"), expected_balance=None, offline=False, training=False,
        details={
            "remote": True, "jobId": str(job.id),
            "hostMachineId": str(job.target_machine_id) if job.target_machine_id else None,
            "hostName": till_label(host), "documentType": p.get("documentType"),
            "documentNumber": p.get("documentNumber"), "approvalRequestId": p.get("approvalRequestId"),
        },
        occurred_at=job.completed_at or now,
    )
    return cash_drawer.record_event(db, sender, body)


# ── "לא הודפס" on "בעיות" (§6) ────────────────────────────────────────────────

EXCEPTION_TYPE = "document_unprinted"
EXCEPTION_LABEL = "חשבון לא הודפס בקופה אחרת"
EXCEPTION_SEVERITY = "medium"
_WHAT_LABEL = {"bill": "חשבון", "receipt": "קבלה", "other": "מסמך"}


def summary_of(payload: Optional[Dict[str, Any]], host: Optional[POSMachine]) -> str:
    """"חשבון 1043 לא הודפס בקופה 3" — what, which, where."""
    from app.services.exception_alerts.watch import till_label

    p = payload if isinstance(payload, dict) else {}
    what = _WHAT_LABEL.get(p.get("category"), "מסמך")
    number = f" {p['number']}" if p.get("number") else ""
    return f"{what}{number} לא הודפס ב{till_label(host) or 'קופה אחרת'}"


def _rows_of(db: Session, job: Any):
    from app.models.audit_exception import AuditException

    return (
        db.query(AuditException)
        .filter(AuditException.exception_type == EXCEPTION_TYPE, AuditException.dedupe_key == f"{EXCEPTION_TYPE}:{job.id}")
        .all()
    )


def record_unprinted(db: Session, job: Any, now: datetime) -> bool:
    """
    The document failed or expired at its host: "<חשבון> לא הודפס בקופה X" — once per job, unless the
    host's rules switch it off ("הגדרות חריגות"). True when written.
    """
    from app.services.exceptions import record_z_exception

    if job.kind != "document" or job.target_machine_id is None:
        return False
    host = db.get(POSMachine, job.target_machine_id)
    if host is None:
        return False
    source = db.get(POSMachine, job.source_machine_id) if job.source_machine_id is not None else None
    payload = job.payload if isinstance(job.payload, dict) else {}
    from app.services.exception_alerts.watch import till_label

    try:
        with db.begin_nested():
            return record_z_exception(
                db, host, exception_type=EXCEPTION_TYPE, key=f"{EXCEPTION_TYPE}:{job.id}", occurred_at=now,
                details={
                    "summary": summary_of(payload, host)
                    + (f" (נשלח מ{till_label(source)})" if source is not None else ""),
                    "jobId": str(job.id),
                    "status": job.status,
                    "error": job.error,
                    "host": till_label(host),
                    "source": till_label(source),
                    "sourceMachineId": str(source.id) if source is not None else None,
                    "printerName": job.printer_name,
                    "document": reference_of(payload),
                    "resolvedAt": None,
                },
            )
    except Exception:  # noqa: BLE001 - "בעיות" never fails the relay
        logger.exception("remote print: unprinted document %s not recorded", job.id)
        return False


def resolve_unprinted(db: Session, job: Any, now: datetime) -> int:
    """It printed after all (a late ack): its "לא הודפס" is over by itself."""
    from app.services.exception_alerts.status_watch import resolve

    closed = 0
    for row in _rows_of(db, job):
        if not (row.details or {}).get("resolvedAt"):
            resolve(row, now, "הודפס בסוף")
            closed += 1
    return closed


# ── §7: "הדפס חשבון" from the dashboard on another till ──────────────────────


def _paper_of(db: Session, machine: POSMachine, printers: Sequence[Any]) -> Optional[int]:
    """The host's paper: its own receipt printer of type cloud's, else its head's."""
    from app.models.pos_machine import device_paper_width_mm

    for p in printers:
        if str(p.host_machine_id) == str(machine.id) and p.paper_width in (58, 80):
            return p.paper_width
    return device_paper_width_mm(getattr(machine, "device_model", None))


def dashboard_targets(db: Session, shop: Any, owner: Optional[POSMachine]) -> Dict[str, Any]:
    """
    The tills the bill may print on besides `owner` (the till that holds the table, which renders it and
    relays it): those of the shop with a printer — their own head, or the host of a receipt printer of
    type cloud — within the owner's `remotePrintHosts`. One whose build does not relay documents is
    listed, not offered (`needs_update`). `available` false (with `why`) when the owner may not:
    `remotePrintEnabled` / `remotePrintFromDashboard` off (`off`), its own build (`owner_needs_update`),
    no owner (`no_owner`).
    """
    from app.models.printers import KitchenPrinter
    from app.services import printers as K
    from app.services.exception_alerts.watch import till_label

    out: Dict[str, Any] = {
        "ownerMachineId": str(owner.id) if owner is not None else None,
        "ownerName": K.machine_label(owner),
        "available": False,
        "why": None,
        "targets": [],
    }
    if owner is None:
        out["why"] = "no_owner"
        return out
    settings = settings_for(db, owner)
    if not (settings.enabled and settings.from_dashboard):
        out["why"] = "off"
        return out
    if not relays_documents(owner):
        out["why"] = "owner_needs_update"
        return out
    printers = [
        p for p in db.query(KitchenPrinter).filter(KitchenPrinter.shop_id == shop.id, KitchenPrinter.is_active.is_(True)).all()
        if is_document_printer(p)
    ]
    hosting = {str(p.host_machine_id) for p in printers if p.host_machine_id is not None}
    targets: List[Dict[str, Any]] = []
    for m in K.shop_machines(db, shop.id):
        if str(m.id) == str(owner.id) or not (m.has_printer or str(m.id) in hosting):
            continue
        if not settings.may_reach(m.id):
            continue
        ready = relays_documents(m)
        targets.append({
            "machineId": str(m.id),
            "tillName": K.machine_label(m),
            "label": till_label(m),
            "paperWidth": _paper_of(db, m, printers),
            "available": ready,
            "why": None if ready else "needs_update",
        })
    out["available"] = True
    out["targets"] = targets
    return out


def lan_of(db: Session, machine: POSMachine, owner: Optional[POSMachine] = None) -> Optional[Dict[str, Any]]:
    """Where `machine` takes jobs on the shop's LAN (its own report), for the owner to try first; None: the cloud."""
    from app.models.printers import DEFAULT_LAN_PORT, KitchenPrintHost
    from app.services.local_shop_z import is_remote_participant

    if is_remote_participant(machine) or (owner is not None and is_remote_participant(owner)):
        return None
    row = db.query(KitchenPrintHost).filter(KitchenPrintHost.machine_id == machine.id).first()
    if row is None or not row.lan_address:
        return None
    return {"address": row.lan_address, "port": row.port or DEFAULT_LAN_PORT}
