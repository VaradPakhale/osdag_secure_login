import { config } from '../config.js';
import { resolveSession } from '../lib/tokens.js';

/**
 * Extract the bearer credential.
 *
 * Order matters: Authorization first, cookie second. In bearer mode the client
 * never sends cookies (web/index.html:110-115), and in cookie mode it never
 * sends Authorization — so the two cannot collide in practice. Preferring the
 * explicit header keeps behaviour predictable if a stale cookie is lying around.
 */
function extractToken(req) {
  const header = req.get('authorization');
  if (header) {
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (match) return match[1].trim();
  }

  // Cookie mode: the alias path. Same token, same session row. [ADR-0001]
  const cookie = req.cookies?.[config.cookieName];
  if (cookie) return cookie;

  return null;
}

/**
 * THE authentication middleware. Every protected route mounts this and no
 * route re-implements any part of it (R5.4).
 *
 * On success it sets `req.auth = { userId }`. That is the ONLY channel by which
 * a handler learns who is calling — handlers never read an identifier from the
 * path, query, body, or a header (R2.2).
 */
export async function requireAuth(req, res, next) {
  try {
    const session = await resolveSession(extractToken(req));

    if (!session) {
      // One body for "no token", "malformed token", "unknown token" and
      // "expired token". The client cannot tell them apart, and neither
      // should anyone probing the endpoint.
      return res.status(401).json({ error: 'Not authenticated' });
    }

    req.auth = { userId: session.userId };
    return next();
  } catch (err) {
    return next(err);
  }
}

export { extractToken };
