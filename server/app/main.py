import warnings
import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic.warnings import UnsupportedFieldAttributeWarning

from app.config import get_settings
from app.observability.logging_config import configure_logging
from app.middleware.request_context import RequestContextMiddleware

configure_logging()
logger = logging.getLogger(__name__)

warnings.filterwarnings(
    "ignore",
    category=UnsupportedFieldAttributeWarning,
    message=r"The '.*has no effect in the context it was used",
)
from app.database import engine, Base
from app.routers import (
    system_access,
    auth,
    users,
    machines,
    pairing,
    pairing_mobile,
    elevation,
    products,
    product_availability,
    availability_reopen as availability_reopen_router,
    machine_catalog,
    categories,
    companies,
    shops,
    areas as areas_router,
    catalog,
    sync,
    images,
    transactions,
    z_reports,
    pos_users,
    tenants,
    vouchers,
    customers,
    stock,
    settings as settings_router,
    tips,
    dashboard,
    close_day,
    shifts as shifts_router,
    z_runs as z_runs_router,
    shift_close_requests as shift_close_requests_router,
    transmit_requests as transmit_requests_router,
    till_z_requests as till_z_requests_router,
    tax_reports,
    reports,
    till_parameters as till_parameters_router,
    app_releases as app_releases_router,
    accounting as accounting_router,
    sales_reports as sales_reports_router,
    till_messages as till_messages_router,
    prepaid_vouchers as prepaid_vouchers_router,
    prepaid_voucher_extras as prepaid_voucher_extras_router,
    till_shop_z as till_shop_z_router,
    main_till as main_till_router,
    lan_server as lan_server_router,
    z_mode as z_mode_router,
    z_participation as z_participation_router,
    till_shop_z_local as till_shop_z_local_router,
    exceptions as exceptions_router,
    promotions as promotions_router,
    tables as tables_router,
    printers as printers_router,
    menu as menu_router,
    insights as insights_router,
    report_events as report_events_router,
    catalog_import as catalog_import_router,
    training_mode as training_mode_router,
)
from app.routers import user_sessions as user_sessions_router
from app.routers import printer_discovery as printer_discovery_router, printer_zones as printer_zones_router
from app.routers import print_redirects as print_redirects_router
from app.services.ably_notify import is_enabled as ably_enabled
from starlette.middleware.gzip import GZipMiddleware

settings = get_settings()

Base.metadata.create_all(bind=engine)

app = FastAPI(
    title="POS Cloud",
    description="Cloud POS management platform — Ably realtime notify + HTTP catalog pull",
    version="0.2.0",
)

# "מכשיר תצוגה אינו קופה": `{"detail": "device_not_fiscal", "message": <Hebrew>}` for a fiscal
# action asked of a KDS / board (app/services/display_devices.py).
from app.services.display_devices import DeviceNotFiscal, not_fiscal_handler  # noqa: E402

app.add_exception_handler(DeviceNotFiscal, not_fiscal_handler)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(RequestContextMiddleware)
# Compressed answers: a till pulls the tables' state (≈140 KB at 200 tables) every few
# seconds, and the catalog on every sync — gzip takes them to a tenth. OkHttp asks for it
# and unpacks it by itself; small answers are left as they are.
app.add_middleware(GZipMiddleware, minimum_size=1024)

_prefix = settings.api_v1_prefix

app.include_router(auth.router, prefix=_prefix)
app.include_router(system_access.router, prefix=_prefix)
# "הרשאות דשבורד" (app/routers/dashboard_access.py): per dashboard user — sections, org scope,
# templates and their history. Enforced for every route in `get_current_user`.
from app.routers import dashboard_access as dashboard_access_router  # noqa: E402

app.include_router(dashboard_access_router.router, prefix=_prefix)
app.include_router(users.router, prefix=_prefix)
app.include_router(companies.router, prefix=_prefix)
app.include_router(shops.router, prefix=_prefix)
app.include_router(areas_router.router, prefix=_prefix)
# "חיפוש מכשיר" (app/routers/machine_search.py): before the machines router, so
# `/machines/search` is never read as `/machines/{machine_id}`.
from app.routers import machine_search as machine_search_router  # noqa: E402

