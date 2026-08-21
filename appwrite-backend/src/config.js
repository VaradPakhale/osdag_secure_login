import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// .env.local is written by `npm run bootstrap` for a local Appwrite and holds a
// real API key. Loaded second so it wins over .env; gitignored.
const { config: loadEnv } = await import('dotenv');
loadEnv({ path: path.join(PACKAGE_ROOT, '.env.local'), override: true });

function int(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive integer, got "${raw}"`);
  return n;
}

function bool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw === 'true' || raw === '1';
}

function required(name) {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `${name} is not set. Run \`npm run bootstrap\` for a local Appwrite, or copy ` +
        `.env.example to .env and fill in your Appwrite Cloud values.`
    );
  }
  return v;
}

export const config = {
  // 3001, not 3000, so both backends can run at once. The reviewer switches
  // between them by editing the client's Base URL field — usage, not a change
  // to index.html.
  port: int('PORT', 3001),

  appwrite: {
    endpoint: process.env.APPWRITE_ENDPOINT ?? 'http://localhost/v1',
    projectId: required('APPWRITE_PROJECT_ID'),
    apiKey: required('APPWRITE_API_KEY'),
    databaseId: process.env.APPWRITE_DATABASE_ID ?? 'osdag',
    filesCollectionId: process.env.APPWRITE_FILES_COLLECTION_ID ?? 'files',
    sessionsCollectionId: process.env.APPWRITE_SESSIONS_COLLECTION_ID ?? 'facade_sessions',
    attemptsCollectionId: process.env.APPWRITE_ATTEMPTS_COLLECTION_ID ?? 'facade_login_attempts',
    bucketId: process.env.APPWRITE_BUCKET_ID ?? 'user-files',
  },

  // Same 30-minute absolute lifetime as custom-backend. [ADR-0001]
  sessionTtlMinutes: int('SESSION_TTL_MINUTES', 30),

  // Encrypts the Appwrite session secret at rest. [ADR-0015]
  sessionEncryptionKey: process.env.SESSION_ENCRYPTION_KEY ?? '',

  corsAllowedOrigins: (process.env.CORS_ALLOWED_ORIGINS ?? '*')
    .split(',').map((s) => s.trim()).filter(Boolean),

  cookieName: process.env.COOKIE_NAME ?? 'session',
  cookieSecure: bool('COOKIE_SECURE', false),
  cookieSameSite: (process.env.COOKIE_SAMESITE ?? 'lax').toLowerCase(),

  // R5.3 is OUR requirement, not Appwrite's. Same shape as custom-backend. [ADR-0006]
  loginRateLimit: {
    emailMax: int('LOGIN_RATE_LIMIT_MAX', 10),
    emailWindowMinutes: int('LOGIN_RATE_LIMIT_WINDOW_MINUTES', 15),
    ipMax: int('LOGIN_RATE_LIMIT_IP_MAX', 50),
    ipWindowMinutes: int('LOGIN_RATE_LIMIT_IP_WINDOW_MINUTES', 15),
  },

  packageRoot: PACKAGE_ROOT,
};
