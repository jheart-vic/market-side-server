# Session Summary — 2026-07-05

> **📌 Current progress snapshot: [summary.md](summary.md)** — what's done, what's pending verification, and what's left to build. Read that first when resuming work (e.g. after `/clear`); this file is the decision history.

## What this session was about
Revised [docs/SPEC.md](../docs/SPEC.md) (the functionality spec for the Market-Side crypto/NGN trading platform) to reflect a new set of decisions. No source code exists in this repo yet — this was a documentation-only session.

## Decisions made

1. **OTP → captcha.** All SMS/OTP verification is removed (no Termii/Twilio, no SMS provider at all). Replaced with **svg-captcha** generated server-side behind a `CaptchaService`, required on **registration, login, and password reset**. Challenges are id'd, answer stored hashed with short TTL, single-use, attempt-limited.
2. **Terms checkbox is frontend-only.** The backend no longer stores or enforces `termsAccepted`; the register form just disables submit until the box is checked. Backend storage can be added later if legal requires proof of acceptance.
3. **bcryptjs for hashing** (replacing argon2) — used for passwords, security-question answers, and the withdrawal PIN.
4. **Password reset via security question.** Users set a security question + answer at registration (answer normalized then hashed). Forgot-password flow: captcha → correct answer → set new password. Question changeable when authenticated with password re-entry.
5. **Withdrawal PIN set/change** (previously OTP-protected): now requires **TOTP if 2FA is enabled, otherwise password re-entry**.
6. **2FA = Google Authenticator** (TOTP; any compatible app).
7. **Referral QR code.** Referral link is also exposed as a QR code (server-generated with the `qrcode` package, data-URL/PNG endpoint) for the Team screen to render/download/share.
8. **In-app notifications** (new §2.9) for users *and* admins, pushed over Socket.IO — plus an admin-visible, filterable **audit log** feed so admins can see everything happening on the platform.
9. **NEW feature — Trading Signals** (new §2.7, not in project.txt):
   - Admin publishes fixed-return "contract order" signals: pair, direction, return %, min/max stake, duration, release date.
   - Released **daily between 3:00 pm and 5:00 pm Africa/Lagos** by a scheduled job.
   - **Signals cannot be repeated** — one join per user per signal (unique `user + signal` index).
   - Join stakes NGN via a held ledger entry; a settlement job credits stake + fixed return after the duration.
   - Maps to the "Contract order" item in the Mine section.
10. **Login alerts** go via in-app notification + email (no SMS).

## Changes applied to docs/SPEC.md

- §1 constraints table: frontend-only terms row, svg-captcha row, in-app+email notifications row, Africa/Lagos timezone row.
- §2.1 rewritten around captcha, bcryptjs, security question, Google Authenticator, new PIN-change rule.
- Inserted §2.7 Trading Signals and §2.9 In-App Notifications; later sections renumbered (Referral 2.8, Announcements 2.10, Admin 2.11, Security 2.12, Structure 2.13).
- Admin API gained: manage signals, view audit log, admin notification feed, signal-payout reports.
- Server structure updated: `CaptchaService`, `SignalService`, `NotificationService` (dropped `OtpService`); models add `Signal`, `SignalPosition`, `Notification`; jobs add signal release + settlement sweeps.
- Frontend screens: OTP Verify screen removed; Register/Login get captcha; new Forgot Password, Signals, and Notifications rows; Team gets the QR code.
- Recommendations + stack pins updated (bcryptjs, svg-captcha, qrcode; note that security-question resets are weaker than email resets — hash + rate-limit).
- Coverage map updated, with two new rows for Trading Signals and In-App Notifications as requirements not present in project.txt.

## Verified
Grep over the final spec confirms no stale `argon2`, `Termii`, `Twilio`, or backend `termsAccepted` references; the only "OTP"/"SMS" hits are "TOTP" (2FA) and lines explicitly stating OTP/SMS was replaced.

## Repo state / next steps
- Repo contains only `docs/SPEC.md`, `project.txt`, and `.claude/` — nothing committed yet, no code scaffolding.
- Natural next step: scaffold the Express server per §2.13 (config, models, routes, controllers, services, middleware, jobs) and start with auth + captcha.

## Client clarifications — 2026-07-05 (evening)

