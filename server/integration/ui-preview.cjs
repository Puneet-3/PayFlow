// Disposable browser-QA API. Every application query is scoped to its own schema.
const path = require("node:path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });
const { readFileSync } = require("node:fs");
const { randomUUID } = require("node:crypto");
const { once } = require("node:events");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const express = require("express");
const db = require("../db");
const authRoutes = require("../routes/auth");
const walletRoutes = require("../routes/wallet");

const schema = `wallet_ui_${randomUUID().replaceAll("-", "")}`;
const connectionString = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
if (!connectionString) throw new Error("Configure TEST_DATABASE_URL or DATABASE_URL");
const pool = new Pool({ connectionString, max: 5, connectionTimeoutMillis: 10000,
  ssl: connectionString.includes("localhost") || connectionString.includes("127.0.0.1") ? false : { rejectUnauthorized: false } });
process.env.JWT_SECRET = randomUUID();
let server;
let created = false;
let stopping = false;
let dropTransfer = false;
let aliceId;
async function stop() {
  if (stopping) return;
  stopping = true;
  try {
    if (server) await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    if (created) {
      if (!/^wallet_ui_[a-f0-9]{32}$/.test(schema)) throw new Error("Unsafe test schema name");
      await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
      console.log("Isolated UI test schema removed.");
    }
  } finally { await pool.end(); }
}

async function main() {
  await pool.query(`CREATE SCHEMA "${schema}"`);
  created = true;
  await pool.query(`
    CREATE TABLE ${schema}.users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name VARCHAR(100) NOT NULL,
      email VARCHAR(255) UNIQUE NOT NULL, password_hash VARCHAR(255) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE ${schema}.wallets (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID UNIQUE NOT NULL REFERENCES ${schema}.users(id) ON DELETE CASCADE,
      balance NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (balance >= 0), currency VARCHAR(3) NOT NULL DEFAULT 'INR',
      updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE ${schema}.transactions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), sender_wallet_id UUID REFERENCES ${schema}.wallets(id),
      receiver_wallet_id UUID REFERENCES ${schema}.wallets(id), amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
      type VARCHAR(20) NOT NULL, status VARCHAR(20) NOT NULL DEFAULT 'SUCCESS', description TEXT,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );
  `);
  const qualify = (sql) => sql.replace(/\b(users|wallets|transactions|payment_requests|auth_sessions)\b/g, `${schema}.$1`);
  for (const migration of ["001_idempotency.sql", "002_auth_sessions.sql"]) {
    await pool.query(qualify(readFileSync(path.join(__dirname, "..", "migrations", migration), "utf8")));
  }
  db.query = (sql, params) => pool.query(qualify(sql), params);
  db.pool.connect = async () => {
    const client = await pool.connect();
    return { query: (sql, params) => client.query(qualify(sql), params), release: () => client.release() };
  };
  const hash = await bcrypt.hash("PracticeWallet123!", 10);
  const users = [];
  for (const [name, email, balance] of [["Alice Morgan", "alice.ui@example.com", "12851.00"], ["Bob Sharma", "bob.ui@example.com", "5149.00"]]) {
    const user = (await pool.query(`INSERT INTO ${schema}.users (name, email, password_hash) VALUES ($1,$2,$3) RETURNING id`, [name, email, hash])).rows[0];
    const wallet = (await pool.query(`INSERT INTO ${schema}.wallets (user_id, balance) VALUES ($1,$2) RETURNING id`, [user.id, balance])).rows[0];
    users.push({ ...user, walletId: wallet.id });
  }
  aliceId = users[0].id;
  await pool.query(`INSERT INTO ${schema}.transactions (receiver_wallet_id, amount, type, description, created_at)
    VALUES ($1,'18000.00','DEPOSIT','A little extra for the week',$2)`, [users[0].walletId, new Date(Date.now() - 7 * 86400000)]);
  for (const [amount, description, days] of [["3250.00", "Dinner with friends", 1], ["1200.00", "Weekend groceries", 2], ["699.00", "Coffee & catch-up", 3]]) {
    await pool.query(`INSERT INTO ${schema}.transactions (sender_wallet_id, receiver_wallet_id, amount, type, description, created_at)
      VALUES ($1,$2,$3,'TRANSFER',$4,$5)`, [users[0].walletId, users[1].walletId, amount, description, new Date(Date.now() - days * 86400000)]);
  }
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const transfer = req.path === "/api/wallet/transfer";
    const original = res.json.bind(res);
    res.json = (body) => {
      if (transfer && dropTransfer && res.statusCode === 200) {
        dropTransfer = false;
        res.socket?.destroy();
        return res;
      }
      return original(body);
    };
    next();
  });
  app.get("/health", (req, res) => res.json({ status: "ok", isolated: true }));
  app.get("/api/__qa", (req, res) => res.json({ isolated: true }));
  app.use("/api/auth", authRoutes);
  app.use("/api/wallet", walletRoutes);
  server = app.listen(Number(process.env.UI_TEST_PORT || 5001), "127.0.0.1");
  await once(server, "listening");
  console.log(`Isolated UI test API ready: http://127.0.0.1:${server.address().port}`);
  console.log("Commands on stdin: summary, expire, drop-transfer, stop");
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", async (chunk) => {
    try {
      for (const command of chunk.trim().split(/\r?\n/)) {
        if (command === "stop" || command.includes("\u0003")) { await stop(); process.exit(0); }
        if (command === "drop-transfer") { dropTransfer = true; console.log("Next successful transfer response will be dropped after commit."); }
        if (command === "expire") {
          await pool.query(`UPDATE ${schema}.auth_sessions SET last_seen_at = CURRENT_TIMESTAMP - INTERVAL '301 seconds' WHERE user_id = $1`, [aliceId]);
          console.log("Expired the isolated Alice sessions.");
        }
        if (command === "summary") {
          const balances = await pool.query(`SELECT u.email, w.balance FROM ${schema}.wallets w JOIN ${schema}.users u ON u.id = w.user_id ORDER BY u.email`);
          const count = await pool.query(`SELECT count(*)::int AS transactions FROM ${schema}.transactions`);
          console.log(JSON.stringify({ balances: balances.rows, transactions: count.rows[0].transactions }));
        }
      }
    } catch (error) { console.error("UI test control failed:", error.code || error.message); }
  });
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, async () => { await stop(); process.exit(0); });
main().catch(async (error) => { console.error("UI test API failed:", error.code || error.message); await stop(); process.exit(1); });
