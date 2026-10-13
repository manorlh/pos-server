"""
"בניית חברת הדגמה" — one click builds a whole, LIVE demo company (P:/specs/demo-company.md,
approved by the owner 13.10.2026: "כל השאר").

**Live, not a demo:** the shops are opened out of training mode — real numbering, a real Z and
real card clearing once the owner sets his terminal. Nothing here touches a card terminal: the
payment methods are left for the owner to fill.

**What one click builds** (the super admin's only — 403 for anybody else):

* the company "R2M הדגמה" (`routers.companies.create_company`) with the business details the
  dialog gave (ח.פ / עוסק, address, city — and the phone for the receipt, `businessInfo.phone` on
  its settings layer); a stand-in logo "R2M Demo" uploaded through the branding upload and set as
  `brandLogoUrl` / `brandReceiptLogoUrl`, so it reaches the receipt, the kiosk and the customer
  display as an uploaded logo does;
* two shops through `routers.shops.create_shop` (branch code, shop number, default POS user,
  licenses, `training_mode` off), each with its "תצורת עבודה" (`routers.work_profile`):
  "מזנון" — "דוכן / קופה מהירה" with the customer display; "מסעדה" — "מסעדה עם שולחנות" with the
  kitchen to printers and a KDS, attendance and tips;
* the restaurant's points of sale (`routers.areas`) אולם / מרפסת / בר / טייק אווי, a floor map
  for each with its tables (`routers.tables`: 12, 8 and 10 bar seats), a menu of their own where it
  makes sense (`routers.catalog_menus`: the bar — drinks only; take away — no alcohol);
* the demo menus (`routers.training_mode.load_demo_menu`): "מסעדה ובר" for the restaurant, the
  new "מזנון" template for the snack bar;
* the kitchen: printers and their routing (`routers.printers`, a zone redirect for the terrace,
  `routers.printer_zones`), a kitchen station for the KDS;
* employees (`routers.pos_users`: a manager, a cashier — and a waiter in the restaurant) with their
  till roles; their codes are the server's configured ones (`DEMO_COMPANY_POS_CODES`) or random —
  never in the code, a response, a log or the summary (which only says whose code is to be set);
* the kiosk's look (`routers.kiosks.put_settings`: style, logo, category pictures, the attract
  screen), the customer display's ad (`routers.customer_display.put_layer`), a till design of its
  own for each shop (`routers.till_design.put_settings`), the restaurant's published digital menu
  (`services.presentation_profiles`, as its routes do — the public menu its QR points at);
* three production voucher batches (`services.prepaid_batch_create`): "ארוחת צהריים" (one of each
  group), "כרטיסיית קפה 10" (a punch card) and "הנחת 20 ₪"; the customer club with its sign-up
  benefit (`routers.club`);
* a pairing code for every planned device (`routers.pairing.generate_pairing_code`) — the snack
  bar's till, kiosk, customer display and voucher station; the restaurant's main till (the local
  server), a second till, the waiter's handheld and the KDS.

**Once more, safely.** Everything it made is a row of `demo_company_items` under a stable key. A
second click completes only what has no row: what it made is never made again, and what the owner
changed — or deleted — since is left as he left it. A step that fails is reported and tried again
on the next click; the rest goes on. The devices' codes live 15 minutes: a click gives a new code
to every device not paired yet, and completes what waits for a paired device (the voucher
station's mode, the display's till).

**Never by a side door:** every row is written by the dashboard's own router functions or the
services they call, with their permissions and rules — the build is the super admin clicking
through the dashboard, faster.
"""
from __future__ import annotations

import asyncio
import concurrent.futures
import io
import logging
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Dict, List, Optional, Tuple

from fastapi import BackgroundTasks, HTTPException, status
from fastapi.responses import JSONResponse
from sqlalchemy import or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.company import Company
from app.models.demo_company import DemoCompanyItem
from app.models.shop import Shop
from app.models.user import User, UserRole

logger = logging.getLogger(__name__)

COMPANY_NAME = "R2M הדגמה"
SNACK, RESTAURANT = "snack", "restaurant"

LOCK_KEY = "build_lock"
LOCK_FOR = timedelta(minutes=10)

#: The 409 when a build of the organization is already running.
BUILD_IN_PROGRESS = "demo_company_build_in_progress"

#: The shops, in the order they are built.
SHOPS: Dict[str, Dict[str, Any]] = {
    SNACK: {"name": "מזנון", "branch": "1", "template": "snack_bar", "design": "fast"},
    RESTAURANT: {"name": "מסעדה", "branch": "2", "template": "restaurant_bar", "design": "seated"},
}

#: The restaurant's points of sale: (key, name, tables, numbers from).
AREAS: Tuple[Tuple[str, str, int, int], ...] = (
    ("hall", "אולם", 12, 1),
    ("terrace", "מרפסת", 8, 21),
    ("bar", "בר", 10, 41),
    ("takeaway", "טייק אווי", 0, 0),
)

#: Kitchen categories of each template (the rest are drinks).
DRINK_CATEGORIES = {
    "שתייה קלה", "שתייה חמה", "בירות", "קוקטיילים", "אלכוהול", "יין", "שתייה קלה וקפה",
}
ALCOHOL_CATEGORIES = {"בירות", "קוקטיילים", "אלכוהול", "יין"}

#: The employees: (key, username, first name, worker number, till role, legacy role).
EMPLOYEES: Dict[str, Tuple[Tuple[str, str, str, str, str, str], ...]] = {
    SNACK: (
        ("manager", "manager", "מנהל", "101", "manager", "shop_manager"),
        ("cashier", "cashier", "קופאי", "102", "cashier", "cashier"),
    ),
    RESTAURANT: (
        ("manager", "manager", "מנהל", "201", "manager", "shop_manager"),
        ("cashier", "cashier", "קופאי", "202", "cashier", "cashier"),
        ("waiter", "waiter", "מלצר", "203", "waiter", "cashier"),
    ),
}
EMPLOYEE_KEYS = ("manager", "cashier", "waiter")


def employee_codes() -> Tuple[Dict[str, str], Dict[str, bool]]:
    """
    The employees' till codes and whether each is the server's configured one
    (`DEMO_COMPANY_POS_CODES`, "manager=…,cashier=…,waiter=…") — else a random one nobody sees,
    to be set on "משתמשי קופה". Never in the code, a response, a log or the summary.
    """
    import secrets

    from app.config import get_settings
    from app.services.pos_user_defaults import DEFAULT_POS_USER_PIN

    raw = str(getattr(get_settings(), "demo_company_pos_codes", "") or "")
    configured: Dict[str, str] = {}
    for part in raw.replace(";", ",").split(","):
        key, _sep, value = part.replace(":", "=").partition("=")
        key, value = key.strip().lower(), value.strip()
        if key in EMPLOYEE_KEYS and value.isdigit() and 4 <= len(value) <= 6:
            configured[key] = value
    codes = dict(configured)
    used = set(codes.values()) | {DEFAULT_POS_USER_PIN}
    for key in EMPLOYEE_KEYS:
        while key not in codes:
            code = f"{secrets.randbelow(9000) + 1000}"
            if code not in used and len(set(code)) > 1:
                codes[key] = code
                used.add(code)
    return codes, {key: key in configured for key in EMPLOYEE_KEYS}

#: The devices to pair: (key, label, role, platform).
DEVICES: Dict[str, Tuple[Tuple[str, str, str], ...]] = {
    SNACK: (
        ("till", "קופה", "till"),
        ("kiosk", "קיוסק", "kiosk"),
        ("display", "מסך לקוח", "customer_display"),
        ("voucher_station", "עמדת שובר", "till"),
    ),
    RESTAURANT: (
        ("main_till", "קופה ראשית (שרת מקומי)", "till"),
        ("till2", "קופה 2", "till"),
        ("handheld", "מסופון מלצר", "till"),
        ("kds", "מסך מטבח (KDS)", "kds"),
    ),
}
ROLE_LABELS = {
    "till": "קופה", "kiosk": "קיוסק", "customer_display": "מסך לקוח", "kds": "מסך מטבח",
}

KITCHEN_STATION = "מטבח"

