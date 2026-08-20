import pg from 'pg';
import { config } from './config.js';

// bigint (int8) arrives as a string by default because it can exceed Number's
// safe range. sizeBytes is small and the contract shows it as a JSON number
// (web/seed-data.json:22), so parse it back.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number.parseInt(v, 10));

export const pool = new pg.Pool({ connectionString: config.databaseUrl });

pool.on('error', (err) => {
  // An idle client dying is not fatal; log it rather than taking the process out.
  console.error('[db] idle client error:', err.message);
});

/** Run a parameterised query. Every call site passes values as $1, $2, ... */
export function query(text, params) {
  return pool.query(text, params);
}

/** First row, or null. */
export async function queryOne(text, params) {
  const { rows } = await pool.query(text, params);
  return rows[0] ?? null;
}

export async function closePool() {
  await pool.end();
}
