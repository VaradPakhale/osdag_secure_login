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

---

## Locked decisions

> Fill the first entry in after Prompt 0. Once a decision is recorded here, it is settled —
> do not revisit it in later sessions.

- **Auth mechanism:** _TBD after Prompt 0 — decided by what `web/index.html` actually sends._
- **Custom backend stack:** Express + PostgreSQL + argon2
- **Database connection:** read from a `DATABASE_URL` environment variable, never hardcoded.
  A `docker-compose.yml` is provided for reviewer convenience, but the app depends only on
  a connection string, not on any particular way of hosting Postgres.
- **Appwrite approach:** a thin adapter exposing routes identical to the custom backend, so
  one unmodified client serves both implementations.

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

## The client is the source of truth for the API contract

Before writing any server code, read `web/index.html` and `web/mock-api.js` and extract:

- every route path and HTTP method the client calls
- exact request body shapes
- exact response body shapes the client destructures
- how the credential is transmitted (`Authorization: Bearer …` vs. cookie)
- where the client stores the credential (localStorage / sessionStorage / cookie)
- which status codes the client branches on

Write this into `API_CONTRACT.md` **first**. Both backends implement that identical
contract, so the same unmodified `index.html` works against either one.

**Decision rule for the auth mechanism:** match whatever the client already does.
- If the client sends `Authorization: Bearer` → JWT, *plus* a server-side session/`jti`
  table so logout genuinely revokes (a stateless JWT alone does not satisfy the
  "invalidate server-side" requirement).
- If the client relies on cookies → httpOnly, `SameSite=Lax`, `Secure` in production,
  with an opaque session ID stored server-side.

Whichever you pick, the README must justify it.

---

## Security invariants (these are the graded checks)

| Requirement | Implementation |
|---|---|
| Password storage | argon2id (preferred) or bcrypt cost ≥ 12. Never SHA/MD5, never reversible encryption. |
| Failed login response | One generic message for both "no such email" and "wrong password". Never reveal registration status. |
| User enumeration via timing | Always run a hash comparison against a dummy hash when the email doesn't exist, so both paths take comparable time. |
| Registration enumeration | Registering an existing email must not leak that it exists any more than the flow strictly requires — document the tradeoff chosen in `DECISIONS.md`. |
| Logout | Deletes/revokes the session server-side. Presenting the old token afterwards returns 401. Prove this in a test. |
| `GET /me` | Derives identity **only** from the validated credential. Any `id`/`email`/`user_id` supplied in the URL, query string, or body is ignored entirely. |
| `GET /files` | Filters by the authenticated user's ID inside the query itself — never fetch-then-filter in application code. |
| `GET /files/:id` | See the status code policy below. This is the sharpest single discriminator in the task. |
| Rate limiting | Per-IP limit on the login route **and** per-account lockout after repeated failures. Both configurable via env. |
| Consistent validation | One auth middleware, applied to every protected route. No route may be individually exempted by accident. |

### Status code policy — be exact

| Situation | Status |
|---|---|
| No credential / malformed / expired / revoked credential | `401` |
| Valid credential, file exists but belongs to another user | `403` |
| Valid credential, file ID does not exist at all | `404` |
| Valid credential, own file | `200` |

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
