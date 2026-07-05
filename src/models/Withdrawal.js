import mongoose from 'mongoose';
import { WITHDRAWAL_STATUS } from '../config/constants.js';

const { Schema } = mongoose;

// Withdrawal to a Nigerian bank account. Funds are held (escrowed) via ledger
// entries while pending and released back on rejection.
const withdrawalSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    amount: { type: Schema.Types.Decimal128, required: true }, // kobo
    fee: { type: Schema.Types.Decimal128, default: () => mongoose.Types.Decimal128.fromString('0') },
    currency: { type: String, default: 'NGN' },
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
