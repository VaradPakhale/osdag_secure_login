# CLAUDE.md — Project Context & Hard Constraints

## What this is

A submission for the FOSSEE / Osdag (IIT Bombay) Autumn 2026 screening task:
**"Secure Login System with User Details & File Access."**

The full task text is in `TASK.md` — treat it as the requirements spec and re-read it
before each phase.

This is graded by a mentor who will clone the repo, follow the README, run it, and then
actively try to break the authorization with two different accounts. It is followed by a
technical interview where the implementation is reviewed line by line.

**Grading is on correctness and security of the auth/data-access logic. Not on visual
design.** Do not spend effort on styling.

---

## Locked decisions

> Settled. Do not revisit in later sessions. Full reasoning lives in `DECISIONS.md`.

- **Credential mechanism (ADR-0001):** opaque Bearer token, **not a JWT**. 32 CSPRNG bytes,
  base64url-encoded. The `sessions` table stores **SHA-256(token)** only, never the token
  itself. Absolute 30-minute expiry, no sliding renewal. Cookie mode is a thin alias that
  resolves to the *same* session row — it is not a second design.
- **Custom backend stack:** Express + PostgreSQL + argon2id
- **Database connection:** read from `DATABASE_URL`, never hardcoded. A `docker-compose.yml`
  is provided as a reviewer convenience, but the app depends only on a connection string.
- **Appwrite approach (ADR-0002):** server-side facade exposing routes identical to the
  custom backend. Admin API key is used for provisioning and registration only; all data
  access is scoped through the user's own Appwrite session, so Appwrite's permission model
  enforces isolation. `index.html` stays byte-identical.

---

## Client-imposed constraints (from `API_CONTRACT.md` — non-negotiable)

1. **Every response body on every `request()` route must be valid JSON.** The client calls
   `res.json()` and falls back to `res.text()` on the same response (index.html:118) — the
   fallback throws, because `json()` has already consumed the body. A non-JSON response makes
   the output pane silently freeze on the previous result. This requires custom handlers for
   the rate limiter's 429, the framework's default HTML 404, and its default HTML 500 page.
   No route may ever emit HTML or plain text.
2. **Listen on `http://localhost:3000`, routes mounted at root.** `/register`, not `/api/register`.
3. **Answer `OPTIONS` on every route.** `Authorization` forces a preflight even on GET.
   `Access-Control-Allow-Methods: GET, POST, OPTIONS` and
   `Access-Control-Allow-Headers: Authorization, Content-Type`.
   **`OPTIONS` must never consume rate-limit budget.**
4. **`POST /login` returns `token` at the top level** of the JSON body. This is the only field
   the client parses (index.html:142-144). Nesting it breaks the entire page.
5. **`/register` and `/login` must ignore any inbound `Authorization` header.** The client
   sends a stale one after any successful login.
6. **`POST /logout` accepts a POST with no body and no `Content-Type`** (index.html:149).
7. **File IDs are opaque `text`, matching the seed (`file_001`).** The client's File ID field
   defaults to `1` (index.html:79). With integer or UUID columns that is a Postgres cast error
   — a 500 where R3.3 demands a 404, and per constraint 1 a 500 freezes the client.
8. **Rate limiting is keyed on email, not IP.** All evaluation traffic shares `::1`; an IP key
   means probing Alice locks out Bob and Carol. A looser per-IP limit may sit alongside it.
9. **`index.html` is never modified.** Not for the custom backend, not for Appwrite. Selecting
   a radio button is usage, not modification.

---

## Hard constraints — violating any of these fails the submission

1. **Do not create a new GUI.** The provided `web/index.html` is the only client.
   If it must be modified at all (e.g. to point at a real API base URL instead of the
   mock), make the smallest possible change, keep it configurable, and record exactly
   what changed and why in `DECISIONS.md`.
2. **`mock-api.js` and `seed-data.json` are reference material only.** Never import,
   serve, require, or wrap them in backend code. Read them to derive the API contract,
   then leave them untouched.
3. **Two separate implementations**, clearly separated at the top level:
   - `custom-backend/` — hand-rolled, with PostgreSQL
   - `appwrite-backend/` — backed by Appwrite
