import { ApiError } from '../utils/ApiError.js';
import { logger } from '../config/logger.js';

/**
 * Restrict a route to known source IPs — used for payment-gateway webhooks
 * (env.PG_CALLBACK_IPS, comma-separated). An empty list allows everything and
 * logs a warning, so local dev works without gateway config.
 */
export function ipAllowlist(ipsCsv) {
  const allowed = new Set(
    String(ipsCsv ?? '')
      .split(',')
      .map((ip) => ip.trim())
      .filter(Boolean),
  );

  return (req, res, next) => {
    if (allowed.size === 0) {
      logger.warn({ path: req.originalUrl }, 'ipAllowlist is empty — allowing all sources');
      return next();
    }
    // req.ip honors trust proxy config; strip IPv4-mapped IPv6 prefix
    const ip = (req.ip || '').replace(/^::ffff:/, '');
    if (allowed.has(ip)) return next();
    logger.warn({ ip, path: req.originalUrl }, 'Blocked webhook from unlisted IP');
    return next(ApiError.forbidden('Source not allowed', 'IP_NOT_ALLOWED'));
  };
}
