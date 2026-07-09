# Market-Side Platform — Functionality Spec

_A crypto/NGN trading platform. This document splits the requirements in [project.txt](../project.txt) into **backend** (this repo: Express + MongoDB) and **frontend** (separate repo: React PWA) responsibilities, and records the agreed constraints and recommendations._

**Last updated:** 2026-07-07

---

## 1. Agreed Constraints

| Constraint | Decision |
|---|---|
| Stack | MERN (MongoDB, Express, React, Node), ES modules throughout |
| Auth transport | **Server-side cookies** (httpOnly), not localStorage tokens |
| Frontend delivery | **PWA**, mobile-first, fully responsive (mobile / tablet / desktop) |
| Styling | Tailwind CSS 4 + daisyUI (dynamic theme switching) |
| Legal | Privacy & Terms pages; "I agree" checkbox on registration is **frontend-only** (submit disabled until checked) — the backend does not store or enforce it |
| Human verification | **svg-captcha** (server-generated) on registration, login, and password reset — **no SMS/OTP provider at all** |
| Notifications | **In-app notifications + email** for alerts (login alerts, transaction events); no SMS |
| Crypto | **No on-chain wallet integration yet** — all crypto balances are internal ledger entries |
| Phone numbers | Always stored with country code (E.164) |
| Timezone | Signal release window and business hours computed in **Africa/Lagos (WAT)** |

---

## 2. Backend Functionalities (this repo — Express + MongoDB)

### 2.1 Auth & User Accounts
- **Registration** (`POST /api/auth/register`)
  - Fields: phone, email, username, full name, password, optional referral code (captcha required). **No security question.**
  - **Recovery codes (client decision 2026-07-08 — replaces security questions):** registration generates **10 one-time recovery codes**, returned in the response **exactly once** for the user to save; only fast hashes (sha256 — the codes are high-entropy) are stored on the user. They are the account-ownership proof for password reset. `POST /api/auth/recovery-codes/regenerate` (authenticated, password re-entry) issues a fresh set and invalidates the old one; profile reports `recoveryCodesRemaining`
  - Phone parsed/validated with `libphonenumber-js`; stored as `{ countryCode, nationalNumber, e164 }` — the `e164` string (e.g. `+2348012345678`) is the canonical unique key
  - Password hashed with **bcryptjs**; security-question answer normalized (trim/lowercase/collapse whitespace) and also hashed with bcryptjs
  - Requires a valid captcha (see below)
  - If a referral code is present, link the new user into the referrer's 3-level tree and **grant the direct (L1) referrer a Spin & Win credit** (see 2.8a)
- **Captcha verification** — **svg-captcha** generated server-side behind a `CaptchaService`; each challenge gets an id, the expected answer is stored hashed with a short TTL, is single-use, and attempt-limited. Required on **registration, login, and password-reset** endpoints
- **Login / logout / session**
  - Short-lived access JWT + rotating refresh token, both delivered as `httpOnly`, `secure`, `sameSite` cookies
  - CSRF protection (double-submit token or `sameSite=strict` + custom header check)
  - Login alerts (**in-app notification + email**) on new device or IP
- **Admin login** (`POST /api/auth/admin/login`) — a separate **email + password** login for staff, **no captcha** (rate-limited instead). Credentials come from `ADMIN_EMAIL` / `ADMIN_PASSWORD` env (the source of truth, constant-time compared on every login); `ADMIN_PHONE` satisfies the User model. There is **no admin registration** — the backing `superadmin` User is **created on first successful login** (with wallets), then normal cookie/session issuance applies. Returns 503 when the env creds aren't configured
- **2FA** — TOTP via **Google Authenticator** (or any compatible authenticator app): enable/verify/disable
- **Withdrawal PIN** — separate hashed PIN, required for withdrawals; set/change requires **TOTP if 2FA is enabled, otherwise password re-entry**
- **Password management**
  - Change password (authenticated, current password required)
  - **Forgot/reset**: captcha + one **unused recovery code** → set new password (`POST /api/auth/reset-password {identifier, recoveryCode, newPassword, captcha}`). Codes are case/format-insensitive, single-use (burned on success), and a reset revokes all sessions. Failures are uniform (`RESET_FAILED`) whether the account or code is wrong — no oracle
