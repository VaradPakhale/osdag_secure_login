import { config } from '../config.js';
import { CONTRACT } from '../lib/contract-errors.js';
import { resolveSession } from '../lib/sessions.js';

/**
 * Extract our opaque bearer token. Identical contract to custom-backend:
 * Authorization first, cookie alias second. [ADR-0001]
 */
function extractToken(req) {
  const header = req.get('authorization');
  if (header) {
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (match) return match[1].trim();
  }
  const cookie = req.cookies?.[config.cookieName];
  if (cookie) return cookie;
  return null;
}

/**
 * THE authentication middleware. Every protected route mounts this. [R5.4]
 *
 * On success `req.auth = { userId, sessionSecret }`. The sessionSecret is what
 * every downstream data call uses to build a user-scoped Appwrite client — so
 * handlers physically cannot reach another user's data, because the credential
 * they hold is that user's own. [ADR-0002]
 *
 * A handler never reads an identifier from the path, query, body or a header.
 */
export async function requireAuth(req, res, next) {
  try {
    const session = await resolveSession(extractToken(req));

    if (!session) {
      // One body for absent / malformed / unknown / expired.
      return res.status(401).json(CONTRACT.notAuthenticated().body);
    }

    req.auth = { userId: session.userId, sessionSecret: session.secret, sessionId: session.sessionId };
    return next();
  } catch (err) {
    return next(err);
  }
}

export { extractToken };
