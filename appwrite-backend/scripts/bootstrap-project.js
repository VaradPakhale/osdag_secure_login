/**
 * Bootstraps a self-hosted Appwrite instance to the point where provision.js
 * can run: a console account, a team, a project, and an API key.
 *
 * On Appwrite Cloud you do this by clicking through the console instead, and
 * you can skip this script entirely — just paste the project id and API key
 * into .env. It exists so that a reviewer running a local Appwrite gets to a
 * working state with one command and no console clicking.
 *
 * Idempotent: re-running logs in to the existing console account and reuses the
 * fixed team/project ids. It always mints a NEW API key, because Appwrite
 * returns a key's secret only at creation time and there is no way to read an
 * existing one back.
 *
 * Uses raw fetch rather than node-appwrite: these are console-scoped endpoints
 * driven by a console session, which is outside what the server SDK models.
 */
import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ENDPOINT = process.env.APPWRITE_ENDPOINT ?? 'http://localhost/v1';
const PROJECT_ID = process.env.APPWRITE_PROJECT_ID || 'osdag-secure-login';
const PROJECT_NAME = 'Osdag Secure Login';
const TEAM_ID = 'osdag-team';

// Console credentials for the LOCAL instance only. Overridable, and never a
// real secret — this is a throwaway dev instance created by this script.
const CONSOLE_EMAIL = process.env.APPWRITE_CONSOLE_EMAIL ?? 'admin@example.com';
const CONSOLE_PASSWORD = process.env.APPWRITE_CONSOLE_PASSWORD ?? 'ConsolePassword123!';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Scopes the facade needs: provisioning + user/account management. */
const KEY_SCOPES = [
  'users.read', 'users.write',
  'teams.read', 'teams.write',
  'databases.read', 'databases.write',
  'collections.read', 'collections.write',
  'attributes.read', 'attributes.write',
  'indexes.read', 'indexes.write',
  'documents.read', 'documents.write',
  'files.read', 'files.write',
  'buckets.read', 'buckets.write',
  'sessions.write',
];

let cookie = '';

async function api(method, pathname, { body, project = 'console', headers = {} } = {}) {
  const res = await fetch(ENDPOINT + pathname, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Appwrite-Project': project,
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const setCookie = res.headers.getSetCookie?.() ?? [];
  const session = setCookie.find((c) => c.startsWith('a_session_console='));
  if (session) cookie = session.split(';')[0];

  const text = await res.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

async function main() {
  console.log(`[bootstrap] endpoint ${ENDPOINT}`);

  // 1. Console account. 409 means it already exists, which is fine.
  const created = await api('POST', '/account', {
    body: {
      userId: 'unique()',
      email: CONSOLE_EMAIL,
      password: CONSOLE_PASSWORD,
      name: 'Osdag Reviewer',
    },
  });
  if (created.status === 201) console.log('[bootstrap] console account created');
  else if (created.status === 409) console.log('[bootstrap] console account already exists');
  else throw new Error(`account create failed: ${created.status} ${JSON.stringify(created.body)}`);

  // 2. Console session.
  const session = await api('POST', '/account/sessions/email', {
    body: { email: CONSOLE_EMAIL, password: CONSOLE_PASSWORD },
  });
  if (session.status !== 201) {
    throw new Error(`console login failed: ${session.status} ${JSON.stringify(session.body)}`);
  }
  console.log('[bootstrap] console session established');

  // 3. Team (a project must belong to one).
  const team = await api('POST', '/teams', {
    body: { teamId: TEAM_ID, name: 'Osdag' },
  });
  if (team.status === 201) console.log(`[bootstrap] team ${TEAM_ID} created`);
  else if (team.status === 409) console.log(`[bootstrap] team ${TEAM_ID} already exists`);
  else throw new Error(`team create failed: ${team.status} ${JSON.stringify(team.body)}`);

  // 4. Project, with a fixed id so re-running is idempotent.
  const project = await api('POST', '/projects', {
    body: { projectId: PROJECT_ID, name: PROJECT_NAME, teamId: TEAM_ID, region: 'default' },
  });
  if (project.status === 201) console.log(`[bootstrap] project ${PROJECT_ID} created`);
  else if (project.status === 409) console.log(`[bootstrap] project ${PROJECT_ID} already exists`);
  else throw new Error(`project create failed: ${project.status} ${JSON.stringify(project.body)}`);

  // 5. API key. Always new — Appwrite reveals the secret only on creation.
  const key = await api('POST', `/projects/${PROJECT_ID}/keys`, {
    body: { name: `facade-key-${Date.now()}`, scopes: KEY_SCOPES, expire: null },
  });
  if (key.status !== 201) {
    throw new Error(`key create failed: ${key.status} ${JSON.stringify(key.body)}`);
  }
  const secret = key.body.secret;
  console.log(`[bootstrap] API key minted (${KEY_SCOPES.length} scopes)`);

  // 6. Write .env.local so the reviewer does not have to copy-paste secrets.
  const envPath = path.join(PACKAGE_ROOT, '.env.local');
  await fs.writeFile(
    envPath,
    [
      '# Generated by `npm run bootstrap`. Gitignored — contains a real API key.',
      `APPWRITE_ENDPOINT=${ENDPOINT}`,
      `APPWRITE_PROJECT_ID=${PROJECT_ID}`,
      `APPWRITE_API_KEY=${secret}`,
      '',
    ].join('\n'),
    'utf8'
  );

  console.log(`[bootstrap] wrote ${envPath}`);
  console.log('[bootstrap] next: npm run setup');
}

main().catch((err) => {
  console.error('[bootstrap] FAILED:', err.message);
  process.exit(1);
});
