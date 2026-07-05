import mongoose from 'mongoose';
import { WALLET_CURRENCIES } from '../config/constants.js';

const { Schema } = mongoose;

// Balances are integer smallest units (kobo / micro-USDT / satoshi / wei) stored
// as Decimal128 — see utils/money.js. They are only ever mutated together with a
// ledger entry (LedgerService), never directly from a controller.
const walletSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    currency: { type: String, enum: WALLET_CURRENCIES, required: true },
    balance: { type: Schema.Types.Decimal128, default: () => mongoose.Types.Decimal128.fromString('0') },
    // Funds escrowed for pending withdrawals / open signal stakes
    held: { type: Schema.Types.Decimal128, default: () => mongoose.Types.Decimal128.fromString('0') },
  },
  { timestamps: true },
);

walletSchema.index({ user: 1, currency: 1 }, { unique: true });

export const Wallet = mongoose.model('Wallet', walletSchema);
