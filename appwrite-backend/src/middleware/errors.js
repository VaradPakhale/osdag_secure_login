import { isAppwriteError, toContractError } from '../lib/contract-errors.js';

/**
 * Terminal JSON handlers. [ADR-0007]
 *
 * DO NOT REMOVE AS REDUNDANT. Express's default 404 and error handlers emit
 * HTML, and the test client parses every response with
 *
 *     try { body = await res.json(); } catch (e) { body = await res.text(); }
 *                                                   ^ web/index.html:118
 *
 * That fallback is broken — json() disturbs the body before parsing, so text()
 * throws again, the promise rejects, the bare onclick= handler drops it, and
 * the page silently keeps showing the PREVIOUS response. See API_CONTRACT.md §3.
 *
 * This handler is also the last line of defence for ADR-0002's rule that no
 * Appwrite error object reaches the client unmapped.
 */

export function notFoundHandler(req, res) {
  res.status(404).json({ error: `No route for ${req.method} ${req.path}` });
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  if (err?.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    return res.status(400).json({ error: 'Malformed JSON body' });
  }
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request body too large' });
  }

  // Anything from Appwrite that escaped a route goes through the same
  // translation layer the routes use, so the client never sees Appwrite's
  // shape, its `type`, or its `version`.
  const { status, body } = toContractError(err, req.contractContext ?? 'generic');

  if (status >= 500) {
    console.error(
      '[error]', req.method, req.originalUrl, '-',
      isAppwriteError(err) ? `appwrite ${err.code} ${err.type}: ${err.message}` : (err?.stack ?? err)
    );
  }

  if (res.headersSent) return next(err);
  return res.status(status).json(body);
}
