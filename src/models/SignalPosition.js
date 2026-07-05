import mongoose from 'mongoose';
import { SIGNAL_POSITION_STATUS } from '../config/constants.js';

const { Schema } = mongoose;

// A user's stake in a signal. The unique (user, signal) index enforces the
// "signals cannot be repeated" rule — one join per user per signal.
const signalPositionSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    signal: { type: Schema.Types.ObjectId, ref: 'Signal', required: true },
    stake: { type: Schema.Types.Decimal128, required: true }, // kobo, held via ledger on join
    // Snapshot of the signal's return % at join time, so later edits can't change payouts
    returnPct: { type: Number, required: true },
    payout: { type: Schema.Types.Decimal128, default: null }, // stake + return, set on settlement
    status: { type: String, enum: SIGNAL_POSITION_STATUS, default: 'open' },
    settlesAt: { type: Date, required: true }, // joinedAt + signal duration
    settledAt: Date,
    stakeLedgerGroupId: { type: Schema.Types.ObjectId },
    settlementLedgerGroupId: { type: Schema.Types.ObjectId },
  },
  { timestamps: true },
);

signalPositionSchema.index({ user: 1, signal: 1 }, { unique: true });
signalPositionSchema.index({ status: 1, settlesAt: 1 }); // settlement job sweep
signalPositionSchema.index({ user: 1, createdAt: -1 });

export const SignalPosition = mongoose.model('SignalPosition', signalPositionSchema);
