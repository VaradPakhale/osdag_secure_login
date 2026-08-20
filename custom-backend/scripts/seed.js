/**
 * Seeds the 3 accounts and 6 files from ../../web/seed-data.json. [R4.1, S3]
 *
 * seed-data.json carries PLAINTEXT passwords and says so (line 2): they are
 * placeholders to be hashed before insertion. This script is the thing that
 * does that hashing — argon2id, identical parameters to the live register
 * path, so a seeded account is indistinguishable from a registered one. [R5.1]
 *
 * Idempotent: it deletes the seeded users first (ON DELETE CASCADE clears
 * their files and sessions) and re-inserts. Self-registered accounts are left
 * alone.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../src/config.js';
import { closePool, pool } from '../src/db.js';
import { hashPassword } from '../src/lib/passwords.js';
import { generateSampleFile } from './lib/sample-files.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SEED_FILE = path.resolve(HERE, '..', '..', 'web', 'seed-data.json');

async function main() {
  const seed = JSON.parse(await fs.readFile(SEED_FILE, 'utf8'));
  const storageDir = config.storageDir;
  await fs.mkdir(storageDir, { recursive: true });

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const ids = seed.users.map((u) => u.id);
    const { rowCount: removed } = await client.query(
      'DELETE FROM users WHERE id = ANY($1::text[])',
      [ids]
    );
    if (removed > 0) console.log(`[seed] removed ${removed} existing seeded user(s)`);

    for (const user of seed.users) {
      const emailNorm = user.email.trim().toLowerCase();
      const passwordHash = await hashPassword(user.password);

      await client.query(
        `INSERT INTO users (id, email, email_norm, password_hash,
                            full_name, display_name, bio, role, created_at)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          user.id,
          user.email,
          emailNorm,
          passwordHash,
          user.profile.fullName,
          user.profile.displayName,
          user.profile.bio,
          user.profile.role,
          user.profile.createdAt,
        ]
      );

      const written = [];

      for (const file of user.files) {
        // Keep the real extension: the blob genuinely IS a PDF/PNG/JPEG/DOCX,
        // so it opens if a reviewer pokes at storage/ directly. [ADR-0013]
        const storageKey = `${file.id}${path.extname(file.fileName) || '.bin'}`;

        // Buffer in, Buffer out — nothing is ever round-tripped through a utf8
        // string, which would silently corrupt every byte above 0x7F.
        const bytes = await generateSampleFile(file, user);
        await fs.writeFile(path.join(storageDir, storageKey), bytes);

        await client.query(
          `INSERT INTO files (id, owner_id, file_name, mime_type,
                              size_bytes, storage_key, uploaded_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            file.id,
            user.id,          // trust the parent, not file.ownerId
            file.fileName,
            file.mimeType,
            bytes.length,     // the REAL size on disk, not seed-data.json's
                              // declared figure — Content-Length must be
                              // truthful or the download is malformed. [ADR-0013]
            storageKey,
            file.uploadedAt,
          ]
        );

        written.push(
          `${file.id}  ${storageKey.padEnd(14)} ${String(bytes.length).padStart(7)} bytes  ` +
            `(seed-data.json declared ${file.sizeBytes})  ${file.fileName}`
        );
      }

      console.log(
        `[seed] ${user.email.padEnd(20)} ${user.id}  ${user.files.length} file(s)  ` +
          `password: ${user.password}`
      );
      for (const line of written) console.log(`[seed]   ${line}`);
    }

    // A stale lockout from a previous run would greet the reviewer with a 429
    // on their first login attempt, which looks exactly like a bug. [ADR-0006]
    const { rowCount: cleared } = await client.query('DELETE FROM login_attempts');
    if (cleared > 0) console.log(`[seed] cleared ${cleared} login-attempt counter(s)`);

    await client.query('COMMIT');

    console.log(`[seed] done — ${seed.users.length} users, blobs in ${storageDir}`);
    console.log('[seed] all seeded passwords are Password123! (see web/seed-data.json)');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await closePool();
  }
}

main().catch((err) => {
  console.error('[seed] FAILED:', err.message);
  process.exit(1);
});
