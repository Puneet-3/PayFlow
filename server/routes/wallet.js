const express = require("express");
const db = require("../db");
const authenticateToken = require("../middleware/auth");

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
      balance: parseFloat(wallet.balance),
      currency: wallet.currency,
      updatedAt: wallet.updated_at,
    });
  } catch (error) {
    console.error("Fetch balance error:", error);
    return res.status(500).json({ error: "Failed to retrieve wallet balance" });
  }
});

// 2. POST /api/wallet/deposit
router.post("/deposit", async (req, res) => {
  const { amount, description } = req.body;

  const parsedAmount = parseFloat(amount);
  if (isNaN(parsedAmount) || parsedAmount <= 0) {
    return res.status(400).json({ error: "Amount must be a positive number" });
  }

  // Ensure maximum 2 decimal places to avoid floating point anomalies
  if (!/^\d+(\.\d{1,2})?$/.test(String(amount).trim())) {
    return res.status(400).json({ error: "Amount can have at most 2 decimal places" });
  }

  if (parsedAmount > 100000) {
    return res.status(400).json({ error: "Maximum deposit limit per transaction is 100,000" });
  }

  const client = await db.pool.connect();

  try {
    await client.query("BEGIN");

    // Lock and retrieve sender wallet
    const wallet = await getOrCreateWallet(req.user.userId, client);

    const updateQuery = `
      UPDATE wallets
      SET balance = balance + $1, updated_at = CURRENT_TIMESTAMP
      WHERE id = $2
      RETURNING id, balance, currency;
    `;
    const updateResult = await client.query(updateQuery, [parsedAmount, wallet.id]);
    const updatedWallet = updateResult.rows[0];

    const txQuery = `
      INSERT INTO transactions (receiver_wallet_id, amount, type, status, description)
      VALUES ($1, $2, 'DEPOSIT', 'SUCCESS', $3)
      RETURNING id, amount, type, status, description, created_at;
    `;
    const txResult = await client.query(txQuery, [
      wallet.id,
      parsedAmount,
      description || "Wallet deposit",
    ]);

    await client.query("COMMIT");

    return res.status(200).json({
      message: "Deposit successful",
      wallet: {
        id: updatedWallet.id,
        balance: parseFloat(updatedWallet.balance),
        currency: updatedWallet.currency,
      },
      transaction: txResult.rows[0],
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Deposit error:", error);
    return res.status(500).json({ error: "Deposit transaction failed" });
  } finally {
    client.release();
  }
});

// 3. POST /api/wallet/transfer
// Peer-to-Peer Transfer with ACID transaction + SELECT FOR UPDATE row-level locking
router.post("/transfer", async (req, res) => {
  const { recipientEmail, amount, description } = req.body;

  if (!recipientEmail || !amount) {
    return res.status(400).json({ error: "Recipient email and amount are required" });
  }

  const parsedAmount = parseFloat(amount);
  if (isNaN(parsedAmount) || parsedAmount <= 0) {
    return res.status(400).json({ error: "Amount must be a positive number" });
  }

  if (!/^\d+(\.\d{1,2})?$/.test(String(amount).trim())) {
    return res.status(400).json({ error: "Amount can have at most 2 decimal places" });
  }

  const normalizedRecipientEmail = recipientEmail.toLowerCase().trim();

  const client = await db.pool.connect();

  try {
    await client.query("BEGIN");

    // 1. Get sender user details and wallet with ROW LOCK
    const senderUserResult = await client.query(`SELECT id, email FROM users WHERE id = $1;`, [
      req.user.userId,
    ]);
    const senderUser = senderUserResult.rows[0];

    if (senderUser.email === normalizedRecipientEmail) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "You cannot transfer funds to yourself" });
    }

    // 2. Lock sender's wallet to eliminate double-spending race conditions
    const senderWalletResult = await client.query(
      `SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE;`,
      [req.user.userId]
    );

    let senderWallet = senderWalletResult.rows[0];
    if (!senderWallet) {
      senderWallet = await getOrCreateWallet(req.user.userId, client);
    }

    if (parseFloat(senderWallet.balance) < parsedAmount) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: "Insufficient funds",
        currentBalance: parseFloat(senderWallet.balance),
      });
    }

    // 3. Find recipient user
    const recipientUserResult = await client.query(
      `SELECT id, name, email FROM users WHERE email = $1;`,
      [normalizedRecipientEmail]
    );
    const recipientUser = recipientUserResult.rows[0];

    if (!recipientUser) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Recipient user not found" });
    }

    // 4. Lock recipient wallet
    let recipientWalletResult = await client.query(
      `SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE;`,
      [recipientUser.id]
    );

    let recipientWallet = recipientWalletResult.rows[0];
    if (!recipientWallet) {
      recipientWallet = await getOrCreateWallet(recipientUser.id, client);
    }

    // 5. Deduct from sender
    const deductResult = await client.query(
      `UPDATE wallets 
       SET balance = balance - $1, updated_at = CURRENT_TIMESTAMP 
       WHERE id = $2 
       RETURNING balance;`,
      [parsedAmount, senderWallet.id]
    );
    const newSenderBalance = deductResult.rows[0].balance;

    // 6. Credit to recipient
    await client.query(
      `UPDATE wallets 
       SET balance = balance + $1, updated_at = CURRENT_TIMESTAMP 
       WHERE id = $2;`,
      [parsedAmount, recipientWallet.id]
    );

    // 7. Record immutable transaction in ledger
    const txNote = description ? description.trim() : `Transfer to ${recipientUser.name}`;
    const txResult = await client.query(
      `INSERT INTO transactions (
         sender_wallet_id, receiver_wallet_id, amount, type, status, description
       ) 
       VALUES ($1, $2, $3, 'TRANSFER', 'SUCCESS', $4) 
       RETURNING id, amount, type, status, description, created_at;`,
      [senderWallet.id, recipientWallet.id, parsedAmount, txNote]
    );

    await client.query("COMMIT");

    return res.status(200).json({
      message: "Transfer completed successfully",
      newBalance: parseFloat(newSenderBalance),
      recipient: {
        name: recipientUser.name,
        email: recipientUser.email,
      },
      transaction: txResult.rows[0],
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Transfer error:", error);
    return res.status(500).json({ error: "Transfer failed due to internal error" });
  } finally {
    client.release();
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
        amount: parseFloat(tx.amount),
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
