import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Precedence: real environment  >  .env.local  >  .env
 *
 * The real environment must win. `.env.local` is written by `npm run bootstrap`
 * for a SELF-HOSTED Appwrite; if it simply overrode everything, a reviewer who
 * had bootstrapped once and then switched to Cloud — by exporting
 * APPWRITE_ENDPOINT, or editing .env — would silently keep talking to their dead
 * local instance, with no indication why. That is the single most likely way to
 * lose an hour on this setup. [ADR-0017]
 *
 * Note `import 'dotenv/config'` is deliberately NOT used: static imports are
 * hoisted, so it would run before we could capture the pre-dotenv environment.
 */
const REAL_ENV = { ...process.env };

dotenv.config({ path: path.join(PACKAGE_ROOT, '.env') });
dotenv.config({ path: path.join(PACKAGE_ROOT, '.env.local'), override: true });

// Restore anything that was genuinely exported, so it outranks both files.
Object.assign(process.env, REAL_ENV);

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
      `${name} is not set. Copy .env.example to .env and fill in your Appwrite Cloud ` +
        `values, or run \`npm run bootstrap\` against a self-hosted Appwrite.`
    );
  }
  return v;
}

/**
 * Like required(), but also checks the value decodes to exactly 32 bytes.
 *
 * There is deliberately NO fallback, not even an empty string: this key
 * encrypts live Appwrite session secrets (ADR-0015), and a default would mean
 * the server could start in a state where it either cannot decrypt anything or
 * — far worse, if the default were real key material — encrypts every
 * deployment's sessions under a value published in this repository. Same
 * fail-fast treatment DATABASE_URL gets in custom-backend.
 */
function requiredKey(name) {
  const raw = required(name);
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error(
      `${name} must decode to exactly 32 bytes, got ${key.length}. Generate one with:\n` +
        `  node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
    );
  }
  return raw;
}

export const config = {
  // 3001, not 3000, so both backends can run at once. The reviewer switches
  // between them by editing the client's Base URL field — usage, not a change
  // to index.html.
  port: int('PORT', 3001),

  appwrite: {
    // Appwrite Cloud is the documented default (ADR-0017). Self-hosted
    // reviewers override this to http://localhost/v1 in .env.
    // NOTE: Cloud is moving to regional endpoints (e.g. https://fra.cloud.appwrite.io/v1).
    // Use whatever the console shows for YOUR project; this generic host still resolves.
    endpoint: process.env.APPWRITE_ENDPOINT ?? 'https://cloud.appwrite.io/v1',
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

  // Encrypts the Appwrite session secret at rest. REQUIRED, no fallback. [ADR-0015]
  sessionEncryptionKey: requiredKey('SESSION_ENCRYPTION_KEY'),

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
