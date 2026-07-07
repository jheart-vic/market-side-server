import mongoose from 'mongoose';

const { Schema } = mongoose;

// One Spin & Win play. The wheel shows 9 admin-configured prizes but the
// outcome is decided server-side: every spin wins the lowest-value prize
// except each Nth spin platform-wide per Lagos day (default 5th), which wins
// the second lowest. `sequence` is that global daily counter position; the
// prize is paid via a `spin_reward` ledger credit.
const spinSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    dayKey: { type: String, required: true }, // Lagos "YYYY-MM-DD" the spin happened
    sequence: { type: Number, required: true }, // position in that day's global counter
    bonus: { type: Boolean, default: false }, // true = Nth spin, won the second lowest
    // Which wheel segment the prize sits on (index into the configured prize
    // list at spin time) — the frontend animates the wheel to this segment
    prizeIndex: { type: Number, required: true },
    amount: { type: Schema.Types.Decimal128, required: true }, // micro-USDT won
    ledgerGroupId: { type: Schema.Types.ObjectId },
  },
  { timestamps: true },
);

spinSchema.index({ user: 1, createdAt: -1 });
spinSchema.index({ dayKey: 1, sequence: 1 });

export const Spin = mongoose.model('Spin', spinSchema);
