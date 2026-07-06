import * as signalService from '../services/signal.service.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const listActive = asyncHandler(async (req, res) => {
  res.json({ success: true, signals: await signalService.listActive() });
});

export const placeOrder = asyncHandler(async (req, res) => {
  const position = await signalService.placeOrder(req.user, req.validated.params.id, req.validated.body);
  res.status(201).json({ success: true, position });
});

export const myPositions = asyncHandler(async (req, res) => {
  const result = await signalService.getPositions(req.user._id, req.validated.query);
  res.json({ success: true, ...result });
});
