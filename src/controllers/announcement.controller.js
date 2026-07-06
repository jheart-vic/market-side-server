import * as announcementService from '../services/announcement.service.js';
import { asyncHandler } from '../utils/asyncHandler.js';

/** Public latest-first list for the homepage + announcements screen. */
export const listPublished = asyncHandler(async (req, res) => {
  const result = await announcementService.listPublished(req.validated.query);
  res.json({ success: true, ...result });
});
