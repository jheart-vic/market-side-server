import mongoose from 'mongoose';

const { Schema } = mongoose;

// Append-only audit trail for all admin actions and sensitive user actions.
// Exposed to admins as a filterable feed (SPEC §2.11).
const auditLogSchema = new Schema(
  {
    actor: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    actorRole: { type: String, required: true },
    action: { type: String, required: true }, // e.g. "withdrawal.approve", "user.freeze"
    target: {
      kind: { type: String },
      item: { type: Schema.Types.ObjectId, refPath: 'target.kind' },
    },
    meta: { type: Schema.Types.Mixed }, // before/after values, amounts, reasons
    ip: String,
    userAgent: String,
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

auditLogSchema.index({ actor: 1, createdAt: -1 });
auditLogSchema.index({ action: 1, createdAt: -1 });
auditLogSchema.index({ 'target.item': 1 });

// Append-only, same guarantee as the ledger
auditLogSchema.pre('save', function blockUpdates(next) {
  if (!this.isNew) return next(new Error('AuditLog is immutable'));
  return next();
});
for (const op of [
  'updateOne',
  'updateMany',
  'findOneAndUpdate',
  'findOneAndReplace',
  'replaceOne',
  'deleteOne',
  'deleteMany',
  'findOneAndDelete',
]) {
  auditLogSchema.pre(op, function blockMutation(next) {
    next(new Error('AuditLog is immutable'));
  });
}

export const AuditLog = mongoose.model('AuditLog', auditLogSchema);
