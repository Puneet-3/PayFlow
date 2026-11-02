const { randomUUID } = require("node:crypto");
const jwt = require("jsonwebtoken");
const db = require("../db");

const SESSION_LIFETIME_SECONDS = 10 * 60;
const IDLE_TIMEOUT_SECONDS = 5 * 60;

async function createSession(userId) {
  const sessionId = randomUUID();
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = new Date((issuedAt + SESSION_LIFETIME_SECONDS) * 1000);
  const token = jwt.sign({ userId, sessionId, iat: issuedAt }, process.env.JWT_SECRET, {
    algorithm: "HS256",
    expiresIn: SESSION_LIFETIME_SECONDS,
  });

  await db.query(
    `INSERT INTO auth_sessions (id, user_id, expires_at) VALUES ($1, $2, $3);`,
    [sessionId, userId, expiresAt]
  );
  return { token, session: { expiresAt, idleTimeoutSeconds: IDLE_TIMEOUT_SECONDS } };
}

module.exports = { createSession, SESSION_LIFETIME_SECONDS, IDLE_TIMEOUT_SECONDS };