#: What to try in each shop (the summary page).
CHECKLISTS: Dict[str, List[str]] = {
    SNACK: [
        "צמדו את הקופה, הקיוסק, מסך הלקוח ועמדת השובר בקודים שבדף הזה.",
        "אחרי הצימוד לחצו שוב \"בניית חברת הדגמה\": עמדת השובר תוגדר כעמדת שובר, ומסך הלקוח יוצמד לקופה.",
        "מכירה מהירה בקופה: קומבו פלאפל, סלטים ורטבים בחינם ותוספות בתשלום (ביצה, גבינה).",
        "הזמנה בקיוסק עם תשלום באשראי. הבון יוצא במדפסת המטבח.",
        "מסך הלקוח מציג את העגלה בזמן המכירה, ואת הפרסומת כשהקופה פנויה.",
        "בעמדת השובר: \"ארוחת צהריים\" (פריט אחד מכל קבוצה) ו\"כרטיסיית קפה 10\".",
        "סוף היום: Z סניפי מהענן.",
    ],
    RESTAURANT: [
        "צמדו קודם את הקופה הראשית, שהיא השרת המקומי. אחריה את קופה 2, המסופון ומסך המטבח.",
        "פתחו שולחן באולם, במרפסת ובבר. לכל אזור יש מפה משלו.",
        "שלחו הזמנה: האוכל יוצא למטבח (מהמרפסת למדפסת המרפסת), השתייה לבר, וההזמנה מופיעה במסך המטבח.",
        "בבר נמכרים רק משקאות וקוקטיילים. בטייק אווי אין אלכוהול.",
        "נוכחות: עובד נכנס למשמרת. טיפ: בתשלום באשראי.",
        "תפריט דיגיטלי: הפרופיל \"תפריט דיגיטלי — מסעדה\" מפורסם. ראו אותו בדף \"תפריט דיגיטלי\".",
        "השובר \"הנחת 20 ₪\" עובד בשני הסניפים.",
        "סוף היום: Z סניפי בקופה הראשית.",
    ],
}


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(moment: Optional[datetime]) -> Optional[str]:
    if moment is None:
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment.isoformat()


def _uuid(value: Any) -> Optional[uuid.UUID]:
    if value is None or isinstance(value, uuid.UUID):
        return value
    try:
        return uuid.UUID(str(value))
    except (TypeError, ValueError):
        return None


def _id_of(answer: Any) -> Optional[uuid.UUID]:
    """The id in a router's answer — a row, a response model or a dict."""
    value = answer.get("id") if isinstance(answer, dict) else getattr(answer, "id", None)
    return _uuid(value)


# ── Who ───────────────────────────────────────────────────────────────────────


def check_super_admin(user: User) -> None:
    if getattr(user, "role", None) != UserRole.SUPER_ADMIN:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"code": "demo_company_super_admin_only", "message": "רק מנהל-על בונה חברת הדגמה."},
        )


# ── The business details from the dialog ─────────────────────────────────────


@dataclass
class Details:
    """What the dialog asked: all optional — the owner fills or edits them later."""

    vat_number: Optional[str] = None
    dealer_type: Optional[str] = None
    address: Optional[str] = None
    city: Optional[str] = None
    phone: Optional[str] = None

    @classmethod
    def of(cls, raw: Any) -> "Details":
        def clean(name: str, limit: int) -> Optional[str]:
            value = getattr(raw, name, None) if raw is not None else None
            text = " ".join(str(value or "").split())[:limit]
            return text or None

        dealer = clean("dealer_type", 16)
        return cls(
            vat_number=clean("vat_number", 20),
            dealer_type=dealer if dealer in ("company", "licensed", "exempt") else None,
            address=clean("address", 500),
            city=clean("city", 100),
            phone=clean("phone", 30),
        )


# ── Calling the dashboard's own functions ─────────────────────────────────────


class StepRefused(Exception):
    """A router answered with a refusal (a `JSONResponse`, or a body of its own)."""

    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


def _answer(result: Any) -> Any:
    """A router's return value; its `JSONResponse` refusal raised as one."""
    if isinstance(result, JSONResponse):
        import json

        try:
            body = json.loads(bytes(result.body).decode("utf-8"))
        except Exception:  # noqa: BLE001
            body = {}
        detail = body.get("detail") if isinstance(body, dict) else None
        message = (body.get("message") if isinstance(body, dict) else None) or (
            detail.get("message") if isinstance(detail, dict) else detail
        )
        raise StepRefused(str(message or f"refused ({result.status_code})"))
    return result


def reason_of(exc: BaseException) -> str:
    """A step's failure in words the summary can show (never a trace)."""
    if isinstance(exc, StepRefused):
        return exc.message
    if isinstance(exc, HTTPException):
        detail = exc.detail
        if isinstance(detail, dict):
            return str(detail.get("message") or detail.get("code") or detail)[:300]
        return str(detail)[:300]
    body = getattr(exc, "body", None)
    if isinstance(body, dict):
        message = body.get("message") or body.get("detail") or body.get("code")
        if message:
            return str(message)[:300]
    message = getattr(exc, "message", None)
    if isinstance(message, str) and message:
        return message[:300]
    return exc.__class__.__name__


def _await(coro):
    """An async route (an upload) from this synchronous build: on its own loop."""
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(coro)
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:  # pragma: no cover - not on a loop
        return pool.submit(asyncio.run, coro).result()


def _upload_file(data: bytes, filename: str):
    from starlette.datastructures import Headers, UploadFile

    return UploadFile(file=io.BytesIO(data), filename=filename, headers=Headers({"content-type": "image/png"}))


# ── The tracking rows ─────────────────────────────────────────────────────────


def _rows(db: Session, tenant_id: Any) -> Dict[str, DemoCompanyItem]:
    return {
        r.item_key: r
        for r in db.query(DemoCompanyItem).filter(DemoCompanyItem.tenant_id == _uuid(tenant_id)).all()
    }


def _company_row(db: Session, tenant_id: Any) -> Optional[DemoCompanyItem]:
    return (
        db.query(DemoCompanyItem)
        .filter(DemoCompanyItem.tenant_id == _uuid(tenant_id), DemoCompanyItem.item_key == "company")
        .first()
    )


def _acquire(db: Session, tenant_id: Any, user: User) -> None:
    """The organization's build lock (409 while another build runs). Commits."""
    now = _now()
    tid = _uuid(tenant_id)
    if db.query(DemoCompanyItem.id).filter(
        DemoCompanyItem.tenant_id == tid, DemoCompanyItem.item_key == LOCK_KEY
    ).first() is None:
        try:
            with db.begin_nested():
                db.add(DemoCompanyItem(
                    id=uuid.uuid4(), tenant_id=tid, company_id=None, item_key=LOCK_KEY, entity_type="lock",
                    created_by=getattr(user, "id", None), created_at=now, updated_at=now,
                ))
                db.flush()
        except IntegrityError:
            pass  # another build made it first; the update below decides
    taken = (
        db.query(DemoCompanyItem)
        .filter(
            DemoCompanyItem.tenant_id == tid,
            DemoCompanyItem.item_key == LOCK_KEY,
            or_(DemoCompanyItem.locked_until.is_(None), DemoCompanyItem.locked_until < now),
        )
        .update({"locked_until": now + LOCK_FOR, "updated_at": now}, synchronize_session=False)
    )
    db.commit()
    if not taken:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": BUILD_IN_PROGRESS, "message": "בניית חברת ההדגמה כבר רצה. המתינו לסיומה ונסו שוב."},
        )


def _release(db: Session, tenant_id: Any) -> None:
    try:
        db.rollback()
        db.query(DemoCompanyItem).filter(
            DemoCompanyItem.tenant_id == _uuid(tenant_id), DemoCompanyItem.item_key == LOCK_KEY
        ).update({"locked_until": None, "updated_at": _now()}, synchronize_session=False)
        db.commit()
    except Exception:  # noqa: BLE001 - the lock times out by itself
        db.rollback()
        logger.exception("demo company: could not release the build lock")


# ── The build ─────────────────────────────────────────────────────────────────


@dataclass
class Outcome:
    created: List[Dict[str, str]] = field(default_factory=list)
    failed: List[Dict[str, str]] = field(default_factory=list)
    notes: List[str] = field(default_factory=list)


