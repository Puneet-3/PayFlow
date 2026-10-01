const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const db = require("../db");
const authenticateToken = require("../middleware/auth");

const router = express.Router();

router.post("/register", async (req, res) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ error: "Name, email, and password are required" });
    }

    if (password.length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters long" });
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
        name,
        email.toLowerCase().trim(),
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
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required" });
    }

    const userQuery = `
      SELECT id, name, email, password_hash 
      FROM users 
      WHERE email = $1;
    `;
    const result = await db.query(userQuery, [email.toLowerCase().trim()]);
    const user = result.rows[0];

    if (!user) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const isPasswordValid = await bcrypt.compare(password, user.password_hash);
    if (!isPasswordValid) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const token = jwt.sign(
      { userId: user.id },
      process.env.JWT_SECRET,
      { expiresIn: "1h" }
    );

    return res.status(200).json({
      message: "Login successful",
      token,
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
