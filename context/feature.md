# Backend Feature Tracker

_Every backend feature we're building, tracked here. Derived from [docs/SPEC.md](../docs/SPEC.md) §2. Update the status as work progresses: `[ ]` not started · `[~]` in progress · `[x]` done._

**Legend for each feature:** what it does, key endpoints/models, and any notes/decisions that came up while building.

---

## 0. Project Scaffolding
- [x] Express 5 app (ES modules), folder structure per SPEC §2.13 (config / models / routes / controllers / services / middleware / utils / jobs)
- [x] MongoDB connection (Mongoose 8), env config (zod-validated, incl. PG_* gateway vars), constants
- [x] Global middleware: helmet, CORS, cookie-parser, pino-http, centralized error handler, general rate limiter, global CSRF (double-submit), `trust proxy` in prod
- [x] **Middleware layer** (`src/middleware/`): `requireAuth`/`optionalAuth`/`requireActive` (JWT cookie via jose), `requireRole` RBAC, `validate` (zod → `req.validated`), rate limiters (general/auth/captcha/transaction), `csrfProtection` + `issueCsrfCookie`, `ipAllowlist` (gateway webhooks), error handler
- [x] **All 18 models** (`src/models/`): User, Wallet, LedgerEntry (immutable), Deposit, Withdrawal, Trade, Signal, SignalPosition, Referral, Notification, Announcement, AuditLog (immutable), Captcha (TTL), Session (refresh tokens), Setting (key/value for runtime config), Spin, SpinCounter, BankAccount — _investment plans dropped from scope 2026-07-05_
- [x] **Utils** (`src/utils/`): money (BigInt smallest-units ↔ Decimal128), phone (E.164), hash (bcryptjs), referralCode, time (Africa/Lagos window), tokens, ApiError, asyncHandler, pagination
- [x] Smoke test (`npm run smoke`) — model registration + util invariants without a DB
- [x] **Vitest unit tests** (`npm test`, `tests/*.test.js`) — fast DB-free coverage of money/time/phone/hash/pagination/security-questions/spin-rules; `npm run test:all` = unit → smoke → live e2e

## 1. Auth & User Accounts (SPEC §2.1)
_Service layer + HTTP routes done & e2e-tested (`npm run test:auth` = service level, `npm run test:http` = over HTTP with cookies/CSRF)._
- [x] **Registration** — `POST /api/auth/register` (captcha, E.164, unique username, bcryptjs, security question, referral-tree link, 4 wallets, session cookies); login identifier accepts phone/email/username
- [x] **Recovery codes (replaced security questions 2026-07-08)** — register issues 10 one-time codes (returned once), stored as sha256 hashes (`User.recoveryCodes`); reset = `POST /api/auth/reset-password {identifier, recoveryCode, newPassword, captcha}` (case/format-insensitive, single-use, revokes all sessions, uniform `RESET_FAILED`); `POST /api/auth/recovery-codes/regenerate` (password re-entry) reissues; profile shows `recoveryCodesRemaining`. Security-question config/endpoints/model field all removed
- [x] **Sessions & devices** — `GET /api/sessions` (device label + IP + `current` flag), `DELETE /api/sessions/:id` (log out a device), `POST /api/sessions/revoke-others` (log out other devices); over the `Session` model, current session matched by refresh-cookie hash.
- [x] **Multi-account switching** (Gmail-style) — `GET/POST /api/auth/accounts` (list/add), `POST /api/auth/accounts/switch|remove|logout-others`; signed httpOnly `ms_accounts` cookie holds inactive accounts, active keeps `ms_access/ms_refresh`. Full login to add, new account becomes active, cap 5. Default logout promotes next linked account. Cross-benefit blocked via durable `User.linkGroupId` (referral commissions + spin credit skip linked accounts).
- [x] **Captcha** — `GET /api/auth/captcha?purpose=` → `{ captchaId, svg }`; hashed answer, TTL, single-use (atomic consume), attempt-limited
- [x] **Login / logout / session** — `POST /api/auth/login` (two-step `requiresTotp` when 2FA on) / `logout` / `refresh` (rotating refresh w/ replay detection) / `GET /me`; httpOnly cookies + CSRF verified over HTTP
- [x] **Admin login** — `POST /api/auth/admin/login {email, password}`: **no captcha** (rate-limited), creds from `ADMIN_EMAIL`/`ADMIN_PASSWORD` env (constant-time compare), `ADMIN_PHONE` for the User record. **No registration** — a `superadmin` User + wallets is created on first successful login; wrong creds → 401 (uniform), unconfigured → 503
- [~] **Login alerts** — in-app notification on new device/IP done; email pending (no email provider yet)
- [x] **2FA (TOTP)** — `POST /api/auth/2fa/enable|confirm|disable`; otplib v13 (`epochTolerance: 60`), QR data-URL
- [x] **Withdrawal PIN** — `POST /api/auth/withdrawal-pin` (TOTP if 2FA on, else password)
- [x] **Password management** — `POST /api/auth/change-password`, `GET /api/auth/security-question`, `POST /api/auth/reset-password`, `POST /api/auth/security-question/change`
- [~] **KYC** — user side done end-to-end: `POST /api/users/kyc` (multipart via multer memory → **Cloudinary v2 private assets**, images capped 1920px/quality:auto, PDFs as raw; docType ∈ passport/voters_card/nin/drivers_license + optional live `selfie`; resubmission deletes replaced assets; profile serves 15-min **signed URLs**); `GET/PATCH /api/users/me`. Admin review route pending (service `reviewKyc` ready)
- [~] **Account states** — model + `requireActive` middleware + `userService.setAccountStatus` (audited; staff accounts superadmin-only) done; admin route pending

