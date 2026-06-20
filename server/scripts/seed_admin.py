"""
Creates the initial super_admin user and a default tenant + company.
Run once: python -m scripts.seed_admin
"""
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from app.database import SessionLocal
from app.models.user import User, UserRole
from app.models.tenant import Tenant
from app.models.company import Company
from app.models.tenant_membership import TenantMembership, TenantMembershipRole
from app.services.auth import get_password_hash
import uuid

USERNAME = "admin"
PASSWORD = "admin123"
EMAIL = "admin@pos.localhost.com"
TENANT_NAME = "Default Tenant"
COMPANY_NAME = "Default Company"


def main():
    db = SessionLocal()
    try:
        existing = db.query(User).filter(User.username == USERNAME).first()
        if existing:
            print(f"User '{USERNAME}' already exists.")
            if not existing.tenant_id:
                tenant = db.query(Tenant).first()
                if not tenant:
                    tenant = Tenant(
                        id=uuid.uuid4(),
                        name=TENANT_NAME,
                        slug="default-tenant",
                    )
                    db.add(tenant)
                    db.flush()
                existing.tenant_id = tenant.id
                membership = (
                    db.query(TenantMembership)
                    .filter(
                        TenantMembership.user_id == existing.id,
                        TenantMembership.tenant_id == tenant.id,
                    )
                    .first()
                )
                if not membership:
                    db.add(
                        TenantMembership(
                            tenant_id=tenant.id,
                            user_id=existing.id,
                            role=TenantMembershipRole.TENANT_ADMIN,
                            is_default=True,
                        )
                    )
                company = db.query(Company).filter(Company.tenant_id == tenant.id).first()
                if not company:
                    company = Company(
                        id=uuid.uuid4(),
                        tenant_id=tenant.id,
                        name=COMPANY_NAME,
                        is_active=True,
                    )
                    db.add(company)
                db.commit()
                print(f"Linked admin to tenant: {TENANT_NAME} ({tenant.id})")
            else:
                print("Already linked to a tenant — nothing to do.")
            return

        admin_id = uuid.uuid4()
        tenant = Tenant(id=uuid.uuid4(), name=TENANT_NAME, slug="default-tenant")
        db.add(tenant)
        db.flush()

        user = User(
            id=admin_id,
            email=EMAIL,
            username=USERNAME,
            hashed_password=get_password_hash(PASSWORD),
            role=UserRole.SUPER_ADMIN,
            tenant_id=tenant.id,
            is_active=True,
        )
        db.add(user)
        db.flush()

        db.add(
            TenantMembership(
                tenant_id=tenant.id,
                user_id=admin_id,
                role=TenantMembershipRole.TENANT_ADMIN,
                is_default=True,
            )
        )

        company = Company(
            id=uuid.uuid4(),
            tenant_id=tenant.id,
            name=COMPANY_NAME,
            is_active=True,
        )
        db.add(company)
        db.commit()

        print("Created super_admin user:")
        print(f"  username   : {USERNAME}")
        print(f"  password   : {PASSWORD}")
        print(f"  email      : {EMAIL}")
        print(f"  tenant     : {TENANT_NAME} ({tenant.id})")
        print(f"  company    : {COMPANY_NAME} ({company.id})")
    finally:
        db.close()


if __name__ == "__main__":
    main()
