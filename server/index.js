require("dotenv").config();
const express = require("express");
const db = require("./db");
const authRoutes = require("./routes/auth");
const walletRoutes = require("./routes/wallet");

const app = express();
app.use(express.json());

app.use("/api/auth", authRoutes);
app.use("/api/wallet", walletRoutes);

app.get("/", (req, res) => {
  res.json({
    message: "Wallet API is running",
    status: "healthy",
    endpoints: {
      health: "/health",
      dbHealth: "/health/db",
      auth: {
        register: "POST /api/auth/register",
        login: "POST /api/auth/login",
        me: "GET /api/auth/me (Requires Bearer token)",
      },
      wallet: {
        balance: "GET /api/wallet/balance (Requires Bearer token)",
        deposit: "POST /api/wallet/deposit (Requires Bearer token)",
        transfer: "POST /api/wallet/transfer (Requires Bearer token)",
        transactions: "GET /api/wallet/transactions (Requires Bearer token)",
      },
    },
  });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.get("/health/db", async (req, res) => {
  try {
    const result = await db.query("SELECT NOW()");
    res.json({ status: "connected", timestamp: result.rows[0].now });
  } catch (err) {
    res.status(500).json({ status: "error", message: err.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});