## 2. Wallets & Ledger (SPEC §2.2)
- [x] Four wallets per user: NGN, USDT, BTC, ETH — creation at registration + read endpoints done (`GET /api/wallets`, `GET /api/wallets/:currency`)
- [x] Immutable double-entry ledger — **`ledgerService`** (`credit`/`debit`/`hold`/`releaseHold`/`settleHold`/`convert`/`post`) writes LedgerEntry rows + wallet updates in one Mongo transaction; `EFFECTS` table maps each `(type, direction)` to balance/held deltas and `reconcile()` replays it (e2e-tested: `npm run test:services`)
- [x] Money math: BigInt smallest units end-to-end; INSUFFICIENT_FUNDS / INSUFFICIENT_HELD guards
- [~] NGN ↔ crypto conversion — `ledgerService.convert` (debit + credit + fee, one group) done; rate/spread quoting + route pending (needs trade service)
- [x] Transaction history — `GET /api/transactions` (type/currency/date filters, paginated, display amounts); admin variant `GET /api/admin/users/:id/transactions`

## 3. Deposits (SPEC §2.3) — _Beidou gateway (mirrors the client's sister project), dollar-denominated_
- [x] `POST /api/deposits {amountUsd}` → rate **locked at intent** (live USDT/NGN ± spread, or admin fixed rate) → whole-naira collection order → hosted checkout `payUrl`; reference prefixed `MS` (unique across projects on the shared merchant account)
- [x] Webhook `POST /api/payments/deposit/callback` — IP allowlist + **MD5 signature over the raw body** (preserves `100.00`), replies literal `success`; **idempotent** credit: actual callback NGN → one ledger group (deposit credit NGN → conversion → USDT credit, NGN nets zero) + referral commission on the USD amount + notification
- [x] `GET /api/deposits` (user) · `GET /api/admin/deposits` + manual approve/reject (reconciliation)
- ⚠ Live gateway untested — needs real `PG_*` creds + public callback URL

## 4. Withdrawals (SPEC §2.4) — _auto-submit like the sister project; admin override retained_
- [x] `POST /api/withdrawals {amountUsd, pin, totp?, bankCode, accountNumber, accountName}` — PIN + TOTP-if-2FA, **admin-configurable Lagos window/days + daily limit + tiered fee** (below/above threshold), USD→NGN at locked rate, whole-naira payout, **gross $ held via ledger**, payout submitted to gateway (failure = instant refund)
- [x] Lifecycle `pending → approved (gateway processing) → paid / rejected`; payout callback settles the hold or refunds it (idempotent)
- [x] `GET /api/withdrawals` + `GET /api/withdrawals/banks` (curated gateway bank codes) · admin list/approve/reject; `GET /api/admin/payments/balance` (shared merchant float)
- [x] **Saved bank accounts** (`BankAccount` model + `/api/bank`): `GET /list` (supported `{code,name}` from config/ngBanks), `GET /accounts`, `POST /bind` (validates gateway `bankCode`, newest becomes default, unique per user+bank+number → 409), `POST /accounts/:id/default`, `DELETE /accounts/:id` (promotes newest remaining). Withdrawal request resolves a saved account by `bankAccountId` or the user's default (or inline bank details, all-or-nothing)
- [ ] Auto-approve rules sweep (currently every gateway-accepted payout is auto-submitted; a review-queue mode can be added)

