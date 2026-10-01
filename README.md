# PayFlow — High-Concurrency Digital Wallet & P2P Payment Engine

[![Node.js](https://img.shields.io/badge/Node.js-v18+-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Express.js](https://img.shields.io/badge/Express.js-5.x-000000?logo=express&logoColor=white)](https://expressjs.com)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-14+-4169E1?logo=postgresql&logoColor=white)](https://www.postgresql.org)
[![JWT](https://img.shields.io/badge/JWT-Authentication-black?logo=jsonwebtokens)](https://jwt.io)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

PayFlow is a financial digital wallet backend built with **Node.js, Express, and raw PostgreSQL**. Designed with strict data integrity and concurrency controls, it prevents race conditions, lost updates, and double-spending attacks during peer-to-peer (P2P) transfers using **PostgreSQL ACID transactions** and **pessimistic row-level locking (`SELECT ... FOR UPDATE`)**.

---

## 🚀 Key Features

### Phase 1: Authentication & Identity Security
* **Stateless Authentication:** Secure JWT-based session verification with auto-expiration.
* **Password Hashing:** Salted passwords using **Bcrypt (10 salt rounds)** against rainbow-table attacks.
* **Mass Assignment Defense:** Strict payload destructuring allowlisting expected fields.
* **SQL Injection Prevention:** 100% parameterized queries (`$1, $2`).

### Phase 2: Core Wallet & Concurrency-Safe Ledger
* **Atomic User Provisioning:** Users and initial wallets are provisioned inside an atomic transaction (`BEGIN...COMMIT`) on registration.
* **Double-Spending Prevention:** Peer-to-peer transfers execute with **`SELECT ... FOR UPDATE` row-level locks** on both sender and recipient wallets, guaranteeing mutual exclusion during concurrent requests.
* **Fixed-Point Financial Math:** Uses PostgreSQL `NUMERIC(12, 2)` instead of floating-point numbers to eliminate binary rounding errors (IEEE-754).
* **Defense-in-Depth Constraints:** Hard schema-level `CHECK (balance >= 0.00)` to physically block negative overdrafts at the database layer.
* **Immutable Double-Entry Ledger:** Every financial movement is permanently logged in the `transactions` table with indexed `CREDIT`/`DEBIT` direction tracking.

---

## 🏛️ System Architecture & Concurrency Defense

```
               [Client Request: Transfer ₹200]
                             │
                             ▼
               [Express Auth Middleware (JWT)]
                             │
                             ▼
             ┌───────────────────────────────┐
             │    PostgreSQL ACID Tx Begins  │
             │             (BEGIN)           │
             └───────────────┬───────────────┘
                             │
            ┌────────────────┴────────────────┐
            ▼                                 ▼
[Lock Sender: SELECT ... FOR UPDATE]  [Verify Sufficient Balance]
            │                                 │
            ├─────────────────────────────────┘
            ▼
[Lock Recipient: SELECT ... FOR UPDATE]
            │
            ├──► UPDATE sender: balance - 200
            ├──► UPDATE recipient: balance + 200
            └──► INSERT INTO transactions (TRANSFER, ₹200)
            │
            ▼
     [COMMIT Transaction] ──► (Locks released, money moved atomically)
```

---

## 🗄️ Database Schema

### `users`
| Column | Type | Constraints |
|---|---|---|
| `id` | UUID | PRIMARY KEY (gen_random_uuid()) |
| `name` | VARCHAR(100) | NOT NULL |
| `email` | VARCHAR(255) | UNIQUE, NOT NULL |
| `password_hash` | VARCHAR(255) | NOT NULL |
| `created_at` | TIMESTAMPTZ | DEFAULT CURRENT_TIMESTAMP |

### `wallets`
| Column | Type | Constraints |
|---|---|---|
| `id` | UUID | PRIMARY KEY (gen_random_uuid()) |
| `user_id` | UUID | UNIQUE, REFERENCES users(id) ON DELETE CASCADE |
| `balance` | NUMERIC(12, 2) | NOT NULL, DEFAULT 0.00, **CHECK (balance >= 0.00)** |
| `currency` | VARCHAR(3) | DEFAULT 'INR' |
| `updated_at` | TIMESTAMPTZ | DEFAULT CURRENT_TIMESTAMP |

### `transactions`
| Column | Type | Constraints |
|---|---|---|
| `id` | UUID | PRIMARY KEY (gen_random_uuid()) |
| `sender_wallet_id` | UUID | REFERENCES wallets(id) ON DELETE SET NULL |
| `receiver_wallet_id`| UUID | REFERENCES wallets(id) ON DELETE SET NULL |
| `amount` | NUMERIC(12, 2) | NOT NULL, **CHECK (amount > 0.00)** |
| `type` | VARCHAR(20) | 'DEPOSIT', 'WITHDRAW', 'TRANSFER' |
| `status` | VARCHAR(20) | 'SUCCESS', 'FAILED', 'PENDING' |
| `created_at` | TIMESTAMPTZ | DEFAULT CURRENT_TIMESTAMP |

---

## 📡 REST API Reference

### 🔐 Auth Endpoints (`/api/auth`)

* **`POST /api/auth/register`** — Register a new user & auto-provision wallet.
  ```json
  // Request
  {
    "name": "Alice Smith",
    "email": "alice@example.com",
    "password": "securePassword123"
  }
  ```

* **`POST /api/auth/login`** — Authenticate and receive JWT.
  ```json
  // Request
  {
    "email": "alice@example.com",
    "password": "securePassword123"
  }
  // Response
  {
    "token": "eyJhbGciOiJIUzI1NiIsIn...",
    "user": { "id": "...", "name": "Alice Smith", "email": "alice@example.com" }
  }
  ```

* **`GET /api/auth/me`** — Fetch authenticated user profile (`Bearer <token>`).

---

### 💳 Wallet Endpoints (`/api/wallet`) *(All require `Authorization: Bearer <token>`)*

* **`GET /api/wallet/balance`** — Get logged-in user's real-time balance.
  ```json
  {
    "walletId": "5ecb03b3-84d7-4efc-b479-6b00278ac9bf",
    "balance": 500,
    "currency": "INR",
    "updatedAt": "2026-09-30T15:04:04.812Z"
  }
  ```

* **`POST /api/wallet/deposit`** — Deposit funds into personal wallet.
  ```json
  // Request
  { "amount": 500.00, "description": "Initial deposit" }
  ```

* **`POST /api/wallet/transfer`** — Concurrency-safe P2P money transfer.
  ```json
  // Request
  {
    "recipientEmail": "bob@example.com",
    "amount": 200.00,
    "description": "Dinner split"
  }
  ```

* **`GET /api/wallet/transactions`** — Get transaction passbook / ledger history.
  ```json
  {
    "count": 2,
    "transactions": [
      {
        "id": "e7992585-1a7f-48f9-a039-1de7e029d0ba",
        "amount": 200,
        "type": "TRANSFER",
        "direction": "DEBIT",
        "status": "SUCCESS",
        "counterparty": { "name": "Bob Jones", "email": "bob@example.com" }
      }
    ]
  }
  ```

---

## 🛠️ Getting Started Locally

### 1. Clone the repository
```bash
git clone https://github.com/Puneet-3/PayFlow.git
cd PayFlow/server
```

### 2. Install dependencies
```bash
npm install
```

### 3. Configure Environment Variables
Copy `.env.example` to `.env` and fill in your PostgreSQL connection string:
```bash
cp .env.example .env
```
```env
PORT=5000
DATABASE_URL=postgresql://user:password@localhost:5432/wallet_db
JWT_SECRET=your_jwt_secret_key
```

### 4. Run Database Migrations
```bash
node migrate.js
```

### 5. Start the Server
```bash
# Development (with auto-reload)
npm run dev

# Production
npm start
```

---

## 👤 Author
**Puneet Panwar**  
* GitHub: [@Puneet-3](https://github.com/Puneet-3)  
* LinkedIn: [puneet-panwar](https://linkedin.com/in/puneet-panwar)  
