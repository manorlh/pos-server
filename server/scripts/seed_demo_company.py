"""
"חברת הדגמה — סימולציה למס הכנסה": a demo tenant with one branch, five bars (points of
sale), ten virtual tills, 32 employees, a bar menu and one full month of trading
(1.9.2026–30.9.2026), generated through the product's own code paths.

    cd server
    python -m scripts.seed_demo_company --db-name <database> [--dry-run] [--z-mode area|shop]
           [--dealer-type licensed|exempt] [--export-window FROM,TO] [--codes-file PATH] [--out DIR] [--days 2026-09-01,2026-09-02] [--verify-only]
           [--registration-number 12345678] [--open-format KEY=VALUE ...]

* `--z-mode` — who the Zs are for. `area` (the default): each bar its own area Z, one per bar per
  night. `shop` ("Z סניפי"): every till closes its shift and ONE Z for the whole branch is
  produced per business night, numbered 1..K by the shop's counter. The documents are the same.
* `--dealer-type` — "סוג עוסק" of the demo company. `licensed` (the default): VAT, tax invoice-receipts
  (320) and credit notes (330). `exempt` (עוסק פטור): no VAT, receipts (400) and receipt refunds (-400) —
  the types a VAT-registered business never issues, so they need a company of their own (and a database
  of its own: the tenant name, slug and the fake ח.פ. differ from the licensed company's).
* `--export-window FROM,TO` — the uniform file's period. Default: the month, or — with `--days` — the first
  to the last of those nights.
* `--registration-number` (env `DEMO_SOFTWARE_REGISTRATION_NUMBER`) and `--open-format KEY=VALUE`
  (softwareName, softwareVersion, manufacturerName, manufacturerVatNumber, registrationNumber,
  outputDrive): the platform setting `openFormat` that the uniform file's A000 1006–1012 are
  written from, set through `PUT /system/open-format` as the super admin (merged over what is
  stored — and platform-wide, like the setting itself). Without them the file carries whatever
  the database already has: zeros in 1006 on a fresh one. The value is never in product code.
  With `--verify-only` they re-write the setting, then the file is exported again.
* DATABASE_URL (the process environment, else server/.env) names the database; `--db-name`
  must repeat its database name, so the target is always typed out.
* Idempotent: when the demo tenant exists the seeder stops and changes nothing
  (`--verify-only` re-runs the verification and the uniform-file export on it).
* Refuses a database whose alembic revision is not this code's head (it never migrates).
* Writes only rows of the new tenant (plus the super admin's ownership membership of it,
  as the dashboard's "new tenant" does).
* Every till, dashboard and Z action goes through the API in process (FastAPI TestClient),
  as virtual tills and as the super admin; the product reads "now" from the simulation
  clock (scripts/demo_company/clock.py). Nothing leaves the machine
  (scripts/demo_company/quiet.py).
* The employees' PINs go only to `--codes-file` (never printed).
* `--dry-run`: checks and the plan only — nothing is written.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time as _time
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse

SERVER = Path(os.path.abspath(__file__)).parent.parent  # not resolve(): P: is a subst (MAX_PATH)
if str(SERVER) not in sys.path:
    sys.path.insert(0, str(SERVER))
os.chdir(SERVER)  # the settings read .env relative to the working directory

from scripts.demo_company import quiet  # noqa: E402

quiet.environment()


def log(*parts) -> None:
    print(*parts, flush=True)


def _database_url() -> str:
    url = os.environ.get("DATABASE_URL")
    if url:
        return url
    from app.config import get_settings

    return get_settings().database_url


def _db_name(url: str) -> str:
    return urlparse(url.replace("postgresql+psycopg2", "postgresql")).path.lstrip("/")


def _alembic_heads() -> set:
    from alembic.config import Config
    from alembic.script import ScriptDirectory

    return set(ScriptDirectory.from_config(Config(str(SERVER / "alembic.ini"))).get_heads())


def _existing_tenant(db):
    from app.models.tenant import Tenant
    from scripts.demo_company import plan as P

    return db.query(Tenant).filter((Tenant.slug == P.TENANT_SLUG) | (Tenant.name == P.TENANT_NAME)).first()


def _super_admin(db):
    from app.models.user import User, UserRole

    admins = db.query(User).filter(User.role == UserRole.SUPER_ADMIN, User.is_active.is_(True)).all()
    if len(admins) != 1:
        raise SystemExit(f"expected exactly one active super admin to act as, found {len(admins)}")
    return admins[0]


OPEN_FORMAT_KEYS = ("softwareName", "softwareVersion", "manufacturerName", "manufacturerVatNumber",
                    "registrationNumber", "outputDrive")


def _open_format_updates(args) -> dict:
    """What `--open-format KEY=VALUE` and `--registration-number` ask the `openFormat` setting to hold."""
    updates = {}
    for item in args.open_format or []:
        key, sep, value = item.partition("=")
        if not sep or key not in OPEN_FORMAT_KEYS:
            raise SystemExit(f"--open-format wants KEY=VALUE, KEY one of: {', '.join(OPEN_FORMAT_KEYS)}")
        updates[key] = value
    if args.registration_number:
        updates["registrationNumber"] = args.registration_number
    return updates


def apply_open_format(api, updates: dict, log) -> None:
    """The platform setting `openFormat` (A000 1006–1012), merged over what is stored, written through
    the product's own `PUT /system/open-format` (validated there: 1006 is up to 8 digits, never zeros)."""
    if not updates:
        return
    stored = api.admin("GET", "/system/open-format")
    merged = {key: stored.get(key) for key in OPEN_FORMAT_KEYS}
    merged.update(updates)
    api.admin("PUT", "/system/open-format", merged)
    log(f"platform setting openFormat written: {', '.join(sorted(updates))} (the others kept as stored)")


