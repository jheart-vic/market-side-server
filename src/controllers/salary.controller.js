import * as salaryService from '../services/salary.service.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const getStatus = asyncHandler(async (req, res) => {
  res.json({ success: true, salary: await salaryService.getStatus(req.user._id) });
});

export const getClaims = asyncHandler(async (req, res) => {
  res.json({ success: true, claims: await salaryService.myClaims(req.user._id) });
});

export const claim = asyncHandler(async (req, res) => {
  const { tier } = req.validated.params;
  const { name, phone } = req.validated.body;
  const row = await salaryService.claim(req.user, tier, { name, phone });
  res.status(201).json({ success: true, claim: { id: row.id, tier: row.tier, status: row.status } });
});

// --- admin ---
export const adminList = asyncHandler(async (req, res) => {
  res.json({ success: true, ...(await salaryService.adminList(req.validated.query)) });
});

export const adminReview = asyncHandler(async (req, res) => {
  const { id } = req.validated.params;
  const { decision, note } = req.validated.body;
  const claim = await salaryService.review(req.user, id, decision, note);
  res.json({ success: true, claim: { id: claim.id, status: claim.status } });
});
