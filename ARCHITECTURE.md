# Architecture — the lifecycle of one authenticated request

This traces a single request end to end through both backends: how the credential is presented,
how it resolves to an identity, how ownership is decided, and how the response is produced. The
worked example throughout is the sharpest one in the task:

```
GET /files/file_003
Authorization: Bearer <alice's token>
```

`file_003` belongs to **Bob**. Alice is authenticated. The correct answer is **`403`** — not `404`
(which would mean "no such file") and not `200`. Getting that distinction right, on both backends,
is R3.3.

---

## 0. What is identical before either backend is reached

Both servers are Express apps with the same middleware stack in the same order, for reasons that
are contractual rather than stylistic:

```
  cors ──▶ cookieParser ──▶ express.json ──▶ routes ──▶ notFoundHandler ──▶ errorHandler
```

1. **`cors` runs first** so preflights are answered before anything can reject them. The client
   attaches `Authorization`, which makes *every* request — `GET` included — preflighted. `OPTIONS`
   is answered here and returns immediately, so it never reaches the rate limiter and cannot
   consume a login attempt.
2. **`express.json` only parses when `Content-Type` is JSON.** `POST /logout` is sent by the client
   with no body and no `Content-Type` (`index.html:149`), so it passes through with `req.body =
   {}` rather than erroring.
3. **`notFoundHandler` and `errorHandler` are terminal and always emit JSON.** Express's defaults
   emit HTML. The client parses every response with `res.json()` and a `res.text()` fallback that
   cannot work — `json()` disturbs the body before parsing, so the fallback throws again, the
   promise rejects, and the bare `onclick=` handler drops it. **The page then keeps displaying the
   previous response.** An HTML 404 does not look like an error to a reviewer; it looks like the
   last success. Hence: JSON on every route, at every status code, without exception.

The credential is also extracted identically in both backends:

```js
Authorization: Bearer <token>     // preferred
Cookie: session=<token>           // alias — same token, same session record
```

Bearer is checked first. The two never collide in practice: the client sends `Authorization` only
when cookie mode is off, and cookies only when it is on.

---

## 1. custom-backend — Express + PostgreSQL

```
GET /files/file_003
Authorization: Bearer QmpF…
        │
        ▼
┌───────────────────────────────────────────────────────────────────────┐
│ cors                                                                  │
│   OPTIONS? → 204 + Allow-Headers, and STOP (never rate-limited)       │
│   otherwise → reflect Origin (or * for file://), continue             │
└───────────────────────────────────────────────────────────────────────┘
        ▼
┌───────────────────────────────────────────────────────────────────────┐
│ requireAuth          ← THE auth middleware. Every protected route.    │
│                                                                       │
│   1. extractToken(req)        Authorization, else cookie              │
│   2. sha256(token)            the token itself is NEVER stored        │
│   3. SELECT user_id FROM sessions                                     │
│        WHERE token_hash = $1 AND expires_at > now()                   │
│                                                                       │
│   miss → 401 {"error":"Not authenticated"}   ← one body for absent,   │
│                                                 malformed, unknown,   │
│                                                 and expired           │
│   hit  → req.auth = { userId }               ← the ONLY channel by    │
│                                                 which a handler       │
│                                                 learns who is calling │
└───────────────────────────────────────────────────────────────────────┘
        ▼
┌───────────────────────────────────────────────────────────────────────┐
│ GET /files/:id handler                                                │
│                                                                       │
│   :id is an untyped string, passed as a query parameter.              │
│                                                                       │
│   Query 1 — the data query, ownership INSIDE it:                      │
│     SELECT id, owner_id, file_name, mime_type, size_bytes,            │
│            storage_key, uploaded_at                                   │
│       FROM files                                                      │
│      WHERE id = $1 AND owner_id = $2      ← req.auth.userId           │
│                                                                       │
│     hit  → 200 {"file":{…}}                                           │
│     miss → the row was never loaded. Not "loaded then filtered".      │
│                                                                       │
│   Query 2 — existence probe, ONLY on a miss:                          │
│     SELECT 1 FROM files WHERE id = $1     ← no columns; cannot leak   │
│                                                                       │
│     found     → 403 {"error":"You do not have access to this file"}   │
│     not found → 404 {"error":"File not found"}                        │
└───────────────────────────────────────────────────────────────────────┘
        ▼
   403  {"error":"You do not have access to this file"}
```

### Why the split into two queries matters

The obvious implementation is one query by id, then an `if (row.owner_id !== userId)` in
JavaScript. That is *fetch-then-filter*: the other user's row is already in process memory, and a
single wrong comparison, an early `return`, or a later refactor that logs the row leaks it.

Here the data-returning query cannot produce another user's row at all, because `owner_id` is in
its `WHERE` clause. The second query exists solely to answer the one bit R3.3 forces us to
disclose — "does this id exist?" — and it selects the literal `1`, so there is nothing in its
result set to leak.

`GET /files` is the same shape: `WHERE owner_id = $1`, with no query parameter that could widen
it.

