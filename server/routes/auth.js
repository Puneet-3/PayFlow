const express = require("express");
const bcrypt = require("bcryptjs");
const db = require("../db");
const authenticateToken = require("../middleware/auth");
const { createSession } = require("../utils/sessions");

const router = express.Router();
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.post("/register", async (req, res) => {
  try {
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
      return res.status(400).json({ error: "Request body must be a JSON object" });
    }

    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      return res
        .status(400)
        .json({ error: "Name, email, and password are required" });
    }
    if (
      typeof email !== "string" ||
      typeof password !== "string" ||
      typeof name !== "string"
    ) {
      return res
        .status(400)
        .json({ error: "Email, password, and name must be strings" });
    }

    const cleanName = name.trim();
    const cleanEmail = email.trim().toLowerCase();

    if (cleanName.length === 0) {
      return res.status(400).json({ error: "Name cannot be empty" });
    }
    if (cleanName.length > 100) {
      return res.status(400).json({ error: "Name must be at most 100 characters long" });
    }
    if (cleanEmail.length > 255) {
      return res.status(400).json({ error: "Email must be at most 255 characters long" });
    }
    if (!emailPattern.test(cleanEmail)) {
      return res.status(400).json({ error: "Email must be a valid email address" });
    }
    if (password.length < 8) {
      return res
        .status(400)
        .json({ error: "Password must be at least 8 characters long" });
    }

    const saltRounds = 10;
    const passwordHash = await bcrypt.hash(password, saltRounds);

    const client = await db.pool.connect();

    try {
      await client.query("BEGIN");

      const insertUserQuery = `
        INSERT INTO users (name, email, password_hash)
        VALUES ($1, $2, $3)
        RETURNING id, name, email, created_at;
      `;
      const userResult = await client.query(insertUserQuery, [
        cleanName,
        cleanEmail,
        passwordHash,
      ]);
      const newUser = userResult.rows[0];

      const insertWalletQuery = `
        INSERT INTO wallets (user_id, balance)
        VALUES ($1, 0.00)
        RETURNING id, balance, currency;
      `;
      const walletResult = await client.query(insertWalletQuery, [newUser.id]);
      const newWallet = walletResult.rows[0];

      await client.query("COMMIT");

      return res.status(201).json({
        message: "User registered successfully",
        user: newUser,
        wallet: newWallet,
      });
    } catch (txError) {
      await client.query("ROLLBACK");
      throw txError;
    } finally {
      client.release();
    }
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({ error: "Email is already registered" });
    }

    console.error("Register Error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/login", async (req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
      return res.status(400).json({ error: "Request body must be a JSON object" });
    }

    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required" });
    }

    if (typeof email !== "string" || typeof password !== "string") {
      return res.status(400).json({ error: "Email and password must be strings" });
    }

    const cleanEmail = email.trim().toLowerCase();

    if (cleanEmail.length > 255) {
      return res.status(400).json({ error: "Email must be at most 255 characters long" });
    }
    if (!emailPattern.test(cleanEmail)) {
      return res.status(400).json({ error: "Email must be a valid email address" });
    }

    const userQuery = `
      SELECT id, name, email, password_hash 
      FROM users 
      WHERE email = $1;
    `;
    const result = await db.query(userQuery, [cleanEmail]);
    const user = result.rows[0];

    if (!user) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const isPasswordValid = await bcrypt.compare(password, user.password_hash);
    if (!isPasswordValid) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const { token, session } = await createSession(user.id);

    return res.status(200).json({
      message: "Login successful",
      token,
      session,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
      },
    });
  } catch (error) {
    console.error("Login Error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/logout", authenticateToken, async (req, res) => {
  try {
    await db.query(
      `UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, clock_timestamp())
       WHERE id = $1 AND user_id = $2;`,
      [req.user.sessionId, req.user.userId]
    );
    return res.status(200).json({ message: "Logged out successfully" });
  } catch (error) {
    console.error("Logout error:", error);
    return res.status(503).json({ error: "Logout temporarily unavailable, please retry" });
  }
});

router.get("/me", authenticateToken, async (req, res) => {
  try {
    const userQuery = `
      SELECT id, name, email, created_at 
      FROM users 
      WHERE id = $1;
    `;
    const result = await db.query(userQuery, [req.user.userId]);
    const user = result.rows[0];

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    return res.status(200).json({ user });
  } catch (err) {
    console.error("Fetch profile error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
