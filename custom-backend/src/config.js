import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Package root, so paths resolve the same whether you run `npm start` from
// custom-backend/ or `node custom-backend/src/server.js` from the repo root.
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function int(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  }
  return n;
}

function bool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw === 'true' || raw === '1';
}

// DATABASE_URL is required and never defaulted: a hardcoded fallback is how a
// dev database quietly becomes the production one.
if (!process.env.DATABASE_URL) {
  throw new Error(
    'DATABASE_URL is not set. Copy .env.example to .env and fill it in ' +
      '(or export DATABASE_URL), then retry.'
  );
}

export const config = {
  port: int('PORT', 3000),
  databaseUrl: process.env.DATABASE_URL,

  // Absolute session lifetime. 30 min mirrors the mock's SESSION_TTL_MS
  // (web/mock-api.js:30).                                            [ADR-0001]
  sessionTtlMinutes: int('SESSION_TTL_MINUTES', 30),

  // '*' reflects whatever Origin turns up (dev default). Set an explicit
  // comma-separated allowlist for anything real.                     [ADR-0012]
  corsAllowedOrigins: (process.env.CORS_ALLOWED_ORIGINS ?? '*')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  // Cookie mode is a thin alias over the same session row.           [ADR-0001]
  cookieName: process.env.COOKIE_NAME ?? 'session',
  cookieSecure: bool('COOKIE_SECURE', false),
  cookieSameSite: (process.env.COOKIE_SAMESITE ?? 'lax').toLowerCase(),

  // Primary limiter: per-email. Secondary: per-IP, deliberately looser so a
  // shared localhost address cannot lock out the whole review.       [ADR-0006]
  loginRateLimit: {
    emailMax: int('LOGIN_RATE_LIMIT_MAX', 10),
    emailWindowMinutes: int('LOGIN_RATE_LIMIT_WINDOW_MINUTES', 15),
    ipMax: int('LOGIN_RATE_LIMIT_IP_MAX', 50),
    ipWindowMinutes: int('LOGIN_RATE_LIMIT_IP_WINDOW_MINUTES', 15),
  },

  storageDir: path.resolve(PACKAGE_ROOT, process.env.STORAGE_DIR ?? 'storage'),

  // OWASP Password Storage Cheat Sheet, argon2id row: m=19 MiB, t=2, p=1.
  argon2: {
    memoryCost: int('ARGON2_MEMORY_COST_KIB', 19456),
    timeCost: int('ARGON2_TIME_COST', 2),
    parallelism: int('ARGON2_PARALLELISM', 1),
  },
};
