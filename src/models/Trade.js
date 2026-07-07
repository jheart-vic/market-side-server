import mongoose from 'mongoose';
import { TRADE_PAIRS, TRADE_SIDES, TRADE_STATUS } from '../config/constants.js';

const { Schema } = mongoose;

// Spot buy/sell against the internal ledger, filled instantly at the cached
// price. Quote side is the platform dollar (micro-USDT).
const tradeSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    pair: { type: String, enum: TRADE_PAIRS, required: true }, // e.g. "BTC/USDT"
    side: { type: String, enum: TRADE_SIDES, required: true },
    // Asset amount in the asset's smallest units; dollar leg in micro-USDT
    baseAmount: { type: Schema.Types.Decimal128, required: true },
    quoteAmount: { type: Schema.Types.Decimal128, required: true },
    // Executed price: micro-USDT per whole unit of the base asset (display/history
    // only — the authoritative amounts are the two legs above)
    price: { type: Schema.Types.Decimal128, required: true },
    fee: { type: Schema.Types.Decimal128, default: () => mongoose.Types.Decimal128.fromString('0') }, // micro-USDT
    status: { type: String, enum: TRADE_STATUS, default: 'filled' },
    executedAt: { type: Date, default: Date.now },
    // FIFO cost-basis tracking: on buys, the base units not yet consumed by later
    // sells; sells decrement the oldest open buys first
    remainingBase: { type: Schema.Types.Decimal128, default: null },
    // Realized P/L in micro-USDT for sells (net proceeds - FIFO cost); null for buys
    realizedPnl: { type: Schema.Types.Decimal128, default: null },
    ledgerGroupId: { type: Schema.Types.ObjectId },
  },
  { timestamps: true },
);

tradeSchema.index({ user: 1, createdAt: -1 });
tradeSchema.index({ user: 1, pair: 1, createdAt: -1 });

export const Trade = mongoose.model('Trade', tradeSchema);
