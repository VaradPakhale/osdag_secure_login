/**
 * Clears login-attempt counters. [ADR-0006]
 *
 * A reviewer who trips the limiter mid-review is otherwise stuck for up to 15
 * minutes, and the counters live in Postgres on purpose, so restarting the
 * server does NOT clear them.
 *
 * This exists so the documented reset does not depend on `psql` being installed
 * — it usually is not on a machine that runs Postgres in Docker. Mirrors
 * appwrite-backend's script of the same name.
 *
 *   npm run reset-lockout                       # clear every counter
 *   npm run reset-lockout -- bob@example.com    # clear one address
 */
import { closePool, query } from '../src/db.js';

const target = process.argv[2]?.trim().toLowerCase();

async function main() {
  if (target) {
    const { rowCount } = await query('DELETE FROM login_attempts WHERE key = $1', [
      `email:${target}`,
    ]);
    console.log(
      rowCount > 0
        ? `[reset] cleared counter for ${target}`
        : `[reset] no counter found for ${target} (nothing to clear)`
    );
  } else {
    const { rowCount } = await query('DELETE FROM login_attempts');
    console.log(`[reset] done — ${rowCount} counter(s) cleared`);
  }
  await closePool();
}

main().catch(async (err) => {
  console.error('[reset] FAILED:', err.message);
  await closePool().catch(() => {});
  process.exit(1);
});
