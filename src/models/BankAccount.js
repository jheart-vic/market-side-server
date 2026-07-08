import mongoose from 'mongoose';

const { Schema } = mongoose;

// A user's saved Nigerian bank account for withdrawals. Users may save several
// and mark one as the default; withdrawals resolve either an explicit account
// or the default. `bankCode` is the EXACT gateway payout code (from
// config/ngBanks.js) so a saved account is directly usable for a payout;
// `bankName` is the display label snapshotted at bind time. `isVerified` is
// reserved for future gateway account-name resolution (not populated yet).
const bankAccountSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    bankCode: { type: String, required: true, trim: true }, // gateway bnkCode (NG_BANK_CODES)
    bankName: { type: String, required: true, trim: true }, // display label
    accountName: { type: String, required: true, trim: true },
    accountNumber: { type: String, required: true, trim: true }, // NUBAN
    isDefault: { type: Boolean, default: false },
    isVerified: { type: Boolean, default: false },
  },
  { timestamps: true },
);

// One row per (user, bank, account number) — re-binding the same account is a dup
bankAccountSchema.index({ user: 1, bankCode: 1, accountNumber: 1 }, { unique: true });
bankAccountSchema.index({ user: 1, isDefault: -1, createdAt: -1 });

export const BankAccount = mongoose.model('BankAccount', bankAccountSchema);
