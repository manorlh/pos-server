"""
Clerk JWT verification using JWKS.
Verifies tokens issued by Clerk and extracts the Clerk user_id (sub).
"""
import time
import httpx
from typing import Optional
from jose import jwt, JWTError
from app.config import get_settings

settings = get_settings()

# Simple in-memory JWKS cache (refreshed every hour)
_jwks_cache: Optional[dict] = None
_jwks_cached_at: float = 0
_JWKS_TTL = 3600  # seconds


def _get_jwks() -> dict:
    global _jwks_cache, _jwks_cached_at
    now = time.time()
    if _jwks_cache is None or (now - _jwks_cached_at) > _JWKS_TTL:
        response = httpx.get(settings.clerk_jwks_url, timeout=10)
        response.raise_for_status()
        _jwks_cache = response.json()
        _jwks_cached_at = now
    return _jwks_cache


def verify_clerk_token(token: str) -> Optional[str]:
    """
    Verify a Clerk session JWT and return the Clerk user_id (sub claim).
    Returns None if the token is invalid or Clerk is not configured.
    """
    if not settings.clerk_jwks_url:
        return None
    try:
        jwks = _get_jwks()
        # Decode without verification first to get the kid
        unverified_header = jwt.get_unverified_header(token)
        kid = unverified_header.get("kid")

        # Find the matching key
        rsa_key = None
        for key in jwks.get("keys", []):
            if key.get("kid") == kid:
                rsa_key = key
                break

        if rsa_key is None:
            # Refresh cache and retry once
            global _jwks_cache
            _jwks_cache = None
            jwks = _get_jwks()
            for key in jwks.get("keys", []):
                if key.get("kid") == kid:
                    rsa_key = key
                    break

        if rsa_key is None:
            return None

        payload = jwt.decode(
            token,
            rsa_key,
            algorithms=["RS256"],
            options={"verify_aud": False},
        )
        return payload.get("sub")  # Clerk user_id like "user_2abc123"
    except (JWTError, Exception):
        return None
