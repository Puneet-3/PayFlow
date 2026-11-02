const express = require("express");
const db = require("../db");
const authenticateToken = require("../middleware/auth");
const { MAX_BALANCE_PAISE, parseMoney, formatMoney } = require("../utils/money");
const requireIdempotencyKey = require("../middleware/idempotency");
const { claimPayment, savePaymentResponse } = require("../utils/idempotency");

const router = express.Router();

// Protect all wallet routes with JWT authentication
router.use(authenticateToken);

// Helper: Fetch wallet for the authenticated user, or auto-create if missing
async function getOrCreateWallet(userId, client = db) {
  const selectQuery = `SELECT * FROM wallets WHERE user_id = $1;`;
  const result = await client.query(selectQuery, [userId]);
  if (result.rows.length > 0) {
    return result.rows[0];
  }

  const insertQuery = `
    INSERT INTO wallets (user_id, balance)
    VALUES ($1, 0.00)
    ON CONFLICT (user_id) DO UPDATE SET updated_at = CURRENT_TIMESTAMP
    RETURNING *;
  `;
  const newWallet = await client.query(insertQuery, [userId]);
  return newWallet.rows[0];
}

// 1. GET /api/wallet/balance
router.get("/balance", async (req, res) => {
  try {
    const wallet = await getOrCreateWallet(req.user.userId);
    return res.status(200).json({
      walletId: wallet.id,
      balance: wallet.balance,
      currency: wallet.currency,
      updatedAt: wallet.updated_at,
    });
  } catch (error) {
    console.error("Fetch balance error:", error);
    return res.status(500).json({ error: "Failed to retrieve wallet balance" });
  }
});

// 2. POST /api/wallet/deposit
router.post("/deposit", requireIdempotencyKey, async (req, res) => {
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
    return res.status(400).json({ error: "Request body must be a JSON object" });
  }

  const { amount, description } = req.body;

  if (typeof amount !== "string" && typeof amount !== "number") {
    return res.status(400).json({ error: "Amount must be a string or number" });
  }
  if (description !== undefined && typeof description !== "string") {
    return res.status(400).json({ error: "Description must be a string" });
  }

  const money = parseMoney(amount);
  if (!money || money.paise === 0n) {
    return res.status(400).json({
      error: "Amount must be positive, have at most 2 decimal places, and not exceed 9,999,999,999.99",
    });
  }

  if (money.paise > 10000000n) {
    return res.status(400).json({ error: "Maximum deposit limit per transaction is 100,000" });
  }

  let client;
  let transactionStarted = false;
  try {
    client = await db.pool.connect();
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    transactionStarted = true;

    const existing = await claimPayment(client, req.user.userId, "deposit", req.idempotencyKey, {
      amount: money.decimal,
      description: description || "Wallet deposit",
    });
    if (existing) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      if (existing.replayed) res.set("Idempotency-Replayed", "true");
      return res.status(existing.status).json(existing.body);
    }

    // The UPDATE below locks the wallet while adding the deposit.
    const wallet = await getOrCreateWallet(req.user.userId, client);

    const updateQuery = `
      UPDATE wallets
      SET balance = balance + $1, updated_at = CURRENT_TIMESTAMP
      WHERE id = $2 AND balance + $1 <= $3
      RETURNING id, balance, currency;
    `;
    const updateResult = await client.query(updateQuery, [
      money.decimal, wallet.id, formatMoney(MAX_BALANCE_PAISE),
    ]);
    const updatedWallet = updateResult.rows[0];
    if (!updatedWallet) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return res.status(400).json({ error: "Deposit would exceed the maximum wallet balance" });
    }

    const txQuery = `
      INSERT INTO transactions (receiver_wallet_id, amount, type, status, description)
      VALUES ($1, $2, 'DEPOSIT', 'SUCCESS', $3)
      RETURNING id, amount, type, status, description, created_at;
    `;
    const txResult = await client.query(txQuery, [
      wallet.id,
      money.decimal,
      description || "Wallet deposit",
    ]);

    const responseBody = {
      message: "Deposit successful",
      wallet: {
        id: updatedWallet.id,
        balance: updatedWallet.balance,
        currency: updatedWallet.currency,
      },
      transaction: txResult.rows[0],
    };
    await savePaymentResponse(client, req.user.userId, "deposit", req.idempotencyKey, responseBody);
    await client.query("COMMIT");
    transactionStarted = false;
    return res.status(200).json(responseBody);
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error("Deposit rollback error:", rollbackError);
      }
    }
    console.error("Deposit error:", error);
    return res.status(500).json({ error: "Deposit transaction failed" });
  } finally {
    if (client) client.release();
  }
});