4. **Open-source libraries only.**
5. **No secrets committed.** `.env` is gitignored; `.env.example` is committed and complete.

---

## The contract is settled

`API_CONTRACT.md` is written and is **binding**. Both backends conform to it exactly.
Re-read it before each phase. Do not re-derive the contract from the client; if something in
it looks wrong, raise it rather than silently diverging.

Open questions from the contract analysis are tracked as numbered ADRs in `DECISIONS.md`.
An ADR must be resolved and written down *before* code depending on it is written.

---

## Security invariants (these are the graded checks)

| Requirement | Implementation |
|---|---|
| Password storage | argon2id (preferred) or bcrypt cost ≥ 12. Never SHA/MD5, never reversible encryption. |
| Failed login response | One generic message for both "no such email" and "wrong password". Never reveal registration status. |
| User enumeration via timing | Always run a hash comparison against a dummy hash when the email doesn't exist, so both paths take comparable time. |
| Registration enumeration | `409` on duplicate email, matching the mock and the evaluator's expectation. R5.2 governs *login* only. The leak is deliberate, documented in ADR-0004, and the fix belongs in the README's "what I'd improve" section. |
| Logout | Deletes/revokes the session server-side. Presenting the old token afterwards returns 401. Prove this in a test. |
| `GET /me` | Derives identity **only** from the validated credential. Any `id`/`email`/`user_id` supplied in the URL, query string, or body is ignored entirely. |
| `GET /files` | Filters by the authenticated user's ID inside the query itself — never fetch-then-filter in application code. |
| `GET /files/:id` | See the status code policy below. This is the sharpest single discriminator in the task. |
| Rate limiting | Primary key is **email**, with a looser secondary key on IP. `OPTIONS` exempt. Thresholds env-configurable. The README must document how an evaluator resets a lockout. |
| Consistent validation | One auth middleware, applied to every protected route. No route may be individually exempted by accident. |

### Status code policy — be exact

| Situation | Status |
|---|---|
| No credential / malformed / expired / revoked credential | `401` |
| Valid credential, file exists but belongs to another user | `403` |
| Valid credential, file ID does not exist at all | `404` |
| Valid credential, own file | `200` |
| Valid credential, file ID malformed or unparseable | `404` — never 500 |
| Login with a missing or malformed field | `401`, matching the mock |
| Registration with an already-registered email | `409` (ADR-0004) |
| Rate limit exceeded | `429` **with a JSON body** |

The 403/404 distinction is explicitly called out in the task text. Most submissions
collapse these into one response. Do not.

Note the deliberate tension with the usual "return 404 to avoid leaking existence"
practice — the task asks for the distinction, so implement it as specified and discuss
the tradeoff in `DECISIONS.md`. That discussion is interview material.

---

## Seeding

At least 3 users, each with their own profile and their own files, plus at least one file
per user that the others must not be able to read. Seeding must be a single documented
command per backend. Credentials for the test accounts go in the README in plain sight —
the reviewer needs them.

---

## Definition of done

- [ ] `API_CONTRACT.md` written and both backends conform to it
- [ ] Unmodified (or minimally, documentedly modified) `index.html` works against **both** backends
- [ ] Automated test suite proving every row of the security invariants table
- [ ] Cross-user isolation tests: user A vs. user B, asserting 403 vs. 404 distinctly
- [ ] Seed script for each backend, ≥3 users with files
- [ ] `.env.example` complete for both backends
- [ ] Clean-clone test passes: fresh directory, follow README verbatim, everything runs
- [ ] `README.md` answers all five questions the task lists, explicitly
- [ ] `DECISIONS.md` records every ambiguity encountered and the reasoning used
- [ ] `ARCHITECTURE.md` — request lifecycle for an authenticated call, both backends

---

## Working style

- Verify, don't assume: actually start the servers and hit them with `curl` before
  claiming something works.
- Commit at the end of each phase with a meaningful message. Small, reviewable commits.
- If a requirement is genuinely ambiguous, pick the more defensible option, proceed, and
  append the reasoning to `DECISIONS.md`. Do not stall.
- Do not add features beyond the task. Extra surface area is extra attack surface and
  extra things to defend in the interview.
