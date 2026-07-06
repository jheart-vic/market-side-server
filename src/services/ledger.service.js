// LedgerService (SPEC §2.2) — THE ONLY PLACE wallet balances change.
// Writes immutable double-entry LedgerEntry rows (shared groupId) and the
// matching Wallet.balance/held updates inside a MongoDB transaction. All
// amounts are positive BigInt smallest units via utils/money.js. Every other
// service (deposits, withdrawals, trades, signals, referrals, admin) calls this.

import mongoose from 'mongoose';
import { LedgerEntry } from '../models/LedgerEntry.js';
import { Wallet } from '../models/Wallet.js';
import { ApiError } from '../utils/ApiError.js';
import { parsePagination, paginationMeta } from '../utils/pagination.js';
import {
  bigIntToDecimal128,
  decimal128ToBigInt,
  fromSmallestUnits,
} from '../utils/money.js';

// How each (type, direction) pair moves wallet funds: `balance` is the
// spendable column, `held` the escrow column; +1 adds the entry amount,
// -1 removes it. Reconciliation replays this exact table, so it is the single
// source of truth for what a ledger row *means*.
const EFFECTS = {
  'deposit:credit': { balance: 1n, held: 0n },
  'withdrawal:debit': { balance: 0n, held: -1n }, // payout of escrowed funds
  'withdrawal_hold:debit': { balance: -1n, held: 1n },
  'withdrawal_release:credit': { balance: 1n, held: -1n },
  'trade:credit': { balance: 1n, held: 0n },
  'trade:debit': { balance: -1n, held: 0n },
  'conversion:credit': { balance: 1n, held: 0n },
  'conversion:debit': { balance: -1n, held: 0n },
  'fee:debit': { balance: -1n, held: 0n },
  'signal_stake:debit': { balance: -1n, held: 1n },
  'signal_stake:credit': { balance: 1n, held: -1n }, // cancelled signal refunds the stake
  'signal_settlement:debit': { balance: 0n, held: -1n }, // consume the stake hold
  'signal_settlement:credit': { balance: 1n, held: 0n }, // stake + fixed return
  'referral_commission:credit': { balance: 1n, held: 0n },
  'admin_adjustment:credit': { balance: 1n, held: 0n },
  'admin_adjustment:debit': { balance: -1n, held: 0n },
};

function effectFor(type, direction) {
  const effect = EFFECTS[`${type}:${direction}`];
  if (!effect) throw new Error(`No ledger effect defined for ${type}/${direction}`);
  return effect;
}

function positiveBigInt(amount) {
  const value = BigInt(amount);
  if (value <= 0n) throw ApiError.badRequest('Amount must be positive', 'INVALID_AMOUNT');
  return value;
}

/**
 * Core write path: apply one operation as N entries sharing a groupId, plus the
 * matching wallet updates, atomically. Every public mutation below funnels here.
 * Entries: { user, currency, direction, amount(BigInt), type, ref?, narration?, performedBy? }.
 * Pass `session` to compose with an outer transaction (caller commits/aborts).
 */
