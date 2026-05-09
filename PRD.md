# PRD: POS Cloud Platform

**Version:** 1.1
**Date:** 2026-03-28
**Market:** Israel
**Inspiration:** Nayax Cloud Retail

---

## 1. Vision

Build a cloud POS management platform that enables merchants to manage their retail
operations centrally — product catalogs, pricing, inventory, and transaction reporting —
across multiple shops and POS terminals, with real-time sync and full offline resilience.

The server (this repo) provides the API, business logic, and sync engine.
The client dashboard (Next.js) is the web UI consumed by merchants and admins.
The POS Desktop (pos-desktop repo) is the Electron terminal running in each shop.

---

## 2. Tech Stack

| Layer             | Technology                        | Hosting     |
|-------------------|-----------------------------------|-------------|
| API Server        | FastAPI (Python 3.11+)            | Fly.io      |
| Database          | PostgreSQL 15                     | Fly.io Postgres |
| MQTT Broker       | Eclipse Mosquitto 2.0             | Fly.io      |
| Background Jobs   | APScheduler (in-process)          | Fly.io      |
| Web Dashboard     | Next.js 14 (App Router)           | Vercel      |
| POS Terminal      | Electron 13.6.9 + React + SQLite  | Local (shop)|
| File Storage      | Cloudinary                        | Cloudinary  |
| Auth              | JWT (HS256, existing)             | —           |

**Scale target:** 100 machines, ~10 merchants.
**Current state:** Server skeleton exists with auth, merchants, machines, products,
categories, MQTT service, and pairing flow. Needs hierarchy expansion and sync protocol.

---

## 3. Entity Hierarchy

```
SUPER_ADMIN  (platform operator — us)
  └── DISTRIBUTOR  (reseller / partner)
        └── MERCHANT  (business owner e.g. "ABC Food Services Ltd")
              └── COMPANY  (brand/chain e.g. "Café Joe" or "Quick Bites")
                    └── SHOP  (physical location e.g. "Café Joe - Tel Aviv")
                          └── MACHINE  (POS terminal, 1–N per shop)
```

**Comparison to Nayax:**
Nayax: Distributor → Operator → Sub-Operator/Location → Machine
Our model adds a "Company" level (brand entity) between Merchant and Shop,
which is useful when one merchant owns multiple independent brands.

### 3.1 User Roles

| Role             | Scope                          | Permissions                                      |
|------------------|--------------------------------|--------------------------------------------------|
| SUPER_ADMIN      | Platform                       | Full access everywhere                           |
| DISTRIBUTOR      | Their merchants                | Manage merchants, generate pairing codes         |
| MERCHANT_ADMIN   | Their companies & shops        | Full control of catalog, users, reporting        |
| COMPANY_MANAGER  | Their company's shops          | Catalog management, reporting for their company  |
| SHOP_MANAGER     | Their shop                     | Local catalog, transactions, users for that shop |
| CASHIER          | Their machine                  | Operate POS, view today's transactions           |

---

## 4. Data Models

### 4.1 Current Models (already exist, need extension)

- **User** — add `company_id`, `shop_id`; extend role enum
- **Merchant** — no changes
- **POSMachine** — add `shop_id` FK; `merchant_id` becomes indirect (via shop → company → merchant)
- **Product** — add `company_id`, `shop_id`, `global_product_id`, `catalog_level`, `local_override`
- **Category** — add `company_id`, `shop_id`, `catalog_level`
- **PairingCode** — no changes

### 4.2 New Models

#### Company
```
id              UUID PK
merchant_id     FK → merchants.id
name            VARCHAR(255)
vat_number      VARCHAR(20)          # Israeli VAT (ח.פ)
address         VARCHAR(500)
city            VARCHAR(100)
is_active       BOOLEAN
created_at      TIMESTAMPTZ
updated_at      TIMESTAMPTZ
```

#### Shop
```
id              UUID PK
company_id      FK → companies.id
name            VARCHAR(255)
branch_id       VARCHAR(50)          # Israeli tax authority branch code
address         VARCHAR(500)
city            VARCHAR(100)
is_active       BOOLEAN
created_at      TIMESTAMPTZ
updated_at      TIMESTAMPTZ
```

