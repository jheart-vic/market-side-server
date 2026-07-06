import mongoose from 'mongoose';

const { Schema } = mongoose;

// Global per-Lagos-day spin counter — one row per day, bumped atomically
// ($inc upsert) on every spin platform-wide. The count decides who lands the
// bonus prize: every Nth spin of the day wins the second-lowest value.
const spinCounterSchema = new Schema(
  {
    dayKey: { type: String, required: true, unique: true }, // Lagos "YYYY-MM-DD"
    count: { type: Number, default: 0 },
  },
  { timestamps: true },
);

export const SpinCounter = mongoose.model('SpinCounter', spinCounterSchema);
