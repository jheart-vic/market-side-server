import mongoose from 'mongoose';
import { TRADE_PAIRS, SIGNAL_DIRECTIONS, SIGNAL_STATUS } from '../config/constants.js';

const { Schema } = mongoose;

// Admin-published fixed-return "contract order" signal, released daily within
// the 3:00–5:00 pm Africa/Lagos window by a scheduled job.
const signalSchema = new Schema(
  {
    pair: { type: String, enum: TRADE_PAIRS, required: true },
    direction: { type: String, enum: SIGNAL_DIRECTIONS, required: true },
    returnPct: { type: Number, required: true, min: 0 }, // fixed return, percent
    minStake: { type: Schema.Types.Decimal128, required: true }, // kobo
    maxStake: { type: Schema.Types.Decimal128, required: true }, // kobo
    durationMinutes: { type: Number, required: true, min: 1 },
    // Lagos calendar day this signal belongs to, "YYYY-MM-DD" (utils/time.lagosDayKey)
    releaseDay: { type: String, required: true },
    releasedAt: Date, // set by the release job when it goes live
    status: { type: String, enum: SIGNAL_STATUS, default: 'scheduled' },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    settledAt: Date,
  },
  { timestamps: true },
);

signalSchema.index({ releaseDay: 1, status: 1 });
signalSchema.index({ status: 1, releasedAt: -1 });

export const Signal = mongoose.model('Signal', signalSchema);
