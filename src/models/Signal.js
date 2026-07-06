import mongoose from 'mongoose';
import { SIGNAL_PAIRS, SIGNAL_DIRECTIONS, SIGNAL_STATUS } from '../config/constants.js';

const { Schema } = mongoose;

// Admin-published "contract order" signal (binary-options mechanic): a
// directional tip (CALL/PUT) with a fixed return %, NOT a guaranteed payout —
// positions win or lose on actual price movement. Released daily within the
// 3:00–5:00 pm Africa/Lagos window by a scheduled job; contracts may only be
// placed inside the signal's own trading window.
const signalSchema = new Schema(
  {
    pair: { type: String, enum: SIGNAL_PAIRS, required: true }, // quoted vs NGN (e.g. BCH/NGN)
    direction: { type: String, enum: SIGNAL_DIRECTIONS, required: true }, // call = up, put = down
    returnPct: { type: Number, required: true, min: 0 }, // fixed return % paid on a win
    // Stakes are in PLATFORM_CURRENCY smallest units (micro-USDT — dollar platform)
    minStake: { type: Schema.Types.Decimal128, required: true },
    maxStake: { type: Schema.Types.Decimal128, required: true },
    durationSeconds: { type: Number, required: true, min: 10 }, // contract length (e.g. 60)
    // Window during which users may place contracts, Lagos wall-clock "HH:mm"
    tradingStart: { type: String, required: true }, // e.g. "18:00"
    tradingEnd: { type: String, required: true }, // e.g. "20:00"
    // Lagos calendar day this signal belongs to, "YYYY-MM-DD" (utils/time.lagosDayKey)
    releaseDay: { type: String, required: true },
    releasedAt: Date, // set by the release job when it goes live
    status: { type: String, enum: SIGNAL_STATUS, default: 'scheduled' },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    settledAt: Date, // set when every position on this signal has settled
  },
  { timestamps: true },
);

signalSchema.index({ releaseDay: 1, status: 1 });
signalSchema.index({ status: 1, releasedAt: -1 });

export const Signal = mongoose.model('Signal', signalSchema);