app.include_router(machine_search_router.router, prefix=_prefix)
app.include_router(machines.router, prefix=_prefix)
app.include_router(close_day.router, prefix=_prefix)
app.include_router(pairing.router, prefix=_prefix)
app.include_router(pairing_mobile.router, prefix=_prefix)
app.include_router(elevation.router, prefix=_prefix)
app.include_router(products.router, prefix=_prefix)
# "מופיע ב" — a product's four channels, their exceptions and the bulk screen.
from app.routers import product_channels as product_channels_router  # noqa: E402

app.include_router(product_channels_router.router, prefix=_prefix)
# "סדר תצוגה" — one ordering model for the tills, the kiosks, online ordering and the digital menu.
from app.routers import display_orderings as display_orderings_router  # noqa: E402

app.include_router(display_orderings_router.router, prefix=_prefix)
# "תפריט דיגיטלי" / "הזמנות אונליין": profiles, revisions, publication; and their public read API.
from app.routers import presentation_profiles as presentation_profiles_router  # noqa: E402
from app.routers import public_digital as public_digital_router  # noqa: E402

app.include_router(presentation_profiles_router.menu_router, prefix=_prefix)
app.include_router(presentation_profiles_router.online_router, prefix=_prefix)
app.include_router(public_digital_router.public_router, prefix=_prefix)
app.include_router(product_availability.router, prefix=_prefix)
app.include_router(availability_reopen_router.router, prefix=_prefix)
app.include_router(machine_catalog.router, prefix=_prefix)
app.include_router(categories.router, prefix=_prefix)
app.include_router(vouchers.router, prefix=_prefix)
app.include_router(customers.router, prefix=_prefix)
app.include_router(stock.router, prefix=_prefix)
# "שליטה חיה בסניף": blocks on items ("אזל" / "חסום"), remote control of tills and kiosks.
from app.routers import item_blocks as item_blocks_router  # noqa: E402
from app.routers import device_commands as device_commands_router  # noqa: E402

app.include_router(item_blocks_router.router, prefix=_prefix)
# A till, a kiosk's staff screen, a controlling till: "חסום / אזל" and "חסומים כעת" (specs/item-blocks-targets.md).
app.include_router(item_blocks_router.till_router, prefix=_prefix)
# Stock over the hierarchy: quick stock, transfers, managed levels, alerts, the daily reset.
from app.routers import stock_live as stock_live_router  # noqa: E402

app.include_router(stock_live_router.router, prefix=_prefix)
# "יעדים ותחרות" (app/routers/targets.py): targets, progress, the till's leaderboard.
from app.routers import targets as targets_router  # noqa: E402

app.include_router(targets_router.router, prefix=_prefix)
app.include_router(targets_router.till_router, prefix=_prefix)
app.include_router(device_commands_router.router, prefix=_prefix)
app.include_router(device_commands_router.till_router, prefix=_prefix)
app.include_router(tips.router, prefix=_prefix)
app.include_router(tax_reports.router, prefix=_prefix)
# After tax_reports: both mount under /reports, and the literal /reports/tax/...
# routes must win over /reports/{machine_id}/shop-transactions.
app.include_router(reports.router, prefix=_prefix)
app.include_router(dashboard.router, prefix=_prefix)
app.include_router(catalog.router, prefix=_prefix)
app.include_router(sync.router, prefix=_prefix)
app.include_router(images.router, prefix=_prefix)
# Images stored on this server when Cloudinary is not configured (app/services/local_media.py).
# A plain route, not StaticFiles: Starlette resolves the directory's real path, and on a
# subst'ed drive (P: → C:\…) that ends in "paths don't have the same drive" and a 500.
from app.services.local_media import MEDIA_PREFIX as _MEDIA_PREFIX, media_file_response as _media_file_response
app.add_api_route(_MEDIA_PREFIX + "/{path:path}", _media_file_response, methods=["GET"], include_in_schema=False)
app.include_router(transactions.router, prefix=_prefix)
app.include_router(z_reports.router, prefix=_prefix)
app.include_router(shifts_router.router, prefix=_prefix)
app.include_router(z_runs_router.router, prefix=_prefix)
app.include_router(shift_close_requests_router.router, prefix=_prefix)
app.include_router(transmit_requests_router.router, prefix=_prefix)
app.include_router(till_z_requests_router.router, prefix=_prefix)
app.include_router(pos_users.router, prefix=_prefix)
app.include_router(tenants.router, prefix=_prefix)
app.include_router(settings_router.router, prefix=_prefix)
app.include_router(till_parameters_router.router, prefix=_prefix)
app.include_router(app_releases_router.router, prefix=_prefix)
# "התקנת גשר ל-Windows" (app/routers/windows_bridge.py, docs/SPEC_KIOSK.md §28): the installer for machine admins.
from app.routers import windows_bridge as windows_bridge_router  # noqa: E402

