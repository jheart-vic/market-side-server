import mongoose from 'mongoose';
import { SALARY_CLAIM_STATUS } from '../config/constants.js';

const { Schema } = mongoose;

// A user's one-time claim on a salary tier reward. Fulfillment is manual: the
// user is told to contact customer care with their name + phone, and an admin
// marks the claim fulfilled/rejected. The tier reward/target and the valid
// direct count at claim time are snapshotted so later downgrades don't rewrite
// history. Reward money is NEVER auto-credited — this is a fulfillment record.
const salaryClaimSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    tier: { type: Number, required: true, min: 0 },
    reward: { type: String, required: true }, // snapshot of SALARY_TIERS[tier].reward
    rewardType: { type: String, required: true }, // cash | prize | salary
    invitees: { type: Number, required: true }, // snapshot target
    validDirectCount: { type: Number, required: true }, // qualifying directs at claim time
    // Contact details the user supplies for manual reward fulfillment
    contactName: { type: String, required: true, trim: true },
    contactPhone: { type: String, required: true, trim: true },
    status: { type: String, enum: SALARY_CLAIM_STATUS, default: 'pending' },
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    reviewedAt: Date,
    note: String, // admin note / rejection reason
  },
  { timestamps: true },
);

// One live claim per (user, tier): the service blocks a new claim while a
// pending or fulfilled one exists; a rejected claim may be re-submitted.
salaryClaimSchema.index({ user: 1, tier: 1 });
salaryClaimSchema.index({ status: 1, createdAt: -1 });

export const SalaryClaim = mongoose.model('SalaryClaim', salaryClaimSchema);
