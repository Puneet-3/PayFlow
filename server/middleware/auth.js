const jwt = require("jsonwebtoken");
const db = require("../db");
const { IDLE_TIMEOUT_SECONDS } = require("../utils/sessions");
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const authenticateToken = async (req, res, next) => {
  res.set("Cache-Control", "no-store");
  const authHeader = req.headers["authorization"];
  const token =
    typeof authHeader === "string"
      ? /^Bearer (\S+)$/i.exec(authHeader)?.[1]
      : null;

  if (!token) {
    return res.status(401).json({ error: "Access denied: No token provided" });
  }

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET, {
      algorithms: ["HS256"],
    });
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      return res
        .status(401)
        .json({ error: "Token expired, please log in again" });
    }
    return res.status(403).json({ error: "Invalid or tampered token" });
  }

  if (
    !decoded ||
    typeof decoded !== "object" ||
    typeof decoded.userId !== "string" ||
    !uuidPattern.test(decoded.userId) ||
    typeof decoded.sessionId !== "string" ||
    !uuidPattern.test(decoded.sessionId) ||
    !Number.isInteger(decoded.iat) ||
    !Number.isInteger(decoded.exp)
  ) {
    return res
      .status(401)
      .json({ error: "Invalid session, please log in again" });
  }

  let session;
  try {
    // One atomic check-and-touch prevents an expired/revoked session from being
    // revived by another request. Absolute expiry is never extended.
    const result = await db.query(
      `UPDATE auth_sessions SET last_seen_at = clock_timestamp()
       WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
         AND expires_at > clock_timestamp()
         AND last_seen_at > clock_timestamp() - ($3::integer * INTERVAL '1 second')
       RETURNING id;`,
      [decoded.sessionId, decoded.userId, IDLE_TIMEOUT_SECONDS],
    );
    session = result.rows[0];
  } catch (error) {
    console.error("Session verification error:", error);
    return res
      .status(503)
      .json({ error: "Authentication temporarily unavailable" });
  }
  if (!session) {
    return res
      .status(401)
      .json({ error: "Session expired or logged out, please log in again" });
  }

  req.user = decoded;
  return next();
};

module.exports = authenticateToken;
