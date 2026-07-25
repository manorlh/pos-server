from functools import lru_cache
from typing import List

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        # `.env.local` overrides `.env` for local docker db/mqtt without touching prod secrets.
        env_file=(".env", ".env.local"),
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )
    # Database
    database_url: str
    
    # JWT
    jwt_secret_key: str
    jwt_algorithm: str = "HS256"
    jwt_access_token_expire_minutes: int = 30
    
    # Ably realtime notify (per-machine channel + token auth from GET /machines/me/ably-auth)
    ably_api_key: str = ""
    
    # Application
    api_v1_prefix: str = "/api/v1"
    debug: bool = True
    log_level: str = "INFO"
    log_request_bodies: bool = False
    log_body_max_bytes: int = 4096
    cors_origins: List[str] = ["http://localhost:3000", "http://localhost:8080"]
    port: int = 8001
    
    # Pairing
    pairing_code_length: int = 8
    pairing_code_expiry_minutes: int = 15
    pairing_session_expire_hours: int = 12
    device_pairing_nonce_expire_minutes: int = 15
    pairing_mobile_app_base_url: str = "http://localhost:3002"

    # Machine Auth
    machine_token_expire_days: int = 365

    # Clerk
    clerk_secret_key: str = ""
    clerk_jwks_url: str = ""   # e.g. https://<your-clerk-domain>/.well-known/jwks.json
    allow_self_service_signup: bool = True

    # Cloudinary
    cloudinary_cloud_name: str = ""
    cloudinary_api_key: str = ""
    cloudinary_api_secret: str = ""


@lru_cache()
def get_settings() -> Settings:
    return Settings()

