import mongoose from 'mongoose';

const { Schema } = mongoose;

// One refresh-token session per device/login. Tokens are stored hashed
// (utils/tokens.sha256); rotation replaces the hash and links the chain so
// reuse of a rotated token can be detected and the session revoked.
const sessionSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    refreshTokenHash: { type: String, required: true, unique: true },
    previousTokenHash: { type: String, default: null }, // reuse detection after rotation
    ip: String,
    userAgent: String,
    lastUsedAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

sessionSchema.index({ user: 1 });
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const Session = mongoose.model('Session', sessionSchema);
