# Project Summary — What's Done & What's Left

_Persistent progress snapshot so any session (even after `/clear`) can pick up where we left off. Keep this updated when meaningful progress is made. Granular per-feature checkboxes live in [feature.md](feature.md); decisions history in [session.md](session.md); the authoritative spec is [../docs/SPEC.md](../docs/SPEC.md)._

**Last updated:** 2026-07-06

> **💵 Money model (client 2026-07-06):** the platform is **dollar-denominated** — `PLATFORM_CURRENCY='USDT'` (micro-units). NGN is only the deposit/withdrawal rail: deposit NGN → auto-convert to USD at live USDT/NGN rate ± spread (one ledger group, NGN wallet nets to zero); withdrawal converts USD → NGN before payout. Signal stakes, referral commissions, adjustments: all dollars.
> **🎯 Signals (client 2026-07-05):** binary options, NOT guaranteed returns — user picks CALL/PUT, entry & settle prices snapshotted, right = stake + return %, wrong/unchanged = full stake lost. Pairs vs NGN incl. BCH; durations in seconds; per-signal trading window.

## ✅ Done

### Planning docs
- `docs/SPEC.md` — full backend/frontend spec (rev: captcha instead of OTP, bcryptjs, security-question reset, referral QR, trading signals, in-app notifications, frontend-only terms checkbox)
- `CLAUDE.md` — binding design decisions + commands (auto-loaded every session)
- `context/feature.md` — feature tracker; `context/session.md` — session log

### Project scaffold
- `package.json` — ESM, Express 5, Mongoose 8, pinned stack (bcryptjs, svg-captcha, qrcode, socket.io, jose, zod, helmet, pino, libphonenumber-js, nanoid). Scripts: `dev`, `start`, `smoke`
- `.env.example` (user filled in real Mongo Atlas URI + yoyopays gateway `PG_*` keys), `.gitignore`
- `src/config/` — `env.js` (zod-validated, prod refuses dev JWT secrets, includes `PG_*`), `db.js`, `logger.js` (pino), `constants.js` (all enums: currencies, ledger types, statuses, signal window 15–17h Lagos, referral defaults 10/2/1%)

### Utils (`src/utils/`)
- `money.js` — **core money invariant**: BigInt integer smallest units (kobo/micro-USDT/satoshi/wei) ↔ Decimal128; `toSmallestUnits`, `fromSmallestUnits`, `percentOf`, no floats ever
- `phone.js` (E.164 via libphonenumber-js) · `hash.js` (bcryptjs + security-answer normalization) · `referralCode.js` (8-char unambiguous nanoid) · `time.js` (Africa/Lagos parts, `lagosDayKey`, `isWithinSignalWindow`) · `tokens.js` (random token + sha256) · `ApiError.js` · `asyncHandler.js` · `pagination.js`

### Models (`src/models/`, 15 total, barrel in `index.js`) — _investment plans dropped from scope 2026-07-05 (no Plan model)_
User (phone.e164 unique, security question, withdrawalPinHash, TOTP secret, KYC, referralCode + uplines[3], knownDevices) · Wallet (user+currency unique, balance + held) · **LedgerEntry (immutable — pre-hooks block update/delete; groupId pairs double entries; balanceAfter)** · Deposit (unique reference, webhook meta) · Withdrawal (bank details, hold/settlement ledger groups) · Trade (pair/side/legs/price/fee/realizedPnl) · Signal (returnPct, min/maxStake, durationMinutes, releaseDay) · SignalPosition (**unique user+signal**, settlesAt sweep index) · Referral (commission records; tree lives on User) · Notification (audience user/admin) · Announcement · **AuditLog (immutable)** · Captcha (TTL index) · Session (hashed rotating refresh tokens, reuse detection) · Setting (key/value runtime config, e.g. referral rates)

### App shell
- `src/app.js` — helmet, CORS (credentials), cookie-parser, pino-http, general rate limiter, global CSRF, `trust proxy` (prod), `GET /api/health`, notFound + errorHandler
- `src/server.js` — connect DB, graceful shutdown
- `scripts/smoke.js` — verifies 15 models register + util invariants, no DB needed

