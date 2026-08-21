/**
 * Idempotent provisioning: database, collections, attributes, indexes, bucket.
 * Running it twice is safe — every step treats "already exists" (409) as success.
 *
 * This is the "no console clicking" path. Everything the facade needs, in one
 * command, in code a reviewer can read — which is also what makes the
 * Appwrite-vs-us split in README question 4 checkable rather than a claim.
 *
 * Admin API key throughout: provisioning is one of its two sanctioned uses. [ADR-0002]
 */
import { config } from '../src/config.js';
import { adminDatabases, adminStorage } from '../src/lib/appwrite.js';

const databases = adminDatabases();
const storage = adminStorage();

const DB = config.appwrite.databaseId;
const FILES = config.appwrite.filesCollectionId;
const SESSIONS = config.appwrite.sessionsCollectionId;
const ATTEMPTS = config.appwrite.attemptsCollectionId;
const BUCKET = config.appwrite.bucketId;

const exists = (err) => err?.code === 409;

async function step(label, fn) {
  try {
    await fn();
    console.log(`[provision] created  ${label}`);
  } catch (err) {
    if (exists(err)) console.log(`[provision] exists   ${label}`);
    else throw new Error(`${label}: ${err.message}`);
  }
}

/** Attributes are created asynchronously; indexes fail if they are not ready. */
async function waitForAttributes(collectionId, keys, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const { attributes } = await databases.listAttributes(DB, collectionId);
    const byKey = new Map(attributes.map((a) => [a.key, a.status]));
    const pending = keys.filter((k) => byKey.get(k) !== 'available');

    if (pending.length === 0) return;
    await new Promise((r) => setTimeout(r, 500));
  }

  throw new Error(`attributes on ${collectionId} not available within ${timeoutMs}ms`);
}

/**
 * Cloud and self-hosted differ ONLY in how you obtain a project id and API key —
 * Cloud has no API for creating a project, so that is done in the console, while
 * self-hosted can script it via `npm run bootstrap`. From this point on the two
 * paths are the same code, which is the entire drift mitigation: there is one
 * provisioning script, not two. [ADR-0017]
 */
function describeTarget() {
  const host = config.appwrite.endpoint;
  const isCloud = /(^|\.)cloud\.appwrite\.io/.test(host);
  return { isCloud, label: isCloud ? 'Appwrite Cloud' : 'self-hosted Appwrite' };
}