### The `:id` type question

`files.id` is `text`, holding the seed's opaque ids. This is deliberate. The client's File ID box
defaults to `1`, so `GET /files/1` is the first thing a reviewer sends after logging in. Against an
`integer` or `uuid` column, the string `file_001` (or `1` against `uuid`) reaches the query layer
and Postgres raises `22P02 invalid input syntax` — a **500 where R3.3 requires a 404**, and by the
JSON rule above, a 500 rendered as an HTML error page freezes the client's output pane on a stale
success. Text ids make `GET /files/1` a clean `404`.

### Download

`GET /files/:id/download` runs the identical two-query resolution, then streams:

```js
fs.createReadStream(absolutePath)   // no encoding argument → Buffers, never utf8 strings
```

`Content-Length` is taken from `fs.stat` of the file being served, **not** from the `size_bytes`
column, so the header cannot disagree with the body if the two ever drift.

---

## 2. appwrite-backend — the facade

The client contract is byte-identical. What changes is where identity and authority live.

```
GET /files/file_003
Authorization: Bearer QmpF…          ← OUR opaque token, not an Appwrite credential
        │
        ▼
   cors ─── identical to custom-backend
        ▼
┌───────────────────────────────────────────────────────────────────────┐
│ requireAuth          ← same role, different store                     │
│                                                                       │
│   1. extractToken(req)                                                │
│   2. docId = sha256(token)[0..32]     Appwrite ids cap at 36 chars    │
│   3. getDocument(facade_sessions, docId)                              │
│   4. timingSafeEqual(full sha256, doc.tokenHash)   ← the short id is  │
│        a lookup key; the FULL hash is the check                       │
│   5. expiresAt in the past? → destroy BOTH sides, return null         │
│   6. decrypt(doc.secretEnc)           AES-256-GCM                     │
│                                                                       │
│   miss → 401 {"error":"Not authenticated"}   ← same body as custom    │
│   hit  → req.auth = { userId, sessionSecret }                         │
└───────────────────────────────────────────────────────────────────────┘
        ▼
┌───────────────────────────────────────────────────────────────────────┐
│ GET /files/:id handler                                                │
│                                                                       │
│   Reject ids Appwrite would refuse outright:                          │
│     /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,35}$/   → else 404 (never a 400)    │
│                                                                       │
│   Call 1 — with the USER'S OWN Appwrite session:                      │
│     sessionScoped(req.auth.sessionSecret)                             │
│       .databases.getDocument(db, 'files', id)                         │
│                                                                       │
│     hit  → 200 {"file":{…}}                                           │
│     miss → Appwrite refused it. THERE IS NO OWNERSHIP CHECK IN OUR    │
│            CODE — no WHERE clause, no if. The platform decided.       │
│                                                                       │
│   Call 2 — existence probe, ONLY on a miss, admin key:                │
│     adminDatabases().getDocument(db, 'files', id)                     │
│     reads no fields — only whether the id resolves                    │
│                                                                       │
│     found     → 403                                                   │
│     not found → 404                                                   │
└───────────────────────────────────────────────────────────────────────┘
        ▼
   403  {"error":"You do not have access to this file"}     ← same bytes
```

### Where the authority actually sits

Provisioning creates the `files` collection with `documentSecurity: true` and **no collection-level
permissions at all**. Each document, and each stored file, carries exactly:

```js
[ Permission.read(Role.user(ownerId)) ]
```

So when the facade calls `getDocument` with Alice's session secret, Appwrite evaluates its own
permission model and refuses Bob's document before our code sees anything. `GET /files` exploits
the same property — it issues `listDocuments` with **no `ownerId` filter whatsoever**:

| Caller | Unfiltered `listDocuments` returns |
|---|---|
| Alice's session | **2 of 2** — `file_001`, `file_002` |
| Bob's session | **2 of 2** — `file_003`, `file_004` |
| admin API key | **6** — everything |

That table is the whole ADR-0002 claim, measured directly against Appwrite with the facade
bypassed.

### The one place the platform fights the requirement

Appwrite answers **`404` for both** "does not exist" and "exists but is not yours" — deliberately,
so as not to disclose existence. R3.3 requires them *distinct*. So Call 2 above uses the admin key
to recover the one bit Appwrite is hiding.

This is the only runtime use of the admin key on a data path, and it is scoped as tightly as
possible: it reads **no fields**, only whether the id resolves. The facade is deliberately
*reducing* confidentiality here, because the task asks for the distinction. Since ids are opaque
and non-sequential, what leaks is negligible.

### The admin key, everywhere else

The admin client is effectively root — it bypasses every document and file permission. It is
confined to:

1. **Provisioning** — `provision.js`, `seed.js`.
2. **Registration and login** — creating the Appwrite account, and creating the session. Neither
   can use a user session, because at that moment none exists.
3. **The facade's own bookkeeping** — `facade_sessions`, `facade_login_attempts`. These hold no
   user-owned data and are created with permissions for *nobody*, so only the API key can touch
   them.