class _Builder:
    def __init__(self, db: Session, user: User, tenant_id: Any, details: Details, background_tasks: BackgroundTasks):
        self.db = db
        self.user = user
        self.tenant_id = _uuid(tenant_id)
        self.details = details
        self.bg = background_tasks
        self.items = _rows(db, tenant_id)
        self.out = Outcome()
        self.company: Optional[Company] = None
        self.shops: Dict[str, Optional[Shop]] = {}

    # ── Rows ──

    def has(self, key: str) -> bool:
        return key in self.items

    def track(self, key: str, entity_type: str, entity_id: Any, *, label: str, shop: Optional[Shop] = None,
              data: Optional[Dict[str, Any]] = None, created: bool = True) -> DemoCompanyItem:
        now = _now()
        row = DemoCompanyItem(
            id=uuid.uuid4(), tenant_id=self.tenant_id,
            company_id=self.company.id if self.company is not None else _uuid(entity_id),
            item_key=key, entity_type=entity_type, entity_id=_uuid(entity_id),
            shop_id=shop.id if shop is not None else None,
            data={"label": label, **(data or {})},
            created_by=getattr(self.user, "id", None), created_at=now, updated_at=now,
        )
        self.db.add(row)
        self.db.commit()
        self.items[key] = row
        if created:
            self.out.created.append({"key": key, "label": label})
        return row

    def step(self, key: str, label: str, run: Callable[[], Any], *, sensitive: bool = False) -> Any:
        """
        Run one step; a failure is reported (and rolled back) and the build goes on. `sensitive`: the
        step carries an employee's code — its failure is logged by its kind only, never its text.
        """
        try:
            return run()
        except Exception as exc:  # noqa: BLE001 - one step never stops the others
            self.db.rollback()
            if sensitive:
                reason = reason_of(exc) if isinstance(exc, (HTTPException, StepRefused)) else exc.__class__.__name__
                logger.warning("demo company: step %s failed (%s)", key, exc.__class__.__name__)
            else:
                reason = reason_of(exc)
                logger.warning("demo company: step %s failed (%s: %s)", key, exc.__class__.__name__, reason,
                               exc_info=True)
            self.out.failed.append({"key": key, "label": label, "message": reason})
            return None

    def done(self, key: str, label: str, *, shop: Optional[Shop] = None, entity_id: Any = None,
             data: Optional[Dict[str, Any]] = None) -> None:
        self.track(key, "step", entity_id or (shop.id if shop is not None else self.company.id),
                   label=label, shop=shop, data=data)

    # ── The company ──

    def build_company(self) -> None:
        from app.routers import companies as RC
        from app.schemas.company import CompanyCreate

        row = self.items.get("company")
        if row is not None:
            self.company = self.db.get(Company, row.company_id) if row.company_id else None
            if self.company is not None:
                self.step("company:details", "פרטי החברה", self._fill_details)
                return
        d = self.details
        body = CompanyCreate.model_validate({
            "name": COMPANY_NAME, "vatNumber": d.vat_number, "address": d.address, "city": d.city,
            **({"dealerType": d.dealer_type} if d.dealer_type else {}),
        })
        company = RC.create_company(body, current_user=self.user, active_tenant_id=self.tenant_id, db=self.db)
        self.company = self.db.get(Company, company.id)
        self.track("company", "company", self.company.id, label=f"החברה \"{COMPANY_NAME}\"")
        if d.phone:
            self.step("company:phone", "טלפון לחשבונית", lambda: self._set_phone(d.phone))

    def _fill_details(self) -> None:
        """A second click with details: only what the company still lacks (never over the owner's)."""
        from app.routers import companies as RC
        from app.schemas.company import CompanyUpdate

        d, c = self.details, self.company
        updates = {}
        if d.vat_number and not (c.vat_number or "").strip():
            updates["vatNumber"] = d.vat_number
        if d.address and not (c.address or "").strip():
            updates["address"] = d.address
        if d.city and not (c.city or "").strip():
            updates["city"] = d.city
        if updates:
            RC.update_company(str(c.id), CompanyUpdate.model_validate(updates), current_user=self.user,
                              active_tenant_id=self.tenant_id, db=self.db)
        if d.phone and not company_phone(c):
            self._set_phone(d.phone)

    def _set_phone(self, phone: str) -> None:
        from app.routers import settings as RS
        from app.schemas.pos_settings import PosSettingsV1Patch

        RS.patch_company_settings(
            str(self.company.id), PosSettingsV1Patch.model_validate({"businessInfo": {"phone": phone}}),
            current_user=self.user, active_tenant_id=self.tenant_id, db=self.db,
        )

    def build_branding(self) -> None:
        """The stand-in logo, uploaded and set as the company's — unless it has one already."""
        key = "step:company:branding"
        if self.has(key):
            return

        def run():
            from app.routers import images as RI
            from app.routers import settings as RS
            from app.schemas.pos_settings import PosSettingsV1Patch
            from app.services import demo_company_images as IMG

            logo = _await(RI.upload_branding_image(
                kind="logo", file=_upload_file(IMG.logo_png(), "r2m-demo-logo.png"),
                current_user=self.user, active_tenant_id=self.tenant_id,
            ))
            receipt = _await(RI.upload_branding_image(
                kind="receipt", file=_upload_file(IMG.receipt_logo_png(), "r2m-demo-receipt.png"),
                current_user=self.user, active_tenant_id=self.tenant_id,
            ))
            stored = self.company.settings if isinstance(self.company.settings, dict) else {}
            patch = {}
            if not stored.get("brandLogoUrl"):
                patch["brandLogoUrl"] = logo.url
            if not stored.get("brandReceiptLogoUrl"):
                patch["brandReceiptLogoUrl"] = receipt.url
            if patch:
                RS.patch_company_settings(
                    str(self.company.id), PosSettingsV1Patch.model_validate(patch),
                    current_user=self.user, active_tenant_id=self.tenant_id, db=self.db,
                )
            self.done(key, "לוגו זמני \"R2M Demo\" (קבלה, קיוסק ומסך לקוח)", data={"logoUrl": logo.url})

        self.step(key, "לוגו זמני", run)

    def logo_url(self) -> Optional[str]:
        row = self.items.get("step:company:branding")
        return (row.data or {}).get("logoUrl") if row is not None else None

    # ── The shops ──

    def build_shop(self, key: str) -> None:
        from app.routers import shops as RS
        from app.schemas.shop import ShopCreate

        row = self.items.get(f"shop:{key}")
        if row is not None:
            self.shops[key] = self.db.get(Shop, row.entity_id)
            return
        spec = SHOPS[key]

        def run():
            body = ShopCreate.model_validate({
                "name": spec["name"], "companyId": str(self.company.id), "branchId": self._branch_code(spec["branch"]),
                # Live: real numbering, a real Z, real clearing (the owner's decision 1).
                "trainingMode": False,
            })
            shop = RS.create_shop(body, current_user=self.user, active_tenant_id=self.tenant_id, db=self.db)
            self.shops[key] = self.db.get(Shop, shop.id)
            self.track(f"shop:{key}", "shop", shop.id, label=f"סניף \"{spec['name']}\"", shop=self.shops[key])

        self.step(f"shop:{key}", f"סניף {spec['name']}", run)

    def _branch_code(self, wanted: str) -> str:
        taken = {
            (b or "").strip()
            for (b,) in self.db.query(Shop.branch_id).filter(Shop.company_id == self.company.id).all()
        }
        code = int(wanted)
        while str(code) in taken:
            code += 1
        return str(code)

    def work_profile(self, key: str) -> None:
        from app.routers import work_profile as RWP
        from app.services import work_profile_templates as T

        shop = self.shops.get(key)
        step_key = f"step:{key}:work_profile"
        if shop is None or self.has(step_key):
            return

        def profile(kitchen: Optional[str] = None) -> Dict[str, Any]:
            template = next(t for t in T.TEMPLATES if t["id"] == ("quick_counter" if key == SNACK else "restaurant_tables"))
            out = dict(template["profile"])
            if key == SNACK:
                out.update(customerDisplay=True)
            else:
                out.update(kitchen=kitchen or T.KITCHEN_BOTH, attendance=True,
                           tips={"enabled": True, "distribution": "equal_pool"})
            return T.validate(out)

        def put(p: Dict[str, Any]):
            return RWP.put_shop_work_profile(
                shop.id, RWP.WorkProfilePutIn(profile=p), self.bg,
                current_user=self.user, active_tenant_id=self.tenant_id, db=self.db,
            )

        def run():
            note = None
            try:
                put(profile())
            except HTTPException as exc:
                detail = exc.detail if isinstance(exc.detail, dict) else {}
                if key != RESTAURANT or detail.get("field") != "kitchen":
                    raise
                # The kitchen to a KDS waits for a KDS screen: printers now, the screen once paired.
                self.db.rollback()
                put(profile(T.KITCHEN_PRINTER))
                note = "מטבח: בונים במדפסת. אחרי צימוד מסך המטבח אפשר לבחור \"בונים ומסך מטבח\" בתצורת העבודה."
            template = "דוכן / קופה מהירה" if key == SNACK else "מסעדה עם שולחנות"
            self.done(step_key, f"תצורת עבודה \"{template}\" ב{SHOPS[key]['name']}", shop=shop,
                      data={"note": note} if note else None)
            if note:
                self.out.notes.append(note)

        self.step(step_key, f"תצורת עבודה ב{SHOPS[key]['name']}", run)

    # ── Points of sale, floor maps and tables ──

    def areas(self) -> Dict[str, Any]:
        """The restaurant's areas by key (made now, made before, or the owner's own of that name)."""
        from app.models.shop_area import ShopArea
        from app.routers import areas as RA
        from app.schemas.area import AreaCreate

        shop = self.shops.get(RESTAURANT)
        out: Dict[str, Any] = {}
        if shop is None:
            return out
        for order, (akey, name, _n, _first) in enumerate(AREAS):
            key = f"area:{RESTAURANT}:{akey}"
            row = self.items.get(key)
            if row is not None:
                area = self.db.get(ShopArea, row.entity_id)
                if area is not None and area.archived_at is None:
                    out[akey] = area
                continue

            def run(akey=akey, name=name, order=order, key=key):
                live = next(
                    (a for a in self.db.query(ShopArea).filter(ShopArea.shop_id == shop.id, ShopArea.archived_at.is_(None))
                     if (a.name or "").strip().lower() == name.lower()),
                    None,
                )
                if live is None:
                    made = RA.create_shop_area(shop.id, AreaCreate(name=name, sortOrder=order), current_user=self.user,
                                               active_tenant_id=self.tenant_id, db=self.db)
                    live = self.db.get(ShopArea, _id_of(made))
                    self.track(key, "area", live.id, label=f"נקודת מכירה \"{name}\"", shop=shop)
                else:
                    self.track(key, "area", live.id, label=f"נקודת מכירה \"{name}\" (קיימת)", shop=shop, created=False)
                out[akey] = live

            self.step(key, f"נקודת מכירה {name}", run)
        return out

    def floor(self, areas: Dict[str, Any]) -> Dict[str, Any]:
        """A map for each area with tables, and its tables; the zones by area key."""
        from app.models.tables import DiningTable, TableZone
        from app.routers import tables as RT
        from app.schemas.tables import TableCreate, ZoneCreate

        shop = self.shops.get(RESTAURANT)
        zones: Dict[str, Any] = {}
        if shop is None:
            return zones
        for akey, name, count, first in AREAS:
            if count == 0:
                continue
            zkey = f"zone:{RESTAURANT}:{akey}"
            row = self.items.get(zkey)
            zone = None
            if row is not None:
                zone = self.db.get(TableZone, row.entity_id)
                if zone is not None and zone.archived_at is not None:
                    zone = None
            elif akey in areas:
                def make_zone(akey=akey, name=name, zkey=zkey):
                    body = ZoneCreate.model_validate({
                        "shopId": str(shop.id), "areaId": str(areas[akey].id), "name": name, "layout": "map",
                        "canvasWidth": 1000, "canvasHeight": 700, "sketch": _sketch(akey),
                    })
                    made = RT.create_zone(body, self.bg, current_user=self.user, active_tenant_id=self.tenant_id, db=self.db)
                    self.track(zkey, "zone", made["id"], label=f"מפת שולחנות \"{name}\"", shop=shop)
                    return self.db.get(TableZone, _uuid(made["id"]))

                zone = self.step(zkey, f"מפת שולחנות {name}", make_zone)
            if zone is None:
                continue
            zones[akey] = zone
            taken = {
                n for (n,) in self.db.query(DiningTable.number)
                .filter(DiningTable.shop_id == shop.id, DiningTable.archived_at.is_(None)).all()
            }
            made_here = 0
            for i, spec in enumerate(_tables(akey, count, first)):
                tkey = f"table:{RESTAURANT}:{akey}:{spec['number']}"
                if self.has(tkey) or spec["number"] in taken:
                    continue

                def make_table(spec=spec, tkey=tkey):
                    table = RT.create_table(
                        TableCreate.model_validate({"zoneId": str(zone.id), **spec}), self.bg,
                        current_user=self.user, active_tenant_id=self.tenant_id, db=self.db,
                    )
                    self.track(tkey, "table", table["id"], label=f"{name} — {spec.get('name') or spec['number']}",
                               shop=shop, created=False)

                if self.step(tkey, f"{name}: שולחן {spec['number']}", make_table) is None and tkey in self.items:
                    made_here += 1
            if made_here:
                what = "כיסאות בר" if akey == "bar" else f"שולחנות ב{name}"
                self.out.created.append({"key": f"tables:{RESTAURANT}:{akey}", "label": f"{made_here} {what}"})
        return zones

    # ── Menus ──

    def demo_menu(self, key: str) -> None:
        from app.routers import training_mode as RTM

        shop = self.shops.get(key)
        mkey = f"menu:{key}"
        if shop is None or self.has(mkey):
            return
        spec = SHOPS[key]

        def run():
            out = RTM.load_demo_menu(
                RTM.DemoLoadIn(companyId=self.company.id, shopId=shop.id, template=spec["template"]), self.bg,
                current_user=self.user, active_tenant_id=self.tenant_id, db=self.db,
            )
            counts = out.get("counts") or {}
            self.track(mkey, "menu_load", out["loadId"], shop=shop,
                       label=f"תפריט \"{out.get('templateName')}\" ב{spec['name']}: {counts.get('product', 0)} מוצרים, "
                             f"{counts.get('category', 0)} מחלקות")

        self.step(mkey, f"תפריט ב{spec['name']}", run)

    def menu_of(self, key: str) -> Tuple[Dict[str, Any], Dict[str, Any]]:
        """The shop's demo load: (category name → Category, product name → Product)."""
        from app.models.category import Category
        from app.models.product import Product
        from app.models.training import DemoMenuItem

        row = self.items.get(f"menu:{key}")
        if row is None:
            return {}, {}
        tracked = self.db.query(DemoMenuItem).filter(DemoMenuItem.load_id == row.entity_id).all()
        cat_ids = [r.entity_id for r in tracked if r.entity_type == "category"]
        prod_ids = [r.entity_id for r in tracked if r.entity_type == "product"]
        cats = {c.name: c for c in self.db.query(Category).filter(Category.id.in_(cat_ids)).all()} if cat_ids else {}
        prods = {p.name: p for p in self.db.query(Product).filter(Product.id.in_(prod_ids)).all()} if prod_ids else {}
        return cats, prods

    def area_menus(self, areas: Dict[str, Any]) -> None:
        """The bar sells drinks; take away sells no alcohol. The hall and the terrace: the whole catalog."""
        from app.routers import catalog_menus as RCM
        from app.schemas.catalog_menu import MenuIn, TargetAssignmentsIn

        shop = self.shops.get(RESTAURANT)
        if shop is None:
            return
        cats, _prods = self.menu_of(RESTAURANT)
        plans = (
            ("bar", "תפריט בר", [n for n in cats if n in DRINK_CATEGORIES]),
            ("takeaway", "תפריט טייק אווי", [n for n in cats if n not in ALCOHOL_CATEGORIES]),
        )
        for akey, name, names in plans:
            key = f"catalog_menu:{RESTAURANT}:{akey}"
            if self.has(key) or akey not in areas or not names:
                continue

            def run(akey=akey, name=name, names=names, key=key):
                menu = RCM.create_catalog_menu(
                    MenuIn.model_validate({
                        "name": name, "companyId": str(self.company.id), "channel": "both", "always": True,
                        "categories": [{"categoryId": str(cats[n].id), "allProducts": True} for n in names],
                    }),
                    self.bg, current_user=self.user, active_tenant_id=self.tenant_id, db=self.db,
                )
                RCM.set_catalog_menu_target(
                    TargetAssignmentsIn.model_validate({
                        "level": "area", "targetId": str(areas[akey].id), "menus": [{"menuId": menu["id"]}],
                    }),
                    self.bg, current_user=self.user, active_tenant_id=self.tenant_id, db=self.db,
                )
                self.track(key, "catalog_menu", menu["id"], shop=shop,
                           label=f"{name} (נקודת המכירה \"{areas[akey].name}\")")

            self.step(key, name, run)

    # ── The kitchen ──

    def kitchen(self, key: str, zones: Dict[str, Any]) -> None:
        from app.models.printers import KitchenPrinter
        from app.routers import printer_zones as RPZ
        from app.routers import printers as RP
        from app.schemas.kitchen_printers import CategoryRoutesIn, PrinterIn
        from app.schemas.printer_discovery import ZoneRedirectsIn

        shop = self.shops.get(key)
        if shop is None:
            return
        cats, _prods = self.menu_of(key)
        wanted = [("kitchen", "מדפסת מטבח")]
        if key == RESTAURANT:
            wanted += [("bar", "מדפסת בר"), ("terrace", "מדפסת מטבח — מרפסת")]
        printers: Dict[str, Any] = {}
        for pkey, name in wanted:
            key_ = f"printer:{key}:{pkey}"
            row = self.items.get(key_)
            if row is not None:
                printers[pkey] = self.db.get(KitchenPrinter, row.entity_id)
                continue

            def run(pkey=pkey, name=name, key_=key_):
                # Printed on the sending till's own head until the owner gives it an address.
                made = RP.create_printer(
                    shop.id, PrinterIn.model_validate({"name": name, "purpose": "kitchen", "connectionType": "till",
                                                       "sortOrder": len(printers)}),
                    self.bg, current_user=self.user, active_tenant_id=self.tenant_id, db=self.db,
                )
                printers[pkey] = self.db.get(KitchenPrinter, _uuid(made["id"]))
                self.track(key_, "printer", made["id"], shop=shop, label=f"{name} ב{SHOPS[key]['name']}")

            self.step(key_, name, run)

        rkey = f"step:{key}:printer_routing"
        if not self.has(rkey) and printers.get("kitchen") is not None and cats:
            def route():
                routes = {}
                for cname, cat in cats.items():
                    target = printers.get("bar") if cname in DRINK_CATEGORIES else printers.get("kitchen")
                    if target is not None and (cname not in DRINK_CATEGORIES or key == RESTAURANT):
                        routes[str(cat.id)] = [str(target.id)]
                RP.put_category_routes(shop.id, CategoryRoutesIn.model_validate({"routes": routes}), self.bg,
                                       current_user=self.user, active_tenant_id=self.tenant_id, db=self.db)
                self.done(rkey, f"ניתוב בונים ב{SHOPS[key]['name']}: אוכל למטבח"
                          + (", שתייה לבר" if key == RESTAURANT else ""), shop=shop)

            self.step(rkey, "ניתוב בונים", route)

        zkey = f"step:{key}:zone_redirect"
        terrace = zones.get("terrace")
        if (key == RESTAURANT and not self.has(zkey) and terrace is not None
                and printers.get("kitchen") is not None and printers.get("terrace") is not None):
            def redirect():
                RPZ.put_zone_redirects(
                    shop.id, terrace.id,
                    ZoneRedirectsIn.model_validate({"redirects": {str(printers["kitchen"].id): str(printers["terrace"].id)}}),
                    self.bg, current_user=self.user, active_tenant_id=self.tenant_id, db=self.db,
                )
                self.done(zkey, "הזמנות המרפסת יוצאות למדפסת המרפסת", shop=shop)

            self.step(zkey, "הפניית מדפסת למרפסת", redirect)

    def kds_station(self) -> Optional[Any]:
        """The kitchen station the KDS shows (the organization's own "מטבח", if it has one)."""
        from app.models.printers import KitchenStation
        from app.routers import printers as RP

        shop = self.shops.get(RESTAURANT)
        if shop is None:
            return None
        key = "kitchen_station"
        row = self.items.get(key)
        if row is not None:
            return self.db.get(KitchenStation, row.entity_id)

        def run():
            station = (
                self.db.query(KitchenStation)
                .filter(KitchenStation.tenant_id == self.tenant_id, KitchenStation.name == KITCHEN_STATION)
                .first()
            )
            if station is None:
                made = RP.create_station(RP.StationIn(name=KITCHEN_STATION), self.bg, current_user=self.user,
                                         active_tenant_id=self.tenant_id, db=self.db)
                station = self.db.get(KitchenStation, _uuid(made["id"]))
                self.track(key, "kitchen_station", station.id, label="תחנת מטבח למסך המטבח", shop=shop)
            else:
                self.track(key, "kitchen_station", station.id, label="תחנת מטבח (קיימת)", shop=shop, created=False)
            cats, _prods = self.menu_of(RESTAURANT)
            for cname, cat in cats.items():
                if cname in DRINK_CATEGORIES:
                    continue
                RP.put_station_target(
                    RP.StationTargetIn(targetType="category", targetId=cat.id, stationId=station.id), self.bg,
                    current_user=self.user, active_tenant_id=self.tenant_id, db=self.db,
                )
            return station

        return self.step(key, "תחנת מטבח", run)

    # ── Employees ──

    def employees(self, key: str) -> None:
        from app.models.till_role import TillRole
        from app.routers import pos_users as RPU
        from app.schemas.pos_user import PosUserCreate
        from app.services import till_roles as TR

        shop = self.shops.get(key)
        if shop is None:
            return
        codes, configured = employee_codes()
        for ekey, username, first, worker, role_key, legacy in EMPLOYEES[key]:
            key_ = f"employee:{key}:{ekey}"
            if self.has(key_):
                continue

            def run(ekey=ekey, username=username, first=first, worker=worker, role_key=role_key, legacy=legacy,
                    key_=key_):
                TR.ensure_company_roles(self.db, self.company)
                self.db.commit()
                role = (
                    self.db.query(TillRole)
                    .filter(TillRole.company_id == self.company.id, TillRole.builtin_key == role_key,
                            TillRole.deleted_at.is_(None))
                    .first()
                )
                made = RPU.create_pos_user(
                    str(shop.id),
                    PosUserCreate.model_validate({
                        "username": username, "firstName": first, "lastName": SHOPS[key]["name"],
                        "workerNumber": worker, "role": legacy, "pin": codes[ekey],
                        **({"tillRoleId": str(role.id)} if role is not None else {}),
                    }),
                    current_user=self.user, active_tenant_id=self.tenant_id, db=self.db,
                )
                # Where its code came from — never the code.
                self.track(key_, "pos_user", _id_of(made), shop=shop,
                           label=f"עובד: {first} ({SHOPS[key]['name']}, מס׳ עובד {worker})",
                           data={"codeSource": "configured" if configured[ekey] else "random"})

            # Sensitive: a refusal's text may echo the body, code included — never logged.
            self.step(key_, f"עובד {first} ב{SHOPS[key]['name']}", run, sensitive=True)

    # ── Looks: the till design, the kiosk, the customer display ──

    def till_design(self, key: str) -> None:
        from app.routers import till_design as RTD

        shop = self.shops.get(key)
        step_key = f"step:{key}:till_design"
        if shop is None or self.has(step_key):
            return
        template = SHOPS[key]["design"]

        def run():
            RTD.put_settings(RTD.TillDesignSettingsIn.model_validate({"overrides": {"template": template}}), self.bg,
                             level="shop", scope_id=shop.id, current_user=self.user, active_tenant_id=self.tenant_id,
                             db=self.db)
            self.done(step_key, f"עיצוב קופה \"{template}\" ב{SHOPS[key]['name']}", shop=shop)

        self.step(step_key, "עיצוב קופה", run)

    def _kiosk_media(self, png: bytes, name: str) -> Dict[str, Any]:
        from app.routers import kiosks as RK

        out = _await(RK.upload_kiosk_media(file=_upload_file(png, name), current_user=self.user,
                                           active_tenant_id=self.tenant_id))
        return {"url": out["url"], "kind": out["kind"], "sha256": out.get("sha256"), "bytes": out.get("bytes")}

    def kiosk(self) -> None:
        from app.routers import kiosks as RK
        from app.schemas.kiosk import KioskSettingsIn
        from app.services import demo_company_images as IMG
        from app.services import demo_menu_templates as T

        shop = self.shops.get(SNACK)
        step_key = f"step:{SNACK}:kiosk"
        if shop is None or self.has(step_key):
            return
        cats, _prods = self.menu_of(SNACK)

        def run():
            colors = {c: color for c, color, _items in T.CATEGORIES}
            logo = self._kiosk_media(IMG.logo_png(), "kiosk-logo.png")
            hero = self._kiosk_media(IMG.banner_png("R2M Demo", "Falafel - Shawarma - Toast", "#EA580C", (1080, 1920)),
                                     "kiosk-attract.png")
            images = {
                str(cat.id): self._kiosk_media(IMG.tile_png(colors.get(name, "#64748B")), f"kiosk-category-{i}.png")
                for i, (name, cat) in enumerate(cats.items())
            }
            overrides = {
                "theme": {"uiStyle": "wolt", "primaryColor": "#EA580C", "accentColor": "#16A34A", "logo": logo,
                          "categoryStyle": "images" if images else "chips"},
                "texts": {"attractTitle": "ברוכים הבאים למזנון", "attractSubtitle": "פלאפל, שווארמה וטוסטים — מזמינים כאן",
                          "attractCta": "להזמנה"},
                "attract": {"playlist": [{"media": hero, "durationSec": 8}]},
                "catalog": {"categoryImages": images},
            }
            RK.put_settings(KioskSettingsIn.model_validate({"overrides": overrides}), level="shop", scope_id=shop.id,
                            current_user=self.user, active_tenant_id=self.tenant_id, db=self.db)
            self.done(step_key, "עיצוב הקיוסק: סגנון, לוגו, תמונות מחלקה ומסך פתיחה", shop=shop)

        self.step(step_key, "עיצוב הקיוסק", run)

    def customer_display(self) -> None:
        from app.routers import customer_display as RCD
        from app.services import customer_display as CD
        from app.services import demo_company_images as IMG

        shop = self.shops.get(SNACK)
        step_key = f"step:{SNACK}:customer_display"
        if shop is None or self.has(step_key):
            return

        def run():
            from app.routers import images as RI

            ad = _await(RI.upload_media(
                file=_upload_file(IMG.banner_png("Falafel Combo", "Falafel + Fries + Drink", "#D97706", (1920, 1080)),
                                  "display-ad.png"),
                current_user=self.user, active_tenant_id=self.tenant_id,
            ))
            layer = {
                **CD.layer_of(shop.settings), "enabled": True, "theme": "brand",
                "playlist": [{"url": ad.url, "kind": "image", "durationSec": 8}],
                "welcomeText": "ברוכים הבאים למזנון", "thanksText": "תודה ובתיאבון!",
            }
            RCD.put_layer("shop", str(shop.id), {"settings": layer}, current_user=self.user,
                          active_tenant_id=self.tenant_id, db=self.db)
            self.done(step_key, "מסך לקוח: עגלה ופרסומת לדוגמה", shop=shop)

        self.step(step_key, "מסך לקוח", run)

    def digital_menu(self) -> None:
        """The restaurant's digital menu, published — as the "תפריט דיגיטלי" routes do it."""
        from app.models.presentation_profile import PresentationProfile
        from app.routers import product_channels as RPC
        from app.services import presentation_profiles as PP
        from app.services import public_digital_cache

        shop = self.shops.get(RESTAURANT)
        key = f"digital_menu:{RESTAURANT}"
        if shop is None or self.has(key):
            return
        cats, prods = self.menu_of(RESTAURANT)
        if not prods:
            return

        def run():
            RPC.bulk_product_channels(
                RPC.BulkIn.model_validate({"selection": {"ids": [str(p.id) for p in prods.values()]},
                                           "set": {"menu": True}, "dryRun": False}),
                current_user=self.user, active_tenant_id=self.tenant_id, db=self.db,
            )
            profile = PP.create(self.db, self.user, self.tenant_id, "menu", {
                "targetLevel": "shop", "targetId": str(shop.id), "internalName": "תפריט דיגיטלי — מסעדה",
                "publicTitle": {"he": f"{COMPANY_NAME} — מסעדה"}, "languages": ["he"], "defaultLanguage": "he",
                "start": {"mode": "new"},
            })
            self.db.commit()
            profile = self.db.get(PresentationProfile, profile.id)
            content = PP.default_content("menu")
            content["selection"] = {"mode": "independent",
                                    "categories": [{"id": str(c.id), "includeFuture": True} for c in cats.values()]}
            draft = PP.put_draft(self.db, profile, content=content, field_states=None, version=None, user=self.user)
            self.db.commit()
            PP.publish(self.db, profile, self.user, version=draft.version)
            self.db.commit()
            public_digital_cache.invalidate(profile.id)
            self.track(key, "digital_menu", profile.id, shop=shop, label="תפריט דיגיטלי למסעדה (מפורסם)",
                       data={"slug": profile.slug})

        self.step(key, "תפריט דיגיטלי", run)

    # ── The company's features ──

    def vouchers(self) -> None:
        from app.schemas.prepaid_voucher import PrepaidVoucherBatchCreate
        from app.services import prepaid_batch_create as PBC
        from app.services import voucher_balance_check as VB

        snack = self.shops.get(SNACK)
        _cats, prods = self.menu_of(SNACK)
        until = (_now() + timedelta(days=365)).replace(microsecond=0).isoformat()

        def ids(*names: str) -> List[str]:
            return [str(prods[n].id) for n in names if n in prods]

        plans = []
        if snack is not None and prods:
            plans.append(("lunch", "ארוחת צהריים", {
                "name": "ארוחת צהריים", "shopIds": [str(snack.id)], "count": 10, "kind": "items",
                "selection": "groups", "totalQty": 3, "splitAllowed": False, "validUntil": until,
                "groups": [
                    {"name": "מנה", "minQty": 0, "maxQty": 1, "allowRepeat": True, "sortOrder": 0,
                     "productIds": ids("פלאפל בפיתה", "שווארמה בפיתה", "טוסט גבינה צהובה", "טוסט טונה")},
                    {"name": "תוספת", "minQty": 0, "maxQty": 1, "allowRepeat": True, "sortOrder": 1,
                     "productIds": ids("צ׳יפס קטן", "חצילים מטוגנים", "סלט ישראלי")},
                    {"name": "שתייה", "minQty": 0, "maxQty": 1, "allowRepeat": True, "sortOrder": 2,
                     "productIds": ids("פחית קולה", "פחית קולה זירו", "פחית ספרייט", "בקבוק מים", "מיץ ענבים")},
                ],
            }))
            plans.append(("coffee10", "כרטיסיית קפה 10", {
                "name": "כרטיסיית קפה 10", "shopIds": [str(snack.id)], "count": 10, "kind": "items",
                "selection": "groups", "totalQty": 10, "splitAllowed": True, "validUntil": until,
                "groups": [{"name": "קפה", "minQty": 1, "maxQty": 10, "allowRepeat": True, "sortOrder": 0,
                            "productIds": ids("קפה שחור", "נס קפה", "הפוך קטן")}],
            }))
        plans.append(("discount20", "הנחת 20 ₪", {
            "name": "הנחת 20 ₪", "count": 10, "kind": "order_discount", "discountType": "fixed", "discountValue": 20,
            "minPurchase": 50, "usesPerVoucher": 1, "maxUsesPerSale": 1, "validUntil": until,
        }))
        for vkey, label, body in plans:
            key = f"voucher:{vkey}"
            if self.has(key):
                continue

            def run(vkey=vkey, label=label, body=body, key=key):
                payload = PrepaidVoucherBatchCreate.model_validate({**body, "companyId": str(self.company.id)})
                # A key of its own: even a lost tracking row never makes the batch twice.
                idem_key = str(uuid.uuid5(uuid.NAMESPACE_URL, f"demo-company:{self.company.id}:{vkey}"))
                out, _replayed = PBC.create(self.db, self.user, self.tenant_id, payload, key=idem_key)
                try:
                    VB.notify_tills_of_batch(self.db, out["id"])
                except Exception:  # noqa: BLE001 - the tills' next pull has it anyway
                    logger.warning("demo company: voucher batch notify failed")
                self.track(key, "voucher_batch", out["id"], label=f"שוברי הפקה: \"{label}\" (10 שוברים)")

            self.step(key, f"שוברים: {label}", run)

    def club(self) -> None:
        from app.models.club import ClubProgram
        from app.routers import club as RCL

        key = "club"
        if self.has(key):
            return

        def run():
            RCL.put_club(body={"name": "מועדון R2M הדגמה"}, company_id=str(self.company.id), user=self.user,
                         tenant_id=self.tenant_id, db=self.db)
            RCL.put_landing(body={
                "businessName": COMPANY_NAME, "headline": "מצטרפים למועדון R2M",
                "intro": "הטבות לחברי המועדון במזנון ובמסעדה.",
                "benefits": ["שתייה קלה מתנה בהצטרפות", "מבצעים לחברי מועדון בלבד", "הודעה על אירועים במסעדה"],
                "signupBenefitEnabled": True, "signupBenefitTitle": "שתייה קלה מתנה בהצטרפות",
                "signupBenefitValidDays": 30,
            }, company_id=str(self.company.id), user=self.user, tenant_id=self.tenant_id, db=self.db)
            club = self.db.query(ClubProgram).filter(ClubProgram.company_id == self.company.id).first()
            self.track(key, "club", club.id, label="מועדון לקוחות עם הטבת הצטרפות")

        self.step(key, "מועדון לקוחות", run)

    # ── The devices ──

    def devices(self, key: str, station: Any) -> List[Dict[str, Any]]:
        """A live pairing code for every planned device not paired yet; the devices as they stand."""
        from app.models.pairing_code import PairingCode
        from app.models.pos_machine import POSMachine

        shop = self.shops.get(key)
        out: List[Dict[str, Any]] = []
        if shop is None:
            return out
        now = _now()
        for dkey, label, role in DEVICES[key]:
            item_key = f"device:{key}:{dkey}"
            row = self.items.get(item_key)
            code = self.db.get(PairingCode, row.entity_id) if row is not None and row.entity_id else None
            if code is not None and code.is_used:
                continue
            expires = code.expires_at if code is not None else None
            if expires is not None and expires.tzinfo is None:
                expires = expires.replace(tzinfo=timezone.utc)
            if code is not None and expires is not None and expires > now + timedelta(minutes=2):
                continue

            def run(dkey=dkey, label=label, role=role, item_key=item_key, row=row):
                fresh = self._pairing_code(shop, key, dkey, label, role, station)
                if row is None:
                    self.track(item_key, "pairing_code", fresh.id, shop=shop, label=f"קוד צימוד: {label}",
                               data={"device": dkey, "role": role, "name": label}, created=False)
                else:
                    row.entity_id = fresh.id
                    row.updated_at = _now()
                    self.db.commit()

            self.step(item_key, f"קוד צימוד: {label}", run)
        for dkey, label, role in DEVICES[key]:
            row = self.items.get(f"device:{key}:{dkey}")
            code = self.db.get(PairingCode, row.entity_id) if row is not None and row.entity_id else None
            machine = self.db.get(POSMachine, code.pos_machine_id) if code is not None and code.pos_machine_id else None
            out.append(device_out(dkey, label, role, code, machine, now))
        return out

    def _pairing_code(self, shop: Shop, key: str, dkey: str, label: str, role: str, station: Any):
        from app.models.pairing_code import PairingCode
        from app.routers import pairing as RPA
        from app.schemas.pairing_code import PairingCodeGenerateRequest

        body: Dict[str, Any] = {"companyId": str(self.company.id), "shopId": str(shop.id)}
        if role == "till":
            body["deviceRole"] = "till"
            body["name"] = label
            if dkey == "main_till":
                body["workConfig"] = {"preset": "main_till", "enableLocalNetwork": True}
        elif role == "kiosk":
            body["deviceRole"] = "kiosk"
            body["kiosk"] = {"name": "קיוסק מזנון"}
        elif role == "customer_display":
            body["deviceRole"] = "customer_display"
            till = self.paired_machine(SNACK, "till")
            body["kds"] = {"name": label, **({"tillMachineId": str(till.id)} if till is not None else {})}
        elif role == "kds":
            body["deviceRole"] = "kds"
            body["kds"] = {"name": label, "screenRole": "station", "stationIds": [str(station.id)]} if station is not None \
                else {"name": label, "screenRole": "expo"}
        try:
            made = _answer(RPA.generate_pairing_code(
                PairingCodeGenerateRequest.model_validate(body), current_user=self.user,
                active_tenant_id=self.tenant_id, db=self.db,
            ))
        except (StepRefused, HTTPException):
            if "workConfig" not in body:
                raise
            # The main till's plan refused now (it is checked again as it pairs): the shop's work
            # profile still makes the first Android till the main one.
            self.db.rollback()
            body.pop("workConfig")
            made = _answer(RPA.generate_pairing_code(
                PairingCodeGenerateRequest.model_validate(body), current_user=self.user,
                active_tenant_id=self.tenant_id, db=self.db,
            ))
        return self.db.get(PairingCode, made.id)

    def paired_machine(self, key: str, dkey: str):
        from app.models.pairing_code import PairingCode
        from app.models.pos_machine import POSMachine

        row = self.items.get(f"device:{key}:{dkey}")
        code = self.db.get(PairingCode, row.entity_id) if row is not None and row.entity_id else None
        if code is None or not code.is_used or code.pos_machine_id is None:
            return None
        machine = self.db.get(POSMachine, code.pos_machine_id)
        return machine if machine is not None and machine.is_active else None

    def after_pairing(self) -> None:
        """What waits for a paired device: the voucher station's mode, the display's till."""
        from app.routers import customer_display as RCD
        from app.routers import settings as RS
        from app.schemas.pos_settings import PosSettingsV1Patch
        from app.services import customer_display as CD

        station = self.paired_machine(SNACK, "voucher_station")
        skey = f"step:{SNACK}:voucher_station"
        if station is not None and not self.has(skey):
            def run():
                # "עמדת שובר" on that device alone (the shop's other tills sell as usual). "מצב מהיר"
                # for the station has no parameter of its own: a station always closes by itself.
                RS.patch_machine_settings(
                    str(station.id), PosSettingsV1Patch.model_validate({"voucherStation": "on",
                                                                        "voucherStationPaidItems": "on"}),
                    current_user=self.user, active_tenant_id=self.tenant_id, db=self.db,
                )
                self.done(skey, "עמדת השובר הוגדרה כעמדת שובר (עם פריטים בתשלום)", shop=self.shops.get(SNACK),
                          entity_id=station.id)

            self.step(skey, "עמדת שובר", run)

        display = self.paired_machine(SNACK, "display")
        till = self.paired_machine(SNACK, "till")
        dkey = f"step:{SNACK}:display_mirror"
        if display is not None and till is not None and not self.has(dkey):
            def bind():
                if not CD.mirrored_till_id(display):
                    layer = {**CD.layer_of(display.settings), CD.MIRROR_KEY: str(till.id)}
                    RCD.put_layer("machine", str(display.id), {"settings": layer}, current_user=self.user,
                                  active_tenant_id=self.tenant_id, db=self.db)
                self.done(dkey, "מסך הלקוח מוצמד לקופת המזנון", shop=self.shops.get(SNACK), entity_id=display.id)

            self.step(dkey, "מסך לקוח לקופה", bind)

    # ── All of it ──

    def run(self) -> None:
        self.build_company()
        if self.company is None:
            return
        self.build_branding()
        for key in SHOPS:
            self.build_shop(key)
        for key in SHOPS:
            self.work_profile(key)
        areas = self.areas()
        zones = self.floor(areas)
        for key in SHOPS:
            self.demo_menu(key)
        self.area_menus(areas)
        for key in SHOPS:
            self.kitchen(key, zones if key == RESTAURANT else {})
        station = self.kds_station()
        for key in SHOPS:
            self.employees(key)
            self.till_design(key)
        self.kiosk()
        self.customer_display()
        self.digital_menu()
        self.vouchers()
        self.club()
        for key in SHOPS:
            self.devices(key, station)
        self.after_pairing()


