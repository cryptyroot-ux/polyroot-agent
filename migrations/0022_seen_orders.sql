CREATE TABLE IF NOT EXISTS seen_orders (
    order_id            UUID PRIMARY KEY,
    state               TEXT NOT NULL,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