#### Transaction (cloud mirror of POS transactions)
```
id                      UUID PK
machine_id              FK → pos_machines.id
shop_id                 FK → shops.id
company_id              FK → companies.id
merchant_id             FK → merchants.id
local_id                VARCHAR(100)       # original id from POS SQLite
transaction_number      VARCHAR(100)       # sequential from POS
document_type           INTEGER            # 305=invoice, 400=receipt
status                  ENUM(completed, refund, void)
payment_method          VARCHAR(50)        # cash / card / mixed
amount_total            NUMERIC(10,2)
amount_tax              NUMERIC(10,2)
amount_discount         NUMERIC(10,2)
amount_tendered         NUMERIC(10,2)
change_amount           NUMERIC(10,2)
cashier_id              VARCHAR(100)       # local user id from POS
nayax_meta              JSONB              # card terminal response
synced_at               TIMESTAMPTZ        # when received by server
created_at              TIMESTAMPTZ        # original sale time on POS
```

#### TransactionItem
```
id                  UUID PK
transaction_id      FK → transactions.id
product_id          UUID               # cloud product id if matched
local_product_id    VARCHAR(100)       # local POS product id
product_name        VARCHAR(255)       # snapshot at sale time
sku                 VARCHAR(100)
quantity            INTEGER
unit_price          NUMERIC(10,2)
total_price         NUMERIC(10,2)
discount            NUMERIC(10,2)
tax_rate            NUMERIC(5,2)
```

#### ZReport
```
id                  UUID PK
machine_id          FK → pos_machines.id
shop_id             FK → shops.id
trading_day_date    DATE
opened_at           TIMESTAMPTZ
closed_at           TIMESTAMPTZ
transaction_count   INTEGER
total_sales         NUMERIC(10,2)
total_tax           NUMERIC(10,2)
total_discounts     NUMERIC(10,2)
cash_opening        NUMERIC(10,2)
cash_expected       NUMERIC(10,2)
cash_actual         NUMERIC(10,2)
cash_discrepancy    NUMERIC(10,2)
raw_data            JSONB              # full Z-report JSON from POS
synced_at           TIMESTAMPTZ
```

#### SyncLog
```
id              UUID PK
machine_id      FK → pos_machines.id
direction       ENUM(server_to_pos, pos_to_server)
entity_type     ENUM(products, categories, transactions, z_report)
entity_id       UUID
action          ENUM(create, update, delete, full_sync)
status          ENUM(success, failed, conflict_resolved)
conflict_note   TEXT
payload         JSONB
created_at      TIMESTAMPTZ
```

### 4.3 Product Catalog — Two-Tier Design

Products can exist at two levels:

| `catalog_level` | `merchant_id` | `company_id` | `shop_id` | `machine_id` | Meaning                         |
|-----------------|---------------|--------------|-----------|---------------|---------------------------------|
| `global`        | ✓             | optional     | null      | null          | Master product in global catalog|
| `local`         | ✓             | optional     | ✓         | optional      | Shop/machine override or local  |

New fields on Product:
```
catalog_level       ENUM(global, local)    default: global
company_id          FK → companies.id      nullable
shop_id             FK → shops.id          nullable
global_product_id   FK → products.id       nullable  # points to master if local copy
is_local_override   BOOLEAN                default: false
```

**Rules:**
- When a product is pushed from global catalog to a shop, a `local` copy is created
  with `global_product_id` pointing to the original.
- The local copy can override price, name, availability.
- Deleting the global product soft-deletes all local copies.
- SKU uniqueness is scoped per merchant (not global).

### 4.4 Shop assortment + overrides (`shop_product_overrides`)

**Explicit assortment (Nayax-style allowlist):** a global product is sold at a shop only if there is a row in `shop_product_overrides` for `(shop_id, global_product_id)`. New shops start with **no** rows until products are assigned in the dashboard (or via API). A one-time DB migration backfilled all `(shop, global)` pairs for existing shops so behavior stayed consistent when this rule shipped.

Per row:

- **`price`** — optional; `NULL` means inherit the global product price.
- **`is_listed`** — when `false`, the product stays in the assortment but is not offered (sync sends `shopListed: false`, `inStock: false`).

Uniqueness: `(shop_id, global_product_id)`. Stock and quantities remain on **machine-local** `Product` rows (or global defaults), not on this table.

**Dashboard:** `/dashboard/shops/assortment` — tab **In shop** (assigned products + price/listing), tab **Add from catalog** (globals not yet assigned).

