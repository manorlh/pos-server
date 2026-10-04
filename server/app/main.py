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
    tax_reports,
    reports,
    till_parameters as till_parameters_router,
    app_releases as app_releases_router,
    accounting as accounting_router,
    sales_reports as sales_reports_router,
    till_messages as till_messages_router,
    prepaid_vouchers as prepaid_vouchers_router,
    till_shop_z as till_shop_z_router,
    main_till as main_till_router,
    exceptions as exceptions_router,
    promotions as promotions_router,
    tables as tables_router,
    printers as printers_router,
    menu as menu_router,
    insights as insights_router,
    catalog_import as catalog_import_router,
)
from app.services.ably_notify import is_enabled as ably_enabled
from starlette.middleware.gzip import GZipMiddleware

settings = get_settings()

Base.metadata.create_all(bind=engine)

app = FastAPI(
    title="POS Cloud",
    description="Cloud POS management platform — Ably realtime notify + HTTP catalog pull",
    version="0.2.0",
)

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
app.include_router(users.router, prefix=_prefix)
app.include_router(companies.router, prefix=_prefix)
app.include_router(shops.router, prefix=_prefix)
app.include_router(areas_router.router, prefix=_prefix)
app.include_router(machines.router, prefix=_prefix)
app.include_router(close_day.router, prefix=_prefix)
app.include_router(pairing.router, prefix=_prefix)
app.include_router(pairing_mobile.router, prefix=_prefix)
app.include_router(elevation.router, prefix=_prefix)
app.include_router(products.router, prefix=_prefix)
app.include_router(product_availability.router, prefix=_prefix)
app.include_router(machine_catalog.router, prefix=_prefix)
app.include_router(categories.router, prefix=_prefix)
app.include_router(vouchers.router, prefix=_prefix)
app.include_router(customers.router, prefix=_prefix)
app.include_router(stock.router, prefix=_prefix)
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
app.include_router(pos_users.router, prefix=_prefix)
app.include_router(tenants.router, prefix=_prefix)
app.include_router(settings_router.router, prefix=_prefix)
app.include_router(till_parameters_router.router, prefix=_prefix)
app.include_router(app_releases_router.router, prefix=_prefix)
app.include_router(accounting_router.router, prefix=_prefix)
app.include_router(sales_reports_router.router, prefix=_prefix)
app.include_router(till_messages_router.router, prefix=_prefix)
app.include_router(prepaid_vouchers_router.router, prefix=_prefix)
app.include_router(till_shop_z_router.router, prefix=_prefix)
app.include_router(main_till_router.router, prefix=_prefix)
app.include_router(exceptions_router.router, prefix=_prefix)
app.include_router(exceptions_router.till_router, prefix=_prefix)
app.include_router(promotions_router.router, prefix=_prefix)
app.include_router(tables_router.router, prefix=_prefix)
app.include_router(printers_router.router, prefix=_prefix)
app.include_router(menu_router.router, prefix=_prefix)
app.include_router(insights_router.router, prefix=_prefix)
# The menu as a spreadsheet; the public half is the share link's download (no login).
app.include_router(catalog_import_router.router, prefix=_prefix)
app.include_router(catalog_import_router.public_router, prefix=_prefix)


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
