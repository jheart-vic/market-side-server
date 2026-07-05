# Market-Side Platform — Functionality Spec

_A crypto/NGN trading platform. This document splits the requirements in [project.txt](../project.txt) into **backend** (this repo: Express + MongoDB) and **frontend** (separate repo: React PWA) responsibilities, and records the agreed constraints and recommendations._

**Last updated:** 2026-07-05

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
  - Fields: phone, email, password, optional referral code, **security question + answer** (used later for password reset)
  - Phone parsed/validated with `libphonenumber-js`; stored as `{ countryCode, nationalNumber, e164 }` — the `e164` string (e.g. `+2348012345678`) is the canonical unique key
  - Password hashed with **bcryptjs**; security-question answer normalized (trim/lowercase) and also hashed with bcryptjs
  - Requires a valid captcha (see below)
  - If a referral code is present, link the new user into the referrer's 3-level tree
- **Captcha verification** — **svg-captcha** generated server-side behind a `CaptchaService`; each challenge gets an id, the expected answer is stored hashed with a short TTL, is single-use, and attempt-limited. Required on **registration, login, and password-reset** endpoints
- **Login / logout / session**
  - Short-lived access JWT + rotating refresh token, both delivered as `httpOnly`, `secure`, `sameSite` cookies
  - CSRF protection (double-submit token or `sameSite=strict` + custom header check)
  - Login alerts (**in-app notification + email**) on new device or IP
- **2FA** — TOTP via **Google Authenticator** (or any compatible authenticator app): enable/verify/disable
- **Withdrawal PIN** — separate hashed PIN, required for withdrawals; set/change requires **TOTP if 2FA is enabled, otherwise password re-entry**
- **Password management**
  - Change password (authenticated, current password required)
  - **Forgot/reset**: captcha + correct security-question answer → set new password
  - Security question changeable when authenticated (password re-entry required)
- **KYC** — document upload + status lifecycle: `unverified → pending → approved / rejected`
- **Account states** — `active` / `frozen` (admin-controlled); frozen users can log in but cannot transact

### 2.2 Wallets & Ledger (internal only)
- Four wallets per user: **NGN, USDT, BTC, ETH**
- Balances backed by an **immutable double-entry transaction ledger** — every credit/debit (deposit, withdrawal, trade, conversion, signal stake/settlement, referral commission, admin adjustment) is a ledger entry; balances are derived/reconciled from it
- **Money is never stored as floats**: NGN in kobo (integer) and crypto amounts as `Decimal128` (or integer smallest-units)
- **Conversion** NGN ↔ USDT/BTC/ETH at live cached rates, with a configurable spread/fee
- Transaction history endpoint with filtering (type, currency, date range) and pagination

### 2.3 Deposits
- NGN deposits via payment gateway (**Paystack** or **Flutterwave**)
- Deposit intent → gateway checkout → **webhook verification** (never trust the client callback) → ledger credit
- Deposit records queryable by user and by admin
- Crypto deposits: **deferred** (no on-chain integration yet)

### 2.4 Withdrawals
- Withdraw to **Nigerian bank account** only for now (crypto withdrawal deferred — hidden or "coming soon" on the frontend)
- Requires withdrawal PIN (+ 2FA if enabled); bank account name resolution via gateway API
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

### 2.7 Trading Signals
- Admin-published, fixed-return "contract order" signals; fields: pair, direction, **fixed return %**, min/max stake, duration, release date
- **Released daily within the 3:00 pm – 5:00 pm window (Africa/Lagos)** — a scheduled job publishes each day's signals; no new signals outside the window
- **Signals cannot be repeated**: each user may join a given signal **at most once** (enforced by a unique `user + signal` index)
- Join flow: stake amount debited from the NGN wallet as a held ledger entry → after the signal's duration a settlement job credits **stake + fixed return** back via ledger entries
- Endpoints: list today's/active signals, join a signal, my signal positions/history
- Maps to the **"Contract order"** item in the Mine section

