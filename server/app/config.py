from pydantic_settings import BaseSettings
from typing import List
from functools import lru_cache


class Settings(BaseSettings):
    # Database
    database_url: str
    
    # JWT
    jwt_secret_key: str
    jwt_algorithm: str = "HS256"
    jwt_access_token_expire_minutes: int = 30
    
    # MQTT
    mqtt_broker_host: str = "localhost"
    mqtt_broker_port: int = 1883
    mqtt_broker_username: str = ""
    mqtt_broker_password: str = ""
    mqtt_client_id: str = "pos-server"
    
    # Application
    api_v1_prefix: str = "/api/v1"
    debug: bool = True
    cors_origins: List[str] = ["http://localhost:3000", "http://localhost:8080"]
    port: int = 8001
    
    # Pairing
    pairing_code_length: int = 8
    pairing_code_expiry_minutes: int = 15

    # Machine Auth
    machine_token_expire_days: int = 365

    # Clerk
    clerk_secret_key: str = ""
    clerk_jwks_url: str = ""   # e.g. https://<your-clerk-domain>/.well-known/jwks.json

    # Cloudinary
    cloudinary_cloud_name: str = ""
    cloudinary_api_key: str = ""
    cloudinary_api_secret: str = ""

    class Config:
        env_file = ".env"
        case_sensitive = False


@lru_cache()
def get_settings() -> Settings:
    return Settings()

