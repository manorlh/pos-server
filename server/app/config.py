from functools import lru_cache
from pathlib import Path
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

    # Card-integration secrets at rest (the Z-Credit terminal password,
    # app/services/payment_secrets.py): a Fernet key or a passphrase. Empty = derived
    # from jwt_secret_key; set it in production before rotating that key.
    payment_secrets_key: str = ""

    # "זיכוי באשראי מהענן (Z-Credit)" (docs/SPEC_REMOTE_CREDIT.md §11): the cloud refunds a
    # Z-Credit card sale through Z-Credit's web API, and a till issues the credit note
    # (remote-credit mode `card_refunded`). OFF by default: with it off the dashboard shows
    # the option disabled and no request ever goes to Z-Credit. Turn it on only once the
    # tills that will issue those credit notes run a version that knows the mode.
    zcredit_cloud_refunds_enabled: bool = False

    # "קופת WEB" (web-till spec v2 §9.1): a till on the "web" (browser) and "ios" platforms —
    # the till screens of the r2m-app bundle, driven by a till engine. OFF by default: with it
    # off a web / iOS code is a kiosk's, a KDS's or a board's only (422 `web_platform_not_a_till`),
    # exactly as before (app/services/display_devices.py `web_till_enabled`).
    web_till_enabled: bool = False
    # The "r2m-app" screens bundle (release platform "web_app", app/services/web_bundles.py) is
    # signed with Ed25519 in CI; these are the public keys the server checks an upload against:
    # base64 of the raw 32-byte keys, comma separated (two while a key is rotated). Empty = no
    # "r2m-app" upload is accepted. Public keys only — the private key is never on a server.
    web_bundle_public_keys: str = ""

    # Notifications / 019 SMS (docs/SPEC_NOTIFICATIONS_CLUB.md). Live sending is its own
    # explicit switch, OFF by default: with it off no request ever goes to 019's live
    # endpoint, whatever a provider config says (mock and 019's /api/test only).
    notifications_live_sending_enabled: bool = False
    # The background queue worker in the API process (lease-safe across processes).
    notifications_worker_enabled: bool = True
    # Dev only: a super admin may read the mock provider's in-process inbox (to finish
    # an OTP sign-up locally). Never on in production.
    notifications_mock_inbox: bool = False
    # Base URL of the public club sign-up page (QR codes point to <base>/<token>).
    # Empty = <pairing_mobile_app_base_url>/join.
    club_join_base_url: str = ""

    # "התראות SMS על חריגות" (app/services/exception_alerts). Which SMS provider the
    # exception alerts use: "dry_run" (the default — nothing leaves the server; every
    # message is recorded in the exceptions log and the process log only) or
    # "notifications" (the 019 queue above, under ITS own mock / test / live gates).
    # Anything else falls back to dry_run.
    exception_alerts_sms_provider: str = "dry_run"
    # Base URL of the dashboard for the SMS link (<base>/x/<code>). Empty =
    # pairing_mobile_app_base_url (the dashboard's public URL).
    exception_alerts_link_base_url: str = ""
    # The background digest pass (rate-limited / quiet-hours alerts summed up afterwards).
    exception_alerts_worker_enabled: bool = True

    # "התראות לטלפון" (Web Push, app/services/webpush.py): the VAPID key pair, base64url — the
    # 65-byte public point and the 32-byte private scalar (`python -m scripts.generate_vapid_keys`).
    # Set only in the environment; never committed. Both empty = phone alerts off.
    webpush_vapid_public_key: str = ""
    webpush_vapid_private_key: str = ""
    # The contact the push services see ("mailto:…" or "https://…"). Empty = the dashboard's
    # https URL when it has one.
    webpush_vapid_subject: str = ""

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
    # There is deliberately no machine-token lifetime setting. Machine tokens do not
    # expire: a terminal is not a person, and an expiry only ever produced an outage
    # nobody was on site to fix. Revocation is `pos_machines.token_version`, bumped
    # when an admin unpairs, and checked on every request.

    # Till elevation (a manager authorising an action at a terminal)
    # Idle window: slides forward on every authorised call, so someone actively
    # working never expires mid-task. Only walking away expires.
    elevated_session_idle_minutes: int = 15
    # Hard ceiling sliding cannot pass, so a grant never outlives a shift.
    elevated_session_absolute_hours: int = 8
    # Counted per user, not per IP: every till in a shop shares one NAT address.
    till_pin_max_attempts: int = 5
    till_pin_lockout_minutes: int = 5
    till_pin_min_length: int = 4
    till_pin_max_length: int = 12

    # Clerk
    clerk_secret_key: str = ""
    clerk_jwks_url: str = ""   # e.g. https://<your-clerk-domain>/.well-known/jwks.json
    allow_self_service_signup: bool = True

    # Cloudinary
    cloudinary_cloud_name: str = ""
    cloudinary_api_key: str = ""
    cloudinary_api_secret: str = ""

    # Product image background removal (POST /images/upload?resource=products).
    # A per-upload `keepBackground=true` skips it; this switches it off server-wide.
    product_image_bg_removal: bool = True
    # rembg model: isnet-general-use (~170 MB, ~1.5 s per image on CPU) cuts cleaner
    # than u2netp (~5 MB, ~0.2 s). Downloaded on the first product upload.
    product_image_bg_model: str = "isnet-general-use"
    product_image_bg_model_dir: str = str(Path(__file__).resolve().parent.parent / "var" / "rembg")
    product_image_max_side: int = 1024

    # Till app releases ("עדכון קופות"): uploaded APKs, one `<release id>.apk` each.
    # Local disk, not Cloudinary — the tills download them through the API, which
    # checks that the release is the one assigned to that till.
    app_releases_dir: str = str(Path(__file__).resolve().parent.parent / "var" / "app_releases")
    app_release_max_bytes: int = 200 * 1024 * 1024


@lru_cache()
def get_settings() -> Settings:
    return Settings()

