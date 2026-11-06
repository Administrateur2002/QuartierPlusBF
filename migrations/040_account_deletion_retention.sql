ALTER TABLE pro_orders
    ALTER COLUMN buyer_id DROP NOT NULL;
ALTER TABLE pro_orders
    DROP CONSTRAINT IF EXISTS pro_orders_buyer_id_fkey;
ALTER TABLE pro_orders
    ADD CONSTRAINT pro_orders_buyer_id_fkey
    FOREIGN KEY (buyer_id) REFERENCES users(id) ON DELETE SET NULL;cd /workspaces/QuartierPlus
    git status
    git push origin main

ALTER TABLE pro_orders
    DROP CONSTRAINT IF EXISTS pro_orders_deliverer_id_fkey;
ALTER TABLE pro_orders
    ADD CONSTRAINT pro_orders_deliverer_id_fkey
    FOREIGN KEY (deliverer_id) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE voy_tickets
    ALTER COLUMN traveler_id DROP NOT NULL;
ALTER TABLE voy_tickets
    DROP CONSTRAINT IF EXISTS voy_tickets_traveler_id_fkey;
ALTER TABLE voy_tickets
    ADD CONSTRAINT voy_tickets_traveler_id_fkey
    FOREIGN KEY (traveler_id) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE voy_parcels
    ALTER COLUMN sender_id DROP NOT NULL;
ALTER TABLE voy_parcels
    DROP CONSTRAINT IF EXISTS voy_parcels_sender_id_fkey;
ALTER TABLE voy_parcels
    ADD CONSTRAINT voy_parcels_sender_id_fkey
    FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE pro_wholesalers
    ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE pro_wholesalers
    DROP CONSTRAINT IF EXISTS pro_wholesalers_user_id_fkey;
ALTER TABLE pro_wholesalers
    ADD CONSTRAINT pro_wholesalers_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE voy_companies
    ALTER COLUMN owner_id DROP NOT NULL;
ALTER TABLE voy_companies
    DROP CONSTRAINT IF EXISTS voy_companies_owner_id_fkey;
ALTER TABLE voy_companies
    ADD CONSTRAINT voy_companies_owner_id_fkey
    FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE SET NULL;

INSERT INTO app_migrations (version)
VALUES ('040_account_deletion_retention.sql')
ON CONFLICT (version) DO NOTHING;
