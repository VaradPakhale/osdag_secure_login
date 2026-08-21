import { Account, Client, Databases, Storage, Users } from 'node-appwrite';
import { config } from '../config.js';

function baseClient() {
  return new Client()
    .setEndpoint(config.appwrite.endpoint)
    .setProject(config.appwrite.projectId);
}

/**
 * ============================================================================
 * THE ADMIN CLIENT — API-KEY SCOPED, EFFECTIVELY ROOT
 * ============================================================================
 *
 * This client carries the Appwrite API key. It bypasses every document and
 * file permission in the project: it can read any user's data. It is therefore
 * allowed in EXACTLY TWO places, and this is the assertion ADR-0002 asks for:
 *
 *   1. PROVISIONING  — scripts/provision.js and scripts/seed.js, which create
 *                      the database, collections, attributes, indexes, bucket,
 *                      and the seeded users/documents/files.
 *   2. REGISTRATION  — POST /register creating the Appwrite account, and
 *                      POST /login creating the initial session. Neither can
 *                      be done with a user session, because at that moment
 *                      there is no user session to use.
 *
 * It is ALSO used for the facade's own bookkeeping collections
 * (facade_sessions, facade_login_attempts). Those hold no user-owned data —
 * they are the facade's session store and rate-limit counters, equivalent to
 * custom-backend's own tables. They are locked to no-one in the permission
 * model, so ONLY the API key can touch them; see ADR-0016.
 *
 * NO ROUTE THAT READS OR RETURNS USER DATA MAY USE THIS CLIENT.
 * /me, /files, /files/:id and /files/:id/download all go through
 * sessionScoped() below, so that Appwrite's permission model — not our WHERE
 * clause — is what enforces isolation. That is the entire point of ADR-0002.
 * If you find yourself reaching for adminDatabases() in a data route, the
 * design has been broken.
 */
export function adminClient() {
  return baseClient().setKey(config.appwrite.apiKey);
}

export const adminUsers = () => new Users(adminClient());
export const adminDatabases = () => new Databases(adminClient());
export const adminStorage = () => new Storage(adminClient());
export const adminAccount = () => new Account(adminClient());

/**
 * A client acting AS THE USER, carrying their Appwrite session secret.
 *
 * Every call made through this is subject to the same document- and
 * file-level permissions Appwrite would apply to that user in a browser. A
 * request for another user's document comes back as a permission failure from
 * Appwrite itself — we never write the ownership check.
 */
export function sessionScoped(sessionSecret) {
  const client = baseClient().setSession(sessionSecret);
  return {
    client,
    account: new Account(client),
    databases: new Databases(client),
    storage: new Storage(client),
  };
}

/** True when an Appwrite error means "this session is no longer valid". */
export function isSessionDead(err) {
  if (!err) return false;
  const type = err.type ?? '';
  return (
    err.code === 401 ||
    type === 'user_unauthorized' ||
    type === 'user_jwt_invalid' ||
    type === 'user_session_not_found' ||
    type === 'general_unauthorized_scope'
  );
}
