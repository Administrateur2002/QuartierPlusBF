CREATE TABLE IF NOT EXISTS voy_companies (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    owner_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(160) NOT NULL,
    logo_url TEXT,
    rccm_last4 CHAR(4),
    rccm_status VARCHAR(16) NOT NULL DEFAULT 'PENDING'
        CHECK (rccm_status IN ('PENDING', 'VERIFIED', 'REJECTED', 'NOT_PROVIDED')),
    ifu_last4 CHAR(4),
    ifu_status VARCHAR(16) NOT NULL DEFAULT 'PENDING'
        CHECK (ifu_status IN ('PENDING', 'VERIFIED', 'REJECTED', 'NOT_PROVIDED')),
    license_last4 CHAR(4),
    license_status VARCHAR(16) NOT NULL DEFAULT 'PENDING'
        CHECK (license_status IN ('PENDING', 'VERIFIED', 'REJECTED', 'NOT_PROVIDED')),
    cancellation_policy TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS voy_agents (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id UUID NOT NULL REFERENCES voy_companies(id) ON DELETE CASCADE,
    user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (company_id, user_id)
);

CREATE TABLE IF NOT EXISTS voy_routes (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id UUID NOT NULL REFERENCES voy_companies(id) ON DELETE CASCADE,
    departure VARCHAR(160) NOT NULL,
    arrival VARCHAR(160) NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (departure <> arrival)
);

CREATE TABLE IF NOT EXISTS voy_trips (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    route_id UUID NOT NULL REFERENCES voy_routes(id) ON DELETE CASCADE,
    departure_at TIMESTAMPTZ NOT NULL,
    arrival_at TIMESTAMPTZ NOT NULL,
    vehicle VARCHAR(120) NOT NULL,
    seat_count INTEGER NOT NULL CHECK (seat_count BETWEEN 1 AND 500),
    price NUMERIC(12, 2) NOT NULL CHECK (price >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (arrival_at > departure_at)
);

CREATE TABLE IF NOT EXISTS voy_seats (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    trip_id UUID NOT NULL REFERENCES voy_trips(id) ON DELETE CASCADE,
    seat_number VARCHAR(12) NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'AVAILABLE'
        CHECK (status IN ('AVAILABLE', 'RESERVED', 'SOLD')),
    UNIQUE (trip_id, seat_number)
);

CREATE TABLE IF NOT EXISTS voy_ticket_reservations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    trip_id UUID NOT NULL REFERENCES voy_trips(id) ON DELETE CASCADE,
    seat_id UUID NOT NULL REFERENCES voy_seats(id),
    traveler_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount NUMERIC(12, 2) NOT NULL CHECK (amount >= 0),
    commission_amount NUMERIC(12, 2) NOT NULL CHECK (commission_amount >= 0),
    status VARCHAR(16) NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING', 'APPROVED', 'CANCELLED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (seat_id, status)
);

CREATE TABLE IF NOT EXISTS voy_tickets (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    trip_id UUID NOT NULL REFERENCES voy_trips(id),
    seat_id UUID NOT NULL REFERENCES voy_seats(id),
    traveler_id UUID NOT NULL REFERENCES users(id),
    status VARCHAR(16) NOT NULL DEFAULT 'VALID'
        CHECK (status IN ('VALID', 'USED', 'EXPIRED', 'CANCELLED')),
    expires_at TIMESTAMPTZ NOT NULL,
    signature TEXT NOT NULL,
    kid VARCHAR(64) NOT NULL,
    short_code CHAR(8) NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (trip_id, seat_id),
    UNIQUE (trip_id, traveler_id)
);

CREATE TABLE IF NOT EXISTS voy_parcels (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id UUID NOT NULL REFERENCES voy_companies(id),
    trip_id UUID NOT NULL REFERENCES voy_trips(id),
    sender_id UUID NOT NULL REFERENCES users(id),
    declared_contents VARCHAR(300) NOT NULL,
    weight_kg NUMERIC(8, 2) NOT NULL CHECK (weight_kg > 0),
    recipient_name VARCHAR(160) NOT NULL,
    recipient_phone_last4 CHAR(4) NOT NULL,
    pickup_code_hash CHAR(64) NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'ACCEPTED'
        CHECK (status IN ('ACCEPTED', 'DEPARTED', 'ARRIVED', 'COLLECTED', 'CANCELLED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS voy_scan_logs (
    id BIGSERIAL PRIMARY KEY,
    company_id UUID NOT NULL REFERENCES voy_companies(id),
    agent_id UUID REFERENCES voy_agents(id) ON DELETE SET NULL,
    ticket_id UUID REFERENCES voy_tickets(id) ON DELETE CASCADE,
    parcel_id UUID REFERENCES voy_parcels(id) ON DELETE CASCADE,
    action VARCHAR(24) NOT NULL,
    result VARCHAR(32) NOT NULL,
    scanned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK ((ticket_id IS NULL) <> (parcel_id IS NULL))
);

CREATE INDEX IF NOT EXISTS voy_trips_search_idx ON voy_trips (departure_at);
CREATE INDEX IF NOT EXISTS voy_routes_search_idx
    ON voy_routes (departure, arrival) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS voy_scan_logs_ticket_idx
    ON voy_scan_logs (ticket_id, scanned_at DESC);