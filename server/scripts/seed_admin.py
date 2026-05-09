"""
Creates the initial super_admin user and a default merchant.
Run once: python -m scripts.seed_admin
"""
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from app.database import SessionLocal
from app.models.user import User, UserRole
from app.models.merchant import Merchant
from app.services.auth import get_password_hash
import uuid

USERNAME = "admin"
PASSWORD = "admin123"
EMAIL = "admin@pos.localhost.com"
MERCHANT_NAME = "Default Merchant"


def main():
    db = SessionLocal()
    try:
        existing = db.query(User).filter(User.username == USERNAME).first()
        if existing:
            print(f"User '{USERNAME}' already exists.")
            if not existing.merchant_id:
                # Ensure a merchant exists and link it
                merchant = db.query(Merchant).first()
                if not merchant:
                    merchant = Merchant(
                        id=uuid.uuid4(),
                        name=MERCHANT_NAME,
                        distributor_id=existing.id,
                    )
                    db.add(merchant)
                    db.flush()
                existing.merchant_id = merchant.id
                db.commit()
                print(f"Linked admin to merchant: {MERCHANT_NAME} ({merchant.id})")
            else:
                print("Already linked to a merchant — nothing to do.")
            return

        # Create admin user first (without merchant_id)
        admin_id = uuid.uuid4()
        user = User(
            id=admin_id,
            email=EMAIL,
            username=USERNAME,
            hashed_password=get_password_hash(PASSWORD),
            role=UserRole.SUPER_ADMIN,
            is_active=True,
        )
        db.add(user)
        db.flush()  # write user so we have the ID

        # Create merchant with admin as distributor
        merchant = Merchant(
            id=uuid.uuid4(),
            name=MERCHANT_NAME,
            distributor_id=admin_id,
        )
        db.add(merchant)
        db.flush()

        # Link merchant back to admin
        user.merchant_id = merchant.id
        db.commit()

        print(f"Created super_admin user:")
        print(f"  username   : {USERNAME}")
        print(f"  password   : {PASSWORD}")
        print(f"  email      : {EMAIL}")
        print(f"  merchant   : {MERCHANT_NAME} ({merchant.id})")
    finally:
        db.close()


if __name__ == "__main__":
    main()
