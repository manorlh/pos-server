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
    
    # MQTT (local Mosquitto or EMQX Cloud — Serverless requires TLS on 8883)
    mqtt_broker_host: str = "localhost"
    mqtt_broker_port: int = 1883
    mqtt_broker_username: str = ""
    mqtt_broker_password: str = ""
    mqtt_client_id: str = "pos-server"
    mqtt_tls_enabled: bool = False
    mqtt_tls_ca_cert_path: str = ""  # path to EMQX server CA .crt (from Console → Overview)
    mqtt_tls_ca_cert: str = ""  # PEM string alternative (useful on Render without a file mount)
    # POS broker auth: machine_jwt = per-device JWT + EMQX HTTP /mqtt/auth (subscribe-only,
    # scoped topics). shared = legacy single broker login (no per-device isolation).
    mqtt_pos_auth_mode: str = "machine_jwt"
    mqtt_http_auth_secret: str = ""  # optional shared secret EMQX sends as X-MQTT-Auth-Secret
    
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

