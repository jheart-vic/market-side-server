import { ApiError } from '../utils/ApiError.js';

/**
 * Role gate; mount after requireAuth. superadmin implicitly passes every check.
 *   router.use(requireAuth, requireRole('admin'))
 */
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return next(ApiError.unauthorized());
    // An impersonated session never carries staff powers, even if the target
    // is an admin — the admin must exit impersonation first.
    if (req.impersonatedBy) {
      return next(ApiError.forbidden('Admin actions are disabled while impersonating', 'IMPERSONATION_ACTIVE'));
    }
    if (req.user.role === 'superadmin' || roles.includes(req.user.role)) return next();
    return next(ApiError.forbidden('Insufficient permissions', 'FORBIDDEN_ROLE'));
  };
}
