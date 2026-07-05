# Backend Feature Tracker

_Every backend feature we're building, tracked here. Derived from [docs/SPEC.md](../docs/SPEC.md) §2. Update the status as work progresses: `[ ]` not started · `[~]` in progress · `[x]` done._

**Legend for each feature:** what it does, key endpoints/models, and any notes/decisions that came up while building.

---

## 0. Project Scaffolding
- [x] Express 5 app (ES modules), folder structure per SPEC §2.13 (config / models / routes / controllers / services / middleware / utils / jobs)
- [x] MongoDB connection (Mongoose 8), env config (zod-validated, incl. PG_* gateway vars), constants
- [x] Global middleware: helmet, CORS, cookie-parser, pino-http, centralized error handler, general rate limiter, global CSRF (double-submit), `trust proxy` in prod
- [x] **Middleware layer** (`src/middleware/`): `requireAuth`/`optionalAuth`/`requireActive` (JWT cookie via jose), `requireRole` RBAC, `validate` (zod → `req.validated`), rate limiters (general/auth/captcha/transaction), `csrfProtection` + `issueCsrfCookie`, `ipAllowlist` (gateway webhooks), error handler
- [x] **All 14 models** (`src/models/`): User, Wallet, LedgerEntry (immutable), Deposit, Withdrawal, Trade, Signal, SignalPosition, Referral, Notification, Announcement, AuditLog (immutable), Captcha (TTL), Session (refresh tokens) — _investment plans dropped from scope 2026-07-05_
- [x] **Utils** (`src/utils/`): money (BigInt smallest-units ↔ Decimal128), phone (E.164), hash (bcryptjs), referralCode, time (Africa/Lagos window), tokens, ApiError, asyncHandler, pagination
- [x] Smoke test (`npm run smoke`) — model registration + util invariants without a DB

## 1. Auth & User Accounts (SPEC §2.1)
_Service layer + HTTP routes done & e2e-tested (`npm run test:auth` = service level, `npm run test:http` = over HTTP with cookies/CSRF)._
- [x] **Registration** — `POST /api/auth/register` (captcha, E.164, bcryptjs, security question, referral-tree link, 4 wallets, session cookies)
- [x] **Captcha** — `GET /api/auth/captcha?purpose=` → `{ captchaId, svg }`; hashed answer, TTL, single-use (atomic consume), attempt-limited
- [x] **Login / logout / session** — `POST /api/auth/login` (two-step `requiresTotp` when 2FA on) / `logout` / `refresh` (rotating refresh w/ replay detection) / `GET /me`; httpOnly cookies + CSRF verified over HTTP
- [~] **Login alerts** — in-app notification on new device/IP done; email pending (no email provider yet)
- [x] **2FA (TOTP)** — `POST /api/auth/2fa/enable|confirm|disable`; otplib v13 (`epochTolerance: 60`), QR data-URL
- [x] **Withdrawal PIN** — `POST /api/auth/withdrawal-pin` (TOTP if 2FA on, else password)
- [x] **Password management** — `POST /api/auth/change-password`, `GET /api/auth/security-question`, `POST /api/auth/reset-password`, `POST /api/auth/security-question/change`
- [ ] **KYC** — document upload; lifecycle `unverified → pending → approved / rejected`
- [~] **Account states** — model + `requireActive` middleware done; admin freeze/unfreeze endpoint pending

## 2. Wallets & Ledger (SPEC §2.2)
- [~] Four wallets per user: NGN, USDT, BTC, ETH — creation at registration + read endpoints done (`GET /api/wallets`, `GET /api/wallets/:currency`); ledger writes pending
- [ ] Immutable double-entry ledger (`LedgerEntry`); balances derived/reconciled from it — never mutate a balance without a ledger entry
- [ ] Money math: NGN in kobo (integer), crypto as Decimal128 / smallest units — no floats
- [ ] NGN ↔ crypto conversion at cached rates with configurable spread/fee
- [ ] Transaction history endpoint (filter by type/currency/date, paginated)