app.include_router(windows_bridge_router.router, prefix=_prefix)
# "עדכון שקט" (app/routers/device_management.py): the provisioning QR and its APK link, "הפעל מחדש".
from app.routers import device_management as device_management_router  # noqa: E402

app.include_router(device_management_router.router, prefix=_prefix)
app.include_router(accounting_router.router, prefix=_prefix)
app.include_router(sales_reports_router.router, prefix=_prefix)
app.include_router(till_messages_router.router, prefix=_prefix)
app.include_router(prepaid_vouchers_router.router, prefix=_prefix)
# Settlement, deliveries, replacements, §15 reports, §18 controls and the simulator (helper).
app.include_router(prepaid_voucher_extras_router.router, prefix=_prefix)
app.include_router(till_shop_z_router.router, prefix=_prefix)
app.include_router(main_till_router.router, prefix=_prefix)
# "רשת מקומית" and "לא משמש כשרת מקומי" (docs/SPEC_LAN_MODE.md §3–4).
app.include_router(lan_server_router.router, prefix=_prefix)
app.include_router(z_mode_router.router, prefix=_prefix)
app.include_router(z_participation_router.router, prefix=_prefix)
# "תצורת עבודה למכשיר" (docs/SPEC_DEVICE_WORK_CONFIG.md): a device's way of working in one place.
from app.routers import work_config as work_config_router  # noqa: E402

app.include_router(work_config_router.router, prefix=_prefix)
app.include_router(till_shop_z_local_router.router, prefix=_prefix)
app.include_router(exceptions_router.router, prefix=_prefix)
app.include_router(exceptions_router.till_router, prefix=_prefix)
# "עסקאות שלא הושלמו" (docs/SPEC_FAILED_PAYMENTS.md): the till's failed payment attempts and the dashboard's list.
from app.routers import failed_payments as failed_payments_router  # noqa: E402

app.include_router(failed_payments_router.till_router, prefix=_prefix)
app.include_router(failed_payments_router.router, prefix=_prefix)
# "זיכוי מרחוק" (docs/SPEC_REMOTE_CREDIT.md): the dashboard asks a till to issue a credit.
from app.routers import remote_credits as remote_credits_router  # noqa: E402

app.include_router(remote_credits_router.till_router, prefix=_prefix)
app.include_router(remote_credits_router.router, prefix=_prefix)
# "זיכוי באשראי מהענן (Z-Credit)" (docs/SPEC_REMOTE_CREDIT.md §11): the cloud refunds the card,
# a till issues the credit note.
from app.routers import cloud_card_refunds as cloud_card_refunds_router  # noqa: E402

