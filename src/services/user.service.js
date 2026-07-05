// UserService — profile reads/updates, KYC lifecycle, account states.
// KYC: unverified → pending (docs uploaded) → approved / rejected (admin);
// admin freeze/unfreeze (frozen users can log in but not transact — requireActive).
//
// Planned API:
//   getProfile(userId) / updateProfile(userId, patch)
//   submitKyc(userId, documents)         → status 'pending' (+ admin notification)
//   reviewKyc(adminUser, userId, approve|reject, reason?)   (+ audit log)
//   setAccountStatus(adminUser, userId, 'active'|'frozen')  (+ audit log)
//   searchUsers(adminFilters, pagination)
