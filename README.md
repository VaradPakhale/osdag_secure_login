# Secure Login System with User Details & File Access

Registration, login, logout, a protected profile route, and per-user file access —
**implemented twice**, against two different backends, behind one identical HTTP contract:

- **`custom-backend/`** — hand-rolled: Express + PostgreSQL + argon2id.
- **`appwrite-backend/`** — a server-side facade over Appwrite (Cloud or self-hosted).

Both expose the same routes, the same response bodies and the same status codes, so the provided
test client works against either by changing one field. `web/index.html` is **not modified**.

## Repo layout

| Path | What it holds |
|---|---|
| [`custom-backend/`](custom-backend/README.md) | Express + PostgreSQL + argon2id implementation, its migrations, seed and setup docs |
| [`appwrite-backend/`](appwrite-backend/README.md) | The Appwrite facade, its provisioning/seed scripts, and the Appwrite-vs-us split |
| `web/` | The provided test client (`index.html`) plus the reference `mock-api.js` and `seed-data.json`. Unmodified. |
| `TASK.md` | The task text, verbatim, with requirement IDs (R1.1, R3.3 …) added for traceability |
| `API_CONTRACT.md` | The exact API surface the client expects, derived line-by-line from `index.html` and `mock-api.js`, with every ambiguity flagged |
| `DECISIONS.md` | 17 ADRs recording every judgement call, the evidence for it, and what it costs |
| `ARCHITECTURE.md` | The full lifecycle of one authenticated request through each backend, and where they diverge |

---

# 1. Prerequisites and setup

You need **Node ≥ 20** and **Docker Desktop**. Everything below has been run as written.

### Step 1 — start Docker Desktop first

**Open Docker Desktop and wait until its engine reports running before any other command.**
This is the first thing that stops people: `docker compose up` and every Appwrite command fail
with a socket error if the engine is not up yet, and the error does not say "start Docker".

```bash
docker info          # should print server details, not an error
```

### A note on what keeps running and what does not

- **Docker containers restart automatically** when Docker Desktop starts. Postgres and (if you
self-host) Appwrite come back on their own.
- **The Node servers do not.** Each must be started by hand and **each needs its own terminal
  window, left open.** Closing the window kills the server. If the client suddenly reports
  connection failures, check that the terminal is still there.

---

## 1a. custom-backend (port 3000)

```bash
cd custom-backend
npm install
cp .env.example .env          # defaults already match the compose file below

docker compose up -d          # Postgres. Skip if you have your own — see note.
npm run setup                 # migrations, then seed 3 users and 6 files
npm run dev                   # http://localhost:3000  — leave this window open
```

`DATABASE_URL` is **required and has no default** — the server exits immediately with a clear
message rather than starting against a surprise database. `.env.example` ships a value matching
the bundled `docker-compose.yml`, so the copy above is enough. The app depends only on the
connection string; any reachable Postgres 13+ works, and the compose file is a convenience.

→ **Detail, layout and troubleshooting: [`custom-backend/README.md`](custom-backend/README.md)**

## 1b. appwrite-backend (port 3001) — Appwrite Cloud

This is the **default and verified** path. Nothing to install.

**In the Appwrite console at <https://cloud.appwrite.io>:**

1. **Create a project.** From Settings, copy two things:
   - the **Project ID**
   - the **API Endpoint**, *exactly as displayed*. Cloud is regional — this project's is
     `https://sgp.cloud.appwrite.io/v1`, not the generic `cloud.appwrite.io`. **The region prefix
     matters**; using the wrong host fails to connect.
2. **Create an API key:** Overview → Integrations → API Keys → Create API key. Enable the
   **Auth**, **Databases**, and **Storage** scope groups (individually: `users.*`, `databases.*`,
   `collections.*`, `attributes.*`, `indexes.*`, `documents.*`, `files.*`, `buckets.*`,
   `sessions.write`).

   > **The console selects no scopes by default.** A scopeless key is the single likeliest way
   > this setup fails, and it surfaces as a bare `401` during provisioning. `npm run provision`
   > detects that case and prints the required scope list rather than leaving you to guess.

   The key secret is shown **once** — copy it now.

**Then:**

```bash
cd appwrite-backend
npm install
cp .env.example .env
```

Edit `.env` and set `APPWRITE_ENDPOINT`, `APPWRITE_PROJECT_ID`, `APPWRITE_API_KEY`.

