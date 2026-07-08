import 'dotenv/config';
import { z } from 'zod';

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(5000),
    MONGODB_URI: z.string().default('mongodb://127.0.0.1:27017/market-side'),
    CLIENT_ORIGIN: z.string().url().default('http://localhost:5173'),
    // Origin of the admin console SPA, when it's served separately from the user
    // app (browser blocks the response otherwise). Leave unset if admin + user
    // share one origin in production — CLIENT_ORIGIN then covers both.
    ADMIN_ORIGIN: z.string().url().optional(),
    // Parent domain for auth cookies in production (e.g. ".example.com" when the
    // frontend and API are on subdomains). Unset → host-only cookies.
    COOKIE_DOMAIN: z.string().optional(),
    JWT_ACCESS_SECRET: z.string().default('dev-only-access-secret-do-not-use-in-prod'),
    JWT_REFRESH_SECRET: z.string().default('dev-only-refresh-secret-do-not-use-in-prod'),
    ACCESS_TOKEN_TTL: z.string().default('15m'),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
    BCRYPT_ROUNDS: z.coerce.number().int().min(8).max(15).default(10),
    // Bootstrap admin: env-configured superadmin that logs in with email +
    // password (no captcha) and is created on first successful login. All three
    // are required for POST /api/auth/admin/login to work (503 otherwise).
    ADMIN_EMAIL: z.string().email().optional(),
    ADMIN_PASSWORD: z.string().min(8).optional(),
    ADMIN_PHONE: z.string().optional(), // E.164 — satisfies the User model's unique phone key
    CAPTCHA_TTL_SECONDS: z.coerce.number().int().positive().default(300),
    CAPTCHA_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
    // Cloudinary (KYC document uploads — private assets, signed delivery)
    CLOUDINARY_CLOUD_NAME: z.string().optional(),
    CLOUDINARY_API_KEY: z.string().optional(),
    CLOUDINARY_API_SECRET: z.string().optional(),
    // Price provider (PriceService — CoinGecko seed, swappable)
    COINGECKO_BASE_URL: z.string().url().default('https://api.coingecko.com/api/v3'),
    COINGECKO_API_KEY: z.string().optional(), // demo/pro key; optional for the free tier
    PRICE_REFRESH_SECONDS: z.coerce.number().int().positive().default(30),
    TRADE_FEE_PCT: z.coerce.number().min(0).max(10).default(0.1), // spot trade fee, percent
    // Payment gateway (deposits/withdrawals)
    PG_BASE_URL: z.string().url().optional(),
    PG_MERCHANT_ID: z.string().optional(),
    PG_SECRET_KEY: z.string().optional(),
    PG_COUNTRY_CODE: z.string().default('NGN'),
    PG_DEPOSIT_PAYTYPE: z.string().default('NGN_TRANSFER'),
    PG_WITHDRAW_PAYTYPE: z.string().default('NGN_PAYOUT'),
    PG_CALLBACK_BASE_URL: z.string().url().optional(),
    PG_CALLBACK_IPS: z.string().default(''), // comma-separated allowlist for webhook source IPs
  })
  .superRefine((cfg, ctx) => {
    if (cfg.NODE_ENV === 'production') {
      for (const key of ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET']) {
        if (cfg[key].startsWith('dev-only-') || cfg[key].length < 32) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: `${key} must be set to a strong secret (>= 32 chars) in production`,
          });
        }
      }
    }
  });

export const env = schema.parse(process.env);
export const isProd = env.NODE_ENV === 'production';

// Origins allowed by CORS / Socket.IO. In production a single CLIENT_ORIGIN
// covers both apps when they share an origin; set ADMIN_ORIGIN only if the admin
// console lives on a different host. In dev the admin SPA defaults to :5174.
const adminOrigin = env.ADMIN_ORIGIN || (isProd ? env.CLIENT_ORIGIN : 'http://localhost:5174');
export const corsOrigins = [...new Set([env.CLIENT_ORIGIN, adminOrigin])];
