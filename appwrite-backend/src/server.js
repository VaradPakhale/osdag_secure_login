import { createApp } from './app.js';
import { config } from './config.js';
import { adminDatabases } from './lib/appwrite.js';
import { purgeExpiredSessions } from './lib/sessions.js';

const app = createApp();

// Fail fast and loudly if Appwrite or the provisioned schema is missing,
// rather than serving 500s that look like application bugs.
try {
  await adminDatabases().get(config.appwrite.databaseId);
} catch (err) {
  console.error(`[startup] cannot reach Appwrite at ${config.appwrite.endpoint}:`, err.message);
  console.error('[startup] is Appwrite up, and have you run `npm run setup`?');
  console.error('[startup] see appwrite-backend/README.md');
  process.exit(1);
}

if (!config.sessionEncryptionKey) {
  console.error('[startup] SESSION_ENCRYPTION_KEY is not set — refusing to store');
  console.error('[startup] Appwrite session secrets in plaintext. See .env.example.');
  process.exit(1);
}

const purgeTimer = setInterval(() => {
  purgeExpiredSessions().catch((err) =>
    console.error('[sessions] purge failed:', err.message)
  );
}, 5 * 60_000);
purgeTimer.unref();

const server = app.listen(config.port, () => {
  console.log(`[server] listening on http://localhost:${config.port}  (appwrite facade)`);
  console.log(`[server] appwrite: ${config.appwrite.endpoint} project=${config.appwrite.projectId}`);
  console.log(`[server] sessions: opaque bearer -> encrypted Appwrite session, ${config.sessionTtlMinutes} min absolute`);
  console.log(
    `[server] login limiter: ${config.loginRateLimit.emailMax}/${config.loginRateLimit.emailWindowMinutes}min per email, ` +
      `${config.loginRateLimit.ipMax}/${config.loginRateLimit.ipWindowMinutes}min per IP`
  );
});

async function shutdown(signal) {
  console.log(`\n[server] ${signal} received, shutting down`);
  clearInterval(purgeTimer);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
