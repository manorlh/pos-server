"""
Creates the built-in till parameters (`shopZOpenTills`, `receiptLogoUrl`) if missing.
The API does the same on start-up; this is for a database the API has not started on.
Idempotent, and never touches a definition that already exists.
Run: python -m scripts.seed_till_parameters
"""
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from app.database import SessionLocal
from app.services.till_parameters import ensure_builtin_parameters


def main():
    db = SessionLocal()
    try:
        created = ensure_builtin_parameters(db)
        db.commit()
        if created:
            print(f"Created: {', '.join(created)}")
        else:
            print("Every built-in till parameter already exists - nothing to do.")
    finally:
        db.close()


if __name__ == "__main__":
    main()
