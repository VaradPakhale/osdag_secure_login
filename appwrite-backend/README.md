# Appwrite backend — server-side facade

Exposes the **same API as `custom-backend`**, byte for byte, backed by Appwrite instead of
Postgres. The same unmodified `web/index.html` works against both: change the Base URL field to
`http://localhost:3001` and nothing else. That is usage, not a modification of the client.

Design rationale is in [`../DECISIONS.md`](../DECISIONS.md) — ADR-0002 (why a facade rather than a
browser adapter), ADR-0014 (session secret rather than JWT), ADR-0015 (encryption at rest),
ADR-0016 (where the facade's own state lives), ADR-0017 (Cloud vs self-hosted). This file is setup,
operation, and the Appwrite-versus-us split.

## Setup

Requires Node ≥ 20 and an Appwrite project. **Appwrite Cloud is the default** — nothing to install.
Self-hosted works identically and needs no account. Why both are supported, and why self-hosting
was never non-compliant with "a managed backend", is ADR-0017.

Both paths have been run end to end against a real Appwrite instance, Cloud included — provision,
seed, and the full flow through the unmodified `web/index.html`. ADR-0017 records exactly what was
observed and what was not (one region, one project, no load testing).

### Path A — Appwrite Cloud (recommended, about two minutes)

In the console at <https://cloud.appwrite.io>:

1. **Create a project.** Note its **Project ID** and the **API Endpoint** shown in Settings. Cloud
   is regional, so yours may be `https://fra.cloud.appwrite.io/v1` rather than the generic host —
   use exactly what the console shows.
2. **Create an API key**: Overview → Integrations → API Keys → Create API key.
   **The console selects no scopes by default.** Enable all of:

   ```
   users.read users.write
   databases.read databases.write
   collections.read collections.write
   attributes.read attributes.write
   indexes.read indexes.write
   documents.read documents.write
   files.read files.write
   buckets.read buckets.write
   sessions.write
   ```

   A scope-less key is the most likely failure on this path; `npm run provision` detects it and
   prints this list rather than surfacing a bare 401. The key secret is shown once.

Then:

```bash
cd appwrite-backend
npm install
cp .env.example .env     # paste endpoint, project id, API key; generate
                         # SESSION_ENCRYPTION_KEY as the file explains
npm run setup            # provision (schema, permissions, bucket) + seed
npm run dev              # http://localhost:3001
```

### Path B — self-hosted (no account required)

**Know the cost before starting.** Measured on this machine: **23 containers, ~1.4 GB RAM at
idle, ~7.5 GB of images to download on first run.** Budget **10–20 minutes** for that download
depending on connection; it is one-off and it is the slow part. Allow roughly **4 GB of free RAM**
for Docker.

```bash
mkdir appwrite && cd appwrite
docker run -it --rm \
  --volume /var/run/docker.sock:/var/run/docker.sock \
  --volume "$(pwd)":/usr/src/code/appwrite:rw \
  --entrypoint="install" appwrite/appwrite:1.6.2
# accept the defaults; it listens on http://localhost

cd ../appwrite-backend
npm install
npm run bootstrap        # console account + team + project + API key + encryption key,
                         # written to .env.local — nothing to copy by hand
npm run setup
npm run dev
```

`npm run bootstrap` exists so this path needs no console clicking at all. It is idempotent, except
that it mints a fresh API key each run — Appwrite reveals a key secret only at creation.

> **Switching from self-hosted to Cloud? Delete `.env.local` first.** Precedence is
> **exported environment → `.env.local` → `.env`**, so a leftover `.env.local` keeps pointing the
> facade at your local instance. The facade prints its endpoint and project id on startup; check
> that line if something looks wrong.

### Both paths end in the same place

```
Cloud:        console (manual)  --+
                                  +-->  npm run provision  ->  npm run seed  ->  npm run dev
Self-hosted:  npm run bootstrap --+          (one script)        (one script)
```

Exactly one provisioning script and one seed script, shared verbatim, neither branching on the
target. The paths differ only in how a project id and API key are obtained. That is the drift
mitigation, and it is structural rather than a promise to remember (ADR-0017).

## Running both backends at once

| | custom-backend | appwrite-backend |
|---|---|---|
| Base URL | `http://localhost:3000` | `http://localhost:3001` |
| store | PostgreSQL | Appwrite |

Both serve identical routes, bodies and status codes. Verified: all six seeded files are
**byte-identical** when downloaded from either.

## Seeded accounts (R4.1, S3)

Same three accounts and same file ids as `custom-backend`, from `web/seed-data.json`. Password for
all three is `Password123!`.

| Email | Files |
|---|---|
| `alice@example.com` | `file_001` resume_alice.pdf, `file_002` profile_photo.jpg |
| `bob@example.com` | `file_003` project_notes.txt, `file_004` invoice_march.pdf |
| `carol@example.com` | `file_005` test_plan.docx, `file_006` vacation.png |

**On Appwrite id constraints.** Appwrite ids must match `^[a-zA-Z0-9][a-zA-Z0-9._-]{0,35}$` — max
36 characters, no leading special character. `file_001` satisfies this as-is, so **the ids are used
verbatim with no mapping**, for both documents and storage files. Confirmed by the verification
run: `GET /files/file_001` returns 200 on both backends.

**User ids do differ.** Appwrite assigns its own `$id` at account creation and it is not ours to
choose, so `usr_001` does not carry over — you will see ids like `6a87eba9000bf412a608`. Nothing
depends on it: the profile is looked up from the session, never by id.

## Locked out? (R5.3)

Ten failed logins against one address returns `429` for 15 minutes. Counters live in Appwrite on
purpose, so **restarting the facade does not clear them**:

```bash
npm run reset-lockout                       # every counter
npm run reset-lockout -- bob@example.com    # one address
```

Unlike `npm run seed`, this leaves users and files untouched, so it is safe mid-review.

## Where Appwrite's own rate limits sit relative to ours

Appwrite applies its own abuse limits to auth endpoints, per IP and endpoint over a rolling window
— on self-hosted these are tunable through `_APP_LIMIT_*` on the containers; on Cloud they are
fixed.

**Ours fire first and are the ones that satisfy R5.3**, for three reasons: Appwrite's are keyed on
IP, which is useless in a review where every account shares `::1` (ADR-0006); they are not
configurable from this codebase; and they return Appwrite's error shape rather than our contract's
`{"error": "..."}`. Appwrite's limits remain underneath as a backstop we do not rely on — and if
one ever did fire, the translation layer maps it to our `429` body rather than leaking Appwrite's.

Our limiter trips at 10 failures per 15 minutes, comfortably inside Appwrite's own thresholds on
either deployment, so this behaves identically on Cloud and self-hosted.

## What Appwrite enforces versus what we enforce

The honest split, verified by talking to Appwrite **directly with a user's own session**, bypassing
the facade entirely.

### Appwrite enforces (we wrote no check)

| Guarantee | Mechanism | Evidence |
|---|---|---|
| A user's file list contains only their files | `documentSecurity: true`, per-document `Permission.read(Role.user(id))`, no collection-wide permissions | Unfiltered `listDocuments` returns **2 of 2** for Alice and **2 of 2** for Bob, while the admin key sees **6**. Our `/files` route passes **no** `ownerId` filter. |
| Reading another user's file document | per-document permissions | Alice → `file_003` refused by Appwrite: `code=404 type=document_not_found` |
| Reading another user's file **bytes** | `fileSecurity: true` on the bucket, per-file permissions | Alice → `getFileDownload(file_003)` refused: `code=404 type=storage_file_not_found` |
| `/me` cannot name another user (R2.2) | `account.get()` takes no identifier at all | There is no argument to supply. `?id=`, `X-User-Id:` and path suffixes are ignored because nothing reads them. |
| Password hashing (R5.1) | Appwrite hashes with argon2id internally | We never see, choose, or store a hash — contrast custom-backend, where we configure argon2id ourselves |
| Session creation and invalidation | `createEmailPasswordSession` / `deleteSession` | After logout, the stored secret used **directly against Appwrite** returns `401 general_unauthorized_scope` |
| Encryption of file bytes at rest | bucket `encryption: true` | configured in `provision.js`, enforced by Appwrite |

### We enforce (Appwrite does not give it to us)

| Guarantee | Why Appwrite does not cover it |
|---|---|
| **403 vs 404 for another user's file (R3.3)** | Appwrite answers **404 for both** — deliberately, so as not to disclose existence. R3.3 requires them **distinct**, so `resolveOwnedFile()` does an explicit existence probe with the admin key after the user-scoped read misses. That probe selects no user data, only whether the id exists. **This is the single most important row in this table**: the one isolation-adjacent behaviour the platform actively works against. |
| **Rate limiting / lockout (R5.3)** | Appwrite's limits are IP-keyed and not configurable from here. Ours are email-keyed. See above. |
| **Generic login error (R5.2)** | Appwrite returns distinguishable errors (`user_not_found` vs `user_invalid_credentials`). The translation layer collapses every credential failure to one identical `401` body. |
| **409 on duplicate registration (ADR-0004)** | Appwrite's own code/type is mapped to our contract's status and body. |
| **All contract status codes and bodies** | Appwrite's error shape (`{message, code, type, version}`) never reaches the client. One translation layer, `src/lib/contract-errors.js`. |
| **JSON on every response (ADR-0007)** | Express's HTML 404/500 defaults would freeze the client's output pane. |
| **Our 30-minute absolute session expiry** | Appwrite sessions last far longer; ours is the binding limit (ADR-0014). |
| **Encryption of the session secret at rest** | Appwrite has no opinion on how a facade stores its credentials (ADR-0015). |
| **CORS for the browser client** | The facade is the origin the client talks to, not Appwrite. |

### The one nuance worth stating plainly

Appwrite's isolation is real and does the heavy lifting — but it is tuned for *confidentiality*,
which is why it returns 404 rather than 403 for another user's document. The task requires the
opposite for R3.3. So the facade has to *reduce* confidentiality slightly, on purpose, using the
admin key to distinguish the two. Everything else on the "we enforce" list is contract translation
rather than security we had to build ourselves.

## The admin API key

Used for exactly two things on the request path — **provisioning** and **registration/login**
(creating the account, creating the session) — plus the facade's own bookkeeping collections, which
hold no user data (ADR-0016). The assertion is written at the point of instantiation in
[`src/lib/appwrite.js`](src/lib/appwrite.js).

**No route that reads or returns user data uses it.** `/me`, `/files`, `/files/:id` and
`/files/:id/download` all go through `sessionScoped()`. The one exception is the existence probe
above, which reads no fields.

## Layout

```
scripts/bootstrap-project.js  console account + team + project + API key (SELF-HOSTED only)
scripts/provision.js          idempotent: database, collections, attributes, indexes, bucket
scripts/seed.js               the 3 users + 6 files; reuses custom-backend's file generators
scripts/reset-lockout.js      the documented lockout escape hatch
src/lib/appwrite.js           admin vs session-scoped clients; the ADR-0002 assertion
src/lib/contract-errors.js    THE translation layer — Appwrite errors -> our contract
src/lib/sessions.js           opaque token -> encrypted Appwrite session secret
src/middleware/auth.js        THE auth middleware, on every protected route (R5.4)
src/middleware/rateLimit.js   email-keyed + IP-keyed counters
src/middleware/errors.js      JSON 404 + JSON 500 — do not delete, see ADR-0007
src/routes/                   auth.js, me.js, files.js
```

## Notes

- **`SESSION_ENCRYPTION_KEY` is required with no fallback anywhere in the code.** The server
  refuses to start without it, and rejects a key that does not decode to exactly 32 bytes — the
  same fail-fast treatment `DATABASE_URL` gets in `custom-backend`.
- **The sample-file generators are imported from `custom-backend`**, not copied
  (`scripts/lib/sample-files.js`). One definition, no drift — which is what lets both backends
  serve byte-identical files.
- Generated files are deterministic: PDF creation dates and ZIP entry dates are pinned, so
  re-seeding produces identical bytes.
- `sizeBytes` is the real byte count, deliberately not the larger figure in `seed-data.json`
  (ADR-0013).
- **There is no upload endpoint.** The client has no affordance for one and TASK.md:49-50 accepts
  seeded files.
