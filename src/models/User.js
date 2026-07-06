import mongoose from 'mongoose';
import { ROLES, ACCOUNT_STATUS, KYC_STATUS } from '../config/constants.js';

const { Schema } = mongoose;

const knownDeviceSchema = new Schema(
  {
    ip: String,
    userAgent: String,
    firstSeenAt: { type: Date, default: Date.now },
    lastSeenAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const userSchema = new Schema(
  {
    phone: {
      countryCode: { type: String, required: true }, // "+234"
      nationalNumber: { type: String, required: true },
      e164: { type: String, required: true, unique: true }, // canonical unique key
    },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    // Display handle; unique when set (sparse: accounts created before the field
    // existed have none and can add one via PATCH /users/me)
    username: { type: String, unique: true, sparse: true, lowercase: true, trim: true },
    fullName: { type: String, trim: true },
    passwordHash: { type: String, required: true, select: false },

    // Password reset is captcha + security question (no SMS/email OTP)
    security: {
      question: { type: String, required: true },
      answerHash: { type: String, required: true, select: false },
    },

    // Separate hashed PIN required for withdrawals; null until the user sets it
    withdrawalPinHash: { type: String, default: null, select: false },

    twoFactor: {
      enabled: { type: Boolean, default: false },
      secret: { type: String, default: null, select: false }, // TOTP secret (Google Authenticator)
    },

    role: { type: String, enum: ROLES, default: 'user' },
    status: { type: String, enum: ACCOUNT_STATUS, default: 'active' },

    kyc: {
      status: { type: String, enum: KYC_STATUS, default: 'unverified' },
      documents: [
        {
          kind: String, // KYC_DOC_TYPES or "selfie"
          url: String, // provider URL (private assets need a signed URL to view)
          publicId: String, // Cloudinary public_id — used for signed delivery + deletion
          resourceType: { type: String, enum: ['image', 'raw'], default: 'image' }, // raw = PDF
          uploadedAt: { type: Date, default: Date.now },
        },
      ],
      submittedAt: Date,
      reviewedBy: { type: Schema.Types.ObjectId, ref: 'User' },
      reviewedAt: Date,
      rejectionReason: String,
    },

    referralCode: { type: String, required: true, unique: true },
    referredBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    // Referral ancestors, nearest first: uplines[0] = L1, [1] = L2, [2] = L3.
    // Denormalized at registration so commission payout never walks the tree.
    uplines: [{ type: Schema.Types.ObjectId, ref: 'User' }],

    // Login-alert baseline: alert (in-app + email) when a login doesn't match any known device
    knownDevices: { type: [knownDeviceSchema], default: [], select: false },
    lastLoginAt: Date,
  },
  { timestamps: true },
);

userSchema.index({ referredBy: 1 });
userSchema.index({ uplines: 1 });

export const User = mongoose.model('User', userSchema);
