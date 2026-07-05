// NotificationService (SPEC §2.9) — in-app notifications for users and admins.
// Socket.IO push on create comes when the socket gateway is built (bindSocketServer);
// until then rows are just persisted and served over REST.
//
// Still to implement:
//   list(userOrAdmin, { unreadOnly?, pagination })  + unread count
//   markRead(user, notificationId) / markAllRead(user)
//   bindSocketServer(io)   → rooms per user + admin room, emit on create

import { Notification } from '../models/Notification.js';
import { logger } from '../config/logger.js';

export async function notifyUser(userId, { type, title, body, meta }) {
  const notification = await Notification.create({
    audience: 'user',
    user: userId,
    type,
    title,
    body,
    meta,
  });
  // TODO(socket): emit to the user's room once bindSocketServer exists
  return notification;
}

export async function notifyAdmins({ type, title, body, meta }) {
  const notification = await Notification.create({ audience: 'admin', type, title, body, meta });
  // TODO(socket): emit to the admin room once bindSocketServer exists
  logger.info({ type }, 'Admin notification recorded');
  return notification;
}