## 5. Market Data Service (SPEC §2.5)
- [x] `PriceService` provider abstraction (CoinGecko seed via `COINGECKO_BASE_URL`/`COINGECKO_API_KEY`) + in-process cache (`PRICE_REFRESH_SECONDS`, stale-while-revalidate, serves stale on provider outage)
- [x] Pairs BTC/ETH/USDT/BNB vs NGN — quoted directly in NGN; `getPriceKobo(pair)` returns BigInt kobo for money math, display prices are decimal strings
- [x] Endpoints (public): `GET /api/market/prices`, `/prices/:asset`, `/ohlc/:asset?days=`; **`/depth/:asset` returns 501** (CoinGecko has no order book — needs Binance provider)
- [x] Socket.IO live push — gateway (`src/socket/index.js`) emits `prices` on every refresh; REST endpoints are the polling fallback

## 6. Trading (SPEC §2.6) — _dollar-denominated: pairs are X/USDT (BTC, ETH, BNB), buys spend $, sells return $_
- [x] `POST /api/trades` — instant fill at cached price via `tradeService.executeTrade` (buy: amount = $ to spend; sell: amount = asset qty); ledger legs + fee (`TRADE_FEE_PCT`, default 0.1%) + Trade row + FIFO updates in one Mongo transaction
- [x] `GET /api/trades` history (asset filter, paginated) · `GET /api/trades/pnl` — realized (FIFO vs prior buys, `remainingBase` tracking) + unrealized (open remainders at current price)

## 7. Trading Signals (SPEC §2.7) — _binary options ("contract order"), client-clarified 2026-07-05: users win OR lose on price direction; no tie (unchanged price = loss)_
- [x] `Signal` model: pair (vs NGN incl. BCH), direction CALL/PUT, fixed return %, min/max stake, **durationSeconds**, trading window (tradingStart/End "HH:mm" Lagos), release day
- [x] `SignalPosition` model: user direction, **entryPrice/settlePrice snapshots**, outcome win/lose, payout, unique `user + signal` index
- [x] Release job (`releaseDueSignals`, every 60s, gated to 3–5 pm Lagos; admin can `POST /api/admin/signals/release {force:true}`) + settlement sweep (`settleDuePositions`, every 5s) — both wired in `src/jobs/index.js`, started by server.js
- [x] Place contract order — `POST /api/signals/:id/orders {stake, direction}`: stake ($) held via ledger + NGN entry-price snapshot, atomically; only inside the signal's trading window; dup rejected by unique index
- [x] Settlement: settle-price snapshot → win pays stake + return %, loss (incl. unchanged price) forfeits stake — both via ledger `signal_settlement` entries; user notified
- [x] Endpoints: `GET /api/signals/active`, `GET /api/signals/positions`; admin CRUD `POST|GET /api/admin/signals`, `PATCH /:id` (scheduled only), `POST /:id/cancel` (refunds open stakes)

## 8. Referral System (SPEC §2.8)
- [x] Unique referral code + shareable link (`getShareLink` → `CLIENT_ORIGIN/register?ref=CODE`); 3-level tree linkage on registration (`resolveReferrer`)
- [x] Referral QR code (`getQrCode` → data-URL PNG); route pending
- [x] 3-level commissions — `payCommissions({event, sourceUser, baseAmount, sourceRef})` pays L1–L3 in NGN via ledger + Referral rows + notifications; rates admin-configurable via `GET|PUT /api/admin/referral-rates`
- [x] Stats + share — `GET /api/referrals/stats|link|qr`
- _Deposit/trade services must call `payCommissions` on qualifying events_

## 9. In-App Notifications (SPEC §2.9)
- [x] `Notification` model (user, type, title, body, read, createdAt)
- [x] Endpoints: `GET /api/notifications?unreadOnly=` (paginated + unread count), `POST /api/notifications/:id/read`, `POST /api/notifications/read-all`; admin feed `GET /api/admin/notifications`
- [x] Socket.IO — gateway in `src/socket/index.js`: cookie-JWT handshake (anonymous sockets keep public events), room joins `user:<id>` + `admins`, bound to `notificationService.bindSocketServer`; events `notification`/`announcement`/`signal_released`/`prices`
- [~] User triggers live so far: login alert, referral commission, KYC decision, announcement; deposit/withdrawal/signal triggers come with those services
- [~] Admin triggers live so far: KYC submission, fraud flag (`auditService.flagFraud`); pending-withdrawal trigger comes with withdrawals

## 10. Announcements (SPEC §2.10)
- [x] `GET /api/announcements` (public latest-first) + admin CRUD under `/api/admin/announcements` (audited, publish fan-out: socket broadcast + batched per-user Notification rows)