**POS after unassign:** SQLite catalog pull is upsert-only; removing a product from the server payload does **not** delete it locally. After removing products from a shop’s assortment, run a **full** catalog pull (clear `since` / omit delta) or otherwise reconcile local SQLite so stale rows are not sold.

---

## 5. Sync Protocol

### 5.1 MQTT Topic Structure

```
# Server → POS (catalog wake-up only — no bulk catalog payload on MQTT)
pos/{merchant_id}/{machine_id}/catalog/notify          # small JSON: serverTime, reason, optional hint

# POS → Server
pos/{merchant_id}/{machine_id}/catalog/update         # deprecated / ignored (cloud is source of truth)
pos/{merchant_id}/{machine_id}/transactions/new       # new transaction(s)
pos/{merchant_id}/{machine_id}/transactions/z-report  # Z-report on close of day
pos/{merchant_id}/{machine_id}/sync/request           # optional: server replies with catalog/notify only
pos/{merchant_id}/{machine_id}/heartbeat              # POS is online
```

**Canonical catalog delivery:** HTTP `GET /api/v1/sync/{machine_id}/catalog?since=...` (machine JWT or dashboard user JWT). All payloads are JSON where used. QoS 1 for MQTT where applicable.

### 5.2 Catalog Sync Flow

#### Scenario A: Cloud → POS (manager updates product in dashboard)

```
1. Merchant edits product in Next.js dashboard (or catalog push runs)
2. Server updates PostgreSQL
3. Server publishes MQTT catalog/notify (lightweight) to affected machine(s)
4. POS receives notify, calls GET /sync/{machine_id}/catalog?since=... (or full if no since)
5. POS applies JSON response to local SQLite (cloud_id mapping)
6. Server may update pos_machines.last_sync_at on GET
```

#### Scenario B: POS → Cloud (catalog changes)

```
1. POS user creates/edits product or category in POS Desktop
2. POS calls cloud HTTP APIs first (e.g. POST/PUT /sync/{machine_id}/products|categories with machine JWT)
3. Server persists as source of truth (global catalog where applicable)
4. Server publishes catalog/notify to merchant machines; POS pulls via GET as in Scenario A
```

#### Scenario C: Initial / Reconnect Full Sync

```
1. POS connects to MQTT (if merchant_id known) and/or uses stored API base + machine token
2. On MQTT connect or on catalog/notify, POS calls GET /sync/{machine_id}/catalog?since=last_local_sync
   (omit since for full catalog)
3. Server returns { products, categories, syncType, serverTime }
4. POS applies all items to SQLite, updates cloud_last_sync locally
```

**Effective catalog for machines with `shop_id`:** `GET /sync/{machine_id}/catalog` returns **categories** = merchant **global** categories (`catalog_level=global`, `pos_machine_id` null) so `categoryId` on merged products matches rows the POS can insert (SQLite FK). **Products:** (1) assigned globals merged with shop **price** / **listing**, (2) machine-local rows for stock and POS-only SKUs (`global_product_id` null). Identity for POS: prefer the local row’s `id` when a clone exists; otherwise the cloud **`id` is the global product id**. **`updatedAt`** is the max of global, override, and local timestamps. Delisted products still use **`shopListed: false`** and **`inStock: false`**. Machines **without** `shop_id` keep the previous behavior for both entities: only rows where `pos_machine_id` equals the machine.

### 5.3 Conflict Resolution

**Rule: Last Write Wins on `updated_at` timestamp.**

```
if incoming.updated_at > server_record.updated_at:
    apply incoming changes
    log: SyncLog(action=update, status=success)
else:
    discard incoming
    log: SyncLog(action=update, status=conflict_resolved, note="server version newer")
    send current server version back to POS
```

**Special case — price conflict:**
If global catalog price was updated on the server AND local override price was updated on
the POS since the last sync — the server version wins for global catalog, but the local
override is preserved and flagged for merchant review in the dashboard.

### 5.4 Transaction Sync Flow