## 3. Deposits (SPEC §2.3)
- [ ] Paystack or Flutterwave integration: deposit intent → checkout → webhook verification → ledger credit
- [ ] Deposit records queryable by user and admin

## 4. Withdrawals (SPEC §2.4)
- [ ] Withdraw to Nigerian bank account; PIN (+ TOTP if enabled); account name resolution via gateway
- [ ] Lifecycle `pending → approved → paid / rejected` with escrow hold + refund on reject
- [ ] Admin: manual approve, auto-approve rules, reject with reason

## 5. Market Data Service (SPEC §2.5)
- [ ] `PriceService` provider abstraction (CoinGecko seed; Binance/CMC swappable) + server-side cache
- [ ] Pairs BTC/ETH/USDT/BNB vs NGN (compose from USD + USD/NGN if needed)
- [ ] Endpoints: prices, 24h change, volume, depth, OHLC
- [ ] Socket.IO live price push (polling fallback)

## 6. Trading (SPEC §2.6)
- [ ] Buy/sell vs NGN against internal ledger at cached price; order records (pair, side, amount, price, fee, status)
- [ ] Trading history + realized/unrealized P/L feeding dashboard total

## 7. Trading Signals (SPEC §2.7)
- [ ] `Signal` model: pair, direction, fixed return %, min/max stake, duration, release date
- [ ] Daily release job within 3:00–5:00 pm Africa/Lagos window
- [ ] `SignalPosition` — one join per user per signal (unique `user + signal` index); stake held via ledger
- [ ] Settlement job: credit stake + fixed return after duration
- [ ] Endpoints: today's/active signals, join, my positions/history ("contract order")

## 8. Referral System (SPEC §2.8)
- [ ] Unique referral code + shareable link; 3-level tree linkage on registration
- [ ] Referral QR code endpoint (`qrcode` package, data-URL/PNG)
- [ ] 3-level commissions (L1 10% / L2 2% / L3 1%, admin-configurable) paid as ledger entries
- [ ] Stats: total referrals, active referrals, earnings per level

## 9. In-App Notifications (SPEC §2.9)
- [ ] `Notification` model (user, type, title, body, read, createdAt)
- [ ] Endpoints: list (paginated, unread count), mark read / mark all read
- [ ] Socket.IO real-time push
- [ ] User triggers: deposit confirmed, withdrawal status, signal release/settlement, referral commission, admin credit/debit, announcement, login alert
- [ ] Admin triggers: pending withdrawal, KYC submission, anti-fraud flags

## 10. Announcements (SPEC §2.10)
- [ ] Admin CRUD + user-facing list (latest first)

## 11. Admin API (SPEC §2.11)
- [ ] RBAC: `user` / `admin` / `superadmin`
- [ ] User management (search/view/edit), freeze/unfreeze
- [ ] Credit/debit wallets via audited ledger entries with reason
- [ ] Withdrawals queue (approve/reject), deposits view
- [ ] Manage trading signals (CRUD, scheduling, joins/settlements view)
- [ ] Send announcements
- [ ] Audit log view (filterable: actor, action, date)
- [ ] Admin notification feed
- [ ] Reports: deposits, withdrawals, trades, signal payouts, referral payouts, user growth
- [ ] Configure referral commission percentages

## 12. Security & Cross-Cutting (SPEC §2.12)
- [ ] Stricter rate limits on auth/captcha routes; captcha attempt limiting
- [ ] zod validation on every route
- [ ] `AuditLog` for all admin + sensitive user actions
- [ ] Anti-fraud flags: velocity checks, duplicate device/IP, unusual withdrawal patterns → admin review
- [ ] Structured logging + centralized error handling

## 13. Jobs (SPEC §2.13)
- [ ] Price cache refresh
- [ ] Signal release (3–5 pm WAT) + settlement sweeps
- [ ] Withdrawal auto-approval sweep
- [ ] Ledger/balance reconciliation

---

## Deferred (SPEC §4)
- On-chain crypto wallets (external deposits/withdrawals)
- Anything requiring exchange custody or blockchain nodes
