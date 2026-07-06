// UserService — profile reads/updates, KYC lifecycle, account states.
// KYC: unverified → pending (docs uploaded) → approved / rejected (admin);
// admin freeze/unfreeze (frozen users can log in but not transact — requireActive).

import { User } from '../models/User.js';
import { ACCOUNT_STATUS } from '../config/constants.js';
import { ApiError } from '../utils/ApiError.js';
import { parsePagination, paginationMeta } from '../utils/pagination.js';
import { getSignedUrl } from '../utils/cloudinary.js';
import { toSafeUser } from './auth.service.js';
import * as auditService from './audit.service.js';
import * as notificationService from './notification.service.js';

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function toProfile(user) {
  return {
    ...toSafeUser(user),
    securityQuestionId: user.security?.questionId ?? null,
    securityQuestion: user.security?.question,
    kyc: {
      status: user.kyc?.status,
      // Documents are private Cloudinary assets — expose short-lived signed URLs
      documents: (user.kyc?.documents ?? []).map((d) => ({
        kind: d.kind,
        url: d.publicId ? getSignedUrl(d.publicId, d.resourceType) : d.url,
        uploadedAt: d.uploadedAt,
      })),
      submittedAt: user.kyc?.submittedAt,
      rejectionReason: user.kyc?.rejectionReason,
    },
    lastLoginAt: user.lastLoginAt,
  };
}

