/**
 * JSON-only terminal handlers. [ADR-0007]
 *
 * DO NOT REMOVE THESE AS REDUNDANT. Express's built-in 404 and error handlers
 * both emit HTML, and the test client parses every response with
 *
 *     try { body = await res.json(); } catch (e) { body = await res.text(); }
 *                                                   ^ web/index.html:118
 *
 * That fallback is broken: json() disturbs the body before parsing, so text()
 * throws a second time, the promise rejects, the bare onclick= handler drops
 * it, and the page silently keeps showing the PREVIOUS response. An HTML 404
 * or 500 therefore does not look like an error to the reviewer — it looks like
 * the last success. See API_CONTRACT.md §3.
 */

/** Unmatched route. Mounted last, after every real route. */
export function notFoundHandler(req, res) {
  res.status(404).json({ error: `No route for ${req.method} ${req.path}` });
}

/** Terminal error handler. Must keep the 4-arg signature to be recognised. */
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  // Malformed JSON from express.json(). Its own default is an HTML 400, and it
  // fires before any route runs — easy to miss. [ADR-0005: 400 is reserved
  // for exactly this, a transport fault that reveals nothing about accounts.]
  if (err?.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    return res.status(400).json({ error: 'Malformed JSON body' });
  }

  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request body too large' });
  }

  console.error('[error]', req.method, req.originalUrl, '-', err?.stack ?? err);

  if (res.headersSent) return next(err);

  // Fixed body: internals stay in the server log.
  return res.status(500).json({ error: 'Internal server error' });
}
