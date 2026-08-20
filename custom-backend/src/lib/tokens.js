import crypto from 'node:crypto';
import { config } from '../config.js';
import { query, queryOne } from '../db.js';

// 32 CSPRNG bytes, base64url. Opaque: it carries no claims, so nothing leaks
// if it is read, and it means nothing to anyone but this database. [ADR-0001]
const TOKEN_BYTES = 32;

export function generateToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString('base64url');
}

/** Raw 32-byte digest, stored as bytea. The token itself is never persisted. */
export function hashToken(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest();
}

export function generateId(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

/** Issue a session and return the plaintext token exactly once, to the caller. */
export async function createSession(userId) {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + config.sessionTtlMinutes * 60_000);

  await query(
    `INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)`,
    [hashToken(token), userId, expiresAt]
  );

  return { token, expiresAt };
}

/**
 * Resolve a token to a user id, or null.
 *
 * Expiry is checked in SQL (`expires_at > now()`) rather than in JS so that a
 * clock or timezone mistake in the app cannot resurrect a dead session.
 */
export async function resolveSession(token) {
  if (!token) return null;

  const row = await queryOne(
    `SELECT user_id, expires_at
       FROM sessions
      WHERE token_hash = $1
        AND expires_at > now()`,
    [hashToken(token)]
  );

  return row ? { userId: row.user_id, expiresAt: row.expires_at } : null;
}

/**
 * Destroy a session. Returns how many rows went away — 0 means the token was
 * unknown, expired, or already revoked. The caller answers 200 either way, so
 * logout never confirms whether a presented token was real. [ADR-0001]
 */
export async function destroySession(token) {
  if (!token) return 0;
  const { rowCount } = await query(`DELETE FROM sessions WHERE token_hash = $1`, [
    hashToken(token),
  ]);
  return rowCount;
}

/** Housekeeping: drop rows that are already dead. Never gates authentication. */
export async function purgeExpiredSessions() {
  const { rowCount } = await query(`DELETE FROM sessions WHERE expires_at <= now()`);
  return rowCount;
}
