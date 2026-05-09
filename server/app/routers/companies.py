from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, status, Query
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.company import Company
from app.models.user import User, UserRole
from app.schemas.company import CompanyCreate, CompanyUpdate, CompanyResponse
from app.middleware.auth import get_current_user, get_current_distributor, get_active_tenant_id, ensure_same_tenant

router = APIRouter(prefix="/companies", tags=["companies"])


def _check_company_access(user: User, company: Company):
    if user.role == UserRole.SUPER_ADMIN:
        return
    if user.role == UserRole.DISTRIBUTOR:
        return  # Distributor sees all companies (filtered by their merchants below)
    if user.role == UserRole.MERCHANT_ADMIN and company.merchant_id == user.merchant_id:
        return
    if user.role in (UserRole.COMPANY_MANAGER, UserRole.SHOP_MANAGER, UserRole.CASHIER):
        if company.id == user.company_id:
            return
    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")


@router.get("", response_model=List[CompanyResponse])
def list_companies(
    merchant_id: Optional[str] = Query(None, alias="merchantId"),
    current_user: User = Depends(get_current_user),
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    query = db.query(Company).filter(Company.tenant_id == active_tenant_id)

    if current_user.role == UserRole.MERCHANT_ADMIN:
        query = query.filter(Company.merchant_id == current_user.merchant_id)
    elif current_user.role in (UserRole.COMPANY_MANAGER, UserRole.SHOP_MANAGER, UserRole.CASHIER):
        query = query.filter(Company.id == current_user.company_id)
    elif merchant_id:
        query = query.filter(Company.merchant_id == merchant_id)

    return query.all()


@router.post("", response_model=CompanyResponse, status_code=status.HTTP_201_CREATED)
def create_company(
    data: CompanyCreate,
    current_user: User = Depends(get_current_distributor),
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    company = Company(
        tenant_id=active_tenant_id,
        merchant_id=data.merchant_id,
        name=data.name,
        vat_number=data.vat_number,
        address=data.address,
        city=data.city,
        is_active=data.is_active,
    )
    db.add(company)
    db.commit()
    db.refresh(company)
    return company


@router.get("/{company_id}", response_model=CompanyResponse)
def get_company(
    company_id: str,
    current_user: User = Depends(get_current_user),
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    company = db.query(Company).filter(Company.id == company_id).first()
    if not company:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Company not found")
    ensure_same_tenant(company.tenant_id, active_tenant_id)
    _check_company_access(current_user, company)
    return company


@router.put("/{company_id}", response_model=CompanyResponse)
def update_company(
    company_id: str,
    data: CompanyUpdate,
    current_user: User = Depends(get_current_user),
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    company = db.query(Company).filter(Company.id == company_id).first()
    if not company:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Company not found")
    ensure_same_tenant(company.tenant_id, active_tenant_id)
    _check_company_access(current_user, company)

    for field, value in data.model_dump(exclude_unset=True, by_alias=False).items():
        setattr(company, field, value)
    db.commit()
    db.refresh(company)
    return company


@router.delete("/{company_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_company(
    company_id: str,
    current_user: User = Depends(get_current_distributor),
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    company = db.query(Company).filter(Company.id == company_id).first()
    if not company:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Company not found")
    ensure_same_tenant(company.tenant_id, active_tenant_id)
    db.delete(company)
    db.commit()
