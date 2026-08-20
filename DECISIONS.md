# Decision Log

Records the judgement calls this task deliberately leaves open (TASK.md:29-31). Each entry states
the evidence, the decision, and what it costs us. Evidence citations refer to `web/index.html` and
`web/mock-api.js`; the full client analysis lives in `API_CONTRACT.md`.

---

## ADR-0001 — Credential mechanism: Bearer token, backed by server-side sessions

**Status:** Accepted · 2026-08-20
**Satisfies:** R1.2, R1.3, R5.4
**Supersedes:** nothing

### Question

TASK.md:38-39 leaves the choice open ("JWT or cookie-based — your choice, with a brief
justification"). The client supports both. Which one does the client *imply*, and which do we
commit to for both backends?

### Evidence in the client

**Pointing to Bearer (decisive):**

1. **Bearer is the default path.** The cookie checkbox ships unchecked (index.html:32), and
   `request()` attaches `Authorization: Bearer` whenever cookie mode is off and the token field
   is non-empty (index.html:110-112). An evaluator who touches nothing gets Bearer.
2. **The client has live code that only makes sense for Bearer.** Login auto-fills the token
   field from the response body:
   ```js
   // index.html:141-144
   // If the backend returns a JWT in the body, auto-fill the token field
   if (result.body && result.body.token) {
     document.getElementById('token').value = result.body.token;
   }
   ```
   Nothing analogous exists for cookies — cookie mode is one line setting
   `credentials: 'include'` (index.html:113-115). There is a whole dedicated UI fieldset for the
   token (index.html:70-73) and none for a session cookie.
3. **The reference implementation is Bearer-only.** `mock-api.js` reads credentials in exactly
   one way — `getBearer()` parsing `Authorization` (mock-api.js:123-127), used by
   `authenticate()` (mock-api.js:129-139) and by `handleLogout()` (mock-api.js:194). There is not
   a single `Set-Cookie` or `document.cookie` anywhere in the file. Every reference behaviour we
   are expected to reproduce was written against Bearer.
4. **Bearer survives the `file://` case; cookies do not.** `mock-api.js:35-36` and 105 explicitly
   anticipate the evaluator double-clicking `index.html`. From a `file://` page the origin is
   opaque (`null`), so credentialed CORS (`credentials: 'include'` + an exact
   `Access-Control-Allow-Origin`) is unusable, while Bearer works with
   `Access-Control-Allow-Origin: *`. Choosing cookies means the client silently fails for anyone
   who opens the page the obvious way.
5. **The download path is Bearer-first.** It sets `credentials: 'same-origin'` in the non-cookie
   branch (index.html:176) — i.e. deliberately *not* sending cookies cross-origin.

**Pointing to cookies (present, but weaker):**

6. The checkbox exists at all (index.html:32) and is wired in both `request()` and
   `downloadFileById()` (index.html:113-115, 176). Someone may tick it during evaluation, and the
   requirement text names cookies as an equal option. This is an argument for *tolerating*
   cookies, not for making them the primary mechanism.

**On "JWT" specifically — the client is self-contradicting and it does not matter:**

index.html:71 and 141 both say "JWT", but the mock issues an opaque random string
(`crypto.randomUUID() + "." + Date.now()`, mock-api.js:119-121) validated by a lookup in a
server-side `Map` (mock-api.js:129-139). The client's only actual requirement is *a string at
`body.token`* that it can echo back (API_CONTRACT.md §4.2). "JWT" is loose prose; the modelled
behaviour is an **opaque session token carried as a Bearer credential**. The format is ours to
choose.

### Decision

**Bearer tokens are the contract.** Concretely, for the custom backend:

- `POST /login` returns `200 {"token": "<opaque>", "user": {...}}` with `token` at the top level.
- The token is **opaque**, not a JWT: 32 bytes from a CSPRNG, base64url-encoded. It carries no
  claims and is unintelligible to anyone holding it.
- Server-side state is a `sessions` table in Postgres: `(token_hash, user_id, created_at,
  expires_at, revoked_at)`. Only **SHA-256(token)** is stored, never the token itself — the same
  reasoning that makes us hash passwords applies to bearer credentials, since a stolen session
  row would otherwise be directly replayable.
- Absolute 30-minute expiry, mirroring the mock's `SESSION_TTL_MS` (mock-api.js:30). No sliding
  renewal.
- One middleware resolves the credential for **every** protected route — `/me`, `/files`,
  `/files/:id`, `/files/:id/download` — so R5.4 holds by construction rather than by discipline.
  Handlers receive an authenticated `user_id` and can never read one from the request.

**Cookies are supported as a compatibility alias, not a second design.** On successful login we
*also* set `Set-Cookie: session=<same token>; HttpOnly; SameSite=Lax; Path=/` (plus `Secure`
whenever served over TLS). The auth middleware reads `Authorization` first, then falls back to
the cookie. Both paths resolve **the same session row**, so ticking the checkbox at index.html:32
works and revocation stays single-sourced. This costs roughly ten lines and removes an obvious
way for the evaluation to dead-end.

The cost of that alias is honest and bounded: a cookie sent automatically by the browser
reintroduces CSRF exposure that pure Bearer does not have. Mitigations: `SameSite=Lax` blocks
cross-site sub-resource sends; every state-changing route is `POST`; and CORS allows exactly one
configured origin with `Access-Control-Allow-Credentials: true` (never `*`, which is illegal with
credentials anyway). Bearer remains the documented and tested path — cookie mode is a
convenience, and README will say so, including that it cannot work from `file://` (evidence #4).

### How logout achieves genuine server-side invalidation

R1.3 is the reason this decision is easy, and it is worth being explicit about the mechanism.

Under Bearer + server-side sessions, `POST /logout`:

1. Resolves the presented credential to a session row (`WHERE token_hash = sha256($1)`).
2. Deletes it (or sets `revoked_at = now()` — we delete; there is no audit requirement here, and
   a deleted row cannot be resurrected by a bug in a `revoked_at` check).
3. Clears the cookie with an expired `Set-Cookie`, for the alias path.
4. Returns `200 {"message": "Logged out"}` unconditionally — no token, unknown token, and
   already-revoked token all get the same answer, so logout never confirms whether a presented
   token was valid (matching mock-api.js:193-197; see API_CONTRACT.md §7.6).

The token string handed back to the client is unchanged and un-expired, yet the next `GET /me`
carrying it returns `401`, because validity lives in the database and not in the token. That is
the difference between real invalidation and clearing a field — and it is exactly what the client
*cannot* demonstrate on its own, since it wipes the token field regardless of the response
(index.html:150). The proof procedure is therefore: log in → copy the token → logout → paste the
token back into the field at index.html:72 → `GET /me` → expect `401`. This will be scripted so
the evaluator does not have to trust a manual demo.

**Why not a JWT.** A self-contained JWT cannot be revoked; the standard remedy is a denylist,
which reintroduces exactly the server-side lookup on every request that JWTs exist to avoid. Once
R1.3 forces that state, the JWT is pure downside: it embeds claims that leak on inspection, it
adds signature/algorithm confusion as a failure surface, and it makes "logged out" a derived
property of a second table rather than the plain absence of a row. A denylist also inverts the
safe default — forget to check it and a revoked token still works, whereas forgetting to find a
session row simply fails closed. An opaque token gives us R1.3 for free, with less code and
strictly less to get wrong.

**Appwrite counterpart.** The same shape holds, which keeps the two implementations comparable:
`account.createEmailPasswordSession()` establishes a real server-side session, `account.createJWT()`
yields a short-lived Bearer credential derived from it, and `account.deleteSession('current')`
invalidates the session server-side — which also invalidates JWTs minted from it. So both
backends answer R1.3 the same way: *a server-side record is destroyed*, not a client field
cleared. What differs is who owns the record, which is precisely the README comparison TASK.md:81
asks for.

### Consequences

- Login response is now load-bearing: omitting or nesting `token` breaks the entire client
  (API_CONTRACT.md §4.2, marked BINDING).
- `/register` and `/login` must ignore a stale inbound `Authorization` header, which the client
  will send after any successful login (API_CONTRACT.md §2).
- Bearer in a text input is visible on screen and lives in the DOM. Acceptable and in fact
  intended here — the client is a testing harness (index.html:8, 21) — but it is a real reason a
  production build would prefer `HttpOnly` cookies. Noted for the README's "what I would improve"
  section.
- Every protected route shares one code path, so a future route is protected by default.

---

## Backlog — decisions raised by the contract analysis, not yet ratified

Each has a proposed resolution in `API_CONTRACT.md`; each becomes its own ADR before the relevant
code is written.

| # | Question | Ref |
|---|---|---|
| 0002 | Appwrite integration shape: browser-side `appwrite-adapter.js` (uncommenting index.html:89-92) vs. a server-side REST facade | §7.1 |
| 0003 | File id type — opaque `text` ids matching the seed, so `GET /files/1` yields a clean `404` rather than a Postgres cast error | §7.4 |
| 0004 | Keep the enumerating `409` on registration, or diverge from the mock | §7.5 |
| 0005 | Login validation errors: `400` vs the mock's `401`, and whether they count toward lockout | §7.7 |
| 0006 | Rate-limit key (per-email + looser per-IP) and `OPTIONS` exemption, given all evaluation traffic shares `::1` | §7.9 |
| 0007 | JSON-only error bodies on every `request()` route, including the framework's default 404/500 handlers, since the client's non-JSON fallback is broken | §3 |
