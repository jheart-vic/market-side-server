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