def write_codes(path: Path, world, db_name: str) -> None:
    from scripts.demo_company import plan as P

    lines = [
        f"# {P.TENANT_NAME} — קודי עובדים (פיתוח בלבד)",
        "",
        f"מסד נתונים: `{db_name}` · דייר `{world.tenant_id}` · סניף `{world.shop_id}`.",
        "קבצים אלה נשמרים מקומית בלבד ואינם נכנסים ל-git. הקודים בענן שמורים מוצפנים (bcrypt).",
        "",
        "| נקודת מכירה | שם | תפקיד | שם משתמש | מספר עובד | קוד |",
        "|---|---|---|---|---|---|",
    ]
    for p in world.people:
        where = f"בר {p.bar}" if p.bar else "כל הסניף"
        lines.append(f"| {where} | {p.name} | {p.job} | `{p.key}` | {p.worker_number} | `{p.pin}` |")
    if world.default_user:
        lines += ["", "בנוסף, המשתמש שהמערכת יוצרת בכל סניף חדש: `default` (קוד ברירת המחדל של המוצר, 1234)."]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--db-name", required=True, help="the database name DATABASE_URL must point at")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--verify-only", action="store_true")
    ap.add_argument("--codes-file", default=None)
    ap.add_argument("--out", default=None, help="where the verification report and the uniform file go")
    ap.add_argument("--days", default=None, help="only these dates (comma separated), for a quick rehearsal")
    ap.add_argument("--z-mode", choices=("area", "shop"), default="area",
                    help="area: each bar its own Z (default); shop: one Z per branch per business night")
    ap.add_argument("--dealer-type", choices=("licensed", "exempt"), default="licensed",
                    help="licensed: VAT, 320/330 (default); exempt: no VAT, receipts 400 / refunds -400")
    ap.add_argument("--export-window", default=None, metavar="FROM,TO",
                    help="the uniform file's period (YYYY-MM-DD,YYYY-MM-DD); default the month, or the --days span")
    ap.add_argument("--registration-number", default=os.environ.get("DEMO_SOFTWARE_REGISTRATION_NUMBER") or None,
                    help="A000 1006, the platform setting openFormat.registrationNumber (up to 8 digits)")
    ap.add_argument("--open-format", action="append", default=None, metavar="KEY=VALUE",
                    help="another openFormat field (A000 1007-1012); repeatable")
    args = ap.parse_args()
    updates = _open_format_updates(args)
    registration = updates.get("registrationNumber")

    url = _database_url()
    name = _db_name(url)
    if name != args.db_name:
        log(f"DATABASE_URL points at database '{name}', not '{args.db_name}' — refusing.")
        return 2
    log(f"database: {name}")

    from scripts.demo_company import clock as C
    from scripts.demo_company import plan as P

    P.use_dealer_type(args.dealer_type)  # before anything reads the demo company's name / ח.פ.
    start = datetime.combine(P.SETUP_DAY, datetime.min.time()).replace(hour=10)
    from zoneinfo import ZoneInfo

    IL = ZoneInfo(P.TIMEZONE)
    clk = C.install(start.replace(tzinfo=IL))
    quiet.install()
    from sqlalchemy import text

    from app.database import SessionLocal

    db = SessionLocal()
    try:
        current = {r[0] for r in db.execute(text("select version_num from alembic_version"))}
        heads = _alembic_heads()
        if current != heads:
            log(f"alembic: database at {sorted(current)}, code head {sorted(heads)} — STOP (no migration is run).")
            return 3
        log(f"alembic: at head {sorted(heads)}")
        existing = _existing_tenant(db)
        admin = _super_admin(db)
        vat = None if existing else __import__("scripts.demo_company.setup", fromlist=["x"]).free_vat_number(db)
    finally:
        db.close()

    out_dir = Path(args.out) if args.out else None
    days = None
    if args.days:
        from datetime import date

        days = [date.fromisoformat(d.strip()) for d in args.days.split(",") if d.strip()]
    window = None
    if args.export_window:
        from datetime import date

        parts = [date.fromisoformat(d.strip()) for d in args.export_window.split(",") if d.strip()]
        if len(parts) != 2 or parts[0] > parts[1]:
            raise SystemExit("--export-window wants FROM,TO (YYYY-MM-DD,YYYY-MM-DD), FROM not after TO")
        window = (parts[0], parts[1])
    if existing is not None and not args.verify_only:
        log(f"the demo tenant already exists ({existing.id} '{existing.name}') — nothing changed.")
        return 0
    if args.verify_only:
        if existing is None:
            log("no demo tenant to verify")
            return 4
        if updates:
            from scripts.demo_company.api import Api

            api = Api(admin.id)
            try:
                apply_open_format(api, updates, log)
            finally:
                api.close()
        C.uninstall()
        from scripts.demo_company import verify as V

        return V.run(existing.id, out_dir, log, z_mode=args.z_mode, registration_number=registration, days=days,
                 dealer_type=args.dealer_type, export_window=window)

    if args.dry_run:
        log(f"DRY RUN — nothing written. ח.פ. to be used: {vat}")
        total = 0
        every_night = set()
        for bar in P.BARS:
            nights = P.nights(bar)
            total += len(nights)
            every_night.update(nights)
            log(f"  {bar.name}: {len(nights)} nights ({nights[0]} … {nights[-1]}), closed weekdays {bar.closed}")
        zs = len(every_night) if args.z_mode == "shop" else total
        log(f"  bar-nights {total}, tills {len(P.BARS) * P.TILLS_PER_BAR}, people {len(P.people())}, "
            f"menu {sum(len(i) for *_x, i in P.CATEGORIES)} products; z-mode {args.z_mode}: {zs} Zs; "
            f"dealer type {args.dealer_type}")
        if updates:
            log(f"  openFormat to be written: {', '.join(sorted(updates))}")
        return 0

    if not args.codes_file:
        log("--codes-file is required for a real run (the employees' PINs go there and nowhere else)")
        return 2
    from scripts.demo_company import setup as S, till as T
    from scripts.demo_company.api import Api
    from scripts.demo_company.simulate import Month

    T.use_timezone(IL)
    t0 = _time.time()
    api = Api(admin.id)
    apply_open_format(api, updates, log)
    world = S.build(api, SessionLocal, vat, log)
    codes = Path(args.codes_file)
    write_codes(codes, world, name)
    log(f"codes written to {codes} ({len(world.people)} employees)")
    state = {"database": name, "tenantId": world.tenant_id, "companyId": world.company_id, "shopId": world.shop_id,
             "vatNumber": world.vat_number, "areas": {str(k): v for k, v in world.areas.items()},
             "tills": [{"id": t.id, "name": t.name, "bar": t.bar.index, "index": t.index, "posNumber": t.pos_number,
                        "prefix": t.prefix, "terminal": t.terminal} for t in world.tills]}
    if args.z_mode != "area":  # the area default keeps writing exactly the state it always did
        state["zMode"] = args.z_mode
    if args.dealer_type != "licensed":
        state["dealerType"] = args.dealer_type
    month = Month(api, world, clk, log, z_mode=args.z_mode)
    ledger = month.run(days)
    api.close()
    state["ledger"] = {"counts": ledger.counts, "zs": ledger.zs, "closes": ledger.closes,
                       "suppressedNotifies": len(quiet.SUPPRESSED), "apiCalls": api.calls,
                       "seconds": round(_time.time() - t0, 1)}
    C.uninstall()
    if out_dir is not None:
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / "seed_state.json").write_text(json.dumps(state, ensure_ascii=False, indent=2, default=str),
                                                 encoding="utf-8")
    log(f"seeded in {state['ledger']['seconds']} s, {api.calls} API calls; counts {ledger.counts}")
    from scripts.demo_company import verify as V

    return V.run(world.tenant_id, out_dir, log, z_mode=args.z_mode, registration_number=registration, days=days,
                 dealer_type=args.dealer_type, export_window=window)


if __name__ == "__main__":
    sys.exit(main())
