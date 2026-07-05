import mongoose from 'mongoose';
import { REFERRAL_LEVELS, REFERRAL_EVENTS } from '../config/constants.js';

const { Schema } = mongoose;

// One commission payout to an upline. The referral tree itself lives on
// User.referredBy / User.uplines; this records the money.
const referralSchema = new Schema(
  {
    beneficiary: { type: Schema.Types.ObjectId, ref: 'User', required: true }, // upline receiving the commission
    sourceUser: { type: Schema.Types.ObjectId, ref: 'User', required: true }, // downline whose activity triggered it
    level: { type: Number, required: true, min: 1, max: REFERRAL_LEVELS },
    event: { type: String, enum: REFERRAL_EVENTS, required: true },
    ratePct: { type: Number, required: true }, // commission % applied, snapshotted
    amount: { type: Schema.Types.Decimal128, required: true }, // kobo
    // The deposit/trade that triggered the commission
    sourceRef: {
      kind: { type: String },
      item: { type: Schema.Types.ObjectId, refPath: 'sourceRef.kind' },
    },
    ledgerGroupId: { type: Schema.Types.ObjectId },
  },
  { timestamps: true },
);

referralSchema.index({ beneficiary: 1, createdAt: -1 });
referralSchema.index({ beneficiary: 1, level: 1 });
referralSchema.index({ sourceUser: 1 });

export const Referral = mongoose.model('Referral', referralSchema);
