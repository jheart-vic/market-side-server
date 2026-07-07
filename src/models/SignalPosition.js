import mongoose from 'mongoose';
import {
  SIGNAL_DIRECTIONS,
  SIGNAL_OUTCOMES,
  SIGNAL_POSITION_STATUS,
} from '../config/constants.js';

const { Schema } = mongoose;

// A user's contract order on a signal. The unique (user, signal) index enforces
// the "signals cannot be repeated" rule — one contract per user per signal.
// Entry and settlement prices are snapshotted from our own PriceService cache
// so every win/lose outcome is provable from platform data.
const signalPositionSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    signal: { type: Schema.Types.ObjectId, ref: 'Signal', required: true },
    stake: { type: Schema.Types.Decimal128, required: true }, // PLATFORM_CURRENCY units (micro-USDT), held via ledger on entry
    // The direction the user actually chose (they are advised to follow the
    // signal but may pick either side)
    direction: { type: String, enum: SIGNAL_DIRECTIONS, required: true },
    // Snapshot of the signal's return % at entry, so later edits can't change payouts
    returnPct: { type: Number, required: true },
    entryPrice: { type: Schema.Types.Decimal128, required: true }, // kobo per unit at entry
    settlePrice: { type: Schema.Types.Decimal128, default: null }, // kobo per unit at expiry
    // win → payout = stake + return %; lose → payout = 0, stake forfeited.
    // Unchanged price counts as lose (no tie — client decision 2026-07-05).
    outcome: { type: String, enum: SIGNAL_OUTCOMES, default: null },
    payout: { type: Schema.Types.Decimal128, default: null }, // PLATFORM_CURRENCY units, set on settlement
    status: { type: String, enum: SIGNAL_POSITION_STATUS, default: 'open' },
    settlesAt: { type: Date, required: true }, // enteredAt + signal durationSeconds
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