```
# During the day (real-time)
1. Each completed sale on POS → publish MQTT:
   topic: pos/{merchant_id}/{machine_id}/transactions/new
   payload: { transaction: {...}, items: [...] }
2. Server receives, upserts into transactions + transaction_items tables
   (idempotent via local_id)
3. If POS is offline: transactions queue in POS SQLite with sync_status='pending'
4. On reconnect: POS publishes all pending transactions in a batch
   (same topic, payload: { batch: true, transactions: [...] })
5. Server processes batch, marks each received

# End of day (Z-report)
1. Cashier closes trading day in POS
2. POS generates Z-report locally (already implemented in pos-desktop)
3. POS publishes:
   topic: pos/{merchant_id}/{machine_id}/transactions/z-report
   payload: { trading_day: "2026-03-28", report: {...} }
4. Server stores in z_reports table
5. Dashboard shows Z-report summary
```

### 5.5 Offline Handling

**POS behavior when disconnected:**
- POS continues to operate normally with local SQLite data (already the case)
- All completed transactions are written to SQLite with `sync_status = 'pending'`
- Any catalog changes (new products) are written with `cloud_synced = false`
- On reconnect (MQTT reconnect callback):
  1. Publish `sync/request` with last_synced_at to get server changes
  2. Flush all pending transactions in batch
  3. Flush all unsynced catalog changes

---

## 6. POS Desktop Changes Required (pos-desktop repo)

The following changes are needed in the POS SQLite schema:

### 6.1 Schema additions

**products table:**
```sql
ALTER TABLE products ADD COLUMN cloud_id TEXT;           -- server UUID
ALTER TABLE products ADD COLUMN cloud_synced INTEGER DEFAULT 0;
ALTER TABLE products ADD COLUMN last_cloud_sync TEXT;    -- ISO timestamp
ALTER TABLE products ADD COLUMN catalog_level TEXT DEFAULT 'local'; -- 'global'|'local'
```

**categories table:**
```sql
ALTER TABLE categories ADD COLUMN cloud_id TEXT;
ALTER TABLE categories ADD COLUMN cloud_synced INTEGER DEFAULT 0;
ALTER TABLE categories ADD COLUMN last_cloud_sync TEXT;
```

**New table: sync_queue**
```sql
CREATE TABLE sync_queue (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,       -- 'product'|'category'|'transaction'|'z_report'
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,            -- 'create'|'update'|'delete'
  payload TEXT NOT NULL,           -- JSON
  created_at TEXT NOT NULL,
  status TEXT DEFAULT 'pending'    -- 'pending'|'synced'|'failed'
);
```

### 6.2 New Electron modules needed

- `electron/mqttClient.ts` — MQTT to broker; subscribes to `catalog/notify` only
- `electron/syncService.ts` — HTTP GET catalog pull, applies to SQLite; optional sync_queue legacy
- IPC handlers: `syncConnect`, `syncPullCatalog`, `syncGetStatus`, `syncRefreshMachineContext`, etc.

### 6.3 Settings additions

- `cloud_api_base` — full REST base e.g. `http://host:8001/api/v1`
- `cloud_access_token` — machine JWT from pairing
- `cloud_merchant_id` — merchant UUID from server (pairing and/or `GET /machines/me`)
- `cloud_machine_id` — machine UUID from server (set during pairing)
- `cloud_sync_enabled` — toggle (default: true when paired)
- `mqtt_cloud_host` — cloud MQTT host
- `mqtt_cloud_port` — cloud MQTT port (default: 8883 TLS in production)

---

## 7. API Endpoints (New / Modified)

### 7.1 New hierarchy endpoints

```
# Companies
GET    /companies                     # list merchant's companies
POST   /companies                     # create company
GET    /companies/{id}
PUT    /companies/{id}
DELETE /companies/{id}

# Shops
GET    /shops?company_id=             # list shops
POST   /shops                         # create shop
GET    /shops/{id}
PUT    /shops/{id}
DELETE /shops/{id}

# Shop assortment (explicit allowlist + overrides; RBAC same as shop access; cashier read-only on GET)
GET    /shops/{shop_id}/product-overrides?skip=&limit=     # products **assigned** to shop only
GET    /shops/{shop_id}/product-catalog-candidates?skip=&limit=&search=   # globals not yet assigned
POST   /shops/{shop_id}/product-overrides/{global_product_id}   # add to assortment (idempotent)
DELETE /shops/{shop_id}/product-overrides/{global_product_id}   # remove from assortment
PUT    /shops/{shop_id}/product-overrides/{global_product_id}
  body: { "price": number | null, "isListed": boolean }  # product must already be assigned; price null = inherit
  → MQTT catalog/notify to active machines with that shop_id
```

### 7.2 Catalog management

