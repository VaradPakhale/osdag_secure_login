import crypto from 'node:crypto';
import { config } from '../config.js';
import { adminDatabases } from '../lib/appwrite.js';
import { CONTRACT } from '../lib/contract-errors.js';

/**
 * Login rate limiting / lockout. [R5.3, ADR-0006]
 *
 * R5.3 is OUR requirement, not something Appwrite hands us. Appwrite does have
 * its own abuse limits (see README), but they are per-IP-and-endpoint, tuned
 * for its own protection rather than ours, not configurable on self-hosted
 * without env surgery, and they return Appwrite's error shape rather than our
 * contract's. So the facade implements the same limiter as custom-backend, with
 * the same defaults and the same keys, and Appwrite's limits sit underneath as
 * an additional backstop we do not rely on.
 *
 * Keyed primarily on EMAIL, secondarily on IP — because every account in a
 * local review shares ::1, so IP-only keying would let a lockout test on Alice
 * block Bob and Carol.
 *
 * State lives in an Appwrite collection rather than in memory, so a restart
 * does not shed a lockout. Same property as custom-backend's table.
 */

const db = () => adminDatabases();
const DB_ID = () => config.appwrite.databaseId;
const COL = () => config.appwrite.attemptsCollectionId;

/** Appwrite ids are [a-zA-Z0-9._-], max 36 — an email is neither. Hash it. */
function keyId(kind, value) {
  return `${kind}_${crypto.createHash('sha256').update(value).digest('hex').slice(0, 28)}`;
}

function windowMs(minutes) {
  return minutes * 60_000;
}

async function readCounter(id) {
  try {
    return await db().getDocument(DB_ID(), COL(), id);
  } catch {
    return null;
  }
}

/** Read-only. Checking must never itself count, or a lockout could never lapse. */
async function checkKey(id, max, windowMinutes) {
  const doc = await readCounter(id);
  if (!doc) return null;

  const elapsed = Date.now() - new Date(doc.windowStartedAt).getTime();
  if (elapsed >= windowMs(windowMinutes)) return null; // window rolled over
  if (doc.failures < max) return null;

  return {
    retryAfterSeconds: Math.max(1, Math.ceil((windowMs(windowMinutes) - elapsed) / 1000)),
  };
}

async function recordFailure(id, label, windowMinutes) {
  const doc = await readCounter(id);
  const now = new Date();

  if (!doc) {
    await db()
      .createDocument(DB_ID(), COL(), id, {
        label,
        failures: 1,
        windowStartedAt: now.toISOString(),
      })
      .catch(() => {});
    return;
  }

  const elapsed = Date.now() - new Date(doc.windowStartedAt).getTime();
  const rolled = elapsed >= windowMs(windowMinutes);

  // Not atomic the way custom-backend's single INSERT ... ON CONFLICT is —
  // Appwrite has no upsert-with-expression. Two simultaneous failures can lose
  // one increment. Acceptable for a lockout counter: the effect is that an
  // attacker might occasionally get one extra attempt, not that the control
  // fails open. Noted in ADR-0016.
  await db()
    .updateDocument(DB_ID(), COL(), id, {
      failures: rolled ? 1 : doc.failures + 1,
      windowStartedAt: rolled ? now.toISOString() : doc.windowStartedAt,
    })
    .catch(() => {});
}

export async function checkLoginRateLimit(req, emailNorm) {
  const { emailMax, emailWindowMinutes, ipMax, ipWindowMinutes } = config.loginRateLimit;

  if (emailNorm) {
    const locked = await checkKey(keyId('email', emailNorm), emailMax, emailWindowMinutes);
    if (locked) return locked;
  }

  const lockedByIp = await checkKey(keyId('ip', req.ip), ipMax, ipWindowMinutes);
  if (lockedByIp) return lockedByIp;

  return null;
}

export async function recordLoginFailure(req, emailNorm) {
  const { emailWindowMinutes, ipWindowMinutes } = config.loginRateLimit;
  // A request with no usable email has no account to count against; inventing
  // a placeholder key would let anyone poison a shared counter. [ADR-0005]
  if (emailNorm) {
    await recordFailure(keyId('email', emailNorm), `email:${emailNorm}`, emailWindowMinutes);
  }
  await recordFailure(keyId('ip', req.ip), `ip:${req.ip}`, ipWindowMinutes);
}

/** Success clears the email counter — never the IP one, which is a spray
 *  backstop and must not be resettable by knowing one good password. */
export async function clearLoginFailures(emailNorm) {
  if (!emailNorm) return;
  await db().deleteDocument(DB_ID(), COL(), keyId('email', emailNorm)).catch(() => {});
}

/** JSON body, always — a plain-text 429 is what freezes the client. [ADR-0007] */
export function sendRateLimited(res, retryAfterSeconds) {
  res.setHeader('Retry-After', String(retryAfterSeconds));
  return res.status(429).json(CONTRACT.rateLimited().body);
}