11. **Signals are binary options, not guaranteed returns** (corrects decision 9). Client's real signal format: pair + direction **CALL/PUT** + time limit in **seconds** (e.g. 60s) + a per-signal **trading window** (e.g. 18:00–20:00) distinct from the 3–5 pm release window. The user stakes NGN and picks a direction; entry price is snapshotted at entry, settlement price at entry+duration. Correct direction → **win** (stake + fixed return %); wrong → **lose the full stake**. **No tie case** — unchanged price counts as a loss. SPEC §2.7 rewritten; `Signal` (durationSeconds, tradingStart/End, call/put) and `SignalPosition` (direction, entryPrice, settlePrice, outcome, payout) updated; `SIGNAL_OUTCOMES` added to constants.
12. **Signal pairs are quoted vs NGN** (e.g. **BCH/NGN**) and the signal universe includes **BCH** beyond the four trading assets; USDT-quoted pairs may come later. `SIGNAL_ASSETS`/`SIGNAL_PAIRS` added; PriceService now quotes BCH/NGN (CoinGecko id `bitcoin-cash`), verified live.
13. **Crypto withdrawals**: sending real on-chain crypto requires either a custody/gateway API or self-managed hot wallets — there is no third option. Plan: launch with manual admin payout through the existing withdrawal-approval escrow flow; integrate a crypto payout provider later if volume justifies it.

## Client clarification — 2026-07-06

14. **The platform is dollar-denominated.** Deposits and withdrawals move in **Naira** (bank rail), but the user's money is held and displayed in **dollars**: on deposit confirmation NGN auto-converts to the USD balance (stored as micro-USDT in the USDT wallet) at the live USDT/NGN rate ± configurable spread; withdrawal converts USD→NGN at the withdrawal-day rate ± spread before payout. All internal denominations (signal stakes/payouts, referral commissions, adjustments, P/L) are dollars — `PLATFORM_CURRENCY = 'USDT'` in constants. Referral service switched from NGN to platform-currency payouts; Signal/SignalPosition stakes re-denominated; SPEC §2.2/§2.3-ish/§2.7/§2.8 updated. The NGN wallet becomes a gateway pass-through (deposit + conversion entries share one ledger group so it nets to zero).

## Payment gateway integration — 2026-07-06

15. **Gateway = Beidou** (MD5-signed "四方"-style, same merchant account as the client's sister project). Client shared their working helper; ours mirrors it in `payment.service.js` (ESM, fetch, no streamifier/axios deps). Key mechanics: ASCII-sorted `k=v&…&<secret>` MD5 sign; callbacks verified against the **raw request body** (`req.rawBody` captured in app.js) because `JSON.parse` destroys `"transAmt": 100.00`; callbacks answered with literal text `success` (else 8 retries); Nigeria payouts must be whole naira; callback amount is authoritative. **`callbackUrl` is passed per order** so this project's callbacks never hit the sister project's server; order IDs are `MS`-prefixed to keep the shared merchantOrderId namespace collision-free.
16. **Deposit flow**: intent locks the USD/NGN rate (live USDT/NGN ± admin spread, or admin fixed rate) → whole-naira collection order → hosted checkout. Completed callback credits the ACTUAL paid NGN and auto-converts at the locked rate in one ledger group (NGN nets zero), pays referral commissions on the USD amount, idempotent under retries.
17. **Withdrawal flow**: auto-submit like the sister project (not queue-first): PIN + TOTP-if-2FA → admin-configured Lagos-timezone days/hours window + daily limit + tiered fee (below/above threshold) → gross $ held via ledger → payout submitted; gateway failure refunds instantly; callback settles (paid) or releases (rejected) the hold. Admin manual approve/reject retained for reconciliation.
18. **Admin platform settings** (`GET|PUT /api/admin/settings`, Setting-persisted): min deposit/withdrawal, fee tiers, withdrawal window, daily limit, fx_mode/spreads. Defaults mirror the sister project (min $11.5, fees 16%/10% @ $100 threshold, window 08:00–22:00 daily).
19. **Improvements over the sister project**: ledger double-entry instead of direct balance mutation; escrow holds instead of upfront deduction; rate locked per order; Lagos wall-clock window (sister used server time); constant-time signature compare; settings persisted + audited.
