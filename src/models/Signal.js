import mongoose from 'mongoose';
import { SIGNAL_PAIRS, SIGNAL_DIRECTIONS, SIGNAL_STATUS } from '../config/constants.js';

const { Schema } = mongoose;

// Admin-published "contract order" signal (binary-options mechanic). The admin
// picks the winning side (`direction`, CALL/PUT) which is HIDDEN from users — a
// contract wins iff the user's own pick matches it (admin-decided outcome), and
// pays a fixed return %. Released inside the admin-configured release window
// (settings signal_release_start/end, Lagos): a signal created inside the window
// goes live immediately, and contracts may be placed on a released signal only
// while the clock is still inside that window.
const signalSchema = new Schema(
  {
    pair: { type: String, enum: SIGNAL_PAIRS, required: true }, // quoted vs NGN (e.g. BCH/NGN)
    direction: { type: String, enum: SIGNAL_DIRECTIONS, required: true }, // admin's winning side — hidden from users
    returnPct: { type: Number, required: true, min: 0 }, // fixed return % paid on a win
    // Stakes are in PLATFORM_CURRENCY smallest units (micro-USDT — dollar platform)
    minStake: { type: Schema.Types.Decimal128, required: true },
    maxStake: { type: Schema.Types.Decimal128, required: true },
    durationSeconds: { type: Number, required: true, min: 10 }, // contract length (e.g. 60)
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
