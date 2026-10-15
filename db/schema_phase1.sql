-- Fas 1: Article, BOM, StockLocation, StockTransaction
-- Detta är ett startschema. I projektet ska Drizzle-migrationer generera motsvarande
-- via drizzle-kit, men denna fil ger Claude Code en tydlig utgångspunkt / referens.

CREATE TYPE article_type AS ENUM ('manufactured', 'purchased', 'service');
CREATE TYPE stock_transaction_type AS ENUM (
    'purchase_receipt',
    'sales_delivery',
    'mo_consumption',
    'mo_receipt',
    'inventory_adjustment'
);

CREATE TABLE articles (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    article_number  VARCHAR(50) UNIQUE NOT NULL,
    name            VARCHAR(255) NOT NULL,
    type            article_type NOT NULL,
    unit            VARCHAR(20) NOT NULL DEFAULT 'st',
    active          BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Self-referencing BOM: en artikel består av komponent-artiklar
CREATE TABLE bom_components (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    parent_article_id    UUID NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
    component_article_id UUID NOT NULL REFERENCES articles(id) ON DELETE RESTRICT,
    quantity             NUMERIC(14,4) NOT NULL DEFAULT 1,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT no_self_reference CHECK (parent_article_id <> component_article_id),
    UNIQUE (parent_article_id, component_article_id)
);

CREATE TABLE warehouses (
    id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name    VARCHAR(100) NOT NULL,
    active  BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE stock_locations (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    warehouse_id  UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
    name          VARCHAR(100) NOT NULL,
    active        BOOLEAN NOT NULL DEFAULT true,
    UNIQUE (warehouse_id, name)
);

-- Append-only transaktionslogg. Aktuellt saldo beräknas som SUM(quantity_delta).
CREATE TABLE stock_transactions (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    article_id       UUID NOT NULL REFERENCES articles(id) ON DELETE RESTRICT,
    location_id      UUID NOT NULL REFERENCES stock_locations(id) ON DELETE RESTRICT,
    quantity_delta   NUMERIC(14,4) NOT NULL,
    transaction_type stock_transaction_type NOT NULL,
    reference_id     UUID, -- FK till t.ex. purchase_order_row / sales_order_row / mo, valideras i applikationslagret
    note             TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by       UUID -- FK till users, läggs till när auth är på plats
);

CREATE INDEX idx_stock_transactions_article_location
    ON stock_transactions (article_id, location_id);

-- Vy för aktuellt saldo per artikel och lagerplats
CREATE VIEW stock_balances AS
SELECT
    article_id,
    location_id,
    SUM(quantity_delta) AS quantity_on_hand
FROM stock_transactions
GROUP BY article_id, location_id;

CREATE INDEX idx_bom_parent ON bom_components (parent_article_id);
CREATE INDEX idx_bom_component ON bom_components (component_article_id);
