# PayFlow — High-Concurrency Digital Wallet & P2P Payment Engine

[![Node.js](https://img.shields.io/badge/Node.js-v18+-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Express.js](https://img.shields.io/badge/Express.js-5.x-000000?logo=express&logoColor=white)](https://expressjs.com)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-14+-4169E1?logo=postgresql&logoColor=white)](https://www.postgresql.org)
[![JWT](https://img.shields.io/badge/JWT-Authentication-black?logo=jsonwebtokens)](https://jwt.io)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

PayFlow is a practice digital wallet with a **React frontend** and a **Node.js, Express, and PostgreSQL backend**. Peer-to-peer transfers use PostgreSQL transactions and ordered row locks to keep balance updates consistent. Deposits create simulated funds; the app has no bank or payment-provider integration.

---

## 🚀 Key Features

### Phase 1: Authentication & Identity Security
* **Server-Side Sessions:** Signed JWTs identify a database-backed session. Sessions expire after 5 minutes without authenticated API activity and at most 10 minutes after login. Logout revokes the current session.
* **Password Hashing:** Salted passwords using **Bcrypt (10 salt rounds)** against rainbow-table attacks.
* **Mass Assignment Defense:** Strict payload destructuring allowlisting expected fields.
* **SQL Injection Prevention:** 100% parameterized queries (`$1, $2`).

### Phase 2: Core Wallet & Concurrency-Safe Ledger
* **Atomic User Provisioning:** Users and initial wallets are provisioned inside an atomic transaction (`BEGIN...COMMIT`) on registration.
* **Double-Spending Prevention:** Peer-to-peer transfers execute with **`SELECT ... FOR UPDATE` row-level locks** on both sender and recipient wallets, guaranteeing mutual exclusion during concurrent requests.
* **Fixed-Point Financial Math:** Validates and compares money as integer paise (`BigInt`), passes exact decimal strings to PostgreSQL `NUMERIC(12, 2)`, and returns monetary values as decimal strings.
* **Consistent Lock Order:** Transfers provision and lock wallets in ascending user-ID order, including transfers in opposite directions.
* **Duplicate Payment Protection:** Deposits and transfers require an `Idempotency-Key`. Successful retries return the original response; changed payment details with the same key return `409`.
* **Defense-in-Depth Constraints:** Hard schema-level `CHECK (balance >= 0.00)` to physically block negative overdrafts at the database layer.
* **Transaction History:** Deposits and transfers record their amount and participating wallets in the same database transaction as balance changes. The API derives `CREDIT`/`DEBIT` direction for the requesting user. This is a transaction log, not a separate double-entry accounting ledger.

---

## 🏛️ System Architecture & Concurrency Defense

```
Client transfer request
  -> Verify JWT and validate inputs
  -> BEGIN
  -> Claim payment key or return its saved response
  -> Resolve sender and recipient
  -> Provision missing wallets in user-ID order
  -> Lock both wallets: ORDER BY user_id FOR UPDATE
  -> Check available funds and recipient balance limit
  -> Debit sender, credit recipient, insert transfer record
  -> Save the successful response under the payment key
  -> COMMIT (release locks)

Any failure before COMMIT -> ROLLBACK (undo all changes)
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
    "user": { "id": "...", "name": "Alice Smith", "email": "alice@example.com" },
    "session": { "expiresAt": "2026-10-29T12:10:00.000Z", "idleTimeoutSeconds": 300 }
  }
  ```

* **`GET /api/auth/me`** — Fetch authenticated user profile (`Bearer <token>`).

* **`POST /api/auth/logout`** — Revoke the current login session (`Bearer <token>`). Returns `{"message":"Logged out successfully"}`. Subsequent requests with that token return `401`, even while its JWT signature and expiry are valid. Other login sessions stay active.

### Session behavior

Login creates an `auth_sessions` row and includes its ID in the signed JWT. Every protected request atomically verifies that the session belongs to the token's user, is not revoked, has not reached its absolute expiry, and was active within the last 5 minutes. A successful check updates only `last_seen_at`; it does not extend the 10-minute expiry.

Activity means authenticated API requests, including automatic background requests. This is enforced in PostgreSQL, independently of client timers. After inactivity or absolute expiry, log in again; there is no automatic token refresh. Logout rejects subsequent authorization checks; requests already authorized and in progress can finish.

Missing, expired, logged-out, or legacy tokens without a session require login again (`401`). Invalid signatures or unsupported signing algorithms return `403`. If session verification cannot reach the database, protected requests return `503` and do not proceed. If the logout write fails, the endpoint returns `503` so the client can retry instead of claiming logout succeeded.

After updating the project, run `node migrate.js` and log in again. Tokens issued before server-side sessions were added are no longer accepted. Clients should discard their local token after successful logout or a `401` response.

---

### 💳 Wallet Endpoints (`/api/wallet`) *(All require `Authorization: Bearer <token>`)*

`POST /deposit` and `POST /transfer` also require `Idempotency-Key: <unique-payment-key>`. Generate one random UUID for each new payment and reuse that same key for every retry of that payment. Keys accept 1–128 letters, digits, dots, underscores, colons, or hyphens and must start with a letter or digit. Keys are scoped to the authenticated user and endpoint.

For example: `Idempotency-Key: 3360dd57-745a-4b1a-a3bd-098bc6a742d0`.

Equivalent amounts (`"10.50"`, `"10.5"`, or `10.5`) and normalized recipient emails match the same payment. The description is part of the payment details. Replays return the original HTTP status and JSON body, with `Idempotency-Replayed: true`, even if the current wallet balance has since changed. A key reused with different details returns `409`; a missing or invalid key returns `400`.

Successful payment results are saved in `payment_requests` in the same database transaction as the balance and history updates. Failed or rejected transactions roll back their key and can be retried. Keys currently have no automatic expiry; a new payment requires a new key.

After logging in, this PowerShell example submits a simulated deposit twice using one key:

```powershell
$paymentHeaders = @{
    Authorization = "Bearer $($login.token)"
    "Idempotency-Key" = [guid]::NewGuid().ToString()
}
$body = @{ amount = "10.00"; description = "Retry demonstration" } | ConvertTo-Json
$request = @{
    Method = "Post"
    Uri = "http://localhost:5000/api/wallet/deposit"
    Headers = $paymentHeaders
    ContentType = "application/json"
    Body = $body
}
$first = Invoke-RestMethod @request
$retry = Invoke-RestMethod @request
$first.transaction.id -eq $retry.transaction.id # True: one deposit
```

* **`GET /api/wallet/balance`** — Get logged-in user's real-time balance.
  ```json
  {
    "walletId": "5ecb03b3-84d7-4efc-b479-6b00278ac9bf",
    "balance": "500.00",
    "currency": "INR",
    "updatedAt": "2026-09-30T15:04:04.812Z"
  }
  ```

* **`POST /api/wallet/deposit`** — Deposit funds into personal wallet.
  ```json
  // Request
  { "amount": "500.00", "description": "Initial deposit" }
  ```

* **`POST /api/wallet/transfer`** — Concurrency-safe P2P money transfer.
  ```json
  // Request
  {
    "recipientEmail": "bob@example.com",
    "amount": "200.00",
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
        "amount": "200.00",
        "type": "TRANSFER",
        "direction": "DEBIT",
        "status": "SUCCESS",
        "counterparty": { "name": "Bob Jones", "email": "bob@example.com" }
      }
    ]
  }
  ```

---

## Frontend and local preview

The React frontend supports registration, login, balance display, simulated deposits, transfers, searchable recent activity, and logout. The review dialog confirms payment details before submission. Activity totals cover only the latest 50 transactions returned by the API.

Use Node.js 22.12 or later in the Node 22 release line for the frontend toolchain. From the repository root, install dependencies:

```powershell
npm.cmd --prefix server install
npm.cmd --prefix client install
```

Configure the server environment and run migrations as described below. For development, run these commands in two separate terminals:

```powershell
npm.cmd --prefix server run dev
```

```powershell
npm.cmd --prefix client run dev
```

Open `http://127.0.0.1:5173`. Vite forwards `/api` requests to `http://127.0.0.1:5000` by default.

To serve the built frontend and API from one local server:

```powershell
npm.cmd --prefix client run build
npm.cmd --prefix server start
```

Open `http://localhost:5000`. API metadata is available at `/api`; health checks remain at `/health` and `/health/db`.

Login tokens stay in memory. Reloading the page requires signing in again. A local countdown follows the server's inactivity and absolute session limits; there is no background polling to keep sessions alive.

If a payment response is lost, the frontend retains the original payment details and key for a retry, including after signing back into the same account. Keep the page open until the result is confirmed: pending attempts are held in memory and do not survive a full reload. After a reload with an unknown payment result, review activity before starting another payment.

Frontend checks:

```powershell
npm.cmd --prefix client test
npm.cmd --prefix client run test:render
npm.cmd --prefix client run build
```

The render check covers authentication, populated dashboard, and empty activity markup. It does not replace browser testing of layout, keyboard navigation, or interactions.

For disposable API smoke checks, `server/integration/ui-preview.cjs` creates a private random database schema with fixture accounts. Run it separately, point Vite at port 5001 with `PAYFLOW_API_URL`, and use `client/scripts/qa-smoke.mjs` with phases `initial`, `lost`, and `retry`. Arm `drop-transfer` on the test API's stdin before the `lost` phase. Send `stop` on stdin when finished to remove the schema. These scripts refuse a normal API; never substitute real user accounts for the fixtures.

## Money values and tests

Send money amounts as decimal strings, for example `"10.50"`. Plain JSON numbers with at most two decimal places are also accepted. Responses return balances and transaction amounts as decimal strings. Values must fit `NUMERIC(12, 2)`; transfers and deposits reject wallet balance overflow.

From the `server` directory, run `npm test` for the isolated HTTP and money tests. These mock database connections and do not access Supabase.

Run `npm run test:integration` for real PostgreSQL transaction and session tests. It reads `TEST_DATABASE_URL` (preferred) or `DATABASE_URL` from the environment or `.env`. The database role needs permission to create a schema. Each test file creates its own randomly named `wallet_test_...` schema, qualifies application queries to use only those tables, and drops that schema afterward. Tests cover exact decimal deposits, competing and opposite-direction transfers, rollback on failed history or response storage, balance limits, missing-wallet provisioning, sequential and simultaneous payment retries, changed-payload conflicts, and key isolation between users and endpoints. Session tests cover real login, inactivity and absolute expiry, logout, user/session binding, and session removal after account deletion. The suites use the actual idempotency and session migration SQL; timeout tests age database timestamps instead of waiting for several minutes.

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
