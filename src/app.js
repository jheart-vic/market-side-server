import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import pinoHttp from 'pino-http';
import { env, isProd, corsOrigins } from './config/env.js';
import { logger } from './config/logger.js';
import { notFound, errorHandler } from './middleware/error.js';
import { generalLimiter } from './middleware/rateLimit.js';
import { csrfProtection } from './middleware/csrf.js';
import apiRoutes from './routes/index.js';

export const app = express();

// Behind a reverse proxy in production; needed for real client IPs (rate limits, webhook allowlist)
if (isProd) app.set('trust proxy', 1);

// API responses are per-user and state-dependent — they must never be cached by
// a browser, service worker, or proxy. A stale cached GET /auth/me once left
// users stuck on old state (e.g. "set your PIN" after already setting it).
// Disable ETags (no conditional caching) and stamp no-store on every response.
app.set('etag', false);

app.use(helmet());
app.use(cors({ origin: corsOrigins, credentials: true }));
app.use(
  express.json({
    limit: '1mb',
    // Keep the raw JSON text: gateway callback signatures cover decimal
    // formatting ("100.00") that JSON.parse would destroy (payment.service)
    verify: (req, _res, buf) => {
      req.rawBody = buf.toString('utf8');
    },
  }),
);
app.use(cookieParser());
app.use(pinoHttp({ logger, autoLogging: env.NODE_ENV !== 'test' }));
app.use(generalLimiter);
app.use(csrfProtection);

// No caching of any API response (see note above the etag setting).
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

app.get('/api/health', (req, res) => {
  res.json({ success: true, status: 'ok', time: new Date().toISOString() });
});

app.use('/api', apiRoutes);

app.use(notFound);
app.use(errorHandler);
