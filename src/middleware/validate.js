import { ZodError } from 'zod';
import { ApiError } from '../utils/ApiError.js';

/**
 * zod validation for a route (SPEC: "request validation with zod on every route").
 *   router.post('/x', validate({ body: schema }), handler)
 *
 * Parsed values land on req.validated.{body,query,params}. req.body is also
 * replaced with the parsed copy; req.query/req.params are getter-only in
 * Express 5, so handlers must read validated query/params from req.validated.
 */
export function validate({ body, query, params } = {}) {
  return (req, res, next) => {
    try {
      req.validated = {};
      if (params) req.validated.params = params.parse(req.params);
      if (query) req.validated.query = query.parse(req.query);
      if (body) {
        req.validated.body = body.parse(req.body);
        req.body = req.validated.body;
      }
      return next();
    } catch (err) {
      if (err instanceof ZodError) {
        return next(ApiError.badRequest('Validation failed', 'VALIDATION_ERROR', err.flatten().fieldErrors));
      }
      return next(err);
    }
  };
}
