import { ApiError } from '../utils/ApiError.js';
import { logger } from '../config/logger.js';
import { isProd } from '../config/env.js';

export function notFound(req, res, next) {
  next(ApiError.notFound(`Route not found: ${req.method} ${req.originalUrl}`));
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  if (err instanceof ApiError) {
    return res.status(err.statusCode).json({
      success: false,
      code: err.code,
      message: err.message,
      ...(err.details ? { details: err.details } : {}),
    });
  }

  // Duplicate-key errors from unique indexes read as conflicts
  if (err?.code === 11000) {
    return res.status(409).json({
      success: false,
      code: 'DUPLICATE',
      message: 'A record with those details already exists',
    });
  }

  logger.error({ err }, 'Unhandled error');
  return res.status(500).json({
    success: false,
    code: 'INTERNAL',
    message: isProd ? 'Something went wrong' : err.message,
  });
}
