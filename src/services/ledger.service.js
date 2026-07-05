// LedgerService (SPEC §2.2) — THE ONLY PLACE wallet balances change.
// Writes immutable double-entry LedgerEntry rows (shared groupId) and the
// matching Wallet.balance/held updates inside a MongoDB transaction. All
// amounts are BigInt smallest units via utils/money.js. Every other service
// (deposits, withdrawals, trades, signals, referrals, admin) calls this.
//
// Planned API:
//   credit({ user, currency, amount, type, ref?, narration?, performedBy? })   → { groupId }
//   debit({ ... })                                                             → { groupId } | throws INSUFFICIENT_FUNDS
//   hold({ user, currency, amount, type, ref })      → moves balance → held (withdrawals, signal stakes)
//   releaseHold({ ... })                             → held → balance (rejections/cancellations)
//   settleHold({ ... })                              → held → out (paid withdrawal, staked signal)
//   transfer/convert({ user, from, to, amounts, feeAmount })   → NGN↔crypto conversion pair
//   getHistory(user, { type?, currency?, from?, to?, pagination })
//   reconcile(userId?)                               → recompute balances from entries (job)
