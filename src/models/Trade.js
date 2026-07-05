import mongoose from 'mongoose';
import { TRADE_PAIRS, TRADE_SIDES, TRADE_STATUS } from '../config/constants.js';

const { Schema } = mongoose;

// Spot buy/sell against the internal ledger, filled instantly at the cached price.
const tradeSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    pair: { type: String, enum: TRADE_PAIRS, required: true }, // e.g. "BTC/NGN"
    side: { type: String, enum: TRADE_SIDES, required: true },
    // Asset amount in the asset's smallest units; NGN leg in kobo
    baseAmount: { type: Schema.Types.Decimal128, required: true },
    quoteAmount: { type: Schema.Types.Decimal128, required: true },
    // Executed price: kobo per whole unit of the base asset (display/history only —
    // the authoritative amounts are the two legs above)
    price: { type: Schema.Types.Decimal128, required: true },
    fee: { type: Schema.Types.Decimal128, default: () => mongoose.Types.Decimal128.fromString('0') }, // kobo
    status: { type: String, enum: TRADE_STATUS, default: 'filled' },
    executedAt: { type: Date, default: Date.now },
    // Realized P/L in kobo for sells (FIFO against prior buys); null for buys
    realizedPnl: { type: Schema.Types.Decimal128, default: null },
    ledgerGroupId: { type: Schema.Types.ObjectId },
  },
  { timestamps: true },
);

tradeSchema.index({ user: 1, createdAt: -1 });
tradeSchema.index({ user: 1, pair: 1, createdAt: -1 });

export const Trade = mongoose.model('Trade', tradeSchema);
