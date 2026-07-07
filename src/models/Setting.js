import mongoose from 'mongoose';

const { Schema } = mongoose;

// Small key/value store for runtime-configurable platform settings
// (e.g. referral commission rates). Read through service-level caches;
// writes are admin-only and audit-logged by the calling service.
const settingSchema = new Schema(
  {
    key: { type: String, required: true, unique: true },
    value: { type: Schema.Types.Mixed, required: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

export const Setting = mongoose.model('Setting', settingSchema);
