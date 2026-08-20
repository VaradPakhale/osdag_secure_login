import { createApp } from './app.js';
import { config } from './config.js';
import { closePool, query } from './db.js';
import { purgeExpiredSessions } from './lib/tokens.js';

const app = createApp();

// Fail fast and loudly if the database is unreachable, rather than serving 500s
// that look like application bugs.
try {
  await query('SELECT 1');
} catch (err) {
  console.error('[startup] cannot reach DATABASE_URL:', err.message);
  console.error('[startup] is Postgres running? see custom-backend/README.md');
  process.exit(1);
}

// Expired rows are already ignored by resolveSession's `expires_at > now()`,
// so this is housekeeping, not enforcement.
const purgeTimer = setInterval(() => {
  purgeExpiredSessions().catch((err) =>
    console.error('[sessions] purge failed:', err.message)
  );
}, 5 * 60_000);
purgeTimer.unref();

const server = app.listen(config.port, () => {
  console.log(`[server] listening on http://localhost:${config.port}`);
  console.log(
    `[server] sessions: bearer + cookie alias, ${config.sessionTtlMinutes} min absolute expiry`
  );
  console.log(
    `[server] login limiter: ${config.loginRateLimit.emailMax}/${config.loginRateLimit.emailWindowMinutes}min per email, ` +
      `${config.loginRateLimit.ipMax}/${config.loginRateLimit.ipWindowMinutes}min per IP`
  );
});

async function shutdown(signal) {
  console.log(`\n[server] ${signal} received, shutting down`);
  clearInterval(purgeTimer);
  server.close(async () => {
    await closePool();
    process.exit(0);
  });
  // Don't hang forever on a stuck connection.
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
