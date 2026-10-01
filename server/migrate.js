require("dotenv").config();
const db = require("./db");

const migrate = async () => {
  const ddlQuery = `
    -- 1. Users Table
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name VARCHAR(100) NOT NULL,
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

    -- 2. Wallets Table (1-to-1 with users)
    CREATE TABLE IF NOT EXISTS wallets (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      balance NUMERIC(12, 2) NOT NULL DEFAULT 0.00 CHECK (balance >= 0.00),
      currency VARCHAR(3) NOT NULL DEFAULT 'INR',
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_wallets_user_id ON wallets(user_id);

    -- 3. Transactions Table (Immutable Financial Ledger)
    CREATE TABLE IF NOT EXISTS transactions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      sender_wallet_id UUID REFERENCES wallets(id) ON DELETE SET NULL,
      receiver_wallet_id UUID REFERENCES wallets(id) ON DELETE SET NULL,
      amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0.00),
      type VARCHAR(20) NOT NULL CHECK (type IN ('DEPOSIT', 'WITHDRAW', 'TRANSFER')),
      status VARCHAR(20) NOT NULL DEFAULT 'SUCCESS' CHECK (status IN ('PENDING', 'SUCCESS', 'FAILED')),
      description TEXT,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_transactions_sender ON transactions(sender_wallet_id);
    CREATE INDEX IF NOT EXISTS idx_transactions_receiver ON transactions(receiver_wallet_id);
    CREATE INDEX IF NOT EXISTS idx_transactions_created_at ON transactions(created_at DESC);

    -- 4. Backfill wallets for any existing users who don't have one yet
    INSERT INTO wallets (user_id, balance)
    SELECT id, 0.00 FROM users
    WHERE id NOT IN (SELECT user_id FROM wallets)
    ON CONFLICT (user_id) DO NOTHING;
  `;

  try {
    await db.query(ddlQuery);
    console.log("Migration complete: 'users', 'wallets', and 'transactions' tables verified.");
    process.exit(0);
  } catch (error) {
    console.error("Migration failed:", error.message);
    process.exit(1);
  }
};

migrate();
