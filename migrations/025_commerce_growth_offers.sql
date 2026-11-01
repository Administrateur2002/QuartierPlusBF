ALTER TABLE transactions
    DROP CONSTRAINT IF EXISTS transactions_payment_type_check;

ALTER TABLE transactions
    ADD CONSTRAINT transactions_payment_type_check
    CHECK (payment_type IN (
        'ALLIANCE_PRO',
        'SPONSORED_PIN',
        'SYNDIC',
        'TOWN_HALL',
        'SECURITY_AGENT',
        'WHOLESALER',
        'TRANSPORT_COMPANY',
        'TICKET'
    ));
