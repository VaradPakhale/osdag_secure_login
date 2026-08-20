<!--
Source: FOSSEE / Osdag (IIT Bombay) — Autumn Semester-Long Internship 2026
Screening task: "Secure Login System with User Details & File Access"
Transcribed verbatim from the provided PDF. DO NOT EDIT the requirement text below.
Companion files referenced by this task live in ./web/
Submission deadline: 23 August 2026
-->

# Task: Secure Login System with User Details & File Access

## Overview

Build a login/registration/logout system, implemented twice, using two different backends:

1. A **custom backend** — Node/Express, or Python with Flask/FastAPI/Django + **PostgreSQL**
2. A **managed backend** using **Appwrite**

For both implementations, a user should be able to register, log in, log out, view their own
profile, and view/download files associated with their account. The UI does not need to be
styled — a plain interface is sufficient. Do not create a new GUI; you must use the provided
`web/index.html` testing client only. This task evaluates the correctness and security of the
authentication and data-access logic, not visual design.

**NOTE:**
The included `web/mock-api.js` and `web/seed-data.json` are **sample mockup files** provided to
demonstrate client-side behavior and expected API endpoint structure. They must not be used as
the actual backend implementation.

Where requirements are left open, please use your own judgment and document your reasoning. We
are as interested in how you approach ambiguous decisions as in the final implementation.

---

## Requirements

### 1. Authentication
- Registration (email + password)
- Login, returning a valid session (JWT or cookie-based — your choice, with a brief
  justification in the README)
- Logout, which should invalidate the session server-side rather than only clearing it on the
  client

### 2. User details (post-login)
- A protected route (e.g. `GET /me`) returning the logged-in user's own profile information
- This route must return data only for the authenticated user, and must not expose another
  user's data even if a different identifier is supplied

### 3. File access (post-login)
- Each user should have one or more files associated with their account (a simple upload
  endpoint, or seeded sample files, is acceptable)
- A protected route (e.g. `GET /files`) returning only the files belonging to the logged-in user
- A protected route (e.g. `GET /files/:id`) for a single file, which must correctly reject a
  request for a file belonging to a different user (distinct from a file that simply does not
  exist)

### 4. Multiple users
- Please seed or register at least 3 separate accounts, each with their own profile and files
- We will verify, using different accounts, that one user's data is never accessible to another

### 5. General security practices
- Passwords must be hashed, not encrypted or stored in plaintext
- Failed login attempts should return a generic error that does not reveal whether an email is
  registered
- Basic rate limiting or lockout after repeated failed login attempts is expected
- The token or session must be passed and validated consistently across all protected routes

---

## Submission

Please provide:

1. A link to your code repository containing both implementations.
2. Both implementations, clearly separated (folders, branches, or repos) within your repository.
3. A means of accessing the 3+ seeded test users and their files (a seed script or clear setup
   instructions)
4. A `README.md` covering:
   - Your reasoning on JWT vs. session-based authentication
   - How logout is implemented under the hood
   - How user data isolation is enforced
   - What Appwrite handled automatically versus what you configured yourself
   - What you would improve given more time

Please include clear setup instructions (e.g. `npm install && npm run dev`, and a `.env.example`
if applicable) so the project can be run without additional guidance.

## Next Steps

Following submission, this task will be followed by a technical interview, during which we will
review your implementation together.

---
---

## Requirement IDs

> Added for traceability. Not part of the original task text.
> Every automated test and every README section must reference the ID it satisfies.

| ID | Requirement |
|------|---|
| R1.1 | Registration with email + password |
| R1.2 | Login returns a valid session; choice of mechanism justified in README |
| R1.3 | Logout invalidates the session **server-side**, not just client-side |
| R2.1 | Protected route returns the logged-in user's own profile |
| R2.2 | `/me` must not expose another user's data even if a different identifier is supplied |
| R3.1 | Each user has one or more files associated with their account |
| R3.2 | `GET /files` returns only the logged-in user's files |
| R3.3 | `GET /files/:id` rejects another user's file **distinctly** from a nonexistent file |
| R4.1 | At least 3 seeded accounts, each with its own profile and files |
| R4.2 | One user's data is never accessible to another, verified across accounts |
| R5.1 | Passwords hashed — not encrypted, not plaintext |
| R5.2 | Failed login returns a generic error revealing nothing about registration status |
| R5.3 | Rate limiting or lockout after repeated failed login attempts |
| R5.4 | Token/session validated consistently across **all** protected routes |
| C1 | Provided `index.html` used as the only client; no new GUI built |
| C2 | `mock-api.js` / `seed-data.json` never used as backend implementation |
| S1 | Repository contains both implementations |
| S2 | Implementations clearly separated |
| S3 | Documented means of accessing the 3+ seeded users and their files |
| S4 | README covers all five listed questions |
| S5 | Setup instructions allow the project to run without additional guidance |
