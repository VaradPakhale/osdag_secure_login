/**
 * Seeds the same 3 accounts and 6 files as custom-backend. [R4.1, S3]
 *
 * Same emails, same passwords, same file ids (file_001 … file_006), same
 * generated sample documents — so a reviewer can point the client at either
 * backend and get identical results. The generator is IMPORTED from
 * custom-backend rather than copied: one definition, no drift.
 *
 * On Appwrite ID constraints. The syntax is ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,35}$ —
 * 36 chars max, must not start with a special character. `file_001` satisfies
 * this as-is (starts with a letter, underscore is allowed), so the ids are used
 * VERBATIM with no mapping. Verified empirically: the documents and storage
 * files below are created with exactly these ids. User ids differ — Appwrite
 * assigns its own $id at account creation and it is not ours to choose, so
 * usr_001 does NOT carry over; the profile lookup is by session, never by id,
 * so nothing depends on it.
 *
 * Admin API key throughout: seeding is provisioning. [ADR-0002]
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ID, Permission, Query, Role } from 'node-appwrite';
import { InputFile } from 'node-appwrite/file';
import { config } from '../src/config.js';
import { adminDatabases, adminStorage, adminUsers } from '../src/lib/appwrite.js';
// Reused, not duplicated — see the note above.
import { generateSampleFile } from '../../custom-backend/scripts/lib/sample-files.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SEED_FILE = path.resolve(HERE, '..', '..', 'web', 'seed-data.json');

const users = adminUsers();
const databases = adminDatabases();
const storage = adminStorage();

const DB = config.appwrite.databaseId;
const FILES = config.appwrite.filesCollectionId;
const BUCKET = config.appwrite.bucketId;

/** Delete every seeded user, their documents and their blobs, so re-running is clean. */
async function clearPrevious(emails) {
  for (const email of emails) {
    const { users: found } = await users.list([Query.equal('email', email)]);
    for (const u of found) {
      await users.delete(u.$id).catch(() => {});
      console.log(`[seed] removed existing account ${email} (${u.$id})`);
    }
  }

  const { documents } = await databases.listDocuments(DB, FILES, [Query.limit(100)]);
  for (const doc of documents) {
    await storage.deleteFile(BUCKET, doc.storageFileId).catch(() => {});
    await databases.deleteDocument(DB, FILES, doc.$id).catch(() => {});
  }
  if (documents.length) console.log(`[seed] removed ${documents.length} existing file document(s)`);
}

async function main() {
  const seed = JSON.parse(await fs.readFile(SEED_FILE, 'utf8'));

  await clearPrevious(seed.users.map((u) => u.email));

  for (const user of seed.users) {
    const emailNorm = user.email.trim().toLowerCase();

    // Appwrite hashes the password itself — argon2id by default. We never see
    // or store a hash, which is one of the things it genuinely handles for us. [R5.1]
    const account = await users.create(
      ID.unique(),
      emailNorm,
      undefined,
      user.password,
      user.profile.fullName
    );

    // Profile fields live in user prefs, which only that user's session can read.
    await users.updatePrefs(account.$id, {
      fullName: user.profile.fullName,
      displayName: user.profile.displayName,
      bio: user.profile.bio,
      role: user.profile.role,
    });

    console.log(
      `[seed] ${user.email.padEnd(20)} ${account.$id}  password: ${user.password}`
    );

    for (const file of user.files) {
      const bytes = await generateSampleFile(file, user);

      // ---------------------------------------------------------------------
      // THE ISOLATION BOUNDARY.
      //
      // These permission lists are what enforce R3.2/R3.3 — not a WHERE clause
      // in our code. Only this user may read this document and this blob;
      // every other session is refused by Appwrite itself, before our facade
      // is involved. Read-only on purpose: a seeded file is not the owner's to
      // delete, and update/delete would widen the surface for no requirement.
      // ---------------------------------------------------------------------
      const ownerOnly = [Permission.read(Role.user(account.$id))];

      // file_001 etc. used verbatim — valid Appwrite ids, see the header note.
      const stored = await storage.createFile(
        BUCKET,
        file.id,
        InputFile.fromBuffer(bytes, file.fileName),
        ownerOnly
      );

      await databases.createDocument(
        DB,
        FILES,
        file.id,
        {
          ownerId: account.$id,
          fileName: file.fileName,
          mimeType: file.mimeType,
          sizeBytes: bytes.length, // real size on disk, not the declared figure [ADR-0013]
          storageFileId: stored.$id,
          uploadedAt: file.uploadedAt,
        },
        ownerOnly
      );

      console.log(
        `[seed]   ${file.id}  ${String(bytes.length).padStart(6)} bytes  ` +
          `(seed-data.json declared ${file.sizeBytes})  ${file.fileName}`
      );
    }
  }

  // A stale lockout would greet the reviewer with a 429 on their first login,
  // which looks exactly like a bug. [ADR-0006]
  const { documents: attempts } = await databases.listDocuments(
    DB, config.appwrite.attemptsCollectionId, [Query.limit(100)]
  );
  for (const doc of attempts) {
    await databases.deleteDocument(DB, config.appwrite.attemptsCollectionId, doc.$id).catch(() => {});
  }
  if (attempts.length) console.log(`[seed] cleared ${attempts.length} login-attempt counter(s)`);

  // Facade sessions reference users that no longer exist after a re-seed.
  const { documents: sessions } = await databases.listDocuments(
    DB, config.appwrite.sessionsCollectionId, [Query.limit(100)]
  );
  for (const doc of sessions) {
    await databases.deleteDocument(DB, config.appwrite.sessionsCollectionId, doc.$id).catch(() => {});
  }
  if (sessions.length) console.log(`[seed] cleared ${sessions.length} stale facade session(s)`);

  console.log(`[seed] done — ${seed.users.length} users, ${seed.users.length * 2} files`);
  console.log('[seed] all seeded passwords are Password123! (see web/seed-data.json)');
}

main().catch((err) => {
  console.error('[seed] FAILED:', err.message);
  process.exit(1);
});
