# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

The **backend** (Express 5 + MongoDB/Mongoose 8, ES modules) for a crypto/NGN trading platform. The React PWA frontend lives in a **separate repo**. There is **no source code yet** — the repo currently holds planning documents, and implementation should follow them:

- [docs/SPEC.md](docs/SPEC.md) — the authoritative functionality spec. §2 defines every backend feature; §2.13 defines the intended `src/` layout (config / models / routes / controllers / services / middleware / utils / jobs). Read it before building anything.
- [project.txt](project.txt) — the raw client requirements SPEC.md was derived from. SPEC.md supersedes it where they differ.
- [context/summary.md](context/summary.md) — **read this first when resuming work**: snapshot of what's done, what's pending verification, and what's left, with a suggested build order. Keep it updated as progress is made.
- [context/feature.md](context/feature.md) — backend feature tracker with checkbox statuses (`[ ]` / `[~]` / `[x]`). **Update it as features are started/completed.**
- [context/session.md](context/session.md) — running summary of working-session decisions.

## Binding design decisions

These were explicitly agreed and must not be silently changed (full detail in SPEC.md §1–2):

- **Ledger-first money**: every balance change (deposit, withdrawal, trade, conversion, signal stake/settlement, referral commission, admin adjustment) is an immutable double-entry `LedgerEntry`; balances are derived from the ledger, never mutated directly.
- **No floats for money**: NGN in kobo (integer); crypto as `Decimal128` or integer smallest-units.
- **Auth via httpOnly cookies** (access JWT + rotating refresh token), never localStorage tokens; CSRF protection required.
- **No SMS/OTP anywhere**: human verification is server-generated **svg-captcha** (register, login, password reset); password reset is captcha + **security question**; 2FA is TOTP (Google Authenticator). Alerts go via in-app notifications + email.
- **bcryptjs** for hashing passwords, security-question answers, and the withdrawal PIN. Withdrawal-PIN set/change requires TOTP if 2FA is enabled, otherwise password re-entry.
- **Terms checkbox is frontend-only** — the backend does not store or enforce `termsAccepted`.
- **Phones in E.164** (parsed with `libphonenumber-js`); the `e164` string is the canonical unique user key.
- **No on-chain crypto**: all crypto balances are internal ledger entries; crypto deposits/withdrawals to external wallets are deferred.
- **Trading signals**: released daily 3:00–5:00 pm **Africa/Lagos**; one join per user per signal (unique `user + signal` index); fixed-return settlement via ledger entries. All time-window logic uses Africa/Lagos.
- **zod validation on every route**; provider abstractions for prices (`PriceService`) and captcha (`CaptchaService`) so implementations can be swapped.
- Stack pins (SPEC §5): Express 5, Mongoose 8, zod, cookie-parser, jose (or jsonwebtoken), socket.io, libphonenumber-js, bcryptjs, svg-captcha, qrcode, helmet, pino.

## Commands

- `npm run dev` — start the API with `node --watch` (needs MongoDB reachable at `MONGODB_URI`)
- `npm start` — start without watch
- `npm run smoke` — import smoke test: verifies all models register and core utils (money, phone, time, hash) hold their invariants; no DB needed
- `npm run test:auth` — live e2e of the auth service layer against the `.env` MongoDB (creates + deletes a throwaway user)
- `npm run test:http` — boots the app on an ephemeral port and drives auth + wallet routes over real HTTP (cookies, CSRF, validation); also self-cleaning

Copy `.env.example` to `.env` for local config. Health check: `GET /api/health`.

## Code layout notes

- `src/models/index.js` re-exports all 15 models; `src/server.js` imports it to register schemas.
- All money amounts are **BigInt integer smallest units** (kobo, micro-USDT, satoshi, wei) persisted as `Decimal128` — convert only via [src/utils/money.js](src/utils/money.js) (`toSmallestUnits` / `fromSmallestUnits` / `bigIntToDecimal128` / `decimal128ToBigInt`). Wallet balances must only change together with `LedgerEntry` rows.
- `LedgerEntry` and `AuditLog` schemas block all updates/deletes via pre-hooks — they are append-only by construction.
- Enums/statuses live in [src/config/constants.js](src/config/constants.js); env is zod-validated in [src/config/env.js](src/config/env.js) (production refuses dev-default JWT secrets).
