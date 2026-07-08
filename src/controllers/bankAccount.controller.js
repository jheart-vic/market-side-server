import * as bankAccountService from '../services/bankAccount.service.js';
import { asyncHandler } from '../utils/asyncHandler.js';

/** Supported banks for the picker. */
export const listBanks = asyncHandler(async (req, res) => {
  res.json({ success: true, banks: bankAccountService.listBanks() });
});

/** The caller's saved accounts (default first). */
export const getAccounts = asyncHandler(async (req, res) => {
  res.json({ success: true, accounts: await bankAccountService.list(req.user._id) });
});

/** Bind a new account (becomes the default). */
export const bind = asyncHandler(async (req, res) => {
  const account = await bankAccountService.bind(req.user._id, req.validated.body);
  res.status(201).json({ success: true, account });
});

/** Switch which saved account is the default. */
export const setDefault = asyncHandler(async (req, res) => {
  const account = await bankAccountService.setDefault(req.user._id, req.validated.params.id);
  res.json({ success: true, account });
});

/** Remove a saved account. */
export const remove = asyncHandler(async (req, res) => {
  const result = await bankAccountService.remove(req.user._id, req.validated.params.id);
  res.json({ success: true, ...result });
});