// 3. POST /api/wallet/transfer
// Peer-to-Peer Transfer with ACID transaction + SELECT FOR UPDATE row-level locking
router.post("/transfer", requireIdempotencyKey, async (req, res) => {
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
    return res.status(400).json({ error: "Request body must be a JSON object" });
  }

  const { recipientEmail, amount, description } = req.body;

  if (!recipientEmail || !amount) {
    return res.status(400).json({ error: "Recipient email and amount are required" });
  }

  if (typeof recipientEmail !== "string") {
    return res.status(400).json({ error: "Recipient email must be a string" });
  }
  if (typeof amount !== "string" && typeof amount !== "number") {
    return res.status(400).json({ error: "Amount must be a string or number" });
  }
  if (description !== undefined && typeof description !== "string") {
    return res.status(400).json({ error: "Description must be a string" });
  }

  const money = parseMoney(amount);
  if (!money || money.paise === 0n) {
    return res.status(400).json({
      error: "Amount must be positive, have at most 2 decimal places, and not exceed 9,999,999,999.99",
    });
  }

  const normalizedRecipientEmail = recipientEmail.toLowerCase().trim();

  let client;
  let transactionStarted = false;
  try {
    client = await db.pool.connect();
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    transactionStarted = true;

    // 1. Resolve both users before acquiring wallet locks.
    const senderUserResult = await client.query(`SELECT id, email FROM users WHERE id = $1;`, [
      req.user.userId,
    ]);
    const senderUser = senderUserResult.rows[0];
    if (!senderUser) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return res.status(401).json({ error: "User no longer exists" });
    }

    const existing = await claimPayment(client, req.user.userId, "transfer", req.idempotencyKey, {
      recipientEmail: normalizedRecipientEmail,
      amount: money.decimal,
      description: description ? description.trim() : null,
    });
    if (existing) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      if (existing.replayed) res.set("Idempotency-Replayed", "true");
      return res.status(existing.status).json(existing.body);
    }

    const recipientUserResult = await client.query(
      `SELECT id, name, email FROM users WHERE email = $1;`,
      [normalizedRecipientEmail]
    );
    const recipientUser = recipientUserResult.rows[0];

    if (!recipientUser) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return res.status(404).json({ error: "Recipient user not found" });
    }

    if (senderUser.id === recipientUser.id) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return res.status(400).json({ error: "You cannot transfer funds to yourself" });
    }

    // 2. Provision missing wallets and lock both in the same user-ID order.
    // A -> B and B -> A must acquire locks in the same order.
    const userIds = [senderUser.id, recipientUser.id].sort();
    await client.query(
      `INSERT INTO wallets (user_id, balance)
       SELECT user_id, 0.00 FROM unnest($1::uuid[]) AS requested(user_id)
       ORDER BY user_id
       ON CONFLICT (user_id) DO NOTHING;`,
      [userIds]
    );
    const lockedWallets = await client.query(
      `SELECT * FROM wallets
       WHERE user_id = ANY($1::uuid[])
       ORDER BY user_id FOR UPDATE;`,
      [userIds]
    );
    const senderWallet = lockedWallets.rows.find((wallet) => wallet.user_id === senderUser.id);
    const recipientWallet = lockedWallets.rows.find((wallet) => wallet.user_id === recipientUser.id);
    if (!senderWallet || !recipientWallet) throw new Error("Wallet missing after provisioning");

    const senderBalance = parseMoney(senderWallet.balance);
    const recipientBalance = parseMoney(recipientWallet.balance);
    if (!senderBalance || !recipientBalance) throw new Error("Invalid stored wallet balance");

    if (senderBalance.paise < money.paise) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return res.status(400).json({ error: "Insufficient funds", currentBalance: senderBalance.decimal });
    }
    if (recipientBalance.paise + money.paise > MAX_BALANCE_PAISE) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return res.status(400).json({ error: "Transfer would exceed the recipient's maximum wallet balance" });
    }

    // 3. Deduct from sender using an exact decimal parameter.
    const deductResult = await client.query(
      `UPDATE wallets 
       SET balance = balance - $1, updated_at = CURRENT_TIMESTAMP 
       WHERE id = $2 
       RETURNING balance;`,
      [money.decimal, senderWallet.id]
    );
    const newSenderBalance = deductResult.rows[0].balance;

    // 4. Credit to recipient
    await client.query(
      `UPDATE wallets 
       SET balance = balance + $1, updated_at = CURRENT_TIMESTAMP 
       WHERE id = $2;`,
      [money.decimal, recipientWallet.id]
    );

    // 5. Record the transfer in transaction history.
    const txNote = description ? description.trim() : `Transfer to ${recipientUser.name}`;
    const txResult = await client.query(
      `INSERT INTO transactions (
         sender_wallet_id, receiver_wallet_id, amount, type, status, description
       ) 
       VALUES ($1, $2, $3, 'TRANSFER', 'SUCCESS', $4) 
       RETURNING id, amount, type, status, description, created_at;`,
      [senderWallet.id, recipientWallet.id, money.decimal, txNote]
    );

    const responseBody = {
      message: "Transfer completed successfully",
      newBalance: newSenderBalance,
      recipient: {
        name: recipientUser.name,
        email: recipientUser.email,
      },
      transaction: txResult.rows[0],
    };
    await savePaymentResponse(client, req.user.userId, "transfer", req.idempotencyKey, responseBody);
    await client.query("COMMIT");
    transactionStarted = false;
    return res.status(200).json(responseBody);
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error("Transfer rollback error:", rollbackError);
      }
    }
    console.error("Transfer error:", error);
    return res.status(500).json({ error: "Transfer failed due to internal error" });
  } finally {
    if (client) client.release();
  }
});