export async function post(entries, { session: outerSession } = {}) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('Ledger operation needs at least one entry');
  }
  const groupId = new mongoose.Types.ObjectId();

  const run = async (session) => {
    for (const entry of entries) {
      const amount = positiveBigInt(entry.amount);
      const effect = effectFor(entry.type, entry.direction);

      const wallet = await Wallet.findOne({
        user: entry.user,
        currency: entry.currency,
      }).session(session);
      if (!wallet) throw ApiError.notFound(`No ${entry.currency} wallet`, 'WALLET_NOT_FOUND');

      const balance = decimal128ToBigInt(wallet.balance) + effect.balance * amount;
      const held = decimal128ToBigInt(wallet.held) + effect.held * amount;
      if (balance < 0n) throw ApiError.badRequest('Insufficient funds', 'INSUFFICIENT_FUNDS');
      if (held < 0n) throw ApiError.badRequest('Insufficient held funds', 'INSUFFICIENT_HELD');

      wallet.balance = bigIntToDecimal128(balance);
      wallet.held = bigIntToDecimal128(held);
      await wallet.save({ session });

      await LedgerEntry.create(
        [
          {
            groupId,
            user: entry.user,
            currency: entry.currency,
            direction: entry.direction,
            amount: bigIntToDecimal128(amount),
            type: entry.type,
            balanceAfter: wallet.balance,
            ref: entry.ref,
            narration: entry.narration,
            performedBy: entry.performedBy,
          },
        ],
        { session },
      );
    }
    return { groupId };
  };

  if (outerSession) return run(outerSession);

  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await run(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export function credit({ user, currency, amount, type, ref, narration, performedBy, session }) {
  return post([{ user, currency, direction: 'credit', amount, type, ref, narration, performedBy }], { session });
}

export function debit({ user, currency, amount, type, ref, narration, performedBy, session }) {
  return post([{ user, currency, direction: 'debit', amount, type, ref, narration, performedBy }], { session });
}

/** balance → held (pending withdrawal, signal stake). */
export function hold({ user, currency, amount, type = 'withdrawal_hold', ref, narration, session }) {
  return post([{ user, currency, direction: 'debit', amount, type, ref, narration }], { session });
}

/** held → balance (rejected withdrawal, cancelled signal — pass type 'signal_stake' + direction handled here). */
export function releaseHold({ user, currency, amount, type = 'withdrawal_release', ref, narration, performedBy, session }) {
  return post([{ user, currency, direction: 'credit', amount, type, ref, narration, performedBy }], { session });
}

/** held → out of the platform (paid withdrawal) or consumed (settled signal stake). */
export function settleHold({ user, currency, amount, type = 'withdrawal', ref, narration, performedBy, session }) {
  return post([{ user, currency, direction: 'debit', amount, type, ref, narration, performedBy }], { session });
}

/**
 * NGN↔crypto conversion: debit `from`, credit `to`, optional fee — one group,
 * one transaction. from/to: { currency, amount }; fee: { currency?, amount }.
 */
export function convert({ user, from, to, fee, ref, narration, session }) {
  const entries = [
    { user, currency: from.currency, direction: 'debit', amount: from.amount, type: 'conversion', ref, narration },
    { user, currency: to.currency, direction: 'credit', amount: to.amount, type: 'conversion', ref, narration },
  ];
  if (fee?.amount) {
    entries.push({
      user,
      currency: fee.currency ?? from.currency,
      direction: 'debit',
      amount: fee.amount,
      type: 'fee',
      ref,
      narration: 'Conversion fee',
    });
  }
  return post(entries, { session });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Transaction history with type/currency/date filters, display amounts. */
export async function getHistory(userId, { type, currency, from, to, ...query } = {}) {
  const filter = { user: userId };
  if (type) filter.type = type;
  if (currency) filter.currency = currency;
  if (from || to) {
    filter.createdAt = {
      ...(from && { $gte: new Date(from) }),
      ...(to && { $lte: new Date(to) }),
    };
  }

  const { page, limit, skip } = parsePagination(query);
  const [rows, total] = await Promise.all([
    LedgerEntry.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    LedgerEntry.countDocuments(filter),
  ]);

  const items = rows.map((e) => ({
    id: e.id,
    groupId: e.groupId,
    currency: e.currency,
    direction: e.direction,
    type: e.type,
    amount: fromSmallestUnits(decimal128ToBigInt(e.amount), e.currency),
    balanceAfter: fromSmallestUnits(decimal128ToBigInt(e.balanceAfter), e.currency),
    narration: e.narration,
    ref: e.ref,
    createdAt: e.createdAt,
  }));
  return { items, meta: paginationMeta(total, page, limit) };
}

/**
 * Replay the ledger and compare with wallet columns (job / admin tool).
 * Returns mismatches as display strings; pass fix:true to overwrite wallets
 * with the recomputed values.
 */
export async function reconcile(userId, { fix = false } = {}) {
  const wallets = await Wallet.find(userId ? { user: userId } : {});
  const mismatches = [];

  for (const wallet of wallets) {
    let balance = 0n;
    let held = 0n;
    const cursor = LedgerEntry.find({ user: wallet.user, currency: wallet.currency })
      .sort({ createdAt: 1 })
      .cursor();
    for await (const entry of cursor) {
      const effect = effectFor(entry.type, entry.direction);
      const amount = decimal128ToBigInt(entry.amount);
      balance += effect.balance * amount;
      held += effect.held * amount;
    }

    const actualBalance = decimal128ToBigInt(wallet.balance);
    const actualHeld = decimal128ToBigInt(wallet.held);
    if (balance !== actualBalance || held !== actualHeld) {
      mismatches.push({
        user: String(wallet.user),
        currency: wallet.currency,
        expectedBalance: fromSmallestUnits(balance, wallet.currency),
        actualBalance: fromSmallestUnits(actualBalance, wallet.currency),
        expectedHeld: fromSmallestUnits(held, wallet.currency),
        actualHeld: fromSmallestUnits(actualHeld, wallet.currency),
      });
      if (fix) {
        wallet.balance = bigIntToDecimal128(balance);
        wallet.held = bigIntToDecimal128(held);
        await wallet.save();
      }
    }
  }
  return { checked: wallets.length, mismatches, fixed: fix };
}
