import warnings
import asyncio
import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic.warnings import UnsupportedFieldAttributeWarning

from app.config import get_settings
from app.observability.logging_config import configure_logging
from app.middleware.request_context import RequestContextMiddleware

configure_logging()
logger = logging.getLogger(__name__)

# FastAPI attaches body models inside generated unions; Pydantic 2.12+ then warns that
# `Field(alias=...)` on those inner arms has no effect (validation still uses the real model).
# The warning's `module` is unset; `message=` uses re.match from the start of the text.
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
from app.services.mqtt import mqtt_service

settings = get_settings()

# Create all database tables (Alembic handles migrations in prod)
Base.metadata.create_all(bind=engine)

app = FastAPI(
    title="POS Cloud",
    description="Cloud POS management platform — FastAPI backend with MQTT catalog notify + HTTP catalog pull",
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

# ── Routers ───────────────────────────────────────────────────────────────────
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


# ── Lifecycle ─────────────────────────────────────────────────────────────────

@app.on_event("startup")
async def startup_event():
    for attempt in range(1, 4):
        if mqtt_service.connect():
            return
        if attempt < 3:
            await asyncio.sleep(2)
    logger.warning("Could not connect to MQTT broker: %s", mqtt_service.last_error)


@app.on_event("shutdown")
async def shutdown_event():
    mqtt_service.disconnect()


# ── Health ────────────────────────────────────────────────────────────────────

@app.get("/")
def root():
    return {"message": "POS Cloud", "version": "0.2.0", "docs": "/docs"}


@app.get("/health")
def health_check():
    body = {"status": "healthy", "mqtt_connected": mqtt_service.connected}
    if mqtt_service.last_error:
        body["mqtt_last_error"] = mqtt_service.last_error
    return body