# ── The floor maps ────────────────────────────────────────────────────────────


def _sketch(area: str) -> Dict[str, Any]:
    """The decor of an area's map (1000 × 700): what a manager draws in the map designer."""
    if area == "hall":
        return {"template": "demo_hall", "background": "wood", "elements": [
            {"id": "kitchen", "kind": "kitchen", "x": 800, "y": 10, "w": 180, "h": 80},
            {"id": "cashier", "kind": "cashier", "x": 20, "y": 10, "w": 150, "h": 70},
            {"id": "door", "kind": "door", "x": 450, "y": 660, "w": 100, "h": 30},
            {"id": "restroom", "kind": "restroom", "x": 880, "y": 600, "w": 100, "h": 80},
        ]}
    if area == "terrace":
        return {"template": "demo_terrace", "background": "tiles", "elements": [
            {"id": "plant1", "kind": "plant", "x": 20, "y": 20, "w": 60, "h": 60},
            {"id": "plant2", "kind": "plant", "x": 920, "y": 20, "w": 60, "h": 60},
            {"id": "plant3", "kind": "plant", "x": 20, "y": 620, "w": 60, "h": 60},
            {"id": "plant4", "kind": "plant", "x": 920, "y": 620, "w": 60, "h": 60},
            {"id": "door", "kind": "door", "x": 450, "y": 0, "w": 100, "h": 30},
        ]}
    return {"template": "demo_bar", "background": "dark", "elements": [
        {"id": "counter", "kind": "counter", "variant": "straight", "x": 90, "y": 70, "w": 820, "h": 90},
        {"id": "door", "kind": "door", "x": 450, "y": 660, "w": 100, "h": 30},
    ]}


