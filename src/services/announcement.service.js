// AnnouncementService (SPEC §2.10) — admin CRUD + user-facing latest-first list.
// Publishing fans out an 'announcement' notification via NotificationService.
//
// Planned API:
//   create(admin, { title, body }) / update / remove      (+ audit log)
//   listPublished(pagination)                              → homepage + announcements screen
//   adminList(pagination)
