"""
Platform-wide settings, the super admin's ("הגדרות מערכת"): one JSON value per key.

Today one key: "access" — which dashboard entries each role does not see and which
device actions it may not take (app/services/access.py).
"""
from __future__ import annotations

from sqlalchemy import Column, DateTime, String
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.sql import func

from app.database import Base


class PlatformSetting(Base):
    __tablename__ = "platform_settings"

    key = Column(String(64), primary_key=True)
    value = Column(JSONB, nullable=False, default=dict, server_default="{}")
    updated_by_user_id = Column(UUID(as_uuid=True), nullable=True)
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())
