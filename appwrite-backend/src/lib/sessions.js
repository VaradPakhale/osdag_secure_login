import crypto from 'node:crypto';
import { Query } from 'node-appwrite';
import { config } from '../config.js';
import { adminDatabases, isSessionDead, sessionScoped } from './appwrite.js';

/**
 * The facade's own session store. [ADR-0014, ADR-0015]
 *
 * We issue OUR opaque token to the client — the client contract is identical to
 * custom-backend's, so index.html cannot tell the backends apart. Behind it we
 * hold the Appwrite session that does the real work.
 *
 * Stored per session:
 *   $id            first 32 hex of sha256(token) — Appwrite ids max out at 36
 *   tokenHash      the FULL sha256 hex, verified on read so the short id is
 *                  only a lookup key and never the security boundary
 *   userId         Appwrite user id
 *   sessionId      Appwrite session id, needed to delete it on logout
 *   secretEnc      the Appwrite session secret, AES-256-GCM encrypted
 *   expiresAt      our own absolute 30-minute expiry
 */

const TOKEN_BYTES = 32;

export function generateToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString('base64url');
}

function fullHash(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Appwrite document ids are capped at 36 chars, so a 64-char sha256 hex will
 * not fit. We use the first 32 (128 bits) as the id — enough that finding a
 * collision is infeasible — and store the full digest as an attribute which is
 * compared on every read. The short id is an index; the full hash is the check.
 */
function shortId(token) {
  return fullHash(token).slice(0, 32);
}

// --- encryption at rest ----------------------------------------------------
// The Appwrite session secret is a live credential: anyone holding it can act
// as that user. Storing it as plaintext in a collection the API key can read
// would mean a leaked database dump hands over every active session. Same
// reasoning that makes custom-backend store only sha256(token) — except here
// we must be able to USE the secret, so it is encrypted rather than hashed.
function encryptionKey() {
  const raw = config.sessionEncryptionKey;
  if (!raw) {
    throw new Error(
      'SESSION_ENCRYPTION_KEY is not set — refusing to store Appwrite session ' +
        'secrets in plaintext. Generate one with: ' +
        'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"'
    );
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error(`SESSION_ENCRYPTION_KEY must decode to 32 bytes, got ${key.length}`);
  }
  return key;
}

function encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${enc.toString('base64')}.${tag.toString('base64')}`;
}

function decrypt(payload) {
  const [ivB64, encB64, tagB64] = String(payload).split('.');
  if (!ivB64 || !encB64 || !tagB64) throw new Error('malformed encrypted secret');
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    encryptionKey(),
    Buffer.from(ivB64, 'base64')
  );
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(encB64, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

// --- store -----------------------------------------------------------------
const db = () => adminDatabases();
const DB_ID = () => config.appwrite.databaseId;
const COL = () => config.appwrite.sessionsCollectionId;

export async function createSession({ userId, sessionId, secret }) {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + config.sessionTtlMinutes * 60_000);

  await db().createDocument(DB_ID(), COL(), shortId(token), {
    tokenHash: fullHash(token),
    userId,
    sessionId,
    secretEnc: encrypt(secret),
    expiresAt: expiresAt.toISOString(),
  });

  return { token, expiresAt };
}

/**
 * Resolve our token to { userId, sessionId, secret }, or null.
 *
 * Returns null — never throws — for every failure mode a caller might present:
 * absent token, unknown token, hash mismatch, expired session. The route turns
 * that into one indistinguishable 401.
 */
export async function resolveSession(token) {
  if (!token) return null;

  let doc;
  try {
    doc = await db().getDocument(DB_ID(), COL(), shortId(token));
  } catch {
    return null;
  }

  // The short id got us the row; the full digest is what authorises it.
  // Constant-time so the comparison cannot be probed byte by byte.
  const expected = Buffer.from(fullHash(token), 'utf8');
  const actual = Buffer.from(String(doc.tokenHash ?? ''), 'utf8');
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    return null;
  }

  if (new Date(doc.expiresAt).getTime() <= Date.now()) {
    // Our own expiry fired. Clean up both sides rather than leaving the
    // Appwrite session alive behind a token that no longer works. [ADR-0014]
    await destroySession(token).catch(() => {});
    return null;
  }

  let secret;
  try {
    secret = decrypt(doc.secretEnc);
  } catch {
    return null;
  }

  return { userId: doc.userId, sessionId: doc.sessionId, secret, docId: doc.$id };
}

/**
 * Kill BOTH sides: the Appwrite session and our record. [R1.3]
 *
 * Order matters. Appwrite first, because that is the credential that actually
 * grants access — if the process dies between the two calls, we would rather
 * be left with an orphaned facade record pointing at a dead Appwrite session
 * (fails closed, resolves to a 401) than a live Appwrite session with no record
 * of it (fails open, and nothing left to revoke it with).
 */
export async function destroySession(token) {
  const session = await resolveSessionRaw(token);
  if (!session) return false;

  try {
    const { account } = sessionScoped(session.secret);
    await account.deleteSession(session.sessionId);
  } catch (err) {
    // Already gone on Appwrite's side is a success, not a failure.
    if (!isSessionDead(err)) {
      console.error('[sessions] Appwrite deleteSession failed:', err.message);
    }
  }

  try {
    await db().deleteDocument(DB_ID(), COL(), session.docId);
  } catch (err) {
    console.error('[sessions] facade record delete failed:', err.message);
  }

  return true;
}

/** Like resolveSession but skips the expiry check — logout must work on an
 *  expired token too, so the Appwrite session still gets torn down. */
async function resolveSessionRaw(token) {
  if (!token) return null;
  try {
    const doc = await db().getDocument(DB_ID(), COL(), shortId(token));
    const expected = Buffer.from(fullHash(token), 'utf8');
    const actual = Buffer.from(String(doc.tokenHash ?? ''), 'utf8');
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
      return null;
    }
    return { userId: doc.userId, sessionId: doc.sessionId, secret: decrypt(doc.secretEnc), docId: doc.$id };
  } catch {
    return null;
  }
}

/** Drop our records whose absolute expiry has passed. Housekeeping only. */
export async function purgeExpiredSessions() {
  try {
    const { documents } = await db().listDocuments(DB_ID(), COL(), [
      Query.lessThan('expiresAt', new Date().toISOString()),
      Query.limit(100),
    ]);
    for (const doc of documents) {
      await db().deleteDocument(DB_ID(), COL(), doc.$id).catch(() => {});
    }
    return documents.length;
  } catch {
    return 0;
  }
}

export { fullHash };
