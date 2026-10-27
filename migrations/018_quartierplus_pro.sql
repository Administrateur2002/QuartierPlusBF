CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS pro_wholesalers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    business_name VARCHAR(120) NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    rccm_status VARCHAR(20) NOT NULL DEFAULT 'PENDING'
        CHECK (rccm_status IN ('PENDING', 'VERIFIED', 'REJECTED', 'NOT_PROVIDED')),
    ifu_status VARCHAR(20) NOT NULL DEFAULT 'PENDING'
        CHECK (ifu_status IN ('PENDING', 'VERIFIED', 'REJECTED', 'NOT_PROVIDED')),
    delivery_zone TEXT NOT NULL,
    catalog_slug VARCHAR(80) NOT NULL UNIQUE,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pro_wholesaler_members (
    wholesaler_id UUID NOT NULL REFERENCES pro_wholesalers(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    member_role VARCHAR(20) NOT NULL CHECK (member_role IN ('DELIVERER', 'MANAGER')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (wholesaler_id, user_id)
);

CREATE TABLE IF NOT EXISTS pro_products (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    wholesaler_id UUID NOT NULL REFERENCES pro_wholesalers(id) ON DELETE CASCADE,
    name VARCHAR(160) NOT NULL,
    photo_url TEXT,
    unit VARCHAR(40) NOT NULL,
    unit_price NUMERIC(12, 2) NOT NULL CHECK (unit_price >= 0),
    stock NUMERIC(12, 3) NOT NULL DEFAULT 0 CHECK (stock >= 0),
    min_order_quantity NUMERIC(12, 3) NOT NULL DEFAULT 1 CHECK (min_order_quantity > 0),
    delivery_days INTEGER NOT NULL DEFAULT 1 CHECK (delivery_days >= 0),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pro_price_tiers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    product_id UUID NOT NULL REFERENCES pro_products(id) ON DELETE CASCADE,
    min_quantity NUMERIC(12, 3) NOT NULL CHECK (min_quantity > 0),
    unit_price NUMERIC(12, 2) NOT NULL CHECK (unit_price >= 0),
    UNIQUE (product_id, min_quantity)
);

CREATE TABLE IF NOT EXISTS pro_orders (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    buyer_id UUID NOT NULL REFERENCES users(id),
    wholesaler_id UUID NOT NULL REFERENCES pro_wholesalers(id),
    deliverer_id UUID REFERENCES users(id),
    status VARCHAR(20) NOT NULL DEFAULT 'RECEIVED'
        CHECK (status IN ('RECEIVED', 'ACCEPTED', 'PREPARED', 'IN_TRANSIT', 'DELIVERED', 'CANCELLED')),
    total NUMERIC(14, 2) NOT NULL CHECK (total >= 0),
    payment_method VARCHAR(24) NOT NULL
        CHECK (payment_method IN ('PAY_ON_DELIVERY', 'DIRECT_DEPOSIT')),
    payment_status VARCHAR(20) NOT NULL DEFAULT 'UNPAID'
        CHECK (payment_status IN ('UNPAID', 'DEPOSIT_PAID', 'PAID_ON_DELIVERY')),
    address TEXT NOT NULL,
    delivery_latitude DOUBLE PRECISION,
    delivery_longitude DOUBLE PRECISION,
    notes TEXT NOT NULL DEFAULT '',
    handoff_code_hash CHAR(64) NOT NULL,
    failed_handoff_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_handoff_attempts >= 0),
    handoff_locked_until TIMESTAMPTZ,
    delivered_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK ((delivery_latitude IS NULL) = (delivery_longitude IS NULL)),
    CHECK (delivery_latitude IS NULL OR delivery_latitude BETWEEN -90 AND 90),
    CHECK (delivery_longitude IS NULL OR delivery_longitude BETWEEN -180 AND 180)
);

CREATE TABLE IF NOT EXISTS pro_order_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_id UUID NOT NULL REFERENCES pro_orders(id) ON DELETE CASCADE,
    product_id UUID REFERENCES pro_products(id) ON DELETE SET NULL,
    product_name VARCHAR(160) NOT NULL,
    unit VARCHAR(40) NOT NULL,
    quantity NUMERIC(12, 3) NOT NULL CHECK (quantity > 0),
    unit_price NUMERIC(12, 2) NOT NULL CHECK (unit_price >= 0),
    line_total NUMERIC(14, 2) NOT NULL CHECK (line_total >= 0)
);

CREATE TABLE IF NOT EXISTS pro_order_events (
    id BIGSERIAL PRIMARY KEY,
    order_id UUID NOT NULL REFERENCES pro_orders(id) ON DELETE CASCADE,
    actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
    status VARCHAR(20) NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pro_favorites (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    wholesaler_id UUID NOT NULL REFERENCES pro_wholesalers(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, wholesaler_id)
);

CREATE TABLE IF NOT EXISTS pro_recurring_lists (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    wholesaler_id UUID NOT NULL REFERENCES pro_wholesalers(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    items JSONB NOT NULL CHECK (jsonb_typeof(items) = 'array'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pro_delivery_locations (
    id BIGSERIAL PRIMARY KEY,
    order_id UUID NOT NULL REFERENCES pro_orders(id) ON DELETE CASCADE,
    deliverer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    latitude DOUBLE PRECISION NOT NULL CHECK (latitude BETWEEN -90 AND 90),
    longitude DOUBLE PRECISION NOT NULL CHECK (longitude BETWEEN -180 AND 180),
    accuracy_meters DOUBLE PRECISION NOT NULL CHECK (accuracy_meters >= 0),
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS pro_products_catalog_idx
    ON pro_products (wholesaler_id, is_active, name);
CREATE INDEX IF NOT EXISTS pro_orders_buyer_idx
    ON pro_orders (buyer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS pro_orders_wholesaler_idx
    ON pro_orders (wholesaler_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS pro_delivery_locations_order_idx
    ON pro_delivery_locations (order_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS pro_order_events_order_idx
    ON pro_order_events (order_id, created_at DESC);

CREATE OR REPLACE FUNCTION pro_delete_expired_delivery_locations()
RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE deleted_count INTEGER;
BEGIN
    DELETE FROM pro_delivery_locations location
    USING pro_orders orders
    WHERE location.order_id = orders.id
      AND orders.status = 'DELIVERED'
      AND orders.delivered_at < NOW() - INTERVAL '30 days';
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$;