## 11. Admin API (SPEC §2.11)
- [x] RBAC: `user` / `admin` / `superadmin`; `/api/admin/*` gated by `requireRole('admin')` (superadmin passes everything)
- [x] User management — `GET /api/admin/users` (q + status/kyc/role filters), `GET /users/:id`, `POST /users/:id/status` (freeze/unfreeze w/ reason)
- [x] Credit/debit wallets — `POST /api/admin/users/:id/wallet` (currency/direction/amount/reason → audited `admin_adjustment` ledger entry + user notification); `POST /api/admin/reconcile` (superadmin)
- [x] KYC review — `POST /api/admin/users/:id/kyc` (approve/reject + reason)
- [x] Withdrawals queue (approve/reject) + deposits view — `GET /api/admin/deposits|withdrawals` (status filter), `POST /:id/approve|reject`, `GET /api/admin/payments/balance`
- [x] Manage trading signals — `/api/admin/signals` CRUD + cancel (auto-refund) + manual release
- [x] Send announcements — `/api/admin/announcements` CRUD
- [x] Audit log view — `GET /api/admin/audit` (actor/action/date filters, paginated)
- [x] Admin notification feed — `GET /api/admin/notifications`
- [x] Reports: deposits, withdrawals, trades, signal payouts, referral payouts, user growth — `reportService`: `GET /api/admin/reports/overview?from&to` (dashboard cards incl. signal house net + per-level referral payouts) + `GET /api/admin/reports/timeseries?metric=users|deposits|withdrawals|trades|signal_payouts|referral_payouts` (daily Lagos-calendar buckets, count + USD volume)
- [x] Impersonation (support "login as user") — `POST /api/admin/users/:id/impersonate` (2h access token carrying the admin id in an `imp` claim; only the access cookie is overwritten so the admin's refresh session survives; staff targets superadmin-only; audited) + `POST /api/admin/impersonation/exit` (restores the admin session; mounted before the role gate). While impersonating: `GET /api/auth/me` returns `impersonation.adminId` for the frontend banner and ALL admin routes 403 `IMPERSONATION_ACTIVE`
- [x] Configure referral commission percentages — `GET|PUT /api/admin/referral-rates` (Setting-persisted, audited)
- [x] Platform settings — `GET|PUT /api/admin/settings`: min deposit/withdrawal, withdrawal fee tiers, **withdrawal days/hours window**, daily limit, FX mode (live ± spreads / fixed rate) — Setting-persisted, audited

## 11b. Spin & Win (client 2026-07-06)
- [x] Wheel of 9 admin-configurable prizes (`spin_prizes` in platform settings, display-dollar strings; defaults $10/8/6/5/4/2/1/0.8/0.5). **Players only ever win the two lowest values**: every spin pays the lowest, except each `spin_bonus_every`-th spin (default 5th) of the Lagos day **platform-wide** (atomic `SpinCounter` $inc per dayKey), which pays the second lowest — counter naturally resets every 5 spins (modulo) and every day (new dayKey)
- [x] Spin credits: earned on **direct (L1) referral registration** (`spin_referral_reward`, default 1, 0 disables; hook in `auth.service.register`) or admin-granted (`POST /api/admin/users/:id/spins {count, reason}` — audited + notified); consumed one per spin via atomic conditional `$inc` (refunded if the spin fails); `spinCredits` exposed in `toSafeUser`
- [x] Payout via ledger `spin_reward` credit in PLATFORM_CURRENCY + `Spin` row (dayKey, global sequence, bonus flag, `prizeIndex` = wheel segment for the frontend animation) + `spin_reward` notification
- [x] Endpoints: `GET /api/spin` (prizes in wheel order + credits), `POST /api/spin` (requireActive + transaction limiter → `{prizeIndex, prizeUsd, bonus, creditsLeft}`), `GET /api/spin/history`; admin `GET /api/admin/spins?day=&user=`

## 12. Security & Cross-Cutting (SPEC §2.12)
- [x] Stricter rate limits on auth/captcha routes; captcha attempt limiting
- [~] zod validation on every route (holds for all routes built so far)
- [~] `AuditLog` writes — `auditService.record` used by user/referral/announcement services; remaining admin actions wire in as their services land
- [~] Anti-fraud — `auditService.flagFraud` (audit row + admin notification) done; velocity/duplicate-device detection rules pending
- [x] Structured logging (pino) + centralized error handling

## 13. Jobs (SPEC §2.13) — `src/jobs/index.js`, overlap-guarded intervals, started/stopped by server.js
- [x] Price cache refresh (every `PRICE_REFRESH_SECONDS`)
- [x] Signal release (60s tick, window-gated) + settlement sweep (5s tick — 60s contracts)
- [ ] Withdrawal auto-approval sweep
- [ ] Ledger/balance reconciliation schedule (service `ledgerService.reconcile` + admin endpoint exist)

---

## Deferred (SPEC §4)
- On-chain crypto wallets (external deposits/withdrawals)
- Anything requiring exchange custody or blockchain nodes