async function mustFind(userId) {
  const user = await User.findById(userId);
  if (!user) throw ApiError.notFound('User not found', 'USER_NOT_FOUND');
  return user;
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

export async function getProfile(userId) {
  return toProfile(await mustFind(userId));
}

/** Phone is the identity key and never changes here; email, username, and fullName are editable. */
export async function updateProfile(userId, { email, username, fullName } = {}) {
  const user = await mustFind(userId);
  let dirty = false;

  if (fullName) {
    user.fullName = String(fullName).trim();
    dirty = true;
  }

  if (email) {
    const normalized = String(email).trim().toLowerCase();
    if (normalized !== user.email) {
      const taken = await User.exists({ email: normalized, _id: { $ne: user._id } });
      if (taken) throw ApiError.conflict('Email already in use', 'EMAIL_TAKEN');
      user.email = normalized;
      dirty = true;
    }
  }
  if (username) {
    const normalized = String(username).trim().toLowerCase();
    if (normalized !== user.username) {
      const taken = await User.exists({ username: normalized, _id: { $ne: user._id } });
      if (taken) throw ApiError.conflict('Username already taken', 'USERNAME_TAKEN');
      user.username = normalized;
      dirty = true;
    }
  }

  if (dirty) await user.save();
  return toProfile(user);
}

// ---------------------------------------------------------------------------
// KYC lifecycle
// ---------------------------------------------------------------------------

/**
 * documents: [{ kind, url, publicId?, resourceType? }] — moves
 * unverified/rejected → pending. Returns the documents that were replaced so
 * the caller can delete the orphaned upload provider assets.
 */
export async function submitKyc(userId, documents) {
  const user = await mustFind(userId);
  if (!['unverified', 'rejected'].includes(user.kyc.status)) {
    throw ApiError.conflict('KYC already submitted or approved', 'KYC_ALREADY_SUBMITTED');
  }
  if (!Array.isArray(documents) || documents.length === 0) {
    throw ApiError.badRequest('At least one document is required', 'KYC_DOCUMENTS_REQUIRED');
  }

  const previousDocuments = (user.kyc.documents ?? []).map((d) => ({
    publicId: d.publicId,
    resourceType: d.resourceType,
  }));

  user.kyc = {
    status: 'pending',
    documents: documents.map(({ kind, url, publicId, resourceType }) => ({
      kind,
      url,
      publicId,
      resourceType,
    })),
    submittedAt: new Date(),
  };
  await user.save();

  await notificationService.notifyAdmins({
    type: 'kyc_submitted',
    title: 'New KYC submission',
    body: `${user.email} submitted KYC documents for review.`,
    meta: { user: user.id },
  });
  await auditService.record({
    actor: user,
    action: 'kyc.submit',
    target: { kind: 'User', item: user._id },
    meta: { documents: documents.map((d) => d.kind) },
  });
  return { status: user.kyc.status, submittedAt: user.kyc.submittedAt, previousDocuments };
}

/** decision: 'approved' | 'rejected' (reason required when rejecting). */
export async function reviewKyc(adminUser, userId, decision, reason) {
  if (!['approved', 'rejected'].includes(decision)) {
    throw ApiError.badRequest('Decision must be approved or rejected', 'INVALID_KYC_DECISION');
  }
  if (decision === 'rejected' && !reason) {
    throw ApiError.badRequest('A rejection reason is required', 'REASON_REQUIRED');
  }

  const user = await mustFind(userId);
  if (user.kyc.status !== 'pending') {
    throw ApiError.conflict('No pending KYC submission for this user', 'KYC_NOT_PENDING');
  }

  user.kyc.status = decision;
  user.kyc.reviewedBy = adminUser._id;
  user.kyc.reviewedAt = new Date();
  user.kyc.rejectionReason = decision === 'rejected' ? reason : undefined;
  await user.save();

  await notificationService.notifyUser(user._id, {
    type: 'kyc_status',
    title: `KYC ${decision}`,
    body:
      decision === 'approved'
        ? 'Your identity verification has been approved.'
        : `Your identity verification was rejected: ${reason}`,
    meta: { status: decision, reason },
  });
  await auditService.record({
    actor: adminUser,
    action: `kyc.${decision === 'approved' ? 'approve' : 'reject'}`,
    target: { kind: 'User', item: user._id },
    meta: { reason },
  });
  return { status: user.kyc.status };
}

// ---------------------------------------------------------------------------
// Account states (admin)
// ---------------------------------------------------------------------------

export async function setAccountStatus(adminUser, userId, status, reason) {
  if (!ACCOUNT_STATUS.includes(status)) {
    throw ApiError.badRequest(`Status must be one of: ${ACCOUNT_STATUS.join(', ')}`, 'INVALID_STATUS');
  }

  const user = await mustFind(userId);
  // Only superadmins may freeze/unfreeze staff accounts
  if (user.role !== 'user' && adminUser.role !== 'superadmin') {
    throw ApiError.forbidden('Only a superadmin can change a staff account', 'FORBIDDEN_TARGET');
  }
  if (user.status === status) {
    throw ApiError.conflict(`Account is already ${status}`, 'STATUS_UNCHANGED');
  }

  user.status = status;
  await user.save();

  await auditService.record({
    actor: adminUser,
    action: status === 'frozen' ? 'user.freeze' : 'user.unfreeze',
    target: { kind: 'User', item: user._id },
    meta: { reason },
  });
  return { id: user.id, status: user.status };
}

// ---------------------------------------------------------------------------
// Admin search
// ---------------------------------------------------------------------------

/** q matches email / phone (E.164) / username / referral code; filters are exact. */
export async function searchUsers({ q, status, kycStatus, role, ...query } = {}) {
  const filter = {};
  if (status) filter.status = status;
  if (kycStatus) filter['kyc.status'] = kycStatus;
  if (role) filter.role = role;
  if (q) {
    const rx = new RegExp(escapeRegex(String(q).trim()), 'i');
    filter.$or = [
      { email: rx },
      { 'phone.e164': rx },
      { username: rx },
      { fullName: rx },
      { referralCode: rx },
    ];
  }

  const { page, limit, skip } = parsePagination(query);
  const [users, total] = await Promise.all([
    User.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    User.countDocuments(filter),
  ]);
  return {
    items: users.map((u) => ({ ...toSafeUser(u), lastLoginAt: u.lastLoginAt })),
    meta: paginationMeta(total, page, limit),
  };
}
