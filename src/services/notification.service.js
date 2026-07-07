// NotificationService (SPEC §2.9) — in-app notifications for users and admins.
// Rows are always persisted; when a Socket.IO server has been bound
// (bindSocketServer, called by the socket gateway at boot), creates are also
// pushed to the user's room / the admin room in real time.

import { Notification } from '../models/Notification.js';
import { logger } from '../config/logger.js';
import { ApiError } from '../utils/ApiError.js';
import { parsePagination, paginationMeta } from '../utils/pagination.js';

export const ADMIN_ROOM = 'admins';
export const userRoom = (userId) => `user:${userId}`;

let io = null;

/** Called once by the socket gateway; until then creates are persist-only. */
export function bindSocketServer(socketServer) {
  io = socketServer;
}

/** Fire-and-forget broadcast to every connected client (e.g. announcements). */
export function broadcast(event, payload) {
  io?.emit(event, payload);
}

function emitTo(room, notification) {
  io?.to(room).emit('notification', {
    id: notification.id,
    type: notification.type,
    title: notification.title,
    body: notification.body,
    meta: notification.meta,
    createdAt: notification.createdAt,
  });
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export async function notifyUser(userId, { type, title, body, meta }) {
  const notification = await Notification.create({
    audience: 'user',
    user: userId,
    type,
    title,
    body,
    meta,
  });
  emitTo(userRoom(userId), notification);
  return notification;
}

export async function notifyAdmins({ type, title, body, meta }) {
  const notification = await Notification.create({ audience: 'admin', type, title, body, meta });
  emitTo(ADMIN_ROOM, notification);
  logger.info({ type }, 'Admin notification recorded');
  return notification;
}

// ---------------------------------------------------------------------------
// Read / mark read
// ---------------------------------------------------------------------------

export async function list(userId, { unreadOnly, ...query } = {}) {
  const filter = { audience: 'user', user: userId };
  if (unreadOnly) filter.read = false;

  const { page, limit, skip } = parsePagination(query);
  const [items, total, unreadCount] = await Promise.all([
    Notification.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Notification.countDocuments(filter),
    Notification.countDocuments({ audience: 'user', user: userId, read: false }),
  ]);
  return { items, unreadCount, meta: paginationMeta(total, page, limit) };
}

/** Shared admin feed (audience:"admin" rows have no user). */
export async function adminList({ unreadOnly, ...query } = {}) {
  const filter = { audience: 'admin' };
  if (unreadOnly) filter.read = false;

  const { page, limit, skip } = parsePagination(query);
  const [items, total, unreadCount] = await Promise.all([
    Notification.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Notification.countDocuments(filter),
    Notification.countDocuments({ audience: 'admin', read: false }),
  ]);
  return { items, unreadCount, meta: paginationMeta(total, page, limit) };
}

export async function markRead(userId, notificationId) {
  const notification = await Notification.findOneAndUpdate(
    { _id: notificationId, audience: 'user', user: userId },
    { $set: { read: true, readAt: new Date() } },
    { new: true },
  ).catch(() => null);
  if (!notification) throw ApiError.notFound('Notification not found', 'NOTIFICATION_NOT_FOUND');
  return notification;
}

export async function markAllRead(userId) {
  const { modifiedCount } = await Notification.updateMany(
    { audience: 'user', user: userId, read: false },
    { $set: { read: true, readAt: new Date() } },
  );
  return { marked: modifiedCount };
}
