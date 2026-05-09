from datetime import datetime
from pydantic import BaseModel
from typing import Optional
import uuid


class MerchantBase(BaseModel):
    name: str


class MerchantCreate(MerchantBase):
    distributor_id: uuid.UUID


class MerchantUpdate(BaseModel):
    name: Optional[str] = None
    is_active: Optional[bool] = None


class MerchantResponse(MerchantBase):
    id: uuid.UUID
    distributor_id: uuid.UUID
    is_active: bool
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True

