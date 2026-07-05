// DepositService (SPEC §2.3) — NGN deposit intent → gateway checkout → webhook
// verification (never the client callback) → LedgerService.credit. Unique
// Deposit.reference makes webhook processing idempotent. Triggers referral
// commissions (ReferralService) and a deposit_confirmed notification.
//
// Planned API:
//   createIntent(user, amountKobo)      → Deposit(pending) + gateway checkout payload
//   handleWebhook(event)                → verify, mark success/failed, credit ledger (idempotent)
//   getHistory(user, pagination) / adminList(filters, pagination)
