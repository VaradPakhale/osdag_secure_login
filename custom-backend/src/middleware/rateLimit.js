import { config } from '../config.js';
import { query, queryOne } from '../db.js';

/**
 * Fixed-window failure counter, backed by the login_attempts table. [ADR-0006]
 *
 * Hand-rolled rather than express-rate-limit because three of the four things
 * this needs are things that package makes awkward: keying on a body field
 * (email) rather than IP, persisting across restarts, and only counting
 * *failures* rather than requests. [ADR-0008]
 *
 * Keys carry their own dimension so one table serves both limiters:
 *   'email:alice@example.com'   'ip:::1'
 */

function windowMs(minutes) {
  return minutes * 60_000;
}

/**
 * Is this key currently locked? Returns null when allowed, or { retryAfterSeconds }.
 *
 * Read-only: checking must never itself count as an attempt, or a locked-out
 * user could never become unlocked by waiting.
 */
async function checkKey(key, max, windowMinutes) {
  const row = await queryOne(
    `SELECT failures, window_started_at FROM login_attempts WHERE key = $1`,
    [key]
  );
  if (!row) return null;

  const elapsed = Date.now() - new Date(row.window_started_at).getTime();
  if (elapsed >= windowMs(windowMinutes)) return null; // window rolled over
  if (row.failures < max) return null;

  return {
    retryAfterSeconds: Math.max(1, Math.ceil((windowMs(windowMinutes) - elapsed) / 1000)),
  };
}

async function recordFailure(key, windowMinutes) {
  // One statement, so concurrent attempts cannot interleave into a lost update.
  // The window resets when the stored one has aged out; otherwise failures++.
  await query(
    `INSERT INTO login_attempts (key, failures, window_started_at)
          VALUES ($1, 1, now())
     ON CONFLICT (key) DO UPDATE
            SET failures = CASE
                             WHEN login_attempts.window_started_at < now() - ($2 || ' minutes')::interval
                             THEN 1
                             ELSE login_attempts.failures + 1
                           END,
                window_started_at = CASE
                             WHEN login_attempts.window_started_at < now() - ($2 || ' minutes')::interval
                             THEN now()
                             ELSE login_attempts.window_started_at
                           END`,
    [key, String(windowMinutes)]
  );
}

async function clearKey(key) {
  await query(`DELETE FROM login_attempts WHERE key = $1`, [key]);
}

function emailKey(emailNorm) {
  return `email:${emailNorm}`;
}

function ipKey(req) {
  return `ip:${req.ip}`;
}

/**
 * Gate a credential attempt. Call BEFORE verifying the password.
 *
 * `emailNorm` may be null — a request that supplied no usable email has no
 * account to count against, and inventing a placeholder key (as the mock does
 * with `undefined`) would let anyone poison a shared counter. [ADR-0005]
 */
export async function checkLoginRateLimit(req, emailNorm) {
  const { emailMax, emailWindowMinutes, ipMax, ipWindowMinutes } = config.loginRateLimit;

  if (emailNorm) {
    const locked = await checkKey(emailKey(emailNorm), emailMax, emailWindowMinutes);
    if (locked) return locked;
  }

  const lockedByIp = await checkKey(ipKey(req), ipMax, ipWindowMinutes);
  if (lockedByIp) return lockedByIp;

  return null;
}

export async function recordLoginFailure(req, emailNorm) {
  const { emailWindowMinutes, ipWindowMinutes } = config.loginRateLimit;
  if (emailNorm) await recordFailure(emailKey(emailNorm), emailWindowMinutes);
  await recordFailure(ipKey(req), ipWindowMinutes);
}

/** A successful login clears the email counter — but not the IP one, which is
 *  a spray backstop and must not be resettable by knowing one good password. */
export async function clearLoginFailures(emailNorm) {
  if (emailNorm) await clearKey(emailKey(emailNorm));
}

/**
 * The 429 response. JSON, always — express-rate-limit's plain-text default is
 * exactly the body that freezes the client's output pane. [ADR-0007]
 */
export function sendRateLimited(res, retryAfterSeconds) {
  res.setHeader('Retry-After', String(retryAfterSeconds));
  // Wording matches the mock (web/mock-api.js:170) and says nothing about
  // which limiter fired or whether the address exists.
  return res.status(429).json({ error: 'Too many failed attempts. Try again in a bit.' });
}