def _tables(area: str, count: int, first: int) -> List[Dict[str, Any]]:
    """The tables of an area's map, by number (numbers are the shop's: 1–12, 21–28, 41–50)."""
    out: List[Dict[str, Any]] = []
    for i in range(count):
        number = first + i
        if area == "bar":
            # A bar seat: a one-seat round stool in front of the counter.
            out.append({"number": number, "name": f"בר {i + 1}", "seats": 1, "shape": "round",
                        "x": 110 + i * 78, "y": 220, "width": 50, "height": 50})
        elif area == "terrace":
            row, col = divmod(i, 4)
            out.append({"number": number, "seats": 2 if col % 2 == 0 else 4, "shape": "round",
                        "x": 150 + col * 200, "y": 170 + row * 230, "width": 80, "height": 80})
        else:
            row, col = divmod(i, 4)
            big = row == 2
            out.append({"number": number, "seats": 6 if big else 4, "shape": "rect" if big else "square",
                        "x": 120 + col * 210, "y": 150 + row * 170, "width": 140 if big else 90, "height": 90})
    return out


# ── What the owner sees ───────────────────────────────────────────────────────


def company_phone(company: Optional[Company]) -> Optional[str]:
    settings = company.settings if company is not None and isinstance(company.settings, dict) else {}
    info = settings.get("businessInfo") if isinstance(settings.get("businessInfo"), dict) else {}
    return str(info.get("phone") or "").strip() or None