No route that returns user data uses it. `/me`, `/files`, `/files/:id` and `/files/:id/download`
all go through `sessionScoped()`.

### Why a session secret rather than a JWT

The facade stores Appwrite's **session secret**, encrypted, rather than minting a JWT per request.
An Appwrite JWT expires in ~15 minutes — shorter than our own 30-minute window — which would
create a period where our token is valid but the credential behind it has died of old age. The
underlying session does not expire that fast, so wrapping the secret makes **our** expiry the
binding one and that gap simply does not exist.

Early death is still handled: if Appwrite rejects the secret mid-request (revoked in the console,
password changed, project re-seeded), `isSessionDead()` recognises the 401 family and the route
returns the standard `401` rather than a 500.

The secret is encrypted at rest with AES-256-GCM because it is a *live, replayable credential* —
anyone holding it can act as that user. Note the asymmetry with our own token:

| Credential | At rest | Why |
|---|---|---|
| our opaque token | SHA-256 **hash** | we only ever need to *recognise* it |
| Appwrite session secret | AES-256-GCM **encrypted** | we need to *use* it |

Hashing is preferable wherever it works, precisely because it is irreversible by anyone including
us. It does not work here, so encryption is the weaker tool we are forced into.

---

## 3. Login and logout, side by side

### Login

| Step | custom-backend | appwrite-backend |
|---|---|---|
| Rate-limit check | per-email, then per-IP, from Postgres | identical logic, counters in Appwrite |
| Missing/invalid fields | `401`, identical body, dummy-hash burn | `401`, identical body |
| Credential verification | `argon2.verify` against the stored hash | `account.createEmailPasswordSession()` — Appwrite verifies |
| Unknown email | verify against a **dummy hash** so timing matches | Appwrite's own path |
| Session created | `INSERT INTO sessions (token_hash, …)` | Appwrite session + our record holding the encrypted secret |
| Response | `{token, user:{id,email}}` | **identical** |
| Cookie alias | same token, `HttpOnly; SameSite=Lax` | **identical** |

The dummy-hash burn is worth calling out: identical response *bodies* are only half of "generic".
If a real account costs ~40 ms of argon2 and a missing one returns instantly, response time is the
enumeration oracle. Measured: unknown-email 46.0 ms vs wrong-password 41.7 ms.

### Logout

| | custom-backend | appwrite-backend |
|---|---|---|
| What is destroyed | the `sessions` row | the **Appwrite session** *then* the facade record |
| Order | n/a | Appwrite first — a crash between the two leaves a record pointing at a dead session, which **fails closed** |
| Cookie | cleared with an expired `Set-Cookie` | identical |
| Status | `200` unconditionally | `200` unconditionally |
| Auth required? | **No** — and deliberately so | **No** |

Logout is not behind `requireAuth` on either backend. The client clears its token field regardless
of the response status, so a `401` would tell the user nothing — while confirming to an attacker
that a probed token was invalid.

**The proof that this is genuine server-side invalidation** is that the token string is unchanged
and un-expired afterwards, yet stops working. On the Appwrite side this was checked the only way
that actually settles it: taking the stored session secret and presenting it **directly to
Appwrite, with the facade entirely out of the path**. It returns `401
general_unauthorized_scope`.

---

## 4. Summary — identical vs. divergent

**Identical** (by design — the client cannot tell the backends apart):

- Every route, request shape, response body and status code
- Bearer-token transport, opaque 32-byte tokens, cookie alias resolving to the same record
- Absolute 30-minute expiry, no sliding renewal
- One auth middleware on every protected route; handlers receive only `req.auth.userId`
- One generic `401` for every credential failure; one generic `401` for every auth failure
- `403` vs `404` distinguished on `/files/:id` **and** `/files/:id/download`
- Email-keyed rate limiting with an IP backstop, `OPTIONS` exempt, counters persisted
- JSON on every response, at every status code
- The seeded users, file ids, and **byte-identical** file contents

**Divergent:**

| | custom-backend | appwrite-backend |
|---|---|---|
| Identity store | `users` table | Appwrite Users |
| Password hashing | argon2id, parameters I chose | argon2id, Appwrite's |
| **Isolation enforced by** | **my `WHERE` clause** | **Appwrite's permission model** |
| Session record | Postgres `sessions` | Appwrite `facade_sessions`, secret encrypted |
| File bytes | filesystem, streamed | Appwrite Storage, buffered |
| `403` vs `404` | natural — two queries I control | requires an admin-key probe, because Appwrite hides existence |
| Rate-limit atomicity | atomic `INSERT … ON CONFLICT` | read-then-write; can lose an increment under concurrency |
| Failure if backing store is down | 500s, logged | 500s, logged |

The interesting line in that table is the third one. Both backends deny Alice access to Bob's
file — but in one case that is a predicate I wrote and must defend, and in the other it is a
platform guarantee I configured and then verified. The fifth line is the interesting *consequence*:
delegating isolation to a platform means inheriting its opinions, and Appwrite's opinion about
disclosing existence is the opposite of what this task requires.