app.include_router(cloud_card_refunds_router.router, prefix=_prefix)
app.include_router(promotions_router.router, prefix=_prefix)
app.include_router(tables_router.router, prefix=_prefix)
app.include_router(printers_router.router, prefix=_prefix)
# "חיפוש מדפסות ברשת" and "הפניה לפי אזור שולחנות" (docs/SPEC_PRINT_BY_ZONE.md).
app.include_router(printer_discovery_router.router, prefix=_prefix)
app.include_router(printer_zones_router.router, prefix=_prefix)
app.include_router(print_redirects_router.router, prefix=_prefix)
app.include_router(menu_router.router, prefix=_prefix)
app.include_router(insights_router.router, prefix=_prefix)
app.include_router(report_events_router.router, prefix=_prefix)
# The menu as a spreadsheet; the public half is the share link's download (no login).
app.include_router(catalog_import_router.router, prefix=_prefix)
app.include_router(catalog_import_router.public_router, prefix=_prefix)
# "מצב הדרכה" and the demo menu (docs/SPEC_TRAINING_MODE.md).
app.include_router(training_mode_router.router, prefix=_prefix)
# "עובד מחובר בקופה אחת בלבד" (docs/SPEC_EXCLUSIVE_LOGIN.md): the till's claim / heartbeat /
# release, and the dashboard's who-is-signed-in-where.
app.include_router(user_sessions_router.till_router, prefix=_prefix)
app.include_router(user_sessions_router.router, prefix=_prefix)
# "נוכחות עובדים" (docs/SPEC_ATTENDANCE.md): the till's clock-in/out/break actions and the
# dashboard's live board, report and corrections — separate from the sign-in above.
from app.routers import attendance as attendance_router  # noqa: E402

app.include_router(attendance_router.till_router, prefix=_prefix)
app.include_router(attendance_router.router, prefix=_prefix)
# "סקירת שינויים לפני שידור לקופות" (docs/SPEC_MENU_BROADCAST_REVIEW.md).
from app.routers import menu_broadcast as menu_broadcast_router  # noqa: E402

app.include_router(menu_broadcast_router.router, prefix=_prefix)
# "סוג אינטגרציית אשראי" — what a settings layer's form needs (docs/SPEC_ZCREDIT.md).
from app.routers import payment_integration as payment_integration_router  # noqa: E402

app.include_router(payment_integration_router.router, prefix=_prefix)
# "צימוד מסוף SynqPay" from the till: the key it paired, a key the terminal refused (docs/SPEC_SYNQPAY.md §2.2).
from app.routers import synqpay_pairing as synqpay_pairing_router  # noqa: E402

app.include_router(synqpay_pairing_router.router, prefix=_prefix)
# "מכשירי תשלום": a shop's card terminals for tills without one of their own.
from app.routers import payment_devices as payment_devices_router  # noqa: E402

app.include_router(payment_devices_router.router, prefix=_prefix)
# "שירות הודעות ו-019" + "מועדון לקוחות" and its public sign-up (docs/SPEC_NOTIFICATIONS_CLUB.md).
from app.routers import club as club_router, notifications as notifications_router  # noqa: E402

app.include_router(notifications_router.router, prefix=_prefix)
app.include_router(notifications_router.till_router, prefix=_prefix)
app.include_router(club_router.router, prefix=_prefix)
app.include_router(club_router.till_router, prefix=_prefix)
app.include_router(club_router.public_router, prefix=_prefix)


@app.on_event("startup")
def start_notifications_worker():
    """The SMS queue worker (lease-safe across processes); NOTIFICATIONS_WORKER_ENABLED=false stops it."""
    if not settings.notifications_worker_enabled:
        return
    from app.database import SessionLocal
    from app.services.notifications.worker import start_background_worker

    start_background_worker(SessionLocal)


# "יומן חריגות" + "התראות SMS על חריגות" (app/services/exception_alerts): the log of every
# detected exception, and the SMS alert rules (dry run unless EXCEPTION_ALERTS_SMS_PROVIDER).
from app.routers import exception_alerts as exception_alerts_router, exception_log as exception_log_router  # noqa: E402

app.include_router(exception_log_router.router, prefix=_prefix)
app.include_router(exception_alerts_router.router, prefix=_prefix)


@app.on_event("startup")
def check_remote_till_z_config():
    """REMOTE_TILL_Z_MIN_TILL_VERSION, when set, must be a till version code — refused loudly otherwise."""
    from app.services import remote_till_z

    remote_till_z.check_config()


