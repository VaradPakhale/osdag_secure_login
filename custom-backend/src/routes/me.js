import express from 'express';
import { queryOne } from '../db.js';
import { requireAuth } from '../middleware/auth.js';

export const meRouter = express.Router();

/**
 * GET /me — the authenticated user's own profile. [R2.1, R2.2]
 *
 * The subject is `req.auth.userId` and nothing else. There is deliberately no
 * `/me/:id` route, no `?id=` handling, and no header or body field that can
 * name a different user — so "must not expose another user's data even if a
 * different identifier is supplied" holds because there is no code path that
 * could, not because a check rejects it.
 *
 * The client never supplies an identifier here (API_CONTRACT.md §4.4), so this
 * is verified out-of-band with curl.
 */
meRouter.get('/me', requireAuth, async (req, res, next) => {
  try {
    const user = await queryOne(
      `SELECT id, email, full_name, display_name, bio, role, created_at
         FROM users
        WHERE id = $1`,
      [req.auth.userId]
    );

    if (!user) {
      // The session referenced a user that no longer exists. Same 401 body as
      // every other auth failure (web/mock-api.js:203).
      return res.status(401).json({ error: 'Not authenticated' });
    }

    // Flat, not wrapped in a `user` envelope — matches web/mock-api.js:204.
    // (/login DOES wrap; the mock is inconsistent and we mirror it exactly.
    // API_CONTRACT.md §7.3)
    return res.status(200).json({
      id: user.id,
      email: user.email,
      profile: {
        fullName: user.full_name,
        displayName: user.display_name,
        bio: user.bio,
        createdAt: user.created_at.toISOString(),
        role: user.role,
      },
    });
  } catch (err) {
    return next(err);
  }
});
