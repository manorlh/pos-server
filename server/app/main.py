import warnings

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic.warnings import UnsupportedFieldAttributeWarning

from app.config import get_settings

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
    merchants,
    machines,
    pairing,
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
)
from app.services.mqtt import mqtt_service

settings = get_settings()

# Create all database tables (Alembic handles migrations in prod)
Base.metadata.create_all(bind=engine)

app = FastAPI(
    title="POS Cloud Server",
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

# ── Routers ───────────────────────────────────────────────────────────────────
_prefix = settings.api_v1_prefix

app.include_router(auth.router, prefix=_prefix)
app.include_router(users.router, prefix=_prefix)
app.include_router(merchants.router, prefix=_prefix)
app.include_router(companies.router, prefix=_prefix)
app.include_router(shops.router, prefix=_prefix)
app.include_router(machines.router, prefix=_prefix)
app.include_router(pairing.router, prefix=_prefix)
app.include_router(products.router, prefix=_prefix)
app.include_router(categories.router, prefix=_prefix)
app.include_router(catalog.router, prefix=_prefix)
app.include_router(sync.router, prefix=_prefix)
app.include_router(images.router, prefix=_prefix)
app.include_router(transactions.router, prefix=_prefix)
app.include_router(z_reports.router, prefix=_prefix)
app.include_router(pos_users.router, prefix=_prefix)
app.include_router(tenants.router, prefix=_prefix)


# ── Lifecycle ─────────────────────────────────────────────────────────────────

@app.on_event("startup")
async def startup_event():
    try:
        mqtt_service.connect()
    except Exception as exc:
        print(f"Warning: Could not connect to MQTT broker: {exc}")


@app.on_event("shutdown")
async def shutdown_event():
    mqtt_service.disconnect()


# ── Health ────────────────────────────────────────────────────────────────────

@app.get("/")
def root():
    return {"message": "POS Cloud Server", "version": "0.2.0", "docs": "/docs"}


@app.get("/health")
def health_check():
    return {"status": "healthy", "mqtt_connected": mqtt_service.connected}
