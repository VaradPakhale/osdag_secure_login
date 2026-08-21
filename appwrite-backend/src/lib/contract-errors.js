/**
 * THE TRANSLATION LAYER.
 *
 * Appwrite's errors have their own shapes, codes and vocabulary:
 *
 *   {"message":"Document with the requested ID could not be found.",
 *    "code":404,"type":"document_not_found","version":"1.6.2"}
 *
 * None of that may reach the client. API_CONTRACT.md specifies `{"error": "..."}`
 * with our own status policy, and the whole point of the facade is that the
 * same unmodified web/index.html cannot tell the two backends apart.
 *
 * This is deliberately ONE layer rather than try/catch blocks scattered through
 * the routes. Scattered handling is how an unmapped Appwrite error object
 * eventually escapes — you only have to forget once, and the failure is a
 * response shape the client cannot parse, which per ADR-0007 freezes its output
 * pane silently. Routes throw ContractError for expected outcomes; anything
 * unexpected reaches the terminal error handler, which maps or generalises it.
 *
 * Every response body this module produces is valid JSON. [ADR-0007]
 */

/** An outcome the contract specifies. Thrown by routes, rendered verbatim. */
export class ContractError extends Error {
  constructor(status, body) {
    super(typeof body?.error === 'string' ? body.error : `HTTP ${status}`);
    this.name = 'ContractError';
    this.status = status;
    this.body = body;
  }
}

// The exact bodies from API_CONTRACT.md §4, byte-identical to custom-backend.
export const CONTRACT = {
  invalidCredentials: () =>
    new ContractError(401, { error: 'Invalid email or password' }),
  notAuthenticated: () =>
    new ContractError(401, { error: 'Not authenticated' }),
  fileForbidden: () =>
    new ContractError(403, { error: 'You do not have access to this file' }),
  fileNotFound: () =>
    new ContractError(404, { error: 'File not found' }),
  emailTaken: () =>
    new ContractError(409, { error: 'An account with that email already exists' }),
  registrationInvalid: () =>
    new ContractError(400, { error: 'email and password are required' }),
  malformedJson: () =>
    new ContractError(400, { error: 'Malformed JSON body' }),
  rateLimited: () =>
    new ContractError(429, { error: 'Too many failed attempts. Try again in a bit.' }),
  internal: () =>
    new ContractError(500, { error: 'Internal server error' }),
};

/** Appwrite error type strings we recognise, grouped by what they mean to us. */
const APPWRITE_TYPES = {
  duplicate: new Set([
    'user_already_exists',
    'user_email_already_exists',
    'document_already_exists',
  ]),
  credentials: new Set([
    'user_invalid_credentials',
    'user_not_found',
    'user_blocked',
    'user_password_mismatch',
    'user_invalid_token',
  ]),
  missing: new Set([
    'document_not_found',
    'storage_file_not_found',
    'collection_not_found',
    'database_not_found',
    'bucket_not_found',
  ]),
  unauthorized: new Set([
    'user_unauthorized',
    'user_session_not_found',
    'user_jwt_invalid',
    'general_unauthorized_scope',
  ]),
  rateLimited: new Set(['general_rate_limit_exceeded']),
  validation: new Set([
    'general_argument_invalid',
    'password_recently_used',
    'password_personal_data',
  ]),
};

/**
 * Map any thrown value to a { status, body } pair that satisfies the contract.
 *
 * `context` tells the mapper which contract surface it is on, because the same
 * Appwrite error means different things in different places: a 404 from the
 * documents API is `File not found` on /files/:id, but on /login a
 * `user_not_found` must NOT become a 404 — it is a credential failure and has
 * to be indistinguishable from a wrong password (R5.2).
 */
export function toContractError(err, context = 'generic') {
  if (err instanceof ContractError) return { status: err.status, body: err.body };

  const type = err?.type ?? '';
  const code = typeof err?.code === 'number' ? err.code : 0;

  // --- credential surfaces: everything collapses to one 401 ---------------
  // No branch here may produce a distinguishable response, or the generic-error
  // guarantee in R5.2 is gone. [ADR-0005]
  if (context === 'login') {
    if (APPWRITE_TYPES.rateLimited.has(type) || code === 429) {
      return { status: 429, body: CONTRACT.rateLimited().body };
    }
    return { status: 401, body: CONTRACT.invalidCredentials().body };
  }

  if (context === 'register') {
    if (APPWRITE_TYPES.duplicate.has(type) || code === 409) {
      return { status: 409, body: CONTRACT.emailTaken().body };
    }
    if (APPWRITE_TYPES.rateLimited.has(type) || code === 429) {
      return { status: 429, body: CONTRACT.rateLimited().body };
    }
    if (APPWRITE_TYPES.validation.has(type) || code === 400) {
      return { status: 400, body: CONTRACT.registrationInvalid().body };
    }
  }

  // --- file surfaces ------------------------------------------------------
  // Appwrite answers a permission failure with 401 when unauthenticated and
  // 404 when the caller may not even know the document exists. Our contract
  // needs 403-vs-404 to be distinct (R3.3), so the routes decide that with an
  // explicit existence probe and throw ContractError; anything reaching here
  // is an unexpected failure.
  if (context === 'files') {
    if (APPWRITE_TYPES.missing.has(type) || code === 404) {
      return { status: 404, body: CONTRACT.fileNotFound().body };
    }
    if (APPWRITE_TYPES.unauthorized.has(type) || code === 401) {
      return { status: 401, body: CONTRACT.notAuthenticated().body };
    }
  }

  // --- authenticated surfaces --------------------------------------------
  if (APPWRITE_TYPES.unauthorized.has(type) || code === 401) {
    return { status: 401, body: CONTRACT.notAuthenticated().body };
  }
  if (APPWRITE_TYPES.rateLimited.has(type) || code === 429) {
    return { status: 429, body: CONTRACT.rateLimited().body };
  }

  // --- anything else ------------------------------------------------------
  // Unmapped Appwrite errors become a generic 500 with a fixed body. The detail
  // is logged, never returned: leaking `type` or `version` would tell an
  // attacker what is behind the facade.
  return { status: 500, body: CONTRACT.internal().body };
}

/** True if this looks like an Appwrite SDK error rather than a plain JS one. */
export function isAppwriteError(err) {
  return Boolean(err && typeof err.code === 'number' && typeof err.type === 'string');
}
