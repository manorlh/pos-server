"""Standalone remote shift close payloads (docs/SHIFTS_API.md §2.14)."""
from __future__ import annotations

from datetime import datetime
from typing import Optional
import uuid

from pydantic import BaseModel, ConfigDict, Field

from app.schemas.shift import ShiftOut


class ShiftCloseRequestOut(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: uuid.UUID
    machine_id: uuid.UUID = Field(..., alias="machineId")
    machine_name: Optional[str] = Field(None, alias="machineName")
    shop_id: Optional[uuid.UUID] = Field(None, alias="shopId")
    shift_id: Optional[uuid.UUID] = Field(None, alias="shiftId")
    #: waiting_close | closing | completed | failed | expired | cancelled
    status: str
    error_code: Optional[str] = Field(None, alias="errorCode")
    error_message: Optional[str] = Field(None, alias="errorMessage")
    created_at: Optional[datetime] = Field(None, alias="createdAt")
    updated_at: Optional[datetime] = Field(None, alias="updatedAt")
    expires_at: Optional[datetime] = Field(None, alias="expiresAt")
    created_by_user_id: Optional[uuid.UUID] = Field(None, alias="createdByUserId")
    sent_at: Optional[datetime] = Field(None, alias="sentAt")
    received_at: Optional[datetime] = Field(None, alias="receivedAt")
    completed_at: Optional[datetime] = Field(None, alias="completedAt")
    #: "כפה סגירה" (app/services/remote_close_force.py): asked forced from remote control.
    remote_force: bool = Field(False, alias="remoteForce")
    #: Completed in that mode: "נסגר בכפייה מרחוק ע״י <מנהל>" (the chip and the notices); else null.
    forced_words: Optional[str] = Field(None, alias="forcedWords")
    # The till's last report, as the status light reads it (a reading, not live).
    online: Optional[bool] = None
    pending_documents: Optional[int] = Field(None, alias="pendingDocuments")
    pending_as_of: Optional[datetime] = Field(None, alias="pendingAsOf")
    #: Documents of the shift being closed that the cloud holds; null once not pending.
    documents_on_cloud: Optional[int] = Field(None, alias="documentsOnCloud")
    #: The shift being closed (its X once completed); null if the cloud has not seen it.
    shift: Optional[ShiftOut] = None
