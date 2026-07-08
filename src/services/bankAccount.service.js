// BankAccountService — a user's saved withdrawal bank accounts. Banks are
// restricted to config/ngBanks.js (the gateway payout table) so every saved
// account carries the exact `bankCode` a payout needs. Exactly one account per
// user is the default; the newest bound account becomes the default, and
// removing the default promotes the most recent remaining one.

import { BankAccount } from '../models/BankAccount.js';
import { NG_BANKS } from '../config/ngBanks.js';
import { ApiError } from '../utils/ApiError.js';

const bankByCode = new Map(NG_BANKS.map((b) => [b.code, b]));

function toDisplay(account) {
  return {
    id: account.id,
    bankCode: account.bankCode,
    bankName: account.bankName,
    accountName: account.accountName,
    accountNumber: account.accountNumber,
    isDefault: account.isDefault,
    isVerified: account.isVerified,
    createdAt: account.createdAt,
  };
}

/** Supported banks for the picker — { code, name } straight from ngBanks. */
export function listBanks() {
  return NG_BANKS;
}

/** Default first, then newest. */
export async function list(userId) {
  const accounts = await BankAccount.find({ user: userId }).sort({ isDefault: -1, createdAt: -1 });
  return accounts.map(toDisplay);
}

/** Bind a new account. The newest account always becomes the default. */
export async function bind(userId, { bankCode, accountName, accountNumber }) {
  const bank = bankByCode.get(bankCode);
  if (!bank) throw ApiError.badRequest('Unsupported bank — pick one from the list', 'UNSUPPORTED_BANK');

  let account;
  try {
    account = await BankAccount.create({
      user: userId,
      bankCode: bank.code,
      bankName: bank.name,
      accountName: String(accountName).trim(),
      accountNumber: String(accountNumber).trim(),
      isDefault: false, // set below, after clearing the previous default
    });
  } catch (err) {
    if (err?.code === 11000) {
      throw ApiError.conflict('That account is already saved', 'BANK_ACCOUNT_EXISTS');
    }
    throw err;
  }

  // Newest becomes the default (clear any previous default first)
  await BankAccount.updateMany(
    { user: userId, _id: { $ne: account._id } },
    { $set: { isDefault: false } },
  );
  account.isDefault = true;
  await account.save();

  return toDisplay(account);
}

/** Make one of the user's accounts the default (unset the others). */
export async function setDefault(userId, id) {
  const account = await BankAccount.findOne({ _id: id, user: userId }).catch(() => null);
  if (!account) throw ApiError.notFound('Bank account not found', 'BANK_ACCOUNT_NOT_FOUND');

  await BankAccount.updateMany(
    { user: userId, _id: { $ne: account._id } },
    { $set: { isDefault: false } },
  );
  account.isDefault = true;
  await account.save();
  return toDisplay(account);
}

/** Remove an account; if it was the default, promote the newest remaining. */
export async function remove(userId, id) {
  const account = await BankAccount.findOne({ _id: id, user: userId }).catch(() => null);
  if (!account) throw ApiError.notFound('Bank account not found', 'BANK_ACCOUNT_NOT_FOUND');

  const wasDefault = account.isDefault;
  await account.deleteOne();

  if (wasDefault) {
    const next = await BankAccount.findOne({ user: userId }).sort({ createdAt: -1 });
    if (next) {
      next.isDefault = true;
      await next.save();
    }
  }
  return { deletedId: id };
}

/**
 * Resolve the bank to pay a withdrawal to: an explicit saved account by id, or
 * the user's default when none is given. Returns the gateway-ready bank detail.
 * Throws if the id isn't the user's, or the user has saved no accounts.
 */
export async function resolveForWithdrawal(userId, bankAccountId) {
  const query = bankAccountId
    ? { _id: bankAccountId, user: userId }
    : { user: userId, isDefault: true };
  const account = await BankAccount.findOne(query).catch(() => null);
  if (!account) {
    throw bankAccountId
      ? ApiError.notFound('Bank account not found', 'BANK_ACCOUNT_NOT_FOUND')
      : ApiError.badRequest('Add a withdrawal bank account first', 'NO_BANK_ACCOUNT');
  }
  return {
    bankCode: account.bankCode,
    bankName: account.bankName,
    accountNumber: account.accountNumber,
    accountName: account.accountName,
  };
}
