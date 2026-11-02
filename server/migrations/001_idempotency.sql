CREATE TABLE IF NOT EXISTS payment_requests (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  operation VARCHAR(16) NOT NULL CHECK (operation IN ('deposit', 'transfer')),
  idempotency_key VARCHAR(128) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  response_status SMALLINT,
  response_body JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, operation, idempotency_key),
  CHECK (
    (response_status IS NULL AND response_body IS NULL)
    OR (response_status IS NOT NULL AND response_status BETWEEN 200 AND 299 AND response_body IS NOT NULL)
  )
);

-- Access this backend-only table through the database owner/backend role.
ALTER TABLE payment_requests ENABLE ROW LEVEL SECURITY;
