// AuditService (SPEC §2.11/§2.12) — append-only AuditLog writes for all admin
// actions and sensitive user actions, plus the admin-facing filterable feed.
// AuditLog model blocks updates/deletes; anti-fraud flags land here too.

import { AuditLog } from '../models/AuditLog.js';
import { parsePagination, paginationMeta } from '../utils/pagination.js';
import * as notificationService from './notification.service.js';

/**
 * Append an audit row. `actor` must be a user document (or lean object) that
 * carries `role` — pass `actorRole` explicitly when only an id is available.
 */
export async function record({ actor, action, target, meta, ip, userAgent, actorRole }) {
  return AuditLog.create({
    actor: actor?._id ?? actor,
    actorRole: actorRole ?? actor?.role ?? 'user',
    action,
    target,
    meta,
    ip,
    userAgent,
  });
}

/** Admin audit-log screen: filter by actor, action, and date range. */
export async function feed({ actor, action, from, to, ...query } = {}) {
  const filter = {};
  if (actor) filter.actor = actor;
  if (action) filter.action = action;
  if (from || to) {
    filter.createdAt = {
      ...(from && { $gte: new Date(from) }),
      ...(to && { $lte: new Date(to) }),
    };
  }

  const { page, limit, skip } = parsePagination(query);
  const [items, total] = await Promise.all([
    AuditLog.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('actor', 'email phone.e164 role'),
    AuditLog.countDocuments(filter),
  ]);
  return { items, meta: paginationMeta(total, page, limit) };
}

/** Anti-fraud flag: audit row + admin notification. */
export async function flagFraud({ user, reason, meta }) {
  const userId = user?._id ?? user;
  const row = await record({
    actor: user,
    action: 'fraud.flag',
    target: { kind: 'User', item: userId },
    meta: { reason, ...meta },
  });
  await notificationService.notifyAdmins({
    type: 'fraud_flag',
    title: 'Fraud flag raised',
    body: reason,
    meta: { user: String(userId), ...meta },
  });
  return row;
}