def device_out(dkey: str, label: str, role: str, code: Any, machine: Any, now: datetime) -> Dict[str, Any]:
    expires = code.expires_at if code is not None else None
    if expires is not None and expires.tzinfo is None:
        expires = expires.replace(tzinfo=timezone.utc)
    if code is not None and code.is_used:
        state = "paired"
    elif code is None:
        state = "none"
    elif expires is not None and expires <= now:
        state = "expired"
    else:
        state = "waiting"
    return {
        "key": dkey,
        "label": label,
        "role": role,
        "roleLabel": ROLE_LABELS.get(role, role),
        # A used or expired code is no use to anyone: only a live one is shown.
        "code": code.code if state == "waiting" else None,
        "expiresAt": _iso(expires) if state == "waiting" else None,
        "status": state,
        "machineId": str(machine.id) if machine is not None else None,
        "machineName": getattr(machine, "name", None) if machine is not None else None,
    }


_MODELS: Dict[str, Tuple[str, str]] = {
    "company": ("app.models.company", "Company"),
    "shop": ("app.models.shop", "Shop"),
    "area": ("app.models.shop_area", "ShopArea"),
    "zone": ("app.models.tables", "TableZone"),
    "table": ("app.models.tables", "DiningTable"),
    "catalog_menu": ("app.models.catalog_menu", "CatalogMenu"),
    "printer": ("app.models.printers", "KitchenPrinter"),
    "kitchen_station": ("app.models.printers", "KitchenStation"),
    "pos_user": ("app.models.pos_user", "PosUser"),
    "voucher_batch": ("app.models.prepaid_voucher", "PrepaidVoucherBatch"),
    "club": ("app.models.club", "ClubProgram"),
    "digital_menu": ("app.models.presentation_profile", "PresentationProfile"),
}


