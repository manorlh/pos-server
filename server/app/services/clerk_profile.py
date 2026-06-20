"""
Fetch Clerk user profile from the Backend API (used on first-login provisioning).
"""
from dataclasses import dataclass
from typing import Optional

import httpx

from app.config import get_settings

settings = get_settings()


@dataclass(frozen=True)
class ClerkProfile:
    clerk_user_id: str
    email: str
    first_name: Optional[str]
    last_name: Optional[str]
    clerk_username: Optional[str]


def fetch_clerk_profile(clerk_user_id: str) -> Optional[ClerkProfile]:
    """Load email and display fields for a Clerk user. Returns None if misconfigured or not found."""
    if not settings.clerk_secret_key:
        return None
    try:
        response = httpx.get(
            f"https://api.clerk.com/v1/users/{clerk_user_id}",
            headers={"Authorization": f"Bearer {settings.clerk_secret_key}"},
            timeout=10,
        )
        if response.status_code == 404:
            return None
        response.raise_for_status()
        data = response.json()
    except (httpx.HTTPError, ValueError):
        return None

    email = _primary_email(data)
    if not email:
        return None

    return ClerkProfile(
        clerk_user_id=clerk_user_id,
        email=email.lower(),
        first_name=_optional_str(data.get("first_name")),
        last_name=_optional_str(data.get("last_name")),
        clerk_username=_optional_str(data.get("username")),
    )


def _optional_str(value: object) -> Optional[str]:
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def _primary_email(data: dict) -> Optional[str]:
    addresses = data.get("email_addresses") or []
    primary_id = data.get("primary_email_address_id")
    if primary_id:
        for entry in addresses:
            if entry.get("id") == primary_id:
                return _email_from_entry(entry)
    for entry in addresses:
        email = _email_from_entry(entry)
        if email:
            return email
    return None


def _email_from_entry(entry: dict) -> Optional[str]:
    if not isinstance(entry, dict):
        return None
    email = entry.get("email_address")
    if isinstance(email, str) and email.strip():
        return email.strip()
    return None
