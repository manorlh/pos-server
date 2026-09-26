"""the built-in general item: one "פריט כללי" per company, sold in all of its shops

The till's calculator tab adds a typed amount to the cart as a line of one product, the
company's general item. Every company has exactly one; the app creates it with each new
company (`ensure_general_item` in app/services/general_item.py), and this migration
creates it for every company that already exists.

* `products.is_general` — true only on that product. `server_default false`, so every
  existing row is, correctly, not a general item.
* `uq_products_general_per_company` — a partial unique index on `company_id WHERE
  is_general`: at most one per company, and it constrains nothing else.
* The backfill, for each company with a tenant and no general item yet:

  - **its category.** `products.category_id` is NOT NULL and the category model has no
    notion of a default category, so the company's own active top-level "כללי"
    category is reused if it has one, and otherwise one is created, placed after the
    tenant's last category so it does not jump to the front of any till's row;
  - **its SKU**, drawn from the tenant's local SKU counter the way `allocate_sku` does:
    the counter is seeded if absent, and the SKU is never below the tenant's highest
    numeric SKU + 1, so it cannot collide with one somebody typed by hand. No global
    SKU: every company's general item is its own. (Only SKUs of up to 18 digits are
    counted — a longer one cannot collide with a counter value, and would not fit the
    counter's BIGINT);
  - **the product**: open price, base price 0, no VAT rate of its own (the shop's
    standard rate applies), not weighed, no stock tracking, and the shop-scope company
    rule on its own company without sub-companies — so the existing shop hooks keep it
    on every shop the company opens later;
  - **its assortment rows**, one per active shop of the company, written exactly as the
    rule writes them (`assigned_by_rule = true`, listed, `price` and `is_available`
    NULL). A deactivated shop gets none, as under the rule; reactivating it runs the
    rule. Sub-companies' shops get none: each sub-company has its own general item.

  `updated_at = now()` on the new rows, so every till picks the item up on its next
  delta pull.

Idempotent like its neighbours, and inside the SQL itself so the offline `--sql`
rendering is too: the column and index are `IF NOT EXISTS`, and a company that already
has a general item is skipped, so a second run creates nothing.

Downgrade drops the index and the column. The products stay, as ordinary open-price
products the merchant may then delete: some may already be on issued documents
(`transaction_items.product_id` has no ON DELETE), so deleting them is not a downgrade's
call.

Deploy order: run this before the new code, which reads and writes `is_general`.

Revision ID: e7f8a9b0c1d2
Revises: d6e7f8a9b0c1
Create Date: 2026-09-26 16:00:00.000000
"""

from __future__ import annotations

from alembic import op


revision = "e7f8a9b0c1d2"
down_revision = "d6e7f8a9b0c1"
branch_labels = None
depends_on = None


GENERAL_ITEM_NAME = "פריט כללי"
GENERAL_CATEGORY_NAME = "כללי"
_INDEX = "uq_products_general_per_company"


ADD_COLUMN = """
    ALTER TABLE products
        ADD COLUMN IF NOT EXISTS is_general BOOLEAN NOT NULL DEFAULT false"""

ADD_INDEX = f"""
    CREATE UNIQUE INDEX IF NOT EXISTS {_INDEX}
        ON products (company_id)
     WHERE is_general"""


