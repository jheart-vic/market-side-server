// AnnouncementService (SPEC §2.10) — admin CRUD + user-facing latest-first list.
// Publishing fans out an 'announcement' notification (socket broadcast + one
// Notification row per user, batched) via NotificationService.

import { Announcement } from '../models/Announcement.js';
import { Notification } from '../models/Notification.js';
import { User } from '../models/User.js';
import { logger } from '../config/logger.js';
import { ApiError } from '../utils/ApiError.js';
import { parsePagination, paginationMeta } from '../utils/pagination.js';
import * as notificationService from './notification.service.js';
import * as auditService from './audit.service.js';

async function mustFind(id) {
  const announcement = await Announcement.findById(id).catch(() => null);
  if (!announcement) throw ApiError.notFound('Announcement not found', 'ANNOUNCEMENT_NOT_FOUND');
  return announcement;
}

/**
 * Notification fan-out: one socket broadcast plus a per-user Notification row
 * (inserted in batches). The announcement itself is already saved — fan-out
 * failures are logged, never thrown.
 */
async function fanOut(announcement) {
  notificationService.broadcast('announcement', {
    id: announcement.id,
    title: announcement.title,
    publishedAt: announcement.publishedAt,
  });
  try {
    const cursor = User.find({ role: 'user', status: 'active' }).select('_id').lean().cursor();
    let batch = [];
    for await (const user of cursor) {
      batch.push({
        audience: 'user',
        user: user._id,
        type: 'announcement',
        title: announcement.title,
        body: announcement.body,
        meta: { announcementId: announcement.id },
      });
      if (batch.length >= 500) {
        await Notification.insertMany(batch);
        batch = [];
      }
    }
    if (batch.length) await Notification.insertMany(batch);
  } catch (err) {
    logger.error({ err, announcement: announcement.id }, 'Announcement fan-out failed');
  }
}

// ---------------------------------------------------------------------------
// Admin CRUD
// ---------------------------------------------------------------------------

export async function create(adminUser, { title, body, published = true }) {
  const announcement = await Announcement.create({
    title,
    body,
    published,
    publishedAt: published ? new Date() : null,
    createdBy: adminUser._id,
  });
  await auditService.record({
    actor: adminUser,
    action: 'announcement.create',
    target: { kind: 'Announcement', item: announcement._id },
    meta: { title, published },
  });
  if (published) await fanOut(announcement);
  return announcement;
}

export async function update(adminUser, id, { title, body, published } = {}) {
  const announcement = await mustFind(id);
  const publishingNow = published === true && !announcement.published;

  if (title !== undefined) announcement.title = title;
  if (body !== undefined) announcement.body = body;
  if (published !== undefined) announcement.published = published;
  if (publishingNow) announcement.publishedAt = new Date();
  await announcement.save();

  await auditService.record({
    actor: adminUser,
    action: 'announcement.update',
    target: { kind: 'Announcement', item: announcement._id },
    meta: { title: announcement.title, published: announcement.published },
  });
  if (publishingNow) await fanOut(announcement);
  return announcement;
}

export async function remove(adminUser, id) {
  const announcement = await mustFind(id);
  await announcement.deleteOne();
  await auditService.record({
    actor: adminUser,
    action: 'announcement.delete',
    target: { kind: 'Announcement', item: announcement._id },
    meta: { title: announcement.title },
  });
}

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

/** Homepage + announcements screen: published only, latest first. */
export async function listPublished(query = {}) {
  const filter = { published: true };
  const { page, limit, skip } = parsePagination(query);
  const [items, total] = await Promise.all([
    Announcement.find(filter)
      .sort({ publishedAt: -1 })
      .skip(skip)
      .limit(limit)
      .select('title body publishedAt'),
    Announcement.countDocuments(filter),
  ]);
  return { items, meta: paginationMeta(total, page, limit) };
}

export async function adminList(query = {}) {
  const { page, limit, skip } = parsePagination(query);
  const [items, total] = await Promise.all([
    Announcement.find().sort({ createdAt: -1 }).skip(skip).limit(limit).populate('createdBy', 'email'),
    Announcement.countDocuments(),
  ]);
  return { items, meta: paginationMeta(total, page, limit) };
}
