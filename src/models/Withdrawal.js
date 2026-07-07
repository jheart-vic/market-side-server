import mongoose from 'mongoose';
import { WITHDRAWAL_STATUS } from '../config/constants.js';

const { Schema } = mongoose;

// Withdrawal to a Nigerian bank account. Funds are held (escrowed) via ledger
// entries while pending and released back on rejection.
const withdrawalSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    amount: { type: Schema.Types.Decimal128, required: true }, // NGN kobo paid out (net, whole naira)
    fee: { type: Schema.Types.Decimal128, default: () => mongoose.Types.Decimal128.fromString('0') }, // micro-USDT fee
    currency: { type: String, default: 'NGN' },
    // Dollar platform: gross/net dollars and the rate locked at request
    amountUsd: { type: Schema.Types.Decimal128 }, // micro-USDT gross (held via ledger)
    netAmountUsd: { type: Schema.Types.Decimal128 }, // micro-USDT after fee
    exchangeRate: { type: Schema.Types.Decimal128 }, // kobo per 1 USD, locked at request
    bank: {
      bankCode: { type: String, required: true },
      bankName: { type: String },
      accountNumber: { type: String, required: true },
      // Resolved via gateway API before the request is accepted
      accountName: { type: String, required: true },
    },
    status: { type: String, enum: WITHDRAWAL_STATUS, default: 'pending' },
    rejectionReason: String,
    autoApproved: { type: Boolean, default: false },
    processedBy: { type: Schema.Types.ObjectId, ref: 'User' }, // admin, when manual
    processedAt: Date,
    paidAt: Date,
    payoutReference: String, // gateway payout reference
    holdLedgerGroupId: { type: Schema.Types.ObjectId },
    settlementLedgerGroupId: { type: Schema.Types.ObjectId },
  },
  { timestamps: true },
);

withdrawalSchema.index({ user: 1, createdAt: -1 });
withdrawalSchema.index({ status: 1, createdAt: -1 });

export const Withdrawal = mongoose.model('Withdrawal', withdrawalSchema);