### Middleware (`src/middleware/`, barrel in `index.js`)
- `auth.js` — `requireAuth` (verifies `ms_access` httpOnly cookie with jose, loads `req.user`), `optionalAuth`, `requireActive` (frozen users can't transact)
- `rbac.js` — `requireRole(...roles)`, superadmin passes everything
- `validate.js` — zod wrapper; parsed values on `req.validated.{body,query,params}` (Express 5: `req.query`/`req.params` are getter-only — always read from `req.validated`)
- `rateLimit.js` — general (300/15m), auth (20/15m), captcha (60/15m), transaction (20/min); disabled when NODE_ENV=test
- `csrf.js` — double-submit: `ms_csrf` cookie (JS-readable) echoed in `x-csrf-token` header on mutating requests; only enforced when an access cookie exists (webhooks/pre-login unaffected); `issueCsrfCookie(res)` for the auth service
- **Cookie attributes are centralized in `src/utils/cookies.js`** (`baseCookieOptions`/`accessCookieOptions`/`refreshCookieOptions`/`csrfCookieOptions`): httpOnly, `secure` + `sameSite:'none'` in prod (lax in dev), `domain` from `COOKIE_DOMAIN` env in prod — **COOKIE_DOMAIN intentionally has no default; user will set the real domain later**. The auth service must set cookies only through these helpers
- `ipAllowlist.js` — webhook source-IP gate fed by `PG_CALLBACK_IPS`
- `error.js` — ApiError-aware handler, dup-key → 409
- Cookie names/CSRF header live in `config/constants.js` (`COOKIES`, `CSRF_HEADER`)

### Services (`src/services/` — implemented ones exported from `index.js` barrel; rest are stubs with planned-API headers)
**Implemented & e2e-tested (`npm run test:auth` — live against Atlas, self-cleaning):**
- `captcha.service` — svg-captcha; hashed answer, TTL, single-use atomic consume, attempt-limited
- `token.service` — jose access JWT; rotating refresh sessions (hashed, replay detection revokes session); `setAuthCookies`/`clearAuthCookies` via utils/cookies
- `auth.service` — register (captcha → E.164 → **unique username (sparse — pre-existing accounts may lack one)** → bcryptjs → referral link → 4 wallets → session), login (identifier = phone/email/**username**, captcha, `{requiresTotp:true}` two-step when 2FA on, new-device in-app alert), refresh/logout, security-question reset (normalized answers, uniform RESET_FAILED, revokes all sessions), changePassword/Question, 2FA via **otplib v13** (top-level `generate/verify/generateURI`, `epochTolerance: 60` — v13 has NO `authenticator` export, plugin-based), withdrawal PIN (TOTP-if-2FA-else-password)
- `wallet.service` — createWalletsForUser (idempotent), getWallets/getWallet display amounts

**Implemented & e2e-tested (`npm run test:services` — live against Atlas incl. Mongo transactions + live CoinGecko, self-cleaning):**
- `ledger.service` — **the only place balances change**: `post()` core (N entries sharing a groupId + wallet updates in one Mongo transaction), `credit`/`debit`/`hold`/`releaseHold`/`settleHold`/`convert` wrappers, `getHistory` (filters + pagination, display strings), `reconcile` (replays the `EFFECTS` table mapping each `(type, direction)` → balance/held deltas). Accepts an outer `session` for composition
- `user.service` — `getProfile`/`updateProfile` (email only), `submitKyc`/`reviewKyc` (pending → approved/rejected, admin notification + audit + user `kyc_status` notification), `setAccountStatus` (freeze/unfreeze, staff targets superadmin-only, audited), `searchUsers`
- `referral.service` — `resolveReferrer`, `payCommissions` (L1–L3 NGN via ledger + Referral rows + notifications), `getStats`, `getShareLink`/`getQrCode` (data-URL PNG), `getRates`/`setRates` (persisted in **Setting**, in-process cache, audited)
- `notification.service` — `notifyUser`/`notifyAdmins` (+ Socket.IO emit when `bindSocketServer(io)` has been called; rooms `user:<id>` / `admins`), `broadcast`, `list`/`adminList` (unread counts), `markRead`/`markAllRead`
- `announcement.service` — admin create/update/remove (audited), publish fan-out (broadcast + batched per-user Notification rows), `listPublished`/`adminList`
- `audit.service` — `record` (append-only), `feed` (actor/action/date filters), `flagFraud`
- `price.service` — CoinGecko provider (`COINGECKO_BASE_URL`/`COINGECKO_API_KEY` env), NGN-quoted, in-process cache (`PRICE_REFRESH_SECONDS`, stale-while-revalidate, serves stale on outage), `getPrices`/`getPrice` (display strings), **`getPriceKobo` (BigInt for money math)**, `getOhlc` (60s cache), `getDepth` (501 — provider has no order book), `refreshCache` + `onPriceUpdate` for the job/socket gateway

- `trade.service` — instant spot fills at cached price, **dollar-quoted pairs (BTC/ETH/BNB vs USDT)**: buy spends $, sell returns $; ledger legs + `TRADE_FEE_PCT` fee + Trade row + **FIFO cost basis** (`remainingBase`) in one Mongo transaction; `getHistory`, `getPnl` (realized + unrealized). Base acquired outside trades (conversions) sells at zero cost basis
- `signal.service` — full binary-options engine: admin `createSignal/updateSignal(scheduled only)/cancelSignal(auto-refunds)`, `releaseDueSignals` (3–5 pm Lagos gate, `force` override), `placeOrder` (window check, stake bounds, $ hold + NGN entry-price snapshot in one txn, unique user+signal), `settleDuePositions` (settle-price snapshot → win stake+return% / lose forfeits; equal price = lose), `listActive`, `getPositions`
- `src/jobs/index.js` — overlap-guarded intervals: price refresh (`PRICE_REFRESH_SECONDS`), signal release (60s), settlement sweep (5s); started in server.js, not in tests (app.js doesn't start jobs)

- `payment.service` — **Beidou gateway client** (mirrors the client's sister project): MD5 signing (ASCII-sorted `k=v&…&secret`), `verifyCallback` against the **raw body** (JSON.parse kills `100.00` — `req.rawBody` captured in app.js), collection/payout create+query, `getBalance`. Callback replies must be literal `success`. `MS`-prefixed order IDs (merchant account shared with the sister project)
- `settings.service` — admin knobs in one Setting row over code defaults: min deposit/withdrawal, withdrawal fee tiers (below/above threshold), **withdrawal days/hours (Lagos)**, daily limit, `fx_mode` live±spread / fixed rate
- `fx.service` — `usdNgnRateKobo('deposit'|'withdrawal')` BigInt kobo/$ + conversion helpers
- `deposit.service` — intent (rate locked, whole-naira order, checkout `payUrl`) → idempotent callback credit: actual paid NGN → one ledger group NGN→USD (nets zero) + referral commission on USD + notify; admin list/manual approve/reject
- `withdrawal.service` — PIN + TOTP-if-2FA, Lagos window + daily limit + tiered fee, gross $ held, whole-naira payout auto-submitted (fail → instant refund); callback settles/refunds hold; admin list/approve/reject; `listBanks` (curated gateway codes in `config/ngBanks.js`)

**⚠ Live gateway untested** — needs real `PG_BASE_URL/PG_MERCHANT_ID/PG_SECRET_KEY`, `PG_CALLBACK_BASE_URL` (public), `PG_CALLBACK_IPS`. Remaining stub: none — all 20 services implemented.

### HTTP layer (`src/controllers/`, `src/routes/`) — auth + wallets live, verified by `npm run test:http`
- `routes/index.js` mounted at `/api` in app.js; zod schemas co-located in route files; handlers read validated query/params from `req.validated`
- **Auth** (`/api/auth`): `GET /captcha?purpose=`, `POST /register`, `POST /login` (returns `{requiresTotp:true}` for 2FA step), `POST /refresh`, `POST /logout`, `GET /me`, `GET /security-question?identifier=`, `POST /reset-password`, `POST /change-password`, `POST /security-question/change`, `POST /2fa/enable|confirm|disable`, `POST /withdrawal-pin` — auth/captcha rate limits applied
- **Wallets** (`/api/wallets`): `GET /` and `GET /:currency` (requireAuth)
- **Users** (`/api/users`): `GET /me` (full profile incl. KYC docs as 15-min signed URLs), `PATCH /me` (email/username/fullName), `POST /kyc` — multipart (`docType` + `document`×2 + optional `selfie`) → **Cloudinary v2 private uploads** (`utils/cloudinary.js`: upload_stream direct from buffer, no streamifier; images limited 1920px + quality:auto, PDFs raw; `type:'private'` so viewing needs `getSignedUrl`); multer memory storage w/ mime filter + 10MB cap in `middleware/upload.js`; failed submit or resubmission cleans up assets. Env: `CLOUDINARY_CLOUD_NAME/API_KEY/API_SECRET` (503 UPLOADS_UNAVAILABLE when unset)
- **Transactions** (`/api/transactions`): `GET /` — own ledger history (type/currency/from/to filters, paginated)
- **Referrals** (`/api/referrals`): `GET /stats`, `GET /link`, `GET /qr` (requireAuth)
- **Notifications** (`/api/notifications`): `GET /?unreadOnly=`, `POST /:id/read`, `POST /read-all`
- **Announcements** (`/api/announcements`): `GET /` (public, published latest-first)
- **Market** (`/api/market`, public): `GET /prices`, `GET /prices/:asset`, `GET /ohlc/:asset?days=` (USD candles), `GET /depth/:asset` (501) — assets BTC/ETH/USDT/BNB/BCH; quotes are dollar-first `{asset, priceUsd, priceNgn, change24hPct, volume24hUsd}`; USDT's `priceNgn` is the deposit/withdrawal rate
- **Trades** (`/api/trades`): `POST /` (asset BTC/ETH/BNB, side, amount — $ for buys, qty for sells; requireActive + transaction limiter), `GET /` history, `GET /pnl`
- **Signals** (`/api/signals`): `GET /active`, `GET /positions`, `POST /:id/orders {stake, direction}` (requireActive + transaction limiter)
- **Admin signals** (`/api/admin/signals`): create/list?day=/patch (scheduled only)/`POST /:id/cancel` (refunds)/`POST /release {force}`
- **Admin** (`/api/admin`, requireAuth + requireRole('admin'); superadmin passes all): `GET /users` (search+filters), `GET /users/:id`, `POST /users/:id/status` (freeze/unfreeze), `POST /users/:id/kyc` (approve/reject), `GET /users/:id/transactions`, `POST /users/:id/wallet` (credit/debit adjustment: display-units amount + reason → audited `admin_adjustment` ledger entry + user notification), `POST /reconcile` (**superadmin only** — fix:true rewrites wallets), `GET /audit`, `GET /notifications`, `GET|PUT /referral-rates`, announcements CRUD (`POST|GET /announcements`, `PATCH|DELETE /announcements/:id`)
- User model now also has **username** (unique sparse, login identifier) and **fullName** (display) — both required at register, editable via `PATCH /users/me`
- `npm run test:http` boots the app on an ephemeral port and verifies over real HTTP: cookies set/cleared, CSRF 403 without header, refresh rotation, validation 400s, wallet reads, profile/transactions/notifications/referral-QR/announcements reads, admin 403 for plain users (self-cleaning)
- Email for login alerts still pending (no provider)

## ⚠️ Pending / verification status
- ✅ `npm install` done (175 packages) and `npm run smoke` **passes** (15 models register, util invariants hold)
- ⏳ `npm run dev` + `GET /api/health` not yet exercised — needs a `.env` file first (dotenv loads `.env`, not `.env.example`, so the Atlas URI currently isn't picked up and the server would try local Mongo)
- ⚠️ **Security**: real credentials (Atlas URI, `PG_SECRET_KEY`, JWT secrets) are sitting in `.env.example`, which is a committed file — move them to `.env` (gitignored) and put placeholders back in `.env.example`; rotate the exposed secrets

## 🔜 Remaining
0. _(note: registration now creates **5 wallets** — BNB added for spot trading)_
1. **Live gateway verification** — fill real `PG_*` env values, expose the API publicly (or tunnel), run a ₦-real deposit + withdrawal end-to-end
2. ~~Socket gateway~~ — **done**: `src/socket/index.js` (attached in server.js; ms_access-cookie JWT handshake, anonymous = public events only; rooms `user:<id>` + `admins`; emits `prices`/`notification`/`announcement`/`signal_released`; Engine.IO handshake covered in `npm run test:http`)
3. **Admin reports** (deposits, withdrawals, trades, signal payouts, referral payouts, user growth) + email provider for login alerts
4. Optional hardening: withdrawal review-queue mode (manual approve before gateway submit), payment status polling job as callback fallback, anti-fraud velocity rules

