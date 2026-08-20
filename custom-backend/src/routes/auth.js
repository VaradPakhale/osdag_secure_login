import express from 'express';
import { config } from '../config.js';
import { query, queryOne } from '../db.js';
import { burnTimingBudget, hashPassword, verifyPassword } from '../lib/passwords.js';
import { createSession, destroySession, generateId } from '../lib/tokens.js';
import { extractToken } from '../middleware/auth.js';
import {
  checkLoginRateLimit,
  clearLoginFailures,
  recordLoginFailure,
  sendRateLimited,
} from '../middleware/rateLimit.js';

export const authRouter = express.Router();

// One body for every credential failure. Defined once so no future edit can
// accidentally introduce a distinguishable variant. [ADR-0005, R5.2]
const GENERIC_LOGIN_ERROR = { error: 'Invalid email or password' };

/** lower(trim(email)) — the uniqueness and lookup key. [ADR-0010] */
function normaliseEmail(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function sessionCookieOptions(expiresAt) {
  return {
    httpOnly: true,
    sameSite: config.cookieSameSite,
    secure: config.cookieSecure,
    path: '/',
    expires: expiresAt,
  };
}

// ---------------------------------------------------------------------------
// POST /register
// ---------------------------------------------------------------------------
// Note: after any successful login the client's token field is populated, so
// this route will often receive a stale `Authorization` header
// (API_CONTRACT.md §2). It is ignored — registering is not an authenticated
// action and an existing session neither helps nor blocks it.
authRouter.post('/register', async (req, res, next) => {
  try {
    const { email, password } = req.body ?? {};

    // Registration DOES validate structurally (400), unlike login. It already
    // discloses account existence by design, so there is nothing left for a
    // 400 to leak here. [ADR-0004, ADR-0005]
    if (!isNonEmptyString(email) || !isNonEmptyString(password)) {
      return res.status(400).json({ error: 'email and password are required' });
    }

    const emailNorm = normaliseEmail(email);
    if (!emailNorm) {
      return res.status(400).json({ error: 'email and password are required' });
    }

    // Registration shares the login limiter, which is what bounds how fast the
    // 409 below can be worked as an enumeration oracle. [ADR-0004]
    const limited = await checkLoginRateLimit(req, emailNorm);
    if (limited) return sendRateLimited(res, limited.retryAfterSeconds);

    const passwordHash = await hashPassword(password);
    const id = generateId('usr');

    // Let the UNIQUE constraint decide, rather than SELECT-then-INSERT: the
    // check-then-act version has a race window where two concurrent signups
    // both see "free" and one gets a 500 instead of a 409.
    let inserted;
    try {
      inserted = await queryOne(
        `INSERT INTO users (id, email, email_norm, password_hash, display_name)
              VALUES ($1, $2, $3, $4, $5)
           RETURNING id, email`,
        [id, email.trim(), emailNorm, passwordHash, emailNorm.split('@')[0]]
      );
    } catch (err) {
      if (err.code === '23505') {
        // Deliberate, documented enumeration trade-off. [ADR-0004]
        return res
          .status(409)
          .json({ error: 'An account with that email already exists' });
      }
      throw err;
    }

    // 201 with no token: registration does not log you in (web/mock-api.js:161).
    return res.status(201).json({ id: inserted.id, email: inserted.email });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /login
// ---------------------------------------------------------------------------
authRouter.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body ?? {};
    const emailNorm = normaliseEmail(email);

    // Rate limit is checked before anything else, including validation, so a
    // locked-out address cannot be probed with malformed requests either.
    const limited = await checkLoginRateLimit(req, emailNorm);
    if (limited) return sendRateLimited(res, limited.retryAfterSeconds);

    // Missing / non-string / empty field: 401, identical body, and NOT counted
    // against any email counter, because there is no email to count. [ADR-0005]
    if (!emailNorm || !isNonEmptyString(password)) {
      await burnTimingBudget(password);
      await recordLoginFailure(req, null); // IP counter only
      return res.status(401).json(GENERIC_LOGIN_ERROR);
    }

    const user = await queryOne(
      `SELECT id, email, password_hash FROM users WHERE email_norm = $1`,
      [emailNorm]
    );

    if (!user) {
      // Equalise timing against the found-user path, or the response time is
      // the enumeration oracle the identical body was meant to close. [R5.2]
      await burnTimingBudget(password);
      await recordLoginFailure(req, emailNorm);
      return res.status(401).json(GENERIC_LOGIN_ERROR);
    }

    const ok = await verifyPassword(user.password_hash, password);
    if (!ok) {
      await recordLoginFailure(req, emailNorm);
      return res.status(401).json(GENERIC_LOGIN_ERROR);
    }

    await clearLoginFailures(emailNorm);

    const { token, expiresAt } = await createSession(user.id);

    // Cookie alias: same token, same session row, so logout revokes both at
    // once and there is no second thing to keep in sync. [ADR-0001]
    res.cookie(config.cookieName, token, sessionCookieOptions(expiresAt));

    // `token` MUST be top-level: web/index.html:142-144 reads exactly this.
    return res.status(200).json({
      token,
      user: { id: user.id, email: user.email },
    });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /logout
// ---------------------------------------------------------------------------
// Deliberately NOT behind requireAuth. The mock answers 200 unconditionally
// (web/mock-api.js:193-197) and the client clears its token regardless of the
// status (web/index.html:150), so a 401 would tell the user nothing while
// confirming to an attacker that a probed token was invalid. [ADR-0001, §7.6]
//
// Accepts a POST with no body and no Content-Type — which is exactly what the
// client sends (web/index.html:149).
authRouter.post('/logout', async (req, res, next) => {
  try {
    // Genuine server-side invalidation: the row is deleted, so the very same
    // token string — unchanged and unexpired — stops working on the next
    // request. That is the difference from clearing a client field. [R1.3]
    await destroySession(extractToken(req));

    res.clearCookie(config.cookieName, { path: '/' });

    return res.status(200).json({ message: 'Logged out' });
  } catch (err) {
    return next(err);
  }
});