**You must also generate `SESSION_ENCRYPTION_KEY` by hand on this path.** It is required with no
fallback — the server and the provisioning script both refuse to start without it, because it
encrypts live Appwrite session secrets at rest and a default value would be worse than no
encryption at all. `npm run bootstrap` generates one automatically, but bootstrap is the
*self-hosted* path only, so on Cloud you produce it yourself:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Paste the output as `SESSION_ENCRYPTION_KEY=` in `.env`. Without it, provisioning stops with
`SESSION_ENCRYPTION_KEY is not set` — expected, and this command is the fix.

```bash
npm run provision             # database, collection, attributes, indexes, bucket, permissions
npm run seed                  # the same 3 users and 6 files as custom-backend
npm run dev                   # http://localhost:3001  — leave this window open
```

`npm run provision` is idempotent; running it twice is safe and reports `exists` for everything.

## 1c. appwrite-backend — self-hosted (alternative)

Works identically and needs no Appwrite account. **Know the cost before starting:** measured at
**23 containers, ~1.4 GB RAM at idle, and ~7.5 GB of images to download on first run.** Budget
**10–20 minutes** for that download depending on connection — it is one-off, and it is the slow
part. Allow roughly **4 GB of free RAM** for Docker.

```bash
mkdir appwrite && cd appwrite
docker run -it --rm \
  --volume /var/run/docker.sock:/var/run/docker.sock \
  --volume "$(pwd)":/usr/src/code/appwrite:rw \
  --entrypoint="install" appwrite/appwrite:1.6.2
# accept the defaults; it listens on http://localhost

cd ../appwrite-backend
npm install
npm run bootstrap             # creates project + API key + encryption key -> .env.local
npm run setup                 # provision + seed
npm run dev
```

`npm run bootstrap` needs no console clicking at all, which is why this path is kept.

→ **Detail for both Appwrite paths — the full console walkthrough, the scope list, the layout, and
the Appwrite-versus-us isolation split:
[`appwrite-backend/README.md`](appwrite-backend/README.md)**

## Environment variable precedence — read this before debugging config

```
exported environment   >   .env.local   >   .env
```

`.env.local` is written by `npm run bootstrap` on the self-hosted path. **If you bootstrap once
and then switch to Cloud, delete `.env.local` first.** Otherwise it silently overrides your `.env`
and points the facade at a local instance that may not even be running — with nothing in the
output to explain why. The facade prints its endpoint and project id on startup; check that line
first if something looks wrong.

## Ports

| | Port | Backend |
|---|---|---|
| `custom-backend` | **3000** | Express + PostgreSQL |
| `appwrite-backend` | **3001** | Appwrite facade |

**Both can run at the same time**, in two terminals, which is the easiest way to compare them.

---

# 2. Seeded test accounts

Three accounts, each with two files. Password is the same for all three.

| Email | Password |
|---|---|
| `alice@example.com` | `Password123!` |
| `bob@example.com` | `Password123!` |
| `carol@example.com` | `Password123!` |

File ownership — everything you need to build a cross-user access test:

| File ID | Owner | File name | Type |
|---|---|---|---|
| `file_001` | alice | `resume_alice.pdf` | PDF |
| `file_002` | alice | `profile_photo.jpg` | JPEG |
| `file_003` | **bob** | `project_notes.txt` | text |
| `file_004` | **bob** | `invoice_march.pdf` | PDF |
| `file_005` | carol | `test_plan.docx` | DOCX |
| `file_006` | carol | `vacation.png` | PNG |

The seeded files are **real, openable documents** — the PDFs open in a PDF reader, the `.docx` in
Word. Each one names its owner in visible text, so downloading a file and opening it is itself an
isolation check:

> *This file belongs to exactly one account. If you are reading it while signed in as anyone other
> than alice@example.com, data isolation has failed.*

Both `npm run seed` commands are idempotent and leave any accounts you register yourself alone.

---

# 3. How to test

Open `web/index.html` in a browser. Set **Base URL** to `http://localhost:3000` (custom) or
`http://localhost:3001` (Appwrite), and select the **Custom REST backend** radio for both — that
radio simply means "use the Base URL" rather than the in-browser mock.

**The same unmodified client works against either backend by changing only the Base URL.** Both
serve an identical contract. Selecting a radio and typing a URL is *usage of the provided client*,
not modification of it — `index.html` is byte-for-byte as supplied.

