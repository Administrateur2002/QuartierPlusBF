CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS country_config (
    code VARCHAR(3) PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    phone_prefix VARCHAR(5) NOT NULL,
    default_radius_m INTEGER NOT NULL DEFAULT 5000 CHECK (default_radius_m > 0),
    police_number VARCHAR(20) NOT NULL,
    firefighters_number VARCHAR(20) NOT NULL,
    ambulance_number VARCHAR(20) NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE country_config
    ADD COLUMN IF NOT EXISTS default_radius_m INTEGER NOT NULL DEFAULT 5000;

CREATE TABLE IF NOT EXISTS country_phone_prefixes (
    country_code VARCHAR(3) NOT NULL REFERENCES country_config(code) ON DELETE CASCADE,
    phone_prefix VARCHAR(16) NOT NULL,
    PRIMARY KEY (country_code, phone_prefix)
);

CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    phone_number VARCHAR(20) UNIQUE,
    email VARCHAR(255),
    google_id VARCHAR(255) UNIQUE,
    full_name VARCHAR(100),
    first_name VARCHAR(100),
    last_name VARCHAR(100),
    phone_e164 VARCHAR(16),
    neighborhood VARCHAR(100),
    role VARCHAR(30) DEFAULT 'CITIZEN',
    country_code VARCHAR(3) REFERENCES country_config(code),
    reputation_score INT DEFAULT 100,
    is_verified BOOLEAN DEFAULT FALSE,
    phone_verified_at TIMESTAMPTZ,
    email_verified_at TIMESTAMPTZ,
    terms_accepted_at TIMESTAMPTZ,
    badge VARCHAR(100),
    profile_photo_public_id TEXT,
    profile_photo_url TEXT,
    last_location GEOMETRY(Point, 4326),
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS profile_photo_public_id TEXT,
    ADD COLUMN IF NOT EXISTS profile_photo_url TEXT;

CREATE TABLE IF NOT EXISTS otp_verifications (
    phone_number VARCHAR(20) PRIMARY KEY,
    code_hash VARCHAR(64) NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    attempts INT NOT NULL DEFAULT 0,
    channel VARCHAR(10) NOT NULL DEFAULT 'sms' CHECK (channel IN ('sms', 'email')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    registration_data JSONB
);

ALTER TABLE otp_verifications
    ADD COLUMN IF NOT EXISTS registration_data JSONB;

CREATE TABLE IF NOT EXISTS sos_alerts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    location GEOMETRY(Point, 4326) NOT NULL,
    status VARCHAR(20) DEFAULT 'ACTIVE',
    emergency_type VARCHAR(20) NOT NULL DEFAULT 'OTHER'
        CHECK (emergency_type IN ('MEDICAL', 'SECURITY', 'FIRE', 'OTHER')),
    escalation_level INT DEFAULT 1,
    emergency_image_url TEXT,
    emergency_audio_url TEXT,
    livekit_room_id VARCHAR(100),
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sos_assists (
    sos_id UUID NOT NULL REFERENCES sos_alerts(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (sos_id, user_id)
);

CREATE TABLE IF NOT EXISTS sos_moderation_queue (
    sos_id UUID PRIMARY KEY REFERENCES sos_alerts(id) ON DELETE CASCADE,
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING', 'REVIEWED', 'DISMISSED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS channels (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(100) NOT NULL,
    kind VARCHAR(20) NOT NULL,
    country_code VARCHAR(3) REFERENCES country_config(code) ON DELETE CASCADE,
    center_location GEOMETRY(Point, 4326),
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE channels
    ADD COLUMN IF NOT EXISTS country_code VARCHAR(3)
        REFERENCES country_config(code) ON DELETE CASCADE;

CREATE UNIQUE INDEX IF NOT EXISTS channels_country_kind_unique_idx
    ON channels (country_code, kind)
    WHERE country_code IS NOT NULL;

CREATE TABLE IF NOT EXISTS messages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    channel_id UUID REFERENCES channels(id) ON DELETE CASCADE,
    sender_id UUID REFERENCES users(id) ON DELETE CASCADE,
    body TEXT,
    media_url TEXT,
    media_type VARCHAR(20),
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS marketplace_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    seller_id UUID REFERENCES users(id) ON DELETE CASCADE,
    title VARCHAR(150) NOT NULL,
    description TEXT,
    price_fcfa NUMERIC(12, 2) NOT NULL,
    category VARCHAR(30) NOT NULL,
    item_type VARCHAR(20) NOT NULL DEFAULT 'listing'
        CHECK (item_type IN ('listing', 'local', 'service')),
    whatsapp_phone VARCHAR(20),
    contact_phone VARCHAR(20),
    image_urls TEXT[],
    location GEOMETRY(Point, 4326) NOT NULL,
    country_of_origin VARCHAR(3),
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE marketplace_items
    ADD COLUMN IF NOT EXISTS country_of_origin VARCHAR(3);

ALTER TABLE marketplace_items
    ADD COLUMN IF NOT EXISTS item_type VARCHAR(20) NOT NULL DEFAULT 'listing'
    CHECK (item_type IN ('listing', 'local', 'service'));

CREATE TABLE IF NOT EXISTS map_markers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    category VARCHAR(30) NOT NULL CHECK (
        category IN ('POWER_OUTAGE', 'WATER_OUTAGE', 'ROAD_HAZARD', 'LOST_ITEM')
    ),
    title VARCHAR(150) NOT NULL,
    description TEXT,
    location GEOMETRY(Point, 4326) NOT NULL,
    radius_impact_m INTEGER NOT NULL DEFAULT 500 CHECK (radius_impact_m > 0),
    status VARCHAR(20) NOT NULL DEFAULT 'CONFIRMING'
        CHECK (status IN ('CONFIRMING', 'ACTIVE', 'RESOLVED', 'EXPIRED')),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP + INTERVAL '24 hours',
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_map_markers_active_location
    ON map_markers USING GIST (location)
    WHERE status IN ('CONFIRMING', 'ACTIVE');

CREATE TABLE IF NOT EXISTS map_marker_confirmations (
    marker_id UUID NOT NULL REFERENCES map_markers(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    location GEOMETRY(Point, 4326) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (marker_id, user_id)
);

CREATE TABLE IF NOT EXISTS conversations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS conversation_participants (
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_read_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (conversation_id, user_id)
);

CREATE TABLE IF NOT EXISTS private_messages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sender_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    media_url TEXT,
    media_type VARCHAR(20),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS user_blocks (
    blocker_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    blocked_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (blocker_id, blocked_id),
    CHECK (blocker_id <> blocked_id)
);

CREATE INDEX IF NOT EXISTS idx_private_messages_conversation_created
    ON private_messages (conversation_id, created_at DESC);

CREATE TABLE IF NOT EXISTS reports (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    reporter_id UUID REFERENCES users(id) ON DELETE CASCADE,
    target_type VARCHAR(20) NOT NULL,
    target_id UUID NOT NULL,
    reason TEXT NOT NULL,
    status VARCHAR(20) DEFAULT 'PENDING',
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS push_tokens (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token VARCHAR(255) NOT NULL UNIQUE,
    platform VARCHAR(20) NOT NULL CHECK (platform IN ('ios', 'android')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS user_channel_subscriptions (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, channel_id)
);

CREATE TABLE IF NOT EXISTS transactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    fedapay_tx_id VARCHAR(100) NOT NULL UNIQUE,
    amount INT NOT NULL CHECK (amount > 0),
    currency CHAR(3) NOT NULL DEFAULT 'XOF',
    status VARCHAR(10) NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING', 'APPROVED', 'FAILED', 'CANCELED')),
    payment_type VARCHAR(20) NOT NULL
        CHECK (payment_type IN (
            'ALLIANCE_PRO', 'SPONSORED_PIN', 'SYNDIC', 'TOWN_HALL',
            'SECURITY_AGENT', 'WHOLESALER', 'TRANSPORT_COMPANY', 'TICKET'
        )),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS subscriptions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    plan_type VARCHAR(50) NOT NULL,
    status VARCHAR(10) NOT NULL DEFAULT 'ACTIVE'
        CHECK (status IN ('ACTIVE', 'EXPIRED')),
    starts_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMPTZ NOT NULL,
    publication JSONB NOT NULL DEFAULT '{}'::jsonb
);

ALTER TABLE subscriptions
    ADD COLUMN IF NOT EXISTS publication JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS sponsored_pins (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title VARCHAR(150) NOT NULL,
    location GEOGRAPHY(Point, 4326) NOT NULL,
    icon_url TEXT,
    caption VARCHAR(300) NOT NULL DEFAULT '',
    marketplace_item_id UUID REFERENCES marketplace_items(id) ON DELETE SET NULL,
    starts_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMPTZ NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT FALSE
);

ALTER TABLE sponsored_pins
    ADD COLUMN IF NOT EXISTS caption VARCHAR(300) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS marketplace_item_id UUID
        REFERENCES marketplace_items(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS residences (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(150) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS residence_members (
    residence_id UUID NOT NULL REFERENCES residences(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role VARCHAR(20) NOT NULL DEFAULT 'MEMBER'
        CHECK (role IN ('MEMBER', 'MANAGER')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (residence_id, user_id)
);

CREATE TABLE IF NOT EXISTS municipalities (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(150) NOT NULL,
    center_location GEOGRAPHY(Point, 4326),
    radius_km DOUBLE PRECISION NOT NULL DEFAULT 30 CHECK (radius_km > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS municipality_members (
    municipality_id UUID NOT NULL REFERENCES municipalities(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (municipality_id, user_id)
);

CREATE TABLE IF NOT EXISTS flash_sales (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    merchant_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title VARCHAR(150) NOT NULL,
    discount_percent INT NOT NULL CHECK (discount_percent BETWEEN 1 AND 100),
    expires_at TIMESTAMPTZ NOT NULL,
    radius_km DOUBLE PRECISION NOT NULL DEFAULT 0.8
        CHECK (radius_km > 0 AND radius_km <= 0.8),
    location GEOGRAPHY(Point, 4326) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS residence_posts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    residence_id UUID NOT NULL REFERENCES residences(id) ON DELETE CASCADE,
    author_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 5000),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS residence_votes (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    residence_id UUID NOT NULL REFERENCES residences(id) ON DELETE CASCADE,
    author_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title VARCHAR(250) NOT NULL,
    options JSONB NOT NULL CHECK (jsonb_typeof(options) = 'array'),
    status VARCHAR(10) NOT NULL DEFAULT 'OPEN'
        CHECK (status IN ('OPEN', 'CLOSED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS residence_vote_responses (
    vote_id UUID NOT NULL REFERENCES residence_votes(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    option_index INT NOT NULL CHECK (option_index >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (vote_id, user_id)
);

CREATE TABLE IF NOT EXISTS craftsmen (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(150) NOT NULL,
    trade VARCHAR(100) NOT NULL,
    phone VARCHAR(30) NOT NULL,
    rating NUMERIC(2, 1) NOT NULL DEFAULT 0 CHECK (rating BETWEEN 0 AND 5),
    residence_id UUID NOT NULL REFERENCES residences(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS smart_report_groups (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    category VARCHAR(30) NOT NULL,
    centroid_location GEOGRAPHY(Point, 4326) NOT NULL,
    report_count INT NOT NULL DEFAULT 0 CHECK (report_count >= 0),
    status VARCHAR(20) NOT NULL DEFAULT 'OPEN',
    grid_key VARCHAR(100) NOT NULL UNIQUE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS citizen_consultations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    municipality_id UUID NOT NULL REFERENCES municipalities(id) ON DELETE CASCADE,
    author_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    question VARCHAR(500) NOT NULL,
    options JSONB NOT NULL CHECK (jsonb_typeof(options) = 'array'),
    ends_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS citizen_consultation_responses (
    consultation_id UUID NOT NULL REFERENCES citizen_consultations(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    option_index INT NOT NULL CHECK (option_index >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (consultation_id, user_id)
);

CREATE TABLE IF NOT EXISTS official_news (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    municipality_id UUID NOT NULL REFERENCES municipalities(id) ON DELETE CASCADE,
    author_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title VARCHAR(250) NOT NULL,
    body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 10000),
    is_certified BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS emergency_profiles (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    medical_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS interventions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    sos_id UUID NOT NULL UNIQUE REFERENCES sos_alerts(id) ON DELETE CASCADE,
    agent_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    patient_medical_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
    status VARCHAR(20) NOT NULL DEFAULT 'ACCEPTED',
    route_coordinates JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS neighbor_responders (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    is_certified_first_aider BOOLEAN NOT NULL DEFAULT FALSE,
    radius_coverage_m INT NOT NULL DEFAULT 800 CHECK (radius_coverage_m > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organizer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title VARCHAR(200) NOT NULL CHECK (length(title) > 0),
    description TEXT NOT NULL DEFAULT '',
    location_name VARCHAR(200) NOT NULL,
    location_coords GEOGRAPHY(Point, 4326),
    event_date TIMESTAMPTZ NOT NULL,
    ticket_price INT NOT NULL DEFAULT 0 CHECK (ticket_price >= 0),
    total_capacity INT NOT NULL CHECK (total_capacity > 0),
    tickets_sold INT NOT NULL DEFAULT 0
        CHECK (tickets_sold >= 0 AND tickets_sold <= total_capacity),
    is_published BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tickets (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    qr_code_signature VARCHAR(64) NOT NULL UNIQUE,
    status VARCHAR(10) NOT NULL DEFAULT 'VALID'
        CHECK (status IN ('VALID', 'USED', 'CANCELLED')),
    purchased_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    scanned_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS event_ticket_reservations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    transaction_id UUID UNIQUE REFERENCES transactions(id) ON DELETE SET NULL,
    status VARCHAR(12) NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING', 'APPROVED', 'CANCELLED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS first_name VARCHAR(100);
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_name VARCHAR(100);
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_e164 VARCHAR(16);
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_verified_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS badge VARCHAR(100);
ALTER TABLE sos_alerts
    ADD COLUMN IF NOT EXISTS emergency_type VARCHAR(20) NOT NULL DEFAULT 'OTHER';
ALTER TABLE sos_alerts
    ADD COLUMN IF NOT EXISTS emergency_audio_url TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS users_phone_e164_unique_idx
    ON users (phone_e164) WHERE phone_e164 IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_unique_idx
    ON users (LOWER(email)) WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_location
    ON users USING GIST (last_location);
CREATE INDEX IF NOT EXISTS idx_sos_location
    ON sos_alerts USING GIST (location);
CREATE INDEX IF NOT EXISTS idx_marketplace_location
    ON marketplace_items USING GIST (location);
CREATE INDEX IF NOT EXISTS idx_push_tokens_user ON push_tokens (user_id);
CREATE INDEX IF NOT EXISTS idx_channel_subscriptions_channel
    ON user_channel_subscriptions (channel_id);
CREATE INDEX IF NOT EXISTS idx_transactions_user_created
    ON transactions (user_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_user_plan_unique_idx
    ON subscriptions (user_id, plan_type);
CREATE INDEX IF NOT EXISTS idx_sponsored_pins_location
    ON sponsored_pins USING GIST (location);
CREATE INDEX IF NOT EXISTS idx_sponsored_pins_active_expiry
    ON sponsored_pins (expires_at) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS flash_sales_location_gist_idx
    ON flash_sales USING GIST (location);
CREATE INDEX IF NOT EXISTS flash_sales_expiry_idx ON flash_sales (expires_at);
CREATE INDEX IF NOT EXISTS residence_posts_residence_created_idx
    ON residence_posts (residence_id, created_at DESC);
CREATE INDEX IF NOT EXISTS craftsmen_residence_rating_idx
    ON craftsmen (residence_id, rating DESC);
CREATE INDEX IF NOT EXISTS smart_report_groups_location_gist_idx
    ON smart_report_groups USING GIST (centroid_location);
CREATE INDEX IF NOT EXISTS neighbor_responders_certified_idx
    ON neighbor_responders (radius_coverage_m)
    WHERE is_certified_first_aider = TRUE;
CREATE INDEX IF NOT EXISTS events_published_date_idx
    ON events (event_date) WHERE is_published = TRUE;
CREATE INDEX IF NOT EXISTS events_organizer_date_idx
    ON events (organizer_id, event_date DESC);
CREATE INDEX IF NOT EXISTS events_location_gist_idx
    ON events USING GIST (location_coords);
CREATE INDEX IF NOT EXISTS tickets_user_purchased_idx
    ON tickets (user_id, purchased_at DESC);
CREATE INDEX IF NOT EXISTS tickets_event_status_idx
    ON tickets (event_id, status);
CREATE INDEX IF NOT EXISTS event_ticket_reservations_capacity_idx
    ON event_ticket_reservations (event_id) WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS event_ticket_reservations_user_idx
    ON event_ticket_reservations (user_id, event_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS event_ticket_reservations_pending_user_idx
    ON event_ticket_reservations (event_id, user_id) WHERE status = 'PENDING';