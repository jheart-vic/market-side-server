import * as spinService from '../services/spin.service.js';
import { asyncHandler } from '../utils/asyncHandler.js';

/** Wheel config (9 prizes, wheel order) + the caller's remaining spin credits. */
export const getWheel = asyncHandler(async (req, res) => {
  res.json({ success: true, wheel: await spinService.getWheel(req.user) });
});

/** Play one spin — responds with the segment index the frontend animates to. */
export const spin = asyncHandler(async (req, res) => {
  const result = await spinService.spin(req.user);
  res.json({ success: true, ...result });
});

export const history = asyncHandler(async (req, res) => {
  const result = await spinService.getHistory(req.user._id, req.validated.query);
  res.json({ success: true, ...result });
});
