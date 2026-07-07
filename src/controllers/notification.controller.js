import * as notificationService from '../services/notification.service.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const list = asyncHandler(async (req, res) => {
  const { unreadOnly, ...query } = req.validated.query;
  const result = await notificationService.list(req.user._id, {
    unreadOnly: unreadOnly === 'true',
    ...query,
  });
  res.json({ success: true, ...result });
});

export const markRead = asyncHandler(async (req, res) => {
  await notificationService.markRead(req.user._id, req.validated.params.id);
  res.json({ success: true });
});

export const markAllRead = asyncHandler(async (req, res) => {
  const result = await notificationService.markAllRead(req.user._id);
  res.json({ success: true, ...result });
});
