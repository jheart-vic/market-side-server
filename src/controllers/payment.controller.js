import * as paymentService from '../services/payment.service.js';
import * as depositService from '../services/deposit.service.js';
import * as withdrawalService from '../services/withdrawal.service.js';
import { logger } from '../config/logger.js';
import { asyncHandler } from '../utils/asyncHandler.js';

// Gateway callbacks: source IP is gated by middleware (PG_CALLBACK_IPS), the
// MD5 signature is verified here against the RAW body, and the gateway expects
// the literal text "success" — anything else triggers up to 8 retries (which
// is also why the handlers are idempotent).

export const depositCallback = asyncHandler(async (req, res) => {
  if (!paymentService.verifyCallback(req.body, req.rawBody)) {
    logger.warn({ body: req.body, ip: req.ip }, 'Deposit callback signature verification FAILED');
    return res.status(400).send('sign error');
  }
  await depositService.handleCallback(req.body);
  res.send('success');
});

export const withdrawCallback = asyncHandler(async (req, res) => {
  if (!paymentService.verifyCallback(req.body, req.rawBody)) {
    logger.warn({ body: req.body, ip: req.ip }, 'Payout callback signature verification FAILED');
    return res.status(400).send('sign error');
  }
  await withdrawalService.handleCallback(req.body);
  res.send('success');
});
