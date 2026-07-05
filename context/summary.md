# Project Summary — What's Done & What's Left

_Persistent progress snapshot so any session (even after `/clear`) can pick up where we left off. Keep this updated when meaningful progress is made. Granular per-feature checkboxes live in [feature.md](feature.md); decisions history in [session.md](session.md); the authoritative spec is [../docs/SPEC.md](../docs/SPEC.md)._

**Last updated:** 2026-07-05

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

### Models (`src/models/`, 14 total, barrel in `index.js`) — _investment plans dropped from scope 2026-07-05 (no Plan model)_
User (phone.e164 unique, security question, withdrawalPinHash, TOTP secret, KYC, referralCode + uplines[3], knownDevices) · Wallet (user+currency unique, balance + held) · **LedgerEntry (immutable — pre-hooks block update/delete; groupId pairs double entries; balanceAfter)** · Deposit (unique reference, webhook meta) · Withdrawal (bank details, hold/settlement ledger groups) · Trade (pair/side/legs/price/fee/realizedPnl) · Signal (returnPct, min/maxStake, durationMinutes, releaseDay) · SignalPosition (**unique user+signal**, settlesAt sweep index) · Referral (commission records; tree lives on User) · Notification (audience user/admin) · Announcement · **AuditLog (immutable)** · Captcha (TTL index) · Session (hashed rotating refresh tokens, reuse detection)

### App shell
- `src/app.js` — helmet, CORS (credentials), cookie-parser, pino-http, general rate limiter, global CSRF, `trust proxy` (prod), `GET /api/health`, notFound + errorHandler
- `src/server.js` — connect DB, graceful shutdown
- `scripts/smoke.js` — verifies 14 models register + util invariants, no DB needed

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
- `auth.service` — register (captcha → E.164 → bcryptjs → referral link → 4 wallets → session), login (captcha, `{requiresTotp:true}` two-step when 2FA on, new-device in-app alert), refresh/logout, security-question reset (normalized answers, uniform RESET_FAILED, revokes all sessions), changePassword/Question, 2FA via **otplib v13** (top-level `generate/verify/generateURI`, `epochTolerance: 60` — v13 has NO `authenticator` export, plugin-based), withdrawal PIN (TOTP-if-2FA-else-password)
- `wallet.service` — createWalletsForUser (idempotent), getWallets/getWallet display amounts
- `referral.service` — `resolveReferrer` only (tree link); commissions/QR/stats TODO
- `notification.service` — `notifyUser`/`notifyAdmins` persist only; Socket.IO bind + list/markRead TODO

**Still stubs:** user, ledger, price, trade, signal, payment, deposit, withdrawal, announcement, audit (read each file's header for the planned API).

### HTTP layer (`src/controllers/`, `src/routes/`) — auth + wallets live, verified by `npm run test:http`
- `routes/index.js` mounted at `/api` in app.js; zod schemas co-located in route files; handlers read validated query/params from `req.validated`
- **Auth** (`/api/auth`): `GET /captcha?purpose=`, `POST /register`, `POST /login` (returns `{requiresTotp:true}` for 2FA step), `POST /refresh`, `POST /logout`, `GET /me`, `GET /security-question?identifier=`, `POST /reset-password`, `POST /change-password`, `POST /security-question/change`, `POST /2fa/enable|confirm|disable`, `POST /withdrawal-pin` — auth/captcha rate limits applied
- **Wallets** (`/api/wallets`): `GET /` and `GET /:currency` (requireAuth)
- `npm run test:http` boots the app on an ephemeral port and verifies over real HTTP: cookies set/cleared, CSRF 403 without header, refresh rotation, validation 400s, wallet reads (self-cleaning)
- Email for login alerts still pending (no provider)

## ⚠️ Pending / verification status
- ✅ `npm install` done (175 packages) and `npm run smoke` **passes** (15 models register, util invariants hold)
- ⏳ `npm run dev` + `GET /api/health` not yet exercised — needs a `.env` file first (dotenv loads `.env`, not `.env.example`, so the Atlas URI currently isn't picked up and the server would try local Mongo)
- ⚠️ **Security**: real credentials (Atlas URI, `PG_SECRET_KEY`, JWT secrets) are sitting in `.env.example`, which is a committed file — move them to `.env` (gitignored) and put placeholders back in `.env.example`; rotate the exposed secrets

## 🔜 Not started (build order suggestion)
1. **Auth domain**: CaptchaService (svg-captcha) → register (captcha, E.164, referral-tree link, wallets init) → login/logout/refresh (Session rotation, httpOnly cookies, CSRF) → security-question password reset → TOTP 2FA → withdrawal PIN
2. **LedgerService** (the one place balances change; Mongo transactions) + wallets/transaction-history endpoints + NGN↔crypto conversion
3. **Deposits** (yoyopays intent + webhook w/ IP allowlist `PG_CALLBACK_IPS`) → **Withdrawals** (hold/escrow, admin approve/auto-approve/reject, payout)
4. **Market data** (PriceService + cache + Socket.IO) → **Trading** → **Signals** (release job 3–5 pm WAT + settlement sweep)
5. **Referrals** (commissions on qualifying events, QR endpoint) → **Notifications** (NotificationService + Socket.IO) → **Announcements** → **Admin API** (users, audit-log feed, reports) → **Jobs** wiring
