import * as priceService from '../services/price.service.js';
import { asyncHandler } from '../utils/asyncHandler.js';

// Quotes are per asset, dollar-first ({ asset, priceUsd, priceNgn, ... });
// USDT's priceNgn is the deposit/withdrawal conversion rate.

export const getPrices = asyncHandler(async (req, res) => {
  res.json({ success: true, prices: await priceService.getPrices() });
});

export const getPrice = asyncHandler(async (req, res) => {
  res.json({ success: true, price: await priceService.getPrice(req.validated.params.asset) });
});

export const getOhlc = asyncHandler(async (req, res) => {
  const { asset } = req.validated.params;
  const { days } = req.validated.query;
  res.json({ success: true, ohlc: await priceService.getOhlc(asset, { days }) });
});

export const getDepth = asyncHandler(async (req, res) => {
  res.json({ success: true, depth: await priceService.getDepth(req.validated.params.asset) });
});
