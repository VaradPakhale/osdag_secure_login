import express from 'express';
import { ID } from 'node-appwrite';
import { config } from '../config.js';
import { adminAccount, adminUsers } from '../lib/appwrite.js';
import { CONTRACT, toContractError } from '../lib/contract-errors.js';
import { createSession, destroySession } from '../lib/sessions.js';
import { extractToken } from '../middleware/auth.js';
import {
  checkLoginRateLimit,
  clearLoginFailures,
  recordLoginFailure,
  sendRateLimited,
} from '../middleware/rateLimit.js';

export const authRouter = express.Router();

function normaliseEmail(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
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
// One of the two places the admin API key is legitimately used: there is no
// user session yet with which to create the user. [ADR-0002]
authRouter.post('/register', async (req, res, next) => {
  req.contractContext = 'register';
  try {
    const { email, password } = req.body ?? {};

    if (!isNonEmptyString(email) || !isNonEmptyString(password)) {
      const e = CONTRACT.registrationInvalid();
      return res.status(e.status).json(e.body);
    }

    const emailNorm = normaliseEmail(email);
    if (!emailNorm) {
      const e = CONTRACT.registrationInvalid();
      return res.status(e.status).json(e.body);
    }

    const limited = await checkLoginRateLimit(req, emailNorm);
    if (limited) return sendRateLimited(res, limited.retryAfterSeconds);

    let user;
    try {
      user = await adminUsers().create(
        ID.unique(),
        emailNorm,
        undefined,               // no phone
        password,                // Appwrite hashes with argon2id itself [R5.1]
        emailNorm.split('@')[0]  // name
      );
    } catch (err) {
      // Duplicate email -> 409, matching the mock and custom-backend. The
      // enumeration trade-off is deliberate and documented. [ADR-0004]
      const mapped = toContractError(err, 'register');
      return res.status(mapped.status).json(mapped.body);
    }

    return res.status(201).json({ id: user.$id, email: user.email });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /login
// ---------------------------------------------------------------------------
authRouter.post('/login', async (req, res, next) => {
  req.contractContext = 'login';
  try {
    const { email, password } = req.body ?? {};
    const emailNorm = normaliseEmail(email);

    const limited = await checkLoginRateLimit(req, emailNorm);
    if (limited) return sendRateLimited(res, limited.retryAfterSeconds);

    // Missing / non-string / empty: same 401, same body as a wrong password.
    // No 400 here — a distinguishable response is a validation-boundary
    // oracle. [ADR-0005]
    if (!emailNorm || !isNonEmptyString(password)) {
      await recordLoginFailure(req, null); // IP counter only
      const e = CONTRACT.invalidCredentials();
      return res.status(e.status).json(e.body);
    }

    // The second legitimate admin-key use: establishing the session. From here
    // on, everything this user does runs on the session created below, never
    // on the API key. [ADR-0002]
    let session;
    try {
      session = await adminAccount().createEmailPasswordSession(emailNorm, password);
    } catch (err) {
      await recordLoginFailure(req, emailNorm);
      // Every Appwrite failure on this surface collapses to one 401 — unknown
      // user, wrong password, blocked account are indistinguishable. [R5.2]
      const mapped = toContractError(err, 'login');
      return res.status(mapped.status).json(mapped.body);
    }

    await clearLoginFailures(emailNorm);

    // Our opaque token wraps Appwrite's session secret. The client contract is
    // unchanged; index.html cannot tell the backends apart. [ADR-0014]
    const { token, expiresAt } = await createSession({
      userId: session.userId,
      sessionId: session.$id,
      secret: session.secret,
    });

    res.cookie(config.cookieName, token, sessionCookieOptions(expiresAt));

    // `token` MUST be top-level: web/index.html:142-144 reads exactly this.
    return res.status(200).json({
      token,
      user: { id: session.userId, email: emailNorm },
    });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /logout
// ---------------------------------------------------------------------------
// Not behind requireAuth: 200 unconditionally, so logout never confirms
// whether a presented token was valid. [ADR-0001, API_CONTRACT.md §7.6]
//
// Accepts a POST with no body and no Content-Type, which is what the client
// sends (web/index.html:149).
authRouter.post('/logout', async (req, res, next) => {
  try {
    // Kills BOTH the Appwrite session and our record. Either surviving would
    // mean the credential still works somewhere. [R1.3]
    await destroySession(extractToken(req));

    res.clearCookie(config.cookieName, { path: '/' });

    return res.status(200).json({ message: 'Logged out' });
  } catch (err) {
    return next(err);
  }
});
