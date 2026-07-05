// WithdrawalService (SPEC §2.4) — bank withdrawals with escrow.
// Request: verifyWithdrawalPin (+ TOTP if enabled) → resolve account name →
// LedgerService.hold. pending → approved (manual or auto-approve rules) → paid
// (gateway payout, settleHold) / rejected (releaseHold refund). Admin actions
// audited; status changes notify the user; new requests notify admins.
//
// Planned API:
//   requestWithdrawal(user, { amountKobo, bank, pin, totp? })   → Withdrawal(pending)
//   approve(admin, withdrawalId) / reject(admin, withdrawalId, reason)
//   markPaid(withdrawalId, payoutRef)         (payout webhook/confirmation)
//   autoApproveSweep()                        → job: rules e.g. amount < threshold && KYC approved
//   getHistory(user, pagination) / adminQueue(filters, pagination)
