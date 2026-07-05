// WalletService — wallet lifecycle and balance reads (writes go through LedgerService).

import { Wallet } from '../models/Wallet.js';
import { WALLET_CURRENCIES } from '../config/constants.js';
import { ApiError } from '../utils/ApiError.js';
import { fromSmallestUnits, decimal128ToBigInt } from '../utils/money.js';

/** Create the 4 wallets (NGN/USDT/BTC/ETH) at registration. Safe to re-run: dup-key rows are skipped. */
export async function createWalletsForUser(userId) {
  try {
    await Wallet.insertMany(
      WALLET_CURRENCIES.map((currency) => ({ user: userId, currency })),
      { ordered: false },
    );
  } catch (err) {
    if (err?.code !== 11000) throw err; // partial re-run: existing wallets are fine
  }
  return Wallet.find({ user: userId });
}

function toDisplay(wallet) {
  return {
    id: wallet.id,
    currency: wallet.currency,
    balance: fromSmallestUnits(decimal128ToBigInt(wallet.balance), wallet.currency),
    held: fromSmallestUnits(decimal128ToBigInt(wallet.held), wallet.currency),
  };
}

export async function getWallets(userId) {
  const wallets = await Wallet.find({ user: userId }).sort({ currency: 1 });
  return wallets.map(toDisplay);
}

export async function getWallet(userId, currency) {
  const wallet = await Wallet.findOne({ user: userId, currency });
  if (!wallet) throw ApiError.notFound(`No ${currency} wallet`, 'WALLET_NOT_FOUND');
  return toDisplay(wallet);
}
