// AuditService (SPEC §2.11/§2.12) — append-only AuditLog writes for all admin
// actions and sensitive user actions, plus the admin-facing filterable feed.
// AuditLog model blocks updates/deletes; anti-fraud flags land here too.
//
// Planned API:
//   record({ actor, action, target?, meta?, ip?, userAgent? })
//   feed({ actor?, action?, from?, to?, pagination })       → admin audit-log screen
//   flagFraud({ user, reason, meta })                       → audit row + admin notification