def _present(db: Session, row: DemoCompanyItem) -> bool:
    """Is what the row made still there (not deleted / archived by the owner)? Steps always are."""
    import importlib

    spec = _MODELS.get(row.entity_type)
    if spec is None or row.entity_id is None:
        return True
    model = getattr(importlib.import_module(spec[0]), spec[1])
    entity = db.get(model, row.entity_id)
    if entity is None:
        return False
    if getattr(entity, "archived_at", None) is not None:
        return False
    if row.entity_type == "pos_user" and getattr(entity, "is_active", True) is False:
        return False
    return True


def summary(db: Session, tenant_id: Any, *, outcome: Optional[Outcome] = None) -> Dict[str, Any]:
    """`GET /demo-company`: the organization's demo company, what it has, its devices and what to try."""
    from app.models.pairing_code import PairingCode
    from app.models.pos_machine import POSMachine

    rows = _rows(db, tenant_id)
    marker = rows.get("company")
    company = db.get(Company, marker.company_id) if marker is not None and marker.company_id else None
    if company is None:
        return {"exists": False, "companyName": COMPANY_NAME, "checklists": CHECKLISTS}
    now = _now()
    shops = []
    for key, spec in SHOPS.items():
        srow = rows.get(f"shop:{key}")
        shop = db.get(Shop, srow.entity_id) if srow is not None and srow.entity_id else None
        devices = []
        for dkey, label, role in DEVICES[key]:
            drow = rows.get(f"device:{key}:{dkey}")
            code = db.get(PairingCode, drow.entity_id) if drow is not None and drow.entity_id else None
            machine = db.get(POSMachine, code.pos_machine_id) if code is not None and code.pos_machine_id else None
            devices.append(device_out(dkey, label, role, code, machine, now))
        shops.append({
            "key": key,
            "id": str(shop.id) if shop is not None else None,
            "name": shop.name if shop is not None else spec["name"],
            "present": shop is not None,
            "trainingMode": bool(getattr(shop, "training_mode", False)) if shop is not None else False,
            "devices": devices,
            "checklist": CHECKLISTS[key],
        })
    items = [r for k, r in rows.items() if k not in (LOCK_KEY,)]
    removed = [
        {"key": r.item_key, "label": (r.data or {}).get("label") or r.item_key}
        for r in items if not _present(db, r)
    ]
    missing = [
        name for name, value in (
            ("vatNumber", company.vat_number), ("address", company.address), ("phone", company_phone(company)),
        ) if not (value or "").strip()
    ]
    digital = rows.get(f"digital_menu:{RESTAURANT}")
    # Employees whose code was random (no configured one): the owner sets theirs on "משתמשי קופה".
    random_codes = [
        (r.data or {}).get("label") or r.item_key
        for r in items
        if r.entity_type == "pos_user" and (r.data or {}).get("codeSource") == "random" and _present(db, r)
    ]
    out: Dict[str, Any] = {
        "exists": True,
        "company": {
            "id": str(company.id),
            "name": company.name,
            "vatNumber": company.vat_number,
            "dealerType": company.dealer_type,
            "address": company.address,
            "city": company.city,
            "phone": company_phone(company),
        },
        "missingDetails": missing,
        "shops": shops,
        "itemCount": len(items),
        "removedByOwner": removed,
        "employeesToSetCode": random_codes,
        "digitalMenuSlug": (digital.data or {}).get("slug") if digital is not None else None,
        "builtAt": _iso(marker.created_at),
    }
    if outcome is not None:
        out["created"] = outcome.created
        out["failed"] = outcome.failed
        out["notes"] = outcome.notes
    return out


def build(db: Session, user: User, tenant_id: Any, raw_details: Any, background_tasks: BackgroundTasks) -> Dict[str, Any]:
    """`POST /demo-company/build`: build what is missing (the super admin's only); the summary."""
    check_super_admin(user)
    if tenant_id is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="No active organization")
    details = Details.of(raw_details)
    _acquire(db, tenant_id, user)
    try:
        builder = _Builder(db, user, tenant_id, details, background_tasks)
        builder.run()
        logger.info(
            "demo company: build by %s — %d created, %d failed",
            getattr(user, "id", None), len(builder.out.created), len(builder.out.failed),
        )
        return summary(db, tenant_id, outcome=builder.out)
    finally:
        _release(db, tenant_id)