// 4. GET /api/wallet/transactions
// Fetch user's transaction ledger history
router.get("/transactions", async (req, res) => {
  try {
    const wallet = await getOrCreateWallet(req.user.userId);

    const query = `
      SELECT 
        t.id,
        t.amount,
        t.type,
        t.status,
        t.description,
        t.created_at,
        CASE 
          WHEN t.sender_wallet_id = $1 THEN 'DEBIT'
          ELSE 'CREDIT'
        END AS direction,
        sender_user.name AS sender_name,
        sender_user.email AS sender_email,
        receiver_user.name AS receiver_name,
        receiver_user.email AS receiver_email
      FROM transactions t
      LEFT JOIN wallets sw ON t.sender_wallet_id = sw.id
      LEFT JOIN users sender_user ON sw.user_id = sender_user.id
      LEFT JOIN wallets rw ON t.receiver_wallet_id = rw.id
      LEFT JOIN users receiver_user ON rw.user_id = receiver_user.id
      WHERE t.sender_wallet_id = $1 OR t.receiver_wallet_id = $1
      ORDER BY t.created_at DESC
      LIMIT 50;
    `;

    const result = await db.query(query, [wallet.id]);

    return res.status(200).json({
      count: result.rows.length,
      transactions: result.rows.map((tx) => ({
        id: tx.id,
        amount: tx.amount,
        type: tx.type,
        direction: tx.direction,
        status: tx.status,
        description: tx.description,
        createdAt: tx.created_at,
        counterparty:
          tx.direction === "DEBIT"
            ? { name: tx.receiver_name, email: tx.receiver_email }
            : { name: tx.sender_name, email: tx.sender_email },
      })),
    });
  } catch (error) {
    console.error("Fetch transactions error:", error);
    return res.status(500).json({ error: "Failed to retrieve transactions" });
  }
});

module.exports = router;
