import { config } from '../config.js';

/**
 * CORS, hand-rolled because the rules here are specific enough that the
 * `cors` package's config would be less readable than the logic itself.
 *
 * The client is always cross-origin (it is opened from a static server or
 * file://, the API lives on :3000), and it attaches Authorization — which makes
 * every request, GET included, preflighted. See API_CONTRACT.md §1.3.
 *
 * Two cases matter:
 *
 *   Origin: null  — the page was opened as file://. Credentialed CORS is
 *                   impossible for an opaque origin, so we answer `*` and no
 *                   credentials. Bearer mode still works; cookie mode cannot,
 *                   and that asymmetry is one reason bearer is the contract.
 *                   [ADR-0001, evidence #4]
 *
 *   Origin: http://... — reflect it and allow credentials, so the cookie alias
 *                   works. Reflection is gated by the allowlist unless it is
 *                   the dev default of '*'. [ADR-0012]
 */
export function cors(req, res, next) {
  const origin = req.get('origin');
  const allowAny = config.corsAllowedOrigins.includes('*');

  if (origin && origin !== 'null' && (allowAny || config.corsAllowedOrigins.includes(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    // The response varies by Origin, so caches must not share it.
    res.setHeader('Vary', 'Origin');
  } else if (allowAny) {
    // Covers file:// (Origin: null) and non-browser callers like curl.
    // Wildcard and credentials are mutually exclusive by spec, so no
    // Allow-Credentials here — bearer only.
    res.setHeader('Access-Control-Allow-Origin', '*');
  }

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Max-Age', '600');
    // 204 is correct and safe here: a preflight response is never read by the
    // client's json()/text() fallback, which only sees the actual response.
    return res.status(204).end();
  }

  return next();
}