```
# Push global catalog to shops
POST /catalog/push
  body: { product_ids: [...] | "all", target: { shop_ids: [...] | machine_ids: [...] } }
  → creates local-level copies; for machines with a **shop_id**, only products **assigned** to that shop
    (shop_product_overrides) are copied. Categories: still all selected globals (per machine).

# Global catalog CRUD (already exists, needs catalog_level=global filter)
GET  /products?catalog_level=global
POST /products  (catalog_level defaults to global)

# Shop-level overrides — see Shops section above (`/shops/{shop_id}/product-overrides`)
```

### 7.3 Sync endpoints (primary path for catalog on POS)

```
# Catalog pull (canonical; also triggered after MQTT catalog/notify)
GET  /sync/{machine_id}/catalog?since=ISO_TIMESTAMP
  → { products: [...], categories: [...], syncType, serverTime }
  Auth: machine JWT (type=machine) or dashboard user JWT

# POS catalog writes (cloud source of truth — prefer over MQTT catalog/update)
POST /sync/{machine_id}/products
POST /sync/{machine_id}/categories
PUT  /sync/{machine_id}/products/{product_id}
PUT  /sync/{machine_id}/categories/{category_id}
DELETE /sync/{machine_id}/products/{product_id}
DELETE /sync/{machine_id}/categories/{category_id}

GET  /machines/me
  → machineId, merchantId, shopId (machine JWT only)

POST /sync/{machine_id}/catalog
  → optional legacy batch upload

POST /sync/{machine_id}/transactions
  → batch upload of pending transactions

POST /sync/{machine_id}/z-report
  → upload Z-report
```

### 7.4 Transaction endpoints

```
GET  /transactions?machine_id=&shop_id=&from=&to=&page=&limit=
GET  /transactions/{id}
GET  /transactions/summary?shop_id=&from=&to=   # aggregated totals

GET  /z-reports?machine_id=&shop_id=&from=&to=
GET  /z-reports/{id}
```

---

## 8. Next.js Dashboard — Pages

```
/dashboard                  # Overview: revenue today, active machines, alerts
/catalog                    # Global product catalog (CRUD)
/catalog/push               # Push catalog to shops wizard
/categories                 # Category management
/shops                      # Shop list
/shops/{id}                 # Shop detail: machines, local catalog, transactions
/machines                   # Machine list with status (online/offline/last sync)
/transactions               # Transaction feed with filters
/transactions/z-reports     # Z-report history
/reports/sales              # Sales analytics (by shop, product, time range)
/settings/company           # Company info, VAT, branches
/settings/users             # User management (RBAC)
/settings/machines/pair     # Pairing wizard
```

---

## 9. Implementation Phases

### Phase 1 — Product Catalog Sync (current sprint)

**Goal:** Merchant can manage a product catalog in the cloud dashboard and have it
automatically sync to all paired POS machines.

**Server tasks:**
1. Add `Company` and `Shop` models + migrations
2. Extend `Product` and `Category` with `catalog_level`, `company_id`, `shop_id`, `global_product_id`
3. Fix SKU uniqueness to be per-merchant
4. Fix timestamp fields to use proper `TIMESTAMPTZ` (not strings)
5. Add `POST /catalog/push` endpoint
6. Add MQTT subscriber for `pos/+/+/catalog/update` (POS → server direction)
7. Add `GET /sync/{machine_id}/catalog` REST fallback
8. Update sync.py to support delta sync with `since` timestamp
9. Add `SyncLog` model for audit trail

**POS Desktop tasks:**
1. Add `cloud_id`, `cloud_synced`, `last_cloud_sync` columns to products/categories
2. Add `sync_queue` table (optional / legacy)
3. Add `electron/mqttClient.ts` with cloud broker connection; subscribe to `catalog/notify`
4. Add `electron/syncService.ts`:
   - On MQTT connect or `catalog/notify`: `GET /sync/{machineId}/catalog` and apply to SQLite
   - On product/category save: call cloud `POST/PUT` under `/sync/{machineId}/...` first, then pull
5. Add IPC handlers for sync status, pull, and machine context refresh
6. Show sync status indicator in UI (synced / pending / offline)

**Dashboard tasks:**
1. Next.js project setup (App Router, Tailwind, shadcn/ui)
2. Auth pages (login, JWT storage)
3. Global catalog CRUD page (`/catalog`)
4. Category management (`/categories`)
5. Push catalog wizard (`/catalog/push`) — select products → select shops → confirm
6. Machine list with last-sync timestamp