- **Sessions & devices** — a user can see and manage their active logins: `GET /api/sessions` (each with a parsed device label, IP, timestamps, and a `current` flag for the caller's own session), `DELETE /api/sessions/:id` (log out that device), `POST /api/sessions/revoke-others` (log out all other devices). Backed by the `Session` model; current session is matched via the refresh-cookie hash. Revoking invalidates a session's refresh token immediately; its short-lived access token lapses within `ACCESS_TOKEN_TTL`.
- **Multi-account switching** (Gmail/Slack-style) — several **full, independent** accounts can be signed into one browser and switched between instantly. The active account uses the normal `ms_access`/`ms_refresh`/`ms_csrf` cookies; a separate **signed httpOnly `ms_accounts`** cookie holds the *inactive* linked accounts (each with its own live refresh token) plus a pointer to the active one — so switching is fully server-mediated and no token is ever exposed to JS. Endpoints (all authenticated): `GET /api/auth/accounts` (switcher list), `POST /api/auth/accounts/add` (a **full login** — captcha + password, TOTP if 2FA — that appends the account and makes it active), `POST /api/auth/accounts/switch {userId}`, `POST /api/auth/accounts/remove {userId}`, `POST /api/auth/accounts/logout-others` (keep only the active one). Default `POST /api/auth/logout` signs out only the **active** account and promotes the next linked one (full logout only when none remain). Cap: **5** accounts per browser. **Anti-abuse:** accounts added together are unioned into a durable `User.linkGroupId`, and referral commissions + referral spin credits are **not paid between accounts in the same link group** (self-referral guard).
- **KYC** — document upload + status lifecycle: `unverified → pending → approved / rejected`
- **Account states** — `active` / `frozen` (admin-controlled); frozen users can log in but cannot transact

### 2.2 Wallets & Ledger (internal only)
- **The platform is dollar-denominated (client decision 2026-07-06)**: the user's money lives in a **USD balance (stored as micro-USDT)**; Naira is only the funding rail. Deposits auto-convert **NGN → USD** at the live USDT/NGN rate (± configurable spread) the moment they confirm; withdrawals convert **USD → NGN** at the withdrawal-day rate (± spread) before the bank payout. All displayed amounts (balances, stakes, payouts, commissions, P/L) are **dollars**
- Four wallets per user: **NGN (gateway pass-through), USDT (the primary dollar balance), BTC, ETH**
- Balances backed by an **immutable double-entry transaction ledger** — every credit/debit (deposit, withdrawal, trade, conversion, signal stake/settlement, referral commission, admin adjustment) is a ledger entry; balances are derived/reconciled from it. Deposit conversion is auditable: the deposit credits NGN and the NGN→USD conversion entries share the same transaction group, so the NGN wallet nets to zero
- **Money is never stored as floats**: NGN in kobo (integer) and crypto amounts as `Decimal128` (or integer smallest-units)
- **Conversion** USD ↔ BTC/ETH at live cached rates, with a configurable spread/fee; the NGN↔USD conversions at deposit/withdrawal use the same engine
- Transaction history endpoint with filtering (type, currency, date range) and pagination

### 2.3 Deposits
- NGN deposits via payment gateway (**Paystack** or **Flutterwave**)
- Deposit intent → gateway checkout → **webhook verification** (never trust the client callback) → ledger credit
- Deposit records queryable by user and by admin
- Crypto deposits: **deferred** (no on-chain integration yet)

### 2.4 Withdrawals
- Withdraw to **Nigerian bank account** only for now (crypto withdrawal deferred — hidden or "coming soon" on the frontend)
- **Saved bank accounts** (`BankAccount` model, `/api/bank`): a user can save multiple withdrawal accounts and mark one as the **default**; the newest bound account becomes the default, and deleting the default promotes the most recent remaining one. Banks are restricted to `config/ngBanks.js` — each saved account stores the exact gateway **`bankCode`** (so it is directly payable) plus the display name. Endpoints: `GET /api/bank/list` (supported `{code, name}` banks), `GET /api/bank/accounts`, `POST /api/bank/bind`, `POST /api/bank/accounts/:id/default`, `DELETE /api/bank/accounts/:id`. `isVerified` is reserved for future gateway account-name resolution
- A withdrawal request pays to a **saved account** (by `bankAccountId`, or the user's default when omitted) **or** inline bank details (all-or-nothing)
- Requires withdrawal PIN (+ 2FA if enabled); bank account name resolution via gateway API (planned)
- Status lifecycle: `pending → approved → paid` / `rejected` (funds held/escrowed while pending, refunded on reject)
- Admin actions: **manual approve**, **auto-approve rules** (e.g. below a threshold, KYC-approved users), **reject with reason**

### 2.5 Market Data Service
- Proxy + **server-side cache** of live prices from CoinGecko/Binance (avoid client-side rate limits and key exposure)  CoinGecko client is the seed for this
- Pairs: BTC/NGN, ETH/NGN, USDT/NGN, BNB/NGN (compose from USD pairs + USD/NGN rate if needed)
- Endpoints: current prices, 24h change, volume, market depth, OHLC/candlestick data for charts
- **Live push via Socket.IO** (polling fallback); single provider abstraction so Binance / CoinGecko / CoinMarketCap can be swapped

### 2.6 Trading
- Buy/sell BTC, ETH, USDT, BNB against NGN, executed against the internal ledger at current cached price
- Order records: pair, side, amount, price, fee, timestamp, status
- Trading history per user; **profit/loss computation** (realized per trade + unrealized from open positions) feeding the dashboard "total profit/loss"

### 2.7 Trading Signals ("Contract Order" — admin-decided binary options)
- **Outcome is admin-decided** (client 2026-07-09, supersedes the price-based model): each signal carries a `direction` (**CALL**/**PUT**) that is the **secret winning side**, **never shown to users**. A contract **wins iff the user's own blind pick matches the signal's direction** — real price movement does not decide it. (Entry/settle prices are still snapshotted best-effort from PriceService, but only for display; they no longer determine win/lose.)
- Signal fields: pair (**quoted vs NGN**, e.g. BCH/NGN — includes BCH beyond the four trading assets), the secret `direction`, **fixed return %**, min/max stake (dollars), **contract duration in seconds** (e.g. 60s), release day. *(The old per-signal trading window was removed.)*
- **Release window is admin-configurable** (settings `signal_release_start`/`signal_release_end`, Lagos wall-clock, default **15:00–17:00**). A signal **created inside the window goes live immediately**; otherwise it stays scheduled and the release job publishes it when the window opens (admin `force`-release publishes early). A released signal is **tradeable only while the clock is still inside the window** (single-window model — released-in-window = tradeable).
- **Placing a contract order**: user stakes **dollars** (moved to `held` via ledger) and picks CALL or PUT blind; entry price snapshotted (cosmetic).
- **Settlement** at entry + duration: `won = user pick === signal's secret direction`. Win → stake + fixed return % credited; lose → full stake forfeited. Settled via ledger.
- **Signals cannot be repeated**: each user may hold a given signal **at most once** (unique `user + signal` index).
- **Admin management**: create/edit(scheduled only)/cancel (refunds open contracts)/**delete** (`DELETE /api/admin/signals/:id` — only when no contracts exist; use cancel to refund otherwise)/release.
- Endpoints: list today's/active signals (direction hidden), place a contract order, my positions/history.
- Maps to the **"Contract order"** item in the Mine section

### 2.8 Referral System
- Unique referral code + shareable link per user
- **Referral QR code** — the referral link is also exposed as a QR code (server-generated with the `qrcode` package, returned as a data-URL/PNG endpoint) for the frontend to render, download, and share
- **3-level commissions** (defaults: L1 = 10%, L2 = 2%, L3 = 1% — admin-configurable), paid **in the platform dollar currency** as ledger entries when qualifying events occur (e.g. deposits or trade fees)
- A **direct (L1) referral registration also grants the referrer a Spin & Win credit** (count admin-configurable, see 2.8a)
- Stats endpoints: total referrals, active referrals, earnings per level

### 2.8a Spin & Win (Wheel of Fortune — client requirement 2026-07-06)
- A circular prize wheel the frontend renders and spins on click. Nine prize segments, **all admin-configurable** (`spin_prizes` in platform settings — display-dollar strings, defaults $10/8/6/5/4/2/1/0.8/0.5)
- **Outcome is decided server-side, not by chance** — players only ever win the **two lowest** prize values:
  - every spin pays the **lowest** value…
  - …except each **Nth spin of the Lagos day, platform-wide** (`spin_bonus_every`, default 5th), which pays the **second lowest**. A global per-day counter (atomic `SpinCounter`, one row per Lagos calendar day) drives this; the modulo rule makes it reset every cycle and every new day automatically
  - the response carries the winning wheel-segment index so the frontend animates the wheel to the right slot
- **Spin credits** (one consumed per spin): earned on **direct (L1) referral registration** (`spin_referral_reward`, default 1 credit, 0 disables) or **granted by an admin** (audited). Consumed via an atomic conditional decrement, refunded if the spin fails
- **Prizes pay via the ledger** — a `spin_reward` credit in the platform dollar currency into the USDT wallet, plus a `Spin` record (day, global sequence, bonus flag, segment index, amount) and an in-app notification. No direct balance writes (ledger-first invariant holds)
- Endpoints: `GET /api/spin` (wheel config + remaining credits), `POST /api/spin` (play — requires an active account + transaction rate limit), `GET /api/spin/history`; admin `GET /api/admin/spins` and grant credits (see 2.11)

### 2.9 In-App Notifications
- `Notification` model: user, type, title, body, read, createdAt
- Endpoints: list (paginated, unread count), mark read / mark all read
- **Real-time push via Socket.IO** alongside the price feed
- User triggers: deposit confirmed, withdrawal status change, signal release/settlement, referral commission, admin credit/debit, new announcement, login alert
- Admin triggers: new pending withdrawal, KYC submission, anti-fraud flags

### 2.10 Announcements
- Admin CRUD; user-facing list (latest first) for homepage + announcements screen

### 2.11 Admin API (role-based)
- Roles: `user`, `admin`, `superadmin` (RBAC middleware)
- **Bootstrap admin login** — env-configured `superadmin` signs in with email + password (no captcha) via `POST /api/auth/admin/login`; the account is created on first login (see 2.1)
- Manage users (search, view, edit), freeze/unfreeze accounts
- Credit/debit wallets — always via audited ledger entries with reason (response returns balance before/after)
- **Impersonation ("login as user") — support tool**: `POST /api/admin/users/:id/impersonate` issues a short-lived (2h) access token authenticating **as the target user** but carrying the admin's id in an `imp` claim; **only the access cookie is overwritten**, so the admin's own refresh session survives and `POST /api/admin/impersonation/exit` (or any token refresh) restores it. Staff accounts are superadmin-only targets. While impersonating, `GET /api/auth/me` returns `impersonation.adminId` (frontend banner) and **every admin route is blocked** (`IMPERSONATION_ACTIVE`) so an impersonated session never carries staff powers. Start + exit are audited
- Approve/reject withdrawals; view deposits
- **Manage trading signals** (CRUD, release scheduling, view joins/settlements)
- **Spin & Win**: grant spin credits to a user (audited); view the spin activity feed; configure the wheel prizes / bonus cadence / referral reward via platform settings (see 2.8a)
- Send announcements
- **View audit log** — filterable feed (actor, action, date) so admins can see everything happening on the platform
- **Admin notification feed** (events needing attention — see 2.9)
- **Reports** (`ReportService`): an **overview** snapshot (`GET /api/admin/reports/overview?from&to` — users total/new/frozen/KYC-pending, deposits & withdrawals by status with volumes and fees, trade count/volume/fees, signals open/settled with wins/losses and **house net**, referral payouts per level) and **daily time series** (`GET /api/admin/reports/timeseries?metric=…` — users, deposits, withdrawals, trades, signal payouts, referral payouts; bucketed on the Africa/Lagos calendar). All money is aggregated in Decimal128 smallest units and returned as display strings
- Configure referral commission percentages; configure platform settings (deposit/withdrawal mins, withdrawal fee tiers + window + daily limit, FX mode/spreads, spin knobs)

### 2.12 Security & Cross-Cutting
- `helmet`, rate limiting (stricter on auth/captcha routes; captcha answer attempts are rate-limited), CORS locked to the frontend origin with `credentials: true`
- Request validation with **zod** on every route (parsed values on `req.validated.{body,query,params}`)
- **Audit log** for all admin actions and sensitive user actions — exposed to admins via the audit-log endpoint (2.11)
- Anti-fraud flags: velocity checks, duplicate device/IP registrations, unusual withdrawal patterns → flag for admin review
- Centralized error handler; structured logging (e.g. `pino`)
- **Testing** — two layers: **Vitest** unit tests (`npm test`, `tests/*.test.js`) cover pure logic (money math, Lagos time windows, phone parsing, hashing, pagination, security questions, spin outcome rules) with no DB or network; and self-cleaning live e2e scripts against the `.env` MongoDB (`npm run test:auth` service layer, `npm run test:http` over real HTTP incl. cookies/CSRF/admin/impersonation/spins, `npm run test:services`, plus `npm run smoke` for model registration). `npm run test:all` chains unit → smoke → live e2e. Vitest was chosen so the React frontend repo can share one framework

### 2.13 Suggested Server Structure
```
src/
├── config/        # env, db connection, constants
├── models/        # 18 Mongoose schemas (User, Wallet, LedgerEntry, Trade, Signal, SignalPosition, Withdrawal, Deposit, Referral, Notification, Announcement, AuditLog, Captcha, Session, Setting, Spin, SpinCounter, BankAccount)
├── routes/        # route definitions per domain
├── controllers/   # request/response handling
├── services/      # business logic (CaptchaService, PriceService, LedgerService, SignalService, NotificationService, ReferralService, PaymentGateway, SpinService, ReportService, …)
├── middleware/    # auth, RBAC, validation, rate limit, error handler
├── utils/         # phone parsing, money math, helpers
└── jobs/          # price cache refresh, signal release + settlement sweeps, auto-approval sweeps, reconciliation
```

---

## 3. Frontend Functionalities (separate repo — React + Vite + Tailwind 4 + daisyUI, PWA)

### 3.1 Pages / Screens
| Screen | Contents (from project.txt) |
|---|---|
| **Landing** | Public (logged-out) marketing page explaining what the platform is and everything it offers: live-price ticker teaser, feature highlights (NGN + crypto wallets, trading, daily trading signals, 3-level referral program, secure withdrawals), how-it-works steps, trust/security notes (KYC, 2FA), Register + Login CTAs, links to Privacy/Terms; authenticated users are redirected to Home |
| **Home** | Live market prices (BTC, ETH, USDT, NGN), wallet balance (₦), total profit/loss, Deposit + Withdraw buttons, referral earnings, latest announcements |
| **Register** | Phone input with **country-code picker**, email, username, full name, password, referral code, **captcha widget** (svg image + refresh), Terms & Privacy checkbox (**frontend-only gate**). On success, **show the 10 one-time recovery codes once** with a "save these" prompt (download/copy) |
| **Login** | Phone/email + password + **captcha**; **Google Authenticator (TOTP)** step when 2FA enabled |
| **Forgot Password** | Captcha → **one recovery code** → set new password |
| **Dashboard** | Wallet balance, trading balance, total earnings, active trades, transaction history, referral income, verification status |
| **Wallet** | NGN / USDT / BTC / ETH balances, convert between NGN and crypto, transaction list |
| **Deposit** | Gateway checkout flow, deposit history |
| **Withdraw** | Saved bank accounts (add/pick/set-default/delete via `/api/bank`, bank chosen from `GET /api/bank/list`) + amount + PIN entry; crypto option hidden or "coming soon" |
| **Trade** | Candlestick charts (`lightweight-charts`), buy/sell forms, live prices, trading history for BTC/ETH/USDT/BNB vs NGN |
| **Signals** | Daily signals (released 3:00–5:00 pm WAT), stake to join (once per signal), countdown to settlement, positions/history ("contract order") |
| **Spin & Win** | Circular prize wheel (9 admin-configured segments) that spins on click; shows remaining spin credits, animates to the winning segment returned by `POST /api/spin`, prize history; credits earned via direct referrals or admin grants |
| **Markets** | Price list with 24h change, volume, market depth |
| **Team** | Referral link + **QR code** (view/download/share), total/active referrals, earnings per level |
| **Notifications** | Bell icon with unread badge in the layout; notification list with mark-read |
| **Mine / Profile** | Authentication (KYC), invite friends, earn rewards, deposit record, withdrawal record, password & **recovery codes** (view remaining / regenerate), **active sessions & devices** (see logins, "log out other devices"), contract order (signal positions), about us, sign out |
| **Privacy / Terms** | Static legal pages, linked from the register checkbox |
| **Admin UI** | User management (+ **impersonation** "login as user" with a persistent "viewing as" banner and exit button), withdrawals queue, deposits, signals management, spin credit grants + spin feed, announcements, audit log, notifications, reports (overview cards + daily charts) — can be a separate route group or app |

### 3.2 Navigation & Layout
- **Bottom navigation** (mobile): Home · Markets · Trade · Wallet · Team · Profile
- Mobile-first layouts that expand gracefully — bottom nav becomes a sidebar/topbar on tablet/desktop; multi-column dashboards on wide screens

### 3.3 PWA
- `vite-plugin-pwa`: web manifest, service worker, installable, offline app shell + cached static assets (never cache authenticated API responses)

### 3.4 Theming
- daisyUI themes via `data-theme` attribute; theme switcher persisted in `localStorage` with `prefers-color-scheme` default

### 3.5 Data & Auth Handling
- API client with `credentials: 'include'` (cookie auth) and CSRF token header
- Socket.IO client for live prices, balance updates, and **in-app notifications**
- Server state via TanStack Query (caching, refetching); forms with react-hook-form + zod (shared validation schemas with the backend where practical)

---

## 4. Deferred (explicitly out of scope for now)
- On-chain crypto wallet integration (crypto deposits/withdrawals to external wallets)
- Anything requiring exchange custody or blockchain nodes

## 5. Recommendations
- **Terms enforcement** — the checkbox is frontend-only for now; if legal later requires proof of acceptance, add backend storage of `{ version, acceptedAt }` at that point
- **Recovery-code resets** (replaced security questions 2026-07-08) — codes are high-entropy and single-use, so they're stronger than guessable security answers; the frontend must make the user save them at registration (they're shown once). An email-based reset can be added later as a convenience once an email provider is wired
- **Ledger-first design** — never mutate a balance without a ledger entry; makes admin credit/debit, signal settlements, reports, and dispute resolution auditable
- **Provider abstraction** — one `PriceService` interface over CoinGecko/Binance/CMC; swap or fail over without touching business logic
- **Regulatory** — the platform holds user funds: KYC/AML obligations and CBN/SEC (Nigeria) licensing considerations should be reviewed before launch
- **Stack pins** — Express 5, Mongoose 8, zod, cookie-parser, `jose` (or jsonwebtoken), socket.io, libphonenumber-js, **bcryptjs**, **svg-captcha**, **qrcode**, helmet, pino

## 6. Coverage Map (project.txt → this spec)
| project.txt § | Item | Where |
|---|---|---|
| 1 | Homepage | Frontend 3.1 (Home) + Backend 2.5/2.2/2.10 |
| 2 | User Registration | Backend 2.1 + Frontend 3.1 (Register — captcha replaces OTP) |
| 3 | User Dashboard | Frontend 3.1 (Dashboard) + Backend 2.2/2.6/2.8 |
| 4 | Naira Wallet | Backend 2.2 + Frontend 3.1 (Wallet) |
| 5 | Withdraw | Backend 2.4 + Frontend 3.1 (Withdraw); crypto → Deferred |
| 6 | Trading Section | Backend 2.5/2.6 + Frontend 3.1 (Trade) |
| 7 | Referral System | Backend 2.8 + Frontend 3.1 (Team) |
| 8 | Mine Section | Frontend 3.1 (Mine/Profile) |
| 12 | Admin Panel | Backend 2.11 + Frontend 3.1 (Admin UI) |
| 13 | Security | Backend 2.1/2.12 (captcha replaces OTP) |
| 14 | Charts | Backend 2.5 + Frontend 3.1 (Trade/Markets) |
| 15 | Bottom Navigation | Frontend 3.2 |
| — | Trading Signals (new requirement, not in project.txt) | Backend 2.7 + Frontend 3.1 (Signals) |
| — | In-app Notifications (new requirement) | Backend 2.9 + Frontend 3.1 (Notifications) |
| — | Landing page (new requirement) | Frontend 3.1 (Landing) |
| — | Spin & Win wheel (new requirement 2026-07-06) | Backend 2.8a + Frontend 3.1 (Spin & Win) |
| — | Admin impersonation (new requirement 2026-07-06) | Backend 2.11 + Frontend 3.1 (Admin UI) |
| — | Sessions & devices (new requirement 2026-07-08) | Backend 2.1 + Frontend 3.1 (Mine/Profile) |
| — | Recovery codes — replaced security questions (2026-07-08) | Backend 2.1 + Frontend 3.1 (Register / Forgot Password) |
