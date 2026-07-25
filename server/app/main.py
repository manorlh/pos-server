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
    auth,
    users,
    machines,
    pairing,
    pairing_mobile,
    products,
    categories,
    companies,
    shops,
    catalog,
    sync,
    images,
    transactions,
    z_reports,
    pos_users,
    tenants,
    vouchers,
    stock,
    settings as settings_router,
    tips,
    dashboard,
    close_day,
)
from app.services.ably_notify import is_enabled as ably_enabled

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

_prefix = settings.api_v1_prefix

app.include_router(auth.router, prefix=_prefix)
app.include_router(users.router, prefix=_prefix)
app.include_router(companies.router, prefix=_prefix)
app.include_router(shops.router, prefix=_prefix)
app.include_router(machines.router, prefix=_prefix)
app.include_router(close_day.router, prefix=_prefix)
app.include_router(pairing.router, prefix=_prefix)
app.include_router(pairing_mobile.router, prefix=_prefix)
app.include_router(products.router, prefix=_prefix)
app.include_router(categories.router, prefix=_prefix)
app.include_router(vouchers.router, prefix=_prefix)
app.include_router(stock.router, prefix=_prefix)
app.include_router(tips.router, prefix=_prefix)
app.include_router(dashboard.router, prefix=_prefix)
app.include_router(catalog.router, prefix=_prefix)
app.include_router(sync.router, prefix=_prefix)
app.include_router(images.router, prefix=_prefix)
app.include_router(transactions.router, prefix=_prefix)
app.include_router(z_reports.router, prefix=_prefix)
app.include_router(pos_users.router, prefix=_prefix)
app.include_router(tenants.router, prefix=_prefix)
app.include_router(settings_router.router, prefix=_prefix)


@app.get("/")
def root():
    return {"message": "POS Cloud", "version": "0.2.0", "docs": "/docs"}


@app.get("/health")
def health_check():
    body = {"status": "healthy", "ably_enabled": ably_enabled()}
    return body