**Cookie mode needs `index.html` served over HTTP**, not opened from `file://`. A `file://` page
has an opaque (`null`) origin, and browsers will not send credentialed cross-origin requests from
one — so the cookie never reaches the server. Bearer mode works fine from `file://`. To test
cookies:

```bash
npx serve web -l 5500        # then open http://localhost:5500/
```

Note the trailing slash: `serve` strips `.html`, so `/index.html` redirects to `/index`. Open
`http://localhost:5500/` and you get the client (7,644 bytes, unmodified), with `mock-api.js` and
`seed-data.json` alongside it.

### A walkthrough that proves isolation

1. Log in as **alice** (quick-fill button, then **Login**). The token field fills automatically.
2. **GET /me** → `200`, Alice's profile.
3. **GET /files** → `200`, exactly `file_001` and `file_002`.
4. Set **File ID** to `file_003` (Bob's) → **GET /files/:id** → **`403`**.
5. Set **File ID** to `file_999` (does not exist) → **`404`**.
   Steps 4 and 5 must return *different* codes. Collapsing them is the most common shortcut in
   this task; the distinction is R3.3 and it is implemented deliberately.
6. **Copy the token out of the token field**, then click **Logout** → `200`.
7. **Paste the token back** into the token field and click **GET /me** → **`401`**.
   The token string is unchanged and un-expired, yet it no longer works — because validity lives
   on the server, not in the token. This step is the only way to observe R1.3 from this client,
   since it clears its own token field regardless of what logout returns.

Repeat against the other Base URL; the results are identical.

### If you get locked out — you probably will

Ten failed logins against one address returns `429` for 15 minutes. The counters are stored in the
database **on purpose**, so restarting the server does *not* clear them. Each backend ships a
reset:

```bash
cd custom-backend    && npm run reset-lockout                       # or -- bob@example.com
cd appwrite-backend  && npm run reset-lockout                       # or -- bob@example.com
```

The limiter is keyed on **email first**, not IP, precisely so that testing lockout on one account
does not lock you out of the other two — every account in a local review shares `::1`.

---

# 4. The five required questions

## 4.1 JWT vs session-based authentication

**Opaque bearer tokens backed by server-side sessions — not JWTs.** 32 CSPRNG bytes, base64url,
carrying no claims, returned as `token` at the top level of the login response.

The client settles the *transport*: it ships with the cookie checkbox unchecked, attaches
`Authorization: Bearer` by default, has a dedicated token field, auto-fills that field from
`body.token`, and the reference `mock-api.js` implements bearer and nothing else — there is not a
single `Set-Cookie` in it. Bearer also survives a reviewer opening `index.html` from `file://`,
where credentialed CORS is impossible.

The *format* is where the real argument is, and **R1.3 decides it.** The task requires logout to
invalidate server-side, not merely clear the client. A self-contained JWT cannot be revoked; the
standard remedy is a denylist — which reintroduces exactly the per-request server lookup that JWTs
exist to avoid. Once that state is mandatory, the JWT is pure downside: it embeds claims that leak
under inspection, it adds signature and algorithm-confusion failure modes, and it makes "logged
out" a derived property of a second table rather than the plain absence of a row.

A denylist also **inverts the safe default**. Forget to check it and a revoked token still works —
it fails *open*. Forget to find a session row and the request fails *closed*. For an auth system
that asymmetry is the whole argument.

So: opaque token, one `sessions` row, absolute 30-minute expiry with no sliding renewal. Only
**SHA-256(token)** is stored — the same reasoning that hashes passwords applies to bearer
credentials, since a leaked session table would otherwise be directly replayable.

Cookie mode is supported as a **thin alias**: login also sets `HttpOnly; SameSite=Lax` carrying the
same token, resolving to the *same session row*. Ticking the client's checkbox works, and logout
revokes both at once because there is only one thing to revoke.

Full reasoning and the evidence for each claim: `DECISIONS.md` ADR-0001, ADR-0014.

## 4.2 How logout is implemented under the hood

**custom-backend.** `POST /logout` hashes the presented token and deletes the row:

```sql
DELETE FROM sessions WHERE token_hash = sha256($1)
```

It then clears the cookie alias with an expired `Set-Cookie`, and returns `200 {"message":"Logged
out"}` **unconditionally** — no token, unknown token and already-revoked token all get the same
answer, so logout never confirms whether a presented credential was real. The token string handed
back to the client is unchanged and un-expired; the next `GET /me` carrying it returns `401`,
because validity is a database row and not a property of the token.

**appwrite-backend.** Two things must die, and both do:

1. `account.deleteSession(sessionId)` — called with **the user's own session**, killing the
   session inside Appwrite.
2. The facade's own record — the row mapping our opaque token to that Appwrite session.

Appwrite is destroyed **first**, deliberately. If the process died between the two steps, the
surviving state would be a facade record pointing at a dead Appwrite session — which resolves to a
`401` and **fails closed**. The reverse order would leave a live Appwrite session with nothing left
to revoke it by.

Verified, not assumed: after logout, the stored Appwrite session secret used **directly against
Appwrite with the facade bypassed entirely** returns `401 general_unauthorized_scope`.

## 4.3 How user data isolation is enforced

The two backends reach the same guarantee by genuinely different mechanisms, which is what makes
comparing them worthwhile.

**custom-backend — ownership is in the SQL.**

```sql
SELECT ... FROM files WHERE id = $1 AND owner_id = $2
```

The data-returning query carries `owner_id` in its `WHERE` clause, so another user's row **never
enters the process**. This is not fetch-then-filter, where a wrong `if` leaks a row already held in
memory. Only when that query misses does a second query run — and it selects the literal `1`, no
columns — purely to tell `403` (exists, not yours) from `404` (does not exist).

`GET /files` is the same shape: `WHERE owner_id = $1`, with no query parameter that could widen it.

**appwrite-backend — ownership is Appwrite's permission model.** The `files` collection is created
with `documentSecurity: true` and **no collection-level permissions at all**; each document and
each stored file carries `Permission.read(Role.user(<ownerId>))`. Every data call is made with a
client scoped to *that user's own Appwrite session* — never the admin API key. Our `/files` route
passes **no `ownerId` filter whatsoever**; the scoping is the platform's.

Measured, querying Appwrite directly with each user's session and the facade bypassed: an
unfiltered `listDocuments` returns **2 of 2** documents for Alice and **2 of 2** for Bob, while the
same call with the admin key returns **6**.

**Both backends, identically:** one authentication middleware on every protected route, and the
subject is taken *only* from the validated credential. `GET /me` has no `:id` variant and reads no
identifier from the path, query, body or headers — verified with `?id=`, `/me/<other-id>` and an
`X-User-Id` header, all of which return the caller's own profile or a `404` for a route that does
not exist.

## 4.4 What Appwrite handled automatically vs. what I configured myself

Precise rather than generous. Everything below was checked by talking to Appwrite directly with a
user's own session, bypassing the facade.

**Appwrite handled — no check written by me:**

| Guarantee | Evidence |
|---|---|
| argon2id password hashing | I never see, choose, or store a hash. `custom-backend` selects the algorithm and OWASP parameters by hand. |
| Session creation and genuine server-side invalidation | After logout, the raw secret used straight against Appwrite returns `401` |
| Per-user document isolation | Unfiltered list: **2 of 2** per user vs **6** for the admin key |
| Per-user file-bytes isolation | Alice fetching Bob's bytes → `storage_file_not_found` |
| `/me` cannot name another user | `account.get()` takes **no identifier argument at all** — R2.2 holds because the API has no such parameter, not because a check rejects one |
| Encryption of file bytes at rest | A bucket flag I set; Appwrite enforces it |

**I configured / implemented — Appwrite does not provide it:**

| Guarantee | Why not Appwrite's |
|---|---|
| **`403` vs `404` for another user's file (R3.3)** | **Appwrite answers `404` for both**, deliberately, so as not to disclose existence. The task requires them *distinct*. So the facade must do an explicit existence probe with the admin key after the user-scoped read misses — a probe that selects no user data, only whether the id exists. |
| Rate limiting / lockout (R5.3) | Appwrite's own limits are IP-keyed and not configurable from this codebase. Mine are email-keyed. |
| Generic login error (R5.2) | Appwrite distinguishes `user_not_found` from `user_invalid_credentials`. A translation layer collapses every credential failure to one identical `401`. |
| `409` on duplicate registration | Mapped from Appwrite's own code/type to the contract's |
| Every contract status code and body | Appwrite's error shape (`{message, code, type, version}`) must never reach the client |
| JSON on every response | Express's HTML 404/500 defaults would break the client (see §6 below) |
| The 30-minute absolute session expiry | Appwrite sessions last far longer; mine is the binding limit |
| Encryption of the *session secret* at rest | Appwrite has no opinion on how a facade stores its credentials |

**The row worth dwelling on is the first one.** Appwrite's isolation is real and does the heavy
lifting — but it is tuned for *confidentiality*, which is exactly why it returns `404` rather than
`403` for another user's document. The task requires the opposite. So the facade has to **reduce
confidentiality slightly, on purpose**, to satisfy R3.3. That is the one place the platform's
instincts and the requirement actively disagree, and it is the most interesting thing I found
building this. Everything else in the right-hand table is contract translation, not security I had
to invent.

The same split, with the exact Appwrite error types and the measurements behind each row, is in
[`appwrite-backend/README.md`](appwrite-backend/README.md#what-appwrite-enforces-versus-what-we-enforce).

## 4.5 What I would improve given more time

- **Close the registration enumeration hole.** `POST /register` returns `409` on a duplicate email,
  matching the reference mock — which tells an attacker whether an address is registered. The
  correct fix is to always return `202` and resolve the difference out-of-band by email. That needs
  a mail transport, and it would make the seeded-account workflow untestable from this client, so
  it is deliberately deferred and documented rather than quietly shipped (ADR-0004).
- **Make the Appwrite rate-limit increment atomic.** `custom-backend` does it in a single
  `INSERT … ON CONFLICT DO UPDATE`. Appwrite has no upsert-with-expression, so the facade does
  read-then-write, and two simultaneous failures can lose an increment. It degrades the control
  slightly; it does not fail open. A small Appwrite Function could make it atomic.
- **Automated test suites.** Verification here was a scripted `curl` matrix plus direct-to-Appwrite
  probes, run repeatedly by hand. That should be a committed test suite asserting every row of the
  security table, so a regression fails loudly instead of waiting to be noticed.
- **Key rotation for `SESSION_ENCRYPTION_KEY`.** There is no key-versioning scheme, so rotating it
  invalidates every live session at once. A `keyId` prefix on the stored ciphertext would allow
  rolling rotation.
- **Progressive delays instead of a hard lockout.** Email-keyed lockout is attacker-controllable:
  anyone can lock a known address for 15 minutes. The standard mitigation is escalating delays plus
  notifying the account owner, rather than a hard block.
- **Tighten CORS by default.** It currently reflects any origin, which is right for local review and
  wrong for anything deployed. An explicit allowlist should be the default with the permissive mode
  opt-in, rather than the reverse.

---

# 5. A note on file sizes

**The `sizeBytes` values the API returns do not match the figures in `web/seed-data.json`, and
that is intentional.**

`seed-data.json` describes files that never existed — it declares `resume_alice.pdf` as 84,213
bytes, for instance. The seed scripts generate *real, openable* documents (via `pdf-lib`, `jszip`,
`jpeg-js`, `pngjs`), and those come out at roughly 1–12 KB. The API reports **the true size of the
bytes on disk**, and `Content-Length` on download is taken from the file actually being served, so
the number is honest end to end.

An earlier version padded the files to hit the declared byte counts exactly. That was reverted:
matching a declared number is cosmetic, while a downloaded `resume_alice.pdf` that a PDF reader
refuses to open reads as a broken download — and a reviewer meets that dialog long before they diff
a byte count. An inaccurate size field is a footnote; a corrupt-looking download is a failed
feature. Reasoning in ADR-0013.

Both seed scripts print the real size and the declared size side by side, so the difference reads
as deliberate rather than as a bug. Both backends serve **byte-identical** files.

---

# 6. Further reading

- **`API_CONTRACT.md`** — the exact surface the provided client expects, derived line-by-line from
  `index.html` and `mock-api.js`, with every ambiguity and mock inconsistency flagged rather than
  guessed at. It also documents the client-side trap that shapes both backends: `index.html:118`
  parses responses with `res.json()` and a `res.text()` fallback that **cannot work** — so any
  non-JSON body (an HTML 404, a plain-text 429) makes the page silently keep displaying the
  *previous* result. That is why every response from every route, at every status code, is JSON.
- **`DECISIONS.md`** — 17 ADRs. `TASK.md:29-31` explicitly invites judgment where requirements are
  open; this is that judgment, with the evidence and the cost of each choice stated rather than
  the verdict alone. Start with ADR-0001 (credential mechanism), ADR-0002 (why a facade rather
  than a browser adapter), ADR-0005 (why every login failure is one identical `401`), and ADR-0017
  (Cloud vs self-hosted, and exactly what has and has not been verified).
- **`ARCHITECTURE.md`** — one authenticated request traced end to end through both backends, and
  precisely where they diverge.