@app.on_event("startup")
def start_stock_reset_worker():
    """"איפוס יומי": each stock location at its business day's start (app/services/stock_reset.py)."""
    import os

    if os.environ.get("STOCK_RESET_WORKER_ENABLED", "true").lower() in ("0", "false", "no"):
        return
    from app.database import SessionLocal
    from app.services.stock_reset import start_background_worker as start_reset_worker

    start_reset_worker(SessionLocal)


@app.on_event("startup")
def start_sales_targets_worker():
    """
    "יעד הושג" every minute (app/services/sales_targets_worker.py) — its own job, never tied to stock
    (`STOCK_LOCATIONS_ENABLED` / `STOCK_RESET_WORKER_ENABLED`); SALES_TARGETS_WORKER_ENABLED=false stops it.
    """
    from app.database import SessionLocal
    from app.services.sales_targets_worker import start_background_worker as start_targets_worker

    start_targets_worker(SessionLocal)


@app.on_event("startup")
def start_exception_alerts_worker():
    """The digests of rate-limited / quiet-hours alerts; EXCEPTION_ALERTS_WORKER_ENABLED=false stops it."""
    if not getattr(settings, "exception_alerts_worker_enabled", True):
        return
    from app.database import SessionLocal
    from app.services.exception_alerts.worker import start_background_worker as start_alerts_worker

    start_alerts_worker(SessionLocal)
# KDS and "תצורת עבודה לעמדה" (docs/SPEC_KDS.md): releases, screens, the workflow card.
from app.routers import kds as kds_router  # noqa: E402

app.include_router(kds_router.router, prefix=_prefix)
# The customer self-order kiosk (app/routers/kiosks.py): the till's kiosk sync, orders,
# pickup numbers and controller commands, and the dashboard's kiosks and their config.
from app.routers import kiosks as kiosks_router  # noqa: E402
# "ביצועי קיוסקים" / "תקינות מכשירים" (app/routers/kiosk_insights.py, docs/SPEC_KIOSK_INSIGHTS.md):
# mounted first, so `/kiosks/health` is never read as a kiosk's id.
from app.routers import kiosk_insights as kiosk_insights_router  # noqa: E402

app.include_router(kiosk_insights_router.till_router, prefix=_prefix)
app.include_router(kiosk_insights_router.router, prefix=_prefix)
# "שליטה מרחוק בקיוסקים" (app/routers/kiosk_live.py): mounted before the kiosks' /{machine_id} routes.
from app.routers import kiosk_live as kiosk_live_router  # noqa: E402

app.include_router(kiosk_live_router.router, prefix=_prefix)
app.include_router(kiosks_router.till_router, prefix=_prefix)
app.include_router(kiosks_router.router, prefix=_prefix)
# "עיצוב קופה" (app/routers/till_design.py, docs/SPEC_TILL_DESIGN.md): the till's design sync
# and the dashboard's design layers company → shop → area → till.
from app.routers import till_design as till_design_router  # noqa: E402

app.include_router(till_design_router.till_router, prefix=_prefix)
app.include_router(till_design_router.router, prefix=_prefix)
# A kiosk's alerts on the tills ("התראות לקופות", app/routers/kiosk_alerts.py).
from app.routers import kiosk_alerts as kiosk_alerts_router  # noqa: E402

app.include_router(kiosk_alerts_router.till_router, prefix=_prefix)
# "תשלום בקופה": kiosk orders paid at the till (app/routers/kiosk_open_orders.py, SPEC_KIOSK §23).
from app.routers import kiosk_open_orders as kiosk_open_orders_router  # noqa: E402

app.include_router(kiosk_open_orders_router.till_router, prefix=_prefix)
# "בדיקות ומידע קיוסק": where a till stands, for the kiosk's technician screen (app/routers/kiosk_technician.py).
from app.routers import kiosk_technician as kiosk_technician_router  # noqa: E402

app.include_router(kiosk_technician_router.till_router, prefix=_prefix)
# The Android kiosk's web renderer status (kiosk web bundles, app/routers/kiosk_web.py).
from app.routers import kiosk_web as kiosk_web_router  # noqa: E402

app.include_router(kiosk_web_router.till_router, prefix=_prefix)
# "תפריטים" (docs/SPEC_MENUS.md): named sales menus by schedule, their assignments, what is
# active where and the report by menu. The tills get them in the catalog pull.
from app.routers import catalog_menus as catalog_menus_router  # noqa: E402

