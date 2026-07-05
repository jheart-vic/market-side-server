import mongoose from 'mongoose';
import { WALLET_CURRENCIES, LEDGER_DIRECTIONS, LEDGER_TYPES } from '../config/constants.js';

const { Schema } = mongoose;

// Immutable double-entry ledger. Every balance change is recorded here; wallet
// balances are derived/reconciled from these rows. Entries belonging to one
// operation (e.g. a trade's debit + credit) share a groupId.
const ledgerEntrySchema = new Schema(
  {
    groupId: { type: Schema.Types.ObjectId, required: true, index: true },
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    currency: { type: String, enum: WALLET_CURRENCIES, required: true },
    direction: { type: String, enum: LEDGER_DIRECTIONS, required: true },
    // Always positive, integer smallest units as Decimal128
    amount: { type: Schema.Types.Decimal128, required: true },
    type: { type: String, enum: LEDGER_TYPES, required: true },
    // Wallet balance after applying this entry — makes statements and reconciliation cheap
    balanceAfter: { type: Schema.Types.Decimal128, required: true },
    // What caused this entry (Deposit, Withdrawal, Trade, SignalPosition, Referral, ...)
    ref: {
      kind: { type: String },
      item: { type: Schema.Types.ObjectId, refPath: 'ref.kind' },
    },
    narration: { type: String },
    // Set when an admin performed the operation (admin_adjustment etc.)
    performedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

ledgerEntrySchema.index({ user: 1, createdAt: -1 });
ledgerEntrySchema.index({ user: 1, currency: 1, createdAt: -1 });
ledgerEntrySchema.index({ type: 1, createdAt: -1 });

// Enforce immutability: entries can be created, never modified or deleted.
ledgerEntrySchema.pre('save', function blockUpdates(next) {
  if (!this.isNew) return next(new Error('LedgerEntry is immutable'));
  return next();
});
for (const op of [
  'updateOne',
  'updateMany',
  'findOneAndUpdate',
  'findOneAndReplace',
  'replaceOne',
  'deleteOne',
  'deleteMany',
  'findOneAndDelete',
]) {
  ledgerEntrySchema.pre(op, function blockMutation(next) {
    next(new Error('LedgerEntry is immutable'));
  });
}

export const LedgerEntry = mongoose.model('LedgerEntry', ledgerEntrySchema);
