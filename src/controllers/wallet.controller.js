import * as walletService from '../services/wallet.service.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const getWallets = asyncHandler(async (req, res) => {
  const wallets = await walletService.getWallets(req.user._id);
  res.json({ success: true, wallets });
});

export const getWallet = asyncHandler(async (req, res) => {
  const { currency } = req.validated.params;
  const wallet = await walletService.getWallet(req.user._id, currency);
  res.json({ success: true, wallet });
});
