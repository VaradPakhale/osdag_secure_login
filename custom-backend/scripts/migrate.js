/**
 * Applies every unapplied file in migrations/, in filename order, inside a
 * transaction, and records it in schema_migrations.
 *
 * Schema changes live in versioned files rather than hand-run SQL so that the
 * database a reviewer builds is provably the one this code was written against.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closePool, pool } from '../src/db.js';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

async function main() {
  const client = await pool.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const files = (await fs.readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();

    const { rows } = await client.query('SELECT filename FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.filename));

    let count = 0;
    for (const filename of files) {
      if (applied.has(filename)) {
        console.log(`[migrate] skip    ${filename} (already applied)`);
        continue;
      }

      const sql = await fs.readFile(path.join(MIGRATIONS_DIR, filename), 'utf8');

      // Each migration is atomic: a failure halfway through leaves nothing behind.
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [filename]);
        await client.query('COMMIT');
        console.log(`[migrate] applied ${filename}`);
        count += 1;
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${filename} failed: ${err.message}`);
      }
    }

    console.log(`[migrate] done — ${count} migration(s) applied, ${files.length} total`);
  } finally {
    client.release();
    await closePool();
  }
}

main().catch((err) => {
  console.error('[migrate] FAILED:', err.message);
  process.exit(1);
});
