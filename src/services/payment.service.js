// PaymentGateway service (SPEC §2.3/§2.4) — client for the configured gateway
// (yoyopays; env.PG_*). Hides HTTP/signing so deposit/withdrawal services can
// swap providers. Webhook signature/IP verification helpers live here too
// (route uses middleware/ipAllowlist with PG_CALLBACK_IPS).
//
// Planned API:
//   createDepositOrder({ reference, amountKobo, user })   → { checkoutUrl / account details }
//   verifyWebhook(req)                                     → normalized event | throws
//   resolveBankAccount(bankCode, accountNumber)            → { accountName }
//   createPayout({ reference, amountKobo, bank })          → payout result (withdrawals)
//   queryOrderStatus(reference)
