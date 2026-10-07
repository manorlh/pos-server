"""
"יומן חריגות": logs what every detection point recorded before the log existed (default:
the last 90 days). Read-only on the sources; idempotent; never sends an SMS.
The migration already copied `audit_exceptions`; this adds the other sources.
Run: python -m scripts.backfill_exception_log [--days 90]
"""
import argparse
import os
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from app.database import SessionLocal  # noqa: E402
from app.services.exception_alerts.backfill import backfill  # noqa: E402


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--days", type=int, default=90)
    args = parser.parse_args()
    db = SessionLocal()
    try:
        counts = backfill(db, since=datetime.now(timezone.utc) - timedelta(days=args.days))
        for name, n in counts.items():
            print(f"{name}: {n} new")
    finally:
        db.close()


if __name__ == "__main__":
    main()
