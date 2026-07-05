import mongoose from 'mongoose';
import { DEPOSIT_STATUS } from '../config/constants.js';

const { Schema } = mongoose;

// NGN deposit via payment gateway. Credited to the ledger only after webhook
// verification — never from the client callback.
const depositSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    gateway: { type: String, required: true }, // e.g. "yoyopays", "paystack"
    // Our reference sent to the gateway; unique so webhooks are idempotent
    reference: { type: String, required: true, unique: true },
    gatewayReference: { type: String },
    amount: { type: Schema.Types.Decimal128, required: true }, // kobo
    fee: { type: Schema.Types.Decimal128, default: () => mongoose.Types.Decimal128.fromString('0') },
    currency: { type: String, default: 'NGN' },
    status: { type: String, enum: DEPOSIT_STATUS, default: 'pending' },
    channel: { type: String }, // e.g. bank transfer, card
    // Raw webhook payload kept for disputes/audits
    gatewayMeta: { type: Schema.Types.Mixed },
    creditedAt: Date,
    ledgerGroupId: { type: Schema.Types.ObjectId },
  },
  { timestamps: true },
);

depositSchema.index({ user: 1, createdAt: -1 });
depositSchema.index({ status: 1, createdAt: -1 });

export const Deposit = mongoose.model('Deposit', depositSchema);
