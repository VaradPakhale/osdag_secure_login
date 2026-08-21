# Custom backend — Express + PostgreSQL + argon2id

Implements the API in [`../API_CONTRACT.md`](../API_CONTRACT.md). Design rationale for every
non-obvious choice is in [`../DECISIONS.md`](../DECISIONS.md); this file is setup and operation.

> The submission-level `README.md` (JWT-vs-session reasoning, Appwrite comparison, and the rest of
> TASK.md:77-82) lives at the repository root and covers both backends. This one is scoped to
> running this one.

## Setup

Requires Node ≥ 20. Postgres can be your own or the bundled container.

```bash
cd custom-backend
npm install                   # plain install — the seed's file generators are
                              # devDependencies, so --omit=dev breaks `npm run seed`
cp .env.example .env          # defaults match the compose file below

docker compose up -d          # optional — skip if you have Postgres already
                              # and point DATABASE_URL at it instead

npm run setup                 # migrate + seed
npm run dev                   # http://localhost:3000
```

`docker-compose.yml` is a convenience, not a dependency: the app only ever reads `DATABASE_URL`.
Any reachable Postgres 13+ works.

Then open `web/index.html` (served over http:// is best — `file://` works for bearer mode but the
mock's seed fetch and all cookie-mode testing need a real origin):

```bash
npx serve ../web -l 5500      # or python -m http.server 5500 --directory ../web
```

In the page: select **Custom REST backend**, leave Base URL at `http://localhost:3000`, and click
one of the quick-fill buttons. **`web/index.html` needs no modification** — see API_CONTRACT.md §1.2.

## Seeded accounts (R4.1, S3)

From `web/seed-data.json`, hashed with argon2id at insert time. Password for all three is
`Password123!`.

| Email | User id | Files |
|---|---|---|
| `alice@example.com` | `usr_001` | `file_001` (resume_alice.pdf), `file_002` (profile_photo.jpg) |
| `bob@example.com` | `usr_002` | `file_003` (project_notes.txt), `file_004` (invoice_march.pdf) |
| `carol@example.com` | `usr_003` | `file_005` (test_plan.docx), `file_006` (vacation.png) |

To check isolation: log in as Alice, then request `file_003`. Expect **403** (Bob's file), against
**404** for `file_999` (nothing). That distinction is R3.3 and the two must not be merged.

`npm run seed` is idempotent — it deletes and re-inserts the seeded users, leaves any accounts you
registered yourself alone, and clears all lockout counters.

### The seeded files are real files

Every blob is a genuinely valid document of the type its extension claims — the PDFs open in a PDF
reader, the `.docx` opens in Word, the images open in an image viewer (ADR-0013). Each one names
its owner in visible text, so **downloading a file and opening it is itself the isolation check**:

> *This file belongs to exactly one account. If you are reading it while signed in as anyone other
> than alice@example.com, data isolation has failed.*

`sizeBytes` in the API is the **real** size on disk (~1–12 KB), which deliberately does not match
the much larger figures in `web/seed-data.json` — those describe files that never existed. The
seed output prints both numbers side by side. `Content-Length` on download is taken from the file
itself, not the database column, so it is true even if the two ever drift.

Blobs live in `storage/`, which is **gitignored** — a fresh clone has none. `npm run setup`
regenerates them; nothing needs to be committed or downloaded separately.

## Locked out? (R5.3)

Ten failed logins against one address returns `429` for 15 minutes. **Restarting the server does
not clear it** — the counter is in the database on purpose, so an attacker cannot shed a lockout by
causing a crash (ADR-0008). Either of these resets it:

```bash
npm run reset-lockout                       # every counter
npm run reset-lockout -- bob@example.com    # just one address
```

`reset-lockout` talks to Postgres through the app's own connection pool, so it does **not** need
`psql` installed — which it usually is not on a machine running Postgres in Docker. It leaves users
and files untouched, so it is safe to run mid-review. (`npm run seed` also clears the counters, but
it re-seeds everything as a side effect.)

The limiter keys on **email** first, so locking out Alice does not block Bob or Carol from the
same machine — which matters because every account in a local review shares `::1` (ADR-0006).

## Layout

```
migrations/001_init.sql     users, files, sessions, login_attempts
scripts/migrate.js          applies unapplied migrations in a transaction
scripts/seed.js             the 3 accounts + 6 files from web/seed-data.json
scripts/reset-lockout.js    the documented lockout escape hatch
scripts/lib/sample-files.js generates the real PDF/JPEG/PNG/DOCX/TXT blobs
src/config.js               env parsing; DATABASE_URL has no default, deliberately
src/db.js                   pg pool, parameterised queries only
src/lib/passwords.js        argon2id + the dummy-hash timing equaliser
src/lib/tokens.js           opaque tokens; only sha256(token) is ever stored
src/middleware/auth.js      THE auth middleware — every protected route uses it (R5.4)
src/middleware/rateLimit.js per-email + per-IP failure counters
src/middleware/cors.js      preflight, origin reflection, the file:// null-origin case
src/middleware/errors.js    JSON 404 + JSON 500 — do not delete, see ADR-0007
src/routes/                 auth.js, me.js, files.js
```

## How the security requirements are met

| | |
|---|---|
| **R1.3 logout** | `DELETE FROM sessions WHERE token_hash = sha256($1)`. The same unexpired token string then returns 401 — validity lives in the database, not the token. |
| **R2.2 `/me` isolation** | The subject is `req.auth.userId` and nothing else. No `/me/:id` route exists; `?id=`, path suffixes and headers are all ignored because no code reads them. |
| **R3.2 / R3.3 file isolation** | The data query carries `owner_id = $2` in its `WHERE`, so another user's row never enters the process. Only on a miss does a second query select the literal `1` to tell 403 from 404 — it returns no columns, so it cannot leak. |
| **R5.1 hashing** | argon2id, `m=19456,t=2,p=1`, per-row salts. The seed script uses the same function as `/register`. |
| **R5.2 generic failure** | One `GENERIC_LOGIN_ERROR` constant for every credential failure — unknown email, wrong password, missing field, wrong type. The unknown-email path verifies against a dummy hash so response *time* does not leak either. |
| **R5.4 consistent validation** | One `requireAuth`, mounted on all four protected routes. Handlers cannot obtain a user id any other way. |

## Notes

- **Bearer is the contract**; the cookie is an alias resolving to the same session row, so ticking
  "Backend uses cookie sessions" in the client works and logout revokes both (ADR-0001). Cookie
  mode cannot work from `file://` — browsers do not send credentials from an opaque origin.
- **Sessions expire absolutely after 30 minutes**, matching the mock. No sliding renewal.
- **Registration returns `409` on a duplicate email**, which discloses that the address is
  registered. Deliberate, matching the mock, and the production fix is written up in ADR-0004.
- **There is no upload endpoint.** The client has no affordance for one and TASK.md:49-50 accepts
  seeded files.