#: One general item, with its category, SKU and assortment rows, for every company
#: that has none. A constant so the test can read exactly what runs.
BACKFILL = f"""
    DO $$
    DECLARE
        c        RECORD;
        cat_id   UUID;
        prod_id  UUID;
        sku_no   BIGINT;
    BEGIN
        FOR c IN
            SELECT co.id, co.tenant_id
              FROM companies co
             WHERE co.tenant_id IS NOT NULL
               AND NOT EXISTS (
                     SELECT 1 FROM products p
                      WHERE p.company_id = co.id AND p.is_general
                   )
             ORDER BY co.created_at, co.id
        LOOP
            -- The category: the company's own active top-level "{GENERAL_CATEGORY_NAME}", else a new one.
            cat_id := NULL;
            SELECT k.id INTO cat_id
              FROM categories k
             WHERE k.tenant_id = c.tenant_id
               AND k.company_id = c.id
               AND k.catalog_level = 'global'
               AND k.shop_id IS NULL
               AND k.pos_machine_id IS NULL
               AND k.parent_id IS NULL
               AND k.is_active
               AND k.name = '{GENERAL_CATEGORY_NAME}'
             ORDER BY k.sort_order, k.created_at, k.id
             LIMIT 1;
            IF cat_id IS NULL THEN
                cat_id := gen_random_uuid();
                INSERT INTO categories
                    (id, tenant_id, company_id, catalog_level, name, is_active, sort_order,
                     created_at, updated_at)
                VALUES
                    (cat_id, c.tenant_id, c.id, 'global', '{GENERAL_CATEGORY_NAME}', true,
                     COALESCE((SELECT MAX(k2.sort_order) FROM categories k2
                                WHERE k2.tenant_id = c.tenant_id
                                  AND k2.catalog_level = 'global'
                                  AND k2.pos_machine_id IS NULL), 0) + 1,
                     now(), now());
            END IF;

            -- The SKU, from the tenant's local counter, never below its highest numeric SKU.
            INSERT INTO tenant_local_sku_sequences (tenant_id, next_value)
            VALUES (c.tenant_id, 1000)
            ON CONFLICT (tenant_id) DO NOTHING;
            -- One statement, so the draw and the bump cannot be split by a concurrent allocation.
            UPDATE tenant_local_sku_sequences q
               SET next_value = GREATEST(
                       q.next_value,
                       COALESCE((SELECT MAX(p.sku::BIGINT) + 1 FROM products p
                                  WHERE p.tenant_id = c.tenant_id
                                    AND p.sku ~ '^[0-9]{{1,18}}$'), 0)
                   ) + 1
             WHERE q.tenant_id = c.tenant_id
            RETURNING q.next_value - 1 INTO sku_no;

            -- The product.
            prod_id := gen_random_uuid();
            INSERT INTO products
                (id, tenant_id, company_id, shop_id, pos_machine_id, category_id,
                 global_product_id, catalog_level, is_local_override, name, description,
                 price, sku, global_sku, sku_auto_assigned, image_url, in_stock,
                 is_available, stock_quantity, barcode, tax_rate, voucher_id, track_stock,
                 is_open_price, is_weighed, unit_label, is_general,
                 shop_scope_mode, shop_scope_company_id, shop_scope_include_subcompanies,
                 created_at, updated_at)
            VALUES
                (prod_id, c.tenant_id, c.id, NULL, NULL, cat_id,
                 NULL, 'global', false, '{GENERAL_ITEM_NAME}', NULL,
                 0, sku_no::TEXT, NULL, true, NULL, true,
                 true, 0, NULL, NULL, NULL, false,
                 true, false, NULL, true,
                 'company', c.id, false,
                 now(), now());

            -- Its assortment: every active shop of this company, as the company rule writes it.
            INSERT INTO shop_product_overrides
                (id, shop_id, global_product_id, price, is_listed, is_available,
                 assigned_by_rule, created_at, updated_at)
            SELECT gen_random_uuid(), s.id, prod_id, NULL, true, NULL,
                   true, now(), now()
              FROM shops s
             WHERE s.company_id = c.id
               AND s.tenant_id = c.tenant_id
               AND s.is_active
            ON CONFLICT (shop_id, global_product_id) DO NOTHING;
        END LOOP;
    END
    $$"""


def upgrade() -> None:
    op.execute(ADD_COLUMN)
    op.execute(ADD_INDEX)
    op.execute(BACKFILL)


def downgrade() -> None:
    # See the module docstring: the products themselves are left in place.
    op.execute(f"DROP INDEX IF EXISTS {_INDEX}")
    op.execute("ALTER TABLE products DROP COLUMN IF EXISTS is_general")
