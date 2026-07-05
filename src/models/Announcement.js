import mongoose from 'mongoose';

const { Schema } = mongoose;

const announcementSchema = new Schema(
  {
    title: { type: String, required: true },
    body: { type: String, required: true },
    published: { type: Boolean, default: true },
    publishedAt: { type: Date, default: Date.now },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);

announcementSchema.index({ published: 1, publishedAt: -1 });

export const Announcement = mongoose.model('Announcement', announcementSchema);
