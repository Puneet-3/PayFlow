const { createHash } = require("node:crypto");

// Call only inside the SAME transaction as the balance and history updates.
async function claimPayment(client, userId, operation, key, payment) {
  const hash = createHash("sha256").update(JSON.stringify(payment)).digest("hex");
  const inserted = await client.query(
    `INSERT INTO payment_requests (user_id, operation, idempotency_key, request_hash)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, operation, idempotency_key) DO NOTHING
     RETURNING idempotency_key;`,
    [userId, operation, key, hash]
  );
  if (inserted.rows.length > 0) return null;

  // A competing INSERT waits for its owner to commit or roll back. A separate
  // SELECT then sees the committed result under PostgreSQL READ COMMITTED.
  const existing = await client.query(
    `SELECT request_hash, response_status, response_body FROM payment_requests
     WHERE user_id = $1 AND operation = $2 AND idempotency_key = $3;`,
    [userId, operation, key]
  );
  const saved = existing.rows[0];
  if (!saved) throw new Error("Payment request missing after an idempotency conflict");
  if (saved.request_hash !== hash) {
    return { status: 409, body: { error: "Idempotency-Key was already used with different payment details" } };
  }
  if (saved.response_status === null || saved.response_body === null) {
    throw new Error("Payment request has no committed response");
  }
  return { status: saved.response_status, body: saved.response_body, replayed: true };
}

async function savePaymentResponse(client, userId, operation, key, body) {
  const result = await client.query(
    `UPDATE payment_requests SET response_status = 200, response_body = $4::jsonb
     WHERE user_id = $1 AND operation = $2 AND idempotency_key = $3
       AND response_status IS NULL
     RETURNING idempotency_key;`,
    [userId, operation, key, JSON.stringify(body)]
  );
  if (result.rows.length !== 1) throw new Error("Payment response could not be saved");
}

module.exports = { claimPayment, savePaymentResponse };
