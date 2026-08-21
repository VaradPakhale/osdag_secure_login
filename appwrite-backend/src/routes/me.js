import express from 'express';
import { sessionScoped } from '../lib/appwrite.js';
import { CONTRACT } from '../lib/contract-errors.js';
import { requireAuth } from '../middleware/auth.js';

export const meRouter = express.Router();

/**
 * GET /me — the authenticated user's own profile. [R2.1, R2.2]
 *
 * `account.get()` on a session-scoped client returns THE SESSION'S OWN user and
 * takes no identifier at all. There is no argument for a caller to influence,
 * so "must not expose another user's data even if a different identifier is
 * supplied" holds because the API physically has no such parameter — not
 * because we check one. There is deliberately no /me/:id route.
 */
meRouter.get('/me', requireAuth, async (req, res, next) => {
  try {
    const { account } = sessionScoped(req.auth.sessionSecret);
    const user = await account.get();

    // Flat, not wrapped in a `user` envelope — matches web/mock-api.js:204 and
    // custom-backend byte for byte. (/login DOES wrap; the mock is inconsistent
    // and we mirror it exactly. API_CONTRACT.md §7.3)
    return res.status(200).json({
      id: user.$id,
      email: user.email,
      profile: {
        fullName: user.prefs?.fullName ?? user.name ?? '',
        displayName: user.prefs?.displayName ?? user.name ?? '',
        bio: user.prefs?.bio ?? '',
        createdAt: user.$createdAt,
        role: user.prefs?.role ?? 'user',
      },
    });
  } catch (err) {
    // A dead Appwrite session behind a live facade token reads as 401, the
    // same body as every other auth failure.
    if (err?.code === 401) {
      return res.status(401).json(CONTRACT.notAuthenticated().body);
    }
    return next(err);
  }
});
