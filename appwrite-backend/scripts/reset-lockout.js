/**
 * Clears login-attempt counters. [ADR-0006]
 *
 * A reviewer who trips the limiter mid-review is otherwise stuck for up to 15
 * minutes, and the counters live in Appwrite on purpose, so restarting the
 * facade does NOT clear them. This is the documented escape hatch — the
 * Appwrite equivalent of custom-backend's `DELETE FROM login_attempts;`.
 *
 * Unlike `npm run seed` this leaves users and files untouched, so it is safe to
 * run mid-review without changing any ids.
 *
 *   npm run reset-lockout                 # clear every counter
 *   npm run reset-lockout -- bob@example.com   # clear one address
 */
import crypto from 'node:crypto';
import { Query } from 'node-appwrite';
import { config } from '../src/config.js';
import { adminDatabases } from '../src/lib/appwrite.js';

const databases = adminDatabases();
const DB = config.appwrite.databaseId;
const COL = config.appwrite.attemptsCollectionId;

const target = process.argv[2]?.trim().toLowerCase();

async function main() {
  if (target) {
    // Same key derivation as middleware/rateLimit.js.
    const id = `email_${crypto.createHash('sha256').update(target).digest('hex').slice(0, 28)}`;
    try {
      await databases.deleteDocument(DB, COL, id);
      console.log(`[reset] cleared counter for ${target}`);
    } catch {
      console.log(`[reset] no counter found for ${target} (nothing to clear)`);
    }
    return;
  }

  const { documents } = await databases.listDocuments(DB, COL, [Query.limit(100)]);
  for (const doc of documents) {
    await databases.deleteDocument(DB, COL, doc.$id).catch(() => {});
    console.log(`[reset] cleared ${doc.label}`);
  }
  console.log(`[reset] done — ${documents.length} counter(s) cleared`);
}

main().catch((err) => {
  console.error('[reset] FAILED:', err.message);
  process.exit(1);
});