---

### Phase 2 — Transaction Sync & Z-Reports

**Goal:** All POS transactions sync to the cloud in real-time (or on reconnect).
Merchants can see live sales data and Z-reports in the dashboard.

**Server tasks:**
1. Add `Transaction`, `TransactionItem`, `ZReport` models
2. MQTT subscriber for `pos/+/+/transactions/new` and `pos/+/+/transactions/z-report`
3. `POST /sync/{machine_id}/transactions` REST fallback (batch)
4. `POST /sync/{machine_id}/z-report`
5. Transaction list and summary endpoints

**POS Desktop tasks:**
1. Add `sync_status` column to transactions table
2. On transaction complete → enqueue to sync_queue
3. On Z-report close → publish z-report via MQTT
4. Flush sync_queue on reconnect

**Dashboard tasks:**
1. Transaction feed page (`/transactions`)
2. Z-report history page
3. Daily summary widget on dashboard

---

### Phase 3 — Reporting & Analytics

1. Sales analytics by shop, product, category, time range
2. Revenue trends chart
3. Top products per shop
4. Cross-shop comparison
5. Export to CSV/Excel
6. Scheduled email reports

---

### Phase 4 — Promotions & Price Management

1. Cloud-initiated price push (update price in catalog, push to machines)
2. Promotions: percentage discount, buy-X-get-Y, happy hour
3. Campaign management with start/end dates
4. Push promotions to selected shops/machines

---

### Phase 5 — Inventory & Alerts

1. Stock level tracking (decremented per sale transaction)
2. Low-stock alerts (push notification / email)
3. Inventory replenishment view per shop
4. Picklist generation (PDF)

---

## 10. Decisions Log

| Question | Decision |
|----------|----------|
| Image storage | Cloudinary (existing account) |
| Dashboard real-time | Polling every 30s (Phase 1); upgrade later if needed |
| MQTT TLS | Plain for dev, TLS (port 8883) before production |
| Pairing UX | Alphanumeric code (keep current flow) |
| Company level | Required — always present in hierarchy |
| Multi-currency | ILS (₪) only |
| User invitation | TBD — Phase 3+ |
| Electron version | **Locked at 13.6.9 — must support Windows 7** |

---

## 10a. POS Desktop — Windows 7 Constraint

The POS Desktop (Electron 13.6.9) must support Windows 7. This version ships Node.js 14.16.
**Do not upgrade Electron** — Electron 23+ dropped Windows 7/8/8.1 support.

### Implications for new POS Desktop code

| Area | Constraint |
|------|-----------|
| MQTT client | Use `mqtt` **v4.x** only — v5+ requires Node 16+ |
| HTTP client | Use `axios` — no native `fetch` in Node 14 |
| ES modules | CommonJS only in electron/ main process — no top-level `await` |
| `AbortController` | Not native in Node 14 — polyfill if needed |
| `crypto.randomUUID()` | Not in Node 14 — use `uuid` package (already a dep) |
| TypeScript target | Keep `ES2019` or lower in electron/ tsconfig |

Any new npm package added to pos-desktop must be verified for Node 14 / Electron 13 compatibility.

---

## 11. Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Sync transport | MQTT primary, REST fallback | MQTT is low-latency and resilient; REST ensures delivery when MQTT unavailable |
| Conflict resolution | Last write wins by updated_at | Simple, predictable; mirrors Nayax behavior |
| Catalog model | Two-tier (global + local) | Mirrors Nayax operator/machine product split |
| Offline | POS keeps full local copy | POS must work without internet; SQLite is the source of truth at the shop level |
| Transactions | POS owns the record, cloud mirrors | POS is authoritative; cloud gets best-effort real-time sync |
| Auth | JWT with role-based middleware | Already implemented; extend roles for new hierarchy levels |
| Timestamps | TIMESTAMPTZ in PostgreSQL | Fix current String fields; essential for conflict resolution |

---

## 12. Non-Goals (out of scope)

- Payment processing in the cloud (handled by local Nayax terminal, already in pos-desktop)
- Mobile app (not in current roadmap)
- ERP integration
- Customer loyalty / Monyx wallet
- Multi-currency
- Hardware/device telemetry (temperature, power)