async function main() {
  const { label } = describeTarget();
  console.log(`[provision] target: ${label}`);
  console.log(`[provision] ${config.appwrite.endpoint} project=${config.appwrite.projectId}`);

  // --- database ------------------------------------------------------------

  await step(`database ${DB}`, () => databases.create(DB, 'Osdag Secure Login'));

  // --- files collection ----------------------------------------------------
  //
  // documentSecurity: true is THE line that makes ADR-0002 true. With it,
  // per-document permissions are enforced instead of collection-wide ones, so
  // a user's session can read exactly the documents that name them and nothing
  // else. Collection-level permissions are left EMPTY: no role has blanket
  // access, so there is no path by which one user's session reaches another's
  // document. Ownership then lives in each document's own permission list,
  // written at seed time.

  await step(`collection ${FILES}`, () =>
    databases.createCollection(DB, FILES, 'Files', [], true)
  );

  await step(`${FILES}.ownerId`, () =>
    databases.createStringAttribute(DB, FILES, 'ownerId', 64, true));
  await step(`${FILES}.fileName`, () =>
    databases.createStringAttribute(DB, FILES, 'fileName', 255, true));
  await step(`${FILES}.mimeType`, () =>
    databases.createStringAttribute(DB, FILES, 'mimeType', 128, true));
  await step(`${FILES}.sizeBytes`, () =>
    databases.createIntegerAttribute(DB, FILES, 'sizeBytes', true));
  await step(`${FILES}.storageFileId`, () =>
    databases.createStringAttribute(DB, FILES, 'storageFileId', 64, true));
  await step(`${FILES}.uploadedAt`, () =>
    databases.createStringAttribute(DB, FILES, 'uploadedAt', 64, true));

  await waitForAttributes(FILES, [
    'ownerId', 'fileName', 'mimeType', 'sizeBytes', 'storageFileId', 'uploadedAt',
  ]);

  await step(`${FILES} index uploadedAt`, () =>
    databases.createIndex(DB, FILES, 'idx_uploadedAt', 'key', ['uploadedAt'], ['ASC'])
  );
  await step(`${FILES} index ownerId`, () =>
    databases.createIndex(DB, FILES, 'idx_ownerId', 'key', ['ownerId'], ['ASC'])
  );

  // --- facade bookkeeping collections --------------------------------------
  //
  // These hold NO user-owned data: they are the facade's session store and
  // rate-limit counters, the equivalent of custom-backend's own tables. Both
  // are created with NO permissions for anyone and documentSecurity off, which
  // means only the API key can touch them — no user session can read another
  // user's session record, or even their own. [ADR-0016]

  await step(`collection ${SESSIONS}`, () =>
    databases.createCollection(DB, SESSIONS, 'Facade Sessions', [], false)
  );

  await step(`${SESSIONS}.tokenHash`, () =>
    databases.createStringAttribute(DB, SESSIONS, 'tokenHash', 64, true));
  await step(`${SESSIONS}.userId`, () =>
    databases.createStringAttribute(DB, SESSIONS, 'userId', 64, true));
  await step(`${SESSIONS}.sessionId`, () =>
    databases.createStringAttribute(DB, SESSIONS, 'sessionId', 64, true));
  await step(`${SESSIONS}.secretEnc`, () =>
    databases.createStringAttribute(DB, SESSIONS, 'secretEnc', 4096, true));
  await step(`${SESSIONS}.expiresAt`, () =>
    databases.createStringAttribute(DB, SESSIONS, 'expiresAt', 64, true));

  await waitForAttributes(SESSIONS, [
    'tokenHash', 'userId', 'sessionId', 'secretEnc', 'expiresAt',
  ]);

  await step(`${SESSIONS} index expiresAt`, () =>
    databases.createIndex(DB, SESSIONS, 'idx_expiresAt', 'key', ['expiresAt'], ['ASC'])
  );

  await step(`collection ${ATTEMPTS}`, () =>
    databases.createCollection(DB, ATTEMPTS, 'Facade Login Attempts', [], false)
  );

  await step(`${ATTEMPTS}.label`, () =>
    databases.createStringAttribute(DB, ATTEMPTS, 'label', 320, true));
  await step(`${ATTEMPTS}.failures`, () =>
    databases.createIntegerAttribute(DB, ATTEMPTS, 'failures', true));
  await step(`${ATTEMPTS}.windowStartedAt`, () =>
    databases.createStringAttribute(DB, ATTEMPTS, 'windowStartedAt', 64, true));

  await waitForAttributes(ATTEMPTS, ['label', 'failures', 'windowStartedAt']);

  // --- storage bucket ------------------------------------------------------
  //
  // fileSecurity: true, and again NO bucket-level permissions — so per-file
  // permissions decide, and a user session can only fetch bytes for files that
  // name them. Encryption at rest is Appwrite's own feature; we just turn it on.

  await step(`bucket ${BUCKET}`, () =>
    storage.createBucket(
      BUCKET,
      'User Files',
      [],                // no bucket-wide permissions
      true,              // fileSecurity — per-file permissions apply
      true,              // enabled
      30_000_000,        // max file size (Appwrite caps this at 30,000,000)
      undefined,         // allowedFileExtensions: any
      undefined,         // compression: default
      true,              // encryption at rest
      false              // antivirus off: self-hosted scanner is a separate container
    )
  );

  console.log('[provision] done — schema and permissions are in place');
  console.log('[provision] next: npm run seed');
}

main().catch((err) => {
  console.error('[provision] FAILED:', err.message);

  // The overwhelmingly common Cloud failure is an API key created without the
  // scopes this needs — the console does not select them by default. Say so,
  // rather than leaving a bare 401 to be interpreted.
  if (/401|unauthorized|missing scopes?/i.test(err.message)) {
    console.error('');
    console.error('[provision] That looks like an API key scope problem.');
    console.error('[provision] In the Appwrite console: Overview -> Integrations -> API Keys,');
    console.error('[provision] edit your key and enable these scopes:');
    console.error('[provision]   users.read users.write databases.read databases.write');
    console.error('[provision]   collections.read collections.write attributes.read attributes.write');
    console.error('[provision]   indexes.read indexes.write documents.read documents.write');
    console.error('[provision]   files.read files.write buckets.read buckets.write sessions.write');
  }

  if (/fetch failed|ENOTFOUND|ECONNREFUSED/i.test(err.message)) {
    console.error('');
    console.error(`[provision] Could not reach ${config.appwrite.endpoint}`);
    console.error('[provision] Cloud: check APPWRITE_ENDPOINT matches the region shown in your');
    console.error('[provision]        console (e.g. https://fra.cloud.appwrite.io/v1).');
    console.error('[provision] Self-hosted: is the stack up? `docker ps | grep appwrite`');
  }

  process.exit(1);
});
