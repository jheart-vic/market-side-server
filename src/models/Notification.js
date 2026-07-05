import mongoose from 'mongoose';
import { NOTIFICATION_AUDIENCES, NOTIFICATION_TYPES } from '../config/constants.js';

const { Schema } = mongoose;

// In-app notification, pushed over Socket.IO on create. audience:"admin" rows
// have no user and appear in every admin's feed.
const notificationSchema = new Schema(
  {
    audience: { type: String, enum: NOTIFICATION_AUDIENCES, default: 'user' },
    user: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: function requiredForUserAudience() {
        return this.audience === 'user';
      },
    },
    type: { type: String, enum: NOTIFICATION_TYPES, required: true },
    title: { type: String, required: true },
    body: { type: String, required: true },
    read: { type: Boolean, default: false },
    readAt: Date,
    // Deep-link payload (ids, amounts) for the frontend
    meta: { type: Schema.Types.Mixed },
  },
  { timestamps: true },
);

notificationSchema.index({ user: 1, read: 1, createdAt: -1 });
notificationSchema.index({ audience: 1, createdAt: -1 });

export const Notification = mongoose.model('Notification', notificationSchema);