app.include_router(catalog_menus_router.router, prefix=_prefix)
# "קבוצות מכשירים": named groups of tills, a menu assignment level of their own.
from app.routers import machine_groups as machine_groups_router  # noqa: E402

app.include_router(machine_groups_router.router, prefix=_prefix)
# The report center (docs/SPEC_REPORTS.md): the consolidated Z table, "דוח שמכיל הכל", the
# reconciliation (transactions ↔ Zs ↔ transmissions) and the transmissions across tills.
from app.routers import report_center as report_center_router  # noqa: E402

app.include_router(report_center_router.router, prefix=_prefix)
# "תפקידים והרשאות" for till users and "מגירת מזומן" (docs/SPEC_ROLES_PERMISSIONS.md).
from app.routers import till_roles as till_roles_router  # noqa: E402

app.include_router(till_roles_router.router, prefix=_prefix)
from app.routers import cash_drawer as cash_drawer_router  # noqa: E402

app.include_router(cash_drawer_router.till_router, prefix=_prefix)
app.include_router(cash_drawer_router.router, prefix=_prefix)

# ── Event and owner awareness (feat/event-live) ──
# "מצב אירוע חי": the event's live screen (app/services/report_events/live.py).
from app.routers import event_live as event_live_router  # noqa: E402

app.include_router(event_live_router.router, prefix=_prefix)
# "התראות לטלפון": Web Push on the exception alerts (app/services/exception_alerts/push.py).
from app.routers import push_alerts as push_alerts_router  # noqa: E402

app.include_router(push_alerts_router.router, prefix=_prefix)
# "עמדת מפיק": the producer's read-only portal, and the owner's side on the event.
from app.routers import event_producers as event_producers_router, producer as producer_router  # noqa: E402

app.include_router(producer_router.router, prefix=_prefix)
app.include_router(event_producers_router.router, prefix=_prefix)
# "תחזית ואיוש": the forecast per shop and the tills to open (app/services/insights/staffing.py).
from app.routers import forecast_staffing as forecast_staffing_router  # noqa: E402

app.include_router(forecast_staffing_router.router, prefix=_prefix)

# "הפצה בוואטסאפ" (app/routers/voucher_distribution.py): prepaid vouchers per recipient, their
# public links, and the optional WhatsApp Cloud API (off unless WHATSAPP_CLOUD_API_ENABLED).
from app.routers import voucher_distribution as voucher_distribution_router  # noqa: E402

app.include_router(voucher_distribution_router.router, prefix=_prefix)
app.include_router(voucher_distribution_router.public_router, prefix=_prefix)


@app.on_event("startup")
def start_whatsapp_distribution_worker():
    """Cloud API retries; does nothing unless WHATSAPP_CLOUD_API_ENABLED (and WHATSAPP_WORKER_ENABLED)."""
    from app.database import SessionLocal
    from app.services.whatsapp_cloud import start_background_worker as start_whatsapp_worker

    start_whatsapp_worker(SessionLocal)


@app.on_event("startup")
def seed_builtin_till_parameters():
    """
    The till parameters the cloud itself reads (`shopZOpenTills`, `receiptLogoUrl`), created if missing.
    Never fatal: without them the rules they drive simply do not apply. Also available
    as `python -m scripts.seed_till_parameters`.
    """
    from app.database import SessionLocal
    from app.services.till_parameters import ensure_builtin_parameters

    db = SessionLocal()
    try:
        created = ensure_builtin_parameters(db)
        db.commit()
        if created:
            logger.info("Created built-in till parameters: %s", ", ".join(created))
    except Exception:  # noqa: BLE001 - see the docstring
        db.rollback()
        logger.exception("Could not create the built-in till parameters")
    finally:
        db.close()


@app.get("/")
def root():
    return {"message": "POS Cloud", "version": "0.2.0", "docs": "/docs"}


@app.get("/health")
def health_check():
    body = {"status": "healthy", "ably_enabled": ably_enabled()}
    return body