### 2.8 Referral System
- Unique referral code + shareable link per user
- **Referral QR code** — the referral link is also exposed as a QR code (server-generated with the `qrcode` package, returned as a data-URL/PNG endpoint) for the frontend to render, download, and share
- **3-level commissions** (defaults: L1 = 10%, L2 = 2%, L3 = 1% — admin-configurable), paid as ledger entries when qualifying events occur (e.g. deposits or trade fees)
- Stats endpoints: total referrals, active referrals, earnings per level

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
- Manage users (search, view, edit), freeze/unfreeze accounts
- Credit/debit wallets — always via audited ledger entries with reason
- Approve/reject withdrawals; view deposits
- **Manage trading signals** (CRUD, release scheduling, view joins/settlements)
- Send announcements
- **View audit log** — filterable feed (actor, action, date) so admins can see everything happening on the platform
- **Admin notification feed** (events needing attention — see 2.9)
- Reports: deposits, withdrawals, trades, signal payouts, referral payouts, user growth
- Configure referral commission percentages

### 2.12 Security & Cross-Cutting
- `helmet`, rate limiting (stricter on auth/captcha routes; captcha answer attempts are rate-limited), CORS locked to the frontend origin with `credentials: true`
- Request validation with **validatejs** on every route
- **Audit log** for all admin actions and sensitive user actions — exposed to admins via the audit-log endpoint (2.11)
- Anti-fraud flags: velocity checks, duplicate device/IP registrations, unusual withdrawal patterns → flag for admin review
- Centralized error handler; structured logging (e.g. `pino`)

### 2.13 Suggested Server Structure
```
src/
├── config/        # env, db connection, constants
├── models/        # Mongoose schemas (User, Wallet, LedgerEntry, Trade, Signal, SignalPosition, Withdrawal, Deposit, Referral, Notification, Announcement, AuditLog)
├── routes/        # route definitions per domain
├── controllers/   # request/response handling
├── services/      # business logic (CaptchaService, PriceService, LedgerService, SignalService, NotificationService, ReferralService, PaymentGateway)
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
| **Register** | Phone input with **country-code picker**, email, password, referral code, **security question + answer**, **captcha widget** (svg image + refresh), Terms & Privacy checkbox (**frontend-only gate** — submit disabled until checked) |
| **Login** | Phone/email + password + **captcha**; **Google Authenticator (TOTP)** step when 2FA enabled |
| **Forgot Password** | Captcha → security-question answer → set new password |
| **Dashboard** | Wallet balance, trading balance, total earnings, active trades, transaction history, referral income, verification status |
| **Wallet** | NGN / USDT / BTC / ETH balances, convert between NGN and crypto, transaction list |
| **Deposit** | Gateway checkout flow, deposit history |
| **Withdraw** | Bank account form + PIN entry; crypto option hidden or "coming soon" |
| **Trade** | Candlestick charts (`lightweight-charts`), buy/sell forms, live prices, trading history for BTC/ETH/USDT/BNB vs NGN |
| **Signals** | Daily signals (released 3:00–5:00 pm WAT), stake to join (once per signal), countdown to settlement, positions/history ("contract order") |
| **Markets** | Price list with 24h change, volume, market depth |
| **Team** | Referral link + **QR code** (view/download/share), total/active referrals, earnings per level |
| **Notifications** | Bell icon with unread badge in the layout; notification list with mark-read |
| **Mine / Profile** | Authentication (KYC), invite friends, earn rewards, deposit record, withdrawal record, password & security question, contract order (signal positions), about us, sign out |
| **Privacy / Terms** | Static legal pages, linked from the register checkbox |
| **Admin UI** | User management, withdrawals queue, deposits, signals management, announcements, audit log, notifications, reports (can be a separate route group or app) |

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
- **Security-question resets are weaker than email resets** — always hash answers, normalize before hashing, and strictly rate-limit reset attempts (captcha already required)
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
