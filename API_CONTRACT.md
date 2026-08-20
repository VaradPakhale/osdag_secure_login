# API Contract — derived from the provided test client

**Scope.** This document describes *only* what `web/index.html` and `web/mock-api.js` actually
establish. Every claim is anchored to a line in those files. Where the client is silent,
ambiguous, or self-contradicting, it is flagged in [§7](#7-ambiguities-inconsistencies-and-gaps)
rather than resolved by guesswork; resolutions we adopt are recorded in `DECISIONS.md`.

Two distinct sources of truth are in play and they are **not** the same thing:

| Source | Authority |
|---|---|
| `web/index.html` | **Binding.** It is the only client, may not be replaced (TASK.md:20-21, C1), and its code determines what the server *must* do for the page to function. |
| `web/mock-api.js` | **Indicative.** Explicitly "a teaching/demo aid, not a reference implementation" (mock-api.js:16) and must not be the backend (TASK.md:25-27, C2). It is the reference for *shapes and status codes the evaluator will expect*, not a hard requirement of the client. |

The practical consequence, stated up front because it drives everything below:
**the client reads exactly one field out of any response body — `token` on `POST /login`.**
Every other response body is stringified and dumped into `<pre id="output">` for a human to
read (index.html:97-99, 119). We therefore mirror `mock-api.js` shapes exactly, not because
the client parses them, but because the evaluator will diff against them.

---

## 1. Transport, base URL, and mode selection

### 1.1 Base URL and path prefix

```js
// index.html:94
function base() { return document.getElementById('baseUrl').value.replace(/\/$/, ''); }
```

```html
<!-- index.html:31 -->
<label>Base URL <input id="baseUrl" value="http://localhost:3000" size="30"></label>
```

- Default origin is **`http://localhost:3000`**. The custom backend must listen there by default.
- One trailing slash is stripped, then the literal path is concatenated (index.html:116). All
  paths are **root-mounted**: `/register`, not `/api/register`. (An evaluator *can* type
  `http://localhost:3000/api` into the Base URL box and a `/api` mount would then work, but the
  default value implies root. We mount at root.)

### 1.2 Mode selection is *not* consulted by the client's request code

```html
<!-- index.html:24-26 -->
<label><input type="radio" id="mockMode" name="backendMode" value="mock" checked> Mock ...</label>
<label><input type="radio" name="backendMode" value="custom"> Custom REST backend ...</label>
<label><input type="radio" name="backendMode" value="appwrite"> Appwrite (appwrite-adapter.js ...)</label>
```

None of `doRegister/doLogin/doLogout/getMe/getFiles/getFileById/downloadFileById` inspect
`backendMode`. Routing happens entirely inside the `window.fetch` patch:

```js
// mock-api.js:236-240
window.fetch = async function (input, init) {
  const mockToggle = document.getElementById("mockMode");
  const mockEnabled = mockToggle && mockToggle.checked;
  if (!mockEnabled) return realFetch(input, init);
```

So:

- **`custom` selected** ⇒ `mockMode.checked === false` ⇒ native fetch to `base() + path`. This is
  the mode our custom backend serves. **No HTML change is required.**
- **`appwrite` selected** ⇒ *identical behaviour to `custom`* — a plain HTTP request to the Base
  URL. Nothing in the shipped client talks to Appwrite. See [§7.1](#71-appwrite-mode-is-inert-as-shipped).
- The mock radio is `checked` by default (index.html:24), so the evaluator must actively select
  a real-backend radio. That is usage, not modification.

### 1.3 CORS is mandatory, and preflight is unavoidable

The page is loaded from somewhere other than `http://localhost:3000` (a static server, or
`file://` — mock-api.js:35-36 and 105 explicitly anticipate the `file://` case). Therefore every
call is cross-origin. Both credential paths attach a non-simple header:

- `Authorization` (index.html:111, 173) ⇒ preflight on **every** request including `GET`.
- `Content-Type: application/json` (index.html:127, 138) ⇒ preflight on register/login.

**Required:** `OPTIONS` must be answered on every route with
`Access-Control-Allow-Methods: GET, POST, OPTIONS` and
`Access-Control-Allow-Headers: Authorization, Content-Type`.
`OPTIONS` must **not** consume the login rate-limit budget ([§7.9](#79-rate-limit-key-and-preflightmethod-interactions)).

For cookie mode (`credentials: 'include'`, index.html:114, 176) the wildcard origin is illegal —
the server must echo the exact `Origin` and send `Access-Control-Allow-Credentials: true`.
From `file://` the origin is opaque (`null`), which makes credentialed CORS unusable; bearer
mode still works there with `Access-Control-Allow-Origin: *`. This asymmetry is a material
input to `DECISIONS.md` ADR-0001.

---

## 2. Credential transport

```js
// index.html:108-120
async function request(path, options = {}) {
  options.headers = options.headers || {};
  if (!useCookies() && tokenVal()) {
    options.headers['Authorization'] = 'Bearer ' + tokenVal();
  }
  if (useCookies()) {
    options.credentials = 'include';
  }
  const res = await fetch(base() + path, options);
  let body;
  try { body = await res.json(); } catch (e) { body = await res.text(); }
  return { status: res.status, body };
}
```

```html
<!-- index.html:32 -->
<label><input type="checkbox" id="useCookies"> Backend uses cookie sessions (send credentials)</label>
```

| `useCookies` | Token field | What is sent |
|---|---|---|
| unchecked (**default**) | non-empty | `Authorization: Bearer <token>`; `credentials` unset ⇒ browser default `same-origin` ⇒ **no cookies cross-origin** |
| unchecked | empty | No credential at all. Protected routes must 401. |
| checked | any | **No `Authorization` header ever** (guarded by `!useCookies()`); `credentials: 'include'` ⇒ cookies sent. The token field is dead in this mode. |

The two modes are mutually exclusive by construction — the client never sends both.

Additional consequence worth stating because it is easy to get wrong server-side: after a
successful login the token field is populated (index.html:142-144), so a *subsequent*
`POST /register` or `POST /login` will also carry an `Authorization` header. **`/register` and
`/login` must ignore any inbound `Authorization` header**, not reject or honour it.

---

## 3. Response-body parsing — a hard constraint the mock never exposes

```js
// index.html:118
try { body = await res.json(); } catch (e) { body = await res.text(); }
```

This fallback **does not work**. Per the Fetch spec, `Response.json()` marks the body as
disturbed *before* parsing; when parsing fails the subsequent `res.text()` throws
`TypeError: Body is unusable: Body has already been read`. That `TypeError` escapes `request()`,
rejects the promise returned by `doLogin()`/`getMe()`/etc., and since these are invoked from bare
`onclick=` handlers (index.html:59, 66-67, 77-80) nothing catches it. **The `<pre>` keeps showing
the previous response and the evaluator sees a stale, misleading result.**

Verified against the reference fetch implementation (Node 24 / undici, same spec as browsers):

| Response body | `json()` | then `text()` | Client outcome |
|---|---|---|---|
| `Too many requests, please try again later.` (429) | throws | **throws** | handler rejects, pane stale |
| `<!DOCTYPE html>…` (404/500 error page) | throws | **throws** | handler rejects, pane stale |
| `''` with `Content-Length: 0` on a body-permitting status | throws | **throws** | handler rejects, pane stale |
| genuine `204` (HTTP forbids a body ⇒ null body) | throws | recovers `""` | pane shows an empty body — misleading, not fatal |
| `{"error":"nope"}` | OK | — | correct |

`mock-api.js` never trips this because its `json()` helper (mock-api.js:112-117) is used for every
response on these routes. A real backend trips it easily. Therefore:

> **Contract requirement.** Every response to `/register`, `/login`, `/logout`, `/me`, `/files`,
> `/files/:id` — success *and* error, at every status code — MUST have a body that is valid
> JSON text.

Concretely this rules out:

- Any empty or bodyless response, including `204` and `res.status(401).end()`.
- Express's default HTML 404 page and default HTML error handler ⇒ install JSON catch-all
  404 and error middleware.
- `express-rate-limit`'s default `429` body, which is the plain-text string
  `Too many requests, please try again later.` ⇒ must be overridden with a JSON handler.
- Any HTML error page from an intervening proxy.

This is the least obvious requirement in the whole contract, because the failure is silent: the
page shows the *previous* response with no error anywhere except the devtools console.

`GET /files/:id/download` is exempt — it uses `res.text()` only (index.html:179), never `.json()`.

---

## 4. Endpoint-by-endpoint contract

Response shapes below are quoted from `mock-api.js` and are **indicative** (see [§6](#6-what-the-client-actually-branches-on)),
except where marked **binding**.

---

### 4.1 `POST /register`

**Client call site**

```js
// index.html:122-131
async function doRegister() {
  const email = document.getElementById('regEmail').value;
  const password = document.getElementById('regPassword').value;
  const result = await request('/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  log('POST /register', result);
}
```

| | |
|---|---|
| **Method / path** | `POST /register` |
| **Request headers** | `Content-Type: application/json`; plus `Authorization: Bearer <token>` iff the token field is non-empty and cookie mode is off (§2) |
| **Request body** | `{"email": string, "password": string}` — exactly these two keys, no others |
| **Credentials** | None required. Must succeed with no session. |

Defaults submitted by the page: `alice@example.com` / `Password123!` (index.html:57-58).

**Responses** (mock-api.js:147-162)

```js
// mock-api.js:149-150, 161
if (!email || !password) return json(400, { error: "email and password are required" });
if (state.usersByEmail.has(email)) return json(409, { error: "An account with that email already exists" });
...
return json(201, { id, email });
```

| Status | Body | Notes |
|---|---|---|
| `201` | `{"id": "usr_xxxxxx", "email": "..."}` | **No token is returned** — registration does not log you in; the user must then call `/login`. |
| `400` | `{"error": "email and password are required"}` | missing/empty field |
| `409` | `{"error": "An account with that email already exists"}` | ⚠ enumeration — see [§7.5](#75-registration-leaks-account-existence-409) |

Registration also seeds an empty profile and an empty file list (mock-api.js:157, 160), so a
freshly registered user's `/me` returns `fullName: ""` and `/files` returns `{"files": []}`.

---

### 4.2 `POST /login`

**Client call site**

```js
// index.html:133-146
async function doLogin() {
  const email = document.getElementById('loginEmail').value;
  const password = document.getElementById('loginPassword').value;
  const result = await request('/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  // If the backend returns a JWT in the body, auto-fill the token field
  if (result.body && result.body.token) {
    document.getElementById('token').value = result.body.token;
  }
  log('POST /login', result);
}
```

| | |
|---|---|
| **Method / path** | `POST /login` |
| **Request headers** | `Content-Type: application/json` (+ stale `Authorization`, §2) |
| **Request body** | `{"email": string, "password": string}` |

**Response — the one binding shape in the whole API**

> **BINDING:** on success the JSON body MUST contain a **top-level string property `token`**
> (index.html:142-144). Without it the token field stays empty, no `Authorization` header is
> ever attached, and every protected route 401s. Nesting it (`{"data":{"token":...}}`) breaks
> the client.

```js
// mock-api.js:188-190
const token = newToken();
state.sessions.set(token, { userId: user.id, expiresAt: Date.now() + SESSION_TTL_MS });
return json(200, { token, user: { id: user.id, email: user.email } });
```

| Status | Body | Established by |
|---|---|---|
| `200` | `{"token": "<opaque>", "user": {"id": "...", "email": "..."}}` | mock-api.js:190; `token` binding per index.html:142 |
| `401` | `{"error": "Invalid email or password"}` — identical for unknown email and wrong password | mock-api.js:166, 184 (`// never reveal whether the email exists`) → R5.2 |
| `429` | `{"error": "Too many failed attempts. Try again in a bit."}` | mock-api.js:169-171 → R5.3 |

Lockout parameters the mock establishes (mock-api.js:30-32): TTL 30 min, 5 failed attempts,
60-second lockout. The counter is keyed by **email**, and is incremented on every failure
including for non-existent emails (mock-api.js:177-183) — which is what keeps the counter from
becoming an enumeration oracle.

Note the mock's token is **opaque and random**, not a JWT: `crypto.randomUUID() + "." + Date.now()`
(mock-api.js:119-121), validated by `Map` lookup (mock-api.js:129-139). The client's comments say
"JWT/bearer" (index.html:71, 141) but the reference behaviour is an opaque server-side session
token presented as a Bearer credential. See ADR-0001.

---

### 4.3 `POST /logout`

**Client call site**

```js
// index.html:148-152
async function doLogout() {
  const result = await request('/logout', { method: 'POST' });
  document.getElementById('token').value = '';
  log('POST /logout', result);
}
```

| | |
|---|---|
| **Method / path** | `POST /logout` |
| **Request headers** | **No `Content-Type`.** Only `Authorization` (bearer mode) or cookies (cookie mode). |
| **Request body** | **None.** Not `{}` — absent entirely. |

> **Contract requirement.** The route must accept a `POST` with no body and no `Content-Type`.
> A body parser that rejects a missing `Content-Type`, or a validator requiring a JSON body,
> will break logout.

The client clears its token field **unconditionally, after the request, ignoring the status**
(index.html:150). So the client always *appears* logged out. This makes logout the single
requirement (R1.3) that cannot be verified through the UI alone — proving server-side
invalidation requires re-pasting the old token into the field and calling `GET /me`.

**Responses** (mock-api.js:193-197)

```js
async function handleLogout(req) {
  const token = getBearer(req);
  if (token) state.sessions.delete(token); // server-side invalidation, not just a client-side clear
  return json(200, { message: "Logged out" });
}
```

| Status | Body | Notes |
|---|---|---|
| `200` | `{"message": "Logged out"}` | Returned **unconditionally** — no token, expired token, and unknown token all yield 200. Logout is idempotent and unauthenticated in the mock. See [§7.6](#76-should-logout-require-a-valid-session). |

---

### 4.4 `GET /me`

**Client call site**

```js
// index.html:154-157
async function getMe() {
  const result = await request('/me', { method: 'GET' });
  log('GET /me', result);
}
```

| | |
|---|---|
| **Method / path** | `GET /me` |
| **Request headers** | `Authorization: Bearer <token>` (or cookies) — nothing else |
| **Request body** | None |
| **Query params** | **None. The client never supplies a user identifier of any kind.** |

**Responses** (mock-api.js:199-205)

| Status | Body |
|---|---|
| `200` | `{"id": "usr_001", "email": "alice@example.com", "profile": {"fullName", "displayName", "bio", "createdAt", "role"}}` — flat, **not** wrapped in a `user` envelope (contrast `/login`, which *does* wrap) |
| `401` | `{"error": "Not authenticated"}` — for both "no/invalid token" (mock-api.js:201) and "token resolves to a vanished user" (mock-api.js:203) |

The profile field set comes from `seed-data.json:9-15`.

R2.2 ("must not expose another user's data even if a different identifier is supplied") **cannot
be exercised from this client** — there is no input for it. It will be probed out-of-band
(`/me?id=usr_002`, `/me/usr_002`, an `X-User-Id:` header, an `id` in a body). The contract is
therefore: **`/me` derives the subject solely from the credential and ignores every other input;
no `/me/:id` variant exists.**

---

### 4.5 `GET /files`

**Client call site**

```js
// index.html:159-162
async function getFiles() {
  const result = await request('/files', { method: 'GET' });
  log('GET /files', result);
}
```

| | |
|---|---|
| **Method / path** | `GET /files` |
| **Request headers** | `Authorization: Bearer <token>` (or cookies) |
| **Query params** | None. No pagination, no filtering, no `ownerId`. |

**Responses** (mock-api.js:207-212)

| Status | Body |
|---|---|
| `200` | `{"files": [ {"id", "ownerId", "fileName", "mimeType", "sizeBytes", "uploadedAt"}, ... ]}` — **wrapped** in a `files` key (mock-api.js:211) |
| `401` | `{"error": "Not authenticated"}` |

File object fields come from `seed-data.json:17-24`. An empty list for a user with no files is
`{"files": []}` with status `200` (mock-api.js:210), not `404`.

Note the response echoes `ownerId` back to the client (seed-data.json:19). That is harmless
here — it is always the caller's own id — and it makes cross-user isolation visually verifiable
in the output pane, so we keep it.

---

### 4.6 `GET /files/:id`

**Client call site**

```js
// index.html:164-168
async function getFileById() {
  const id = document.getElementById('fileId').value;
  const result = await request('/files/' + id, { method: 'GET' });
  log('GET /files/' + id, result);
}
```

```html
<!-- index.html:79 -->
<label>File ID <input id="fileId" value="1" size="10"></label>
```

| | |
|---|---|
| **Method / path** | `GET /files/<raw value of the text input>` |
| **Request headers** | `Authorization: Bearer <token>` (or cookies) |

The id is **not** URL-encoded or validated by the client — whatever is typed is concatenated
into the path. The default value is `1`, which matches nothing in the seed data ([§7.4](#74-default-file-id-1-vs-seeded-ids-file_001)).

**Responses** (mock-api.js:214-221) — this is the endpoint the whole task hinges on (R3.3):

```js
const file = state.filesById.get(fileId);
if (!file) return json(404, { error: "File not found" });
if (file.ownerId !== userId) return json(403, { error: "You do not have access to this file" }); // distinct from 404
return json(200, { file });
```

| Status | Body | Meaning |
|---|---|---|
| `200` | `{"file": {...}}` — **wrapped** in a `file` key | own file |
| `401` | `{"error": "Not authenticated"}` | no/invalid session |
| `403` | `{"error": "You do not have access to this file"}` | **exists, belongs to someone else** |
| `404` | `{"error": "File not found"}` | does not exist at all |

The 403/404 split is explicitly mandated (R3.3, and the mock's own inline comment
`// distinct from 404`). Note this is a deliberate, documented trade of confidentiality for
requirement compliance: distinguishing the two confirms the existence of another user's file id.
Since ids are opaque and non-sequential the leak is negligible, and the requirement is
unambiguous.

---

### 4.7 `GET /files/:id/download`

**Client call site — the only handler that bypasses `request()`**

```js
// index.html:170-189
async function downloadFileById() {
  const id = document.getElementById('fileId').value;
  const headers = {};
  if (!useCookies() && tokenVal()) headers['Authorization'] = 'Bearer ' + tokenVal();
  const res = await fetch(base() + '/files/' + id + '/download', {
    headers,
    credentials: useCookies() ? 'include' : 'same-origin'
  });
  if (!res.ok) {
    log('GET /files/' + id + '/download', { status: res.status, body: await res.text() });
    return;
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'file-' + id;
  a.click();
  log('GET /files/' + id + '/download', { status: res.status, note: 'File download triggered.' });
}
```

| | |
|---|---|
| **Method / path** | `GET /files/<id>/download` |
| **Request headers** | `Authorization: Bearer <token>` only (bearer mode). No `Content-Type`. |
| **Credentials** | `'include'` in cookie mode, explicitly `'same-origin'` otherwise |

**This is the client's only real status branch:** `res.ok` (index.html:178), i.e. `200-299`
versus everything else.

- **`res.ok` true** → the body is consumed as a **blob** and saved. The body must be the file bytes.
- **`res.ok` false** → the body is consumed as **text** and displayed. JSON is fine here (it
  renders as a raw JSON string), plain text is fine too.

**Responses** (mock-api.js:223-231) — note the mock returns **plain-text** error bodies here,
unlike every other route:

| Status | Body | Content-Type |
|---|---|---|
| `200` | file bytes | mock returns `text/plain` with a stand-in string (mock-api.js:229-230); a real backend streams the actual bytes with the file's `mimeType` |
| `401` | `Not authenticated` (plain text) | — |
| `403` | `Forbidden` (plain text) | — |
| `404` | `File not found` (plain text) | — |

Two behaviours worth recording:

1. **`Content-Disposition` is ignored by the client.** The saved filename is hard-coded to
   `'file-' + id` (index.html:186). We still send a correct `Content-Disposition: attachment;
   filename="..."` for `curl`-based checking and general correctness.
2. **The 403-vs-404 distinction must be preserved here too** (mock-api.js:227-228), even though
   R3.3 only names `GET /files/:id`, since R5.4 demands consistent enforcement across *all*
   protected routes.

---

## 5. Status-code summary

| Route | 200 | 201 | 400 | 401 | 403 | 404 | 409 | 429 |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `POST /register` | | ✓ | ✓ | | | | ✓ | ⚠ §7.9 |
| `POST /login` | ✓ | | ⚠ §7.7 | ✓ | | | | ✓ |
| `POST /logout` | ✓ | | | ⚠ §7.6 | | | | |
| `GET /me` | ✓ | | | ✓ | | | | |
| `GET /files` | ✓ | | | ✓ | | | | |
| `GET /files/:id` | ✓ | | | ✓ | ✓ | ✓ | | |
| `GET /files/:id/download` | ✓ | | | ✓ | ✓ | ✓ | | |

---

## 6. What the client *actually* branches on

Stated exhaustively, because it is a much shorter list than the table above and it separates
"the page will break" from "the evaluator will raise an eyebrow":

1. **`res.ok`** — index.html:178, download only. The single genuine status-code branch.
2. **`result.body.token` truthiness** — index.html:142. Drives the entire authenticated flow.
3. **`res.json()` succeeding** — index.html:118. Not a branch so much as a trap: the `catch`
   path is itself broken (§3), so non-JSON on the six `request()` routes silently freezes the
   output pane.
4. **`mockMode.checked`** — mock-api.js:237. Decides real vs. mock fetch.

Nothing else. `401`, `403`, `404`, `409` and `429` are never inspected by client code — they are
rendered as text for a human. They are still binding on us via TASK.md R3.3/R5.2/R5.3 and via
the evaluator's out-of-band `curl` checks; they are simply not enforced by the page.

---

## 7. Ambiguities, inconsistencies, and gaps

Flagged rather than silently resolved. "Proposal" marks *our* reading, to be ratified in
`DECISIONS.md` — it is not something the client establishes.

### 7.1 Appwrite mode is inert as shipped

The radio at index.html:26 promises "appwrite-adapter.js talks to Appwrite directly via its Web
SDK", but `appwrite-adapter.js` **is not in the repository**, its `<script>` tags are commented
out (index.html:88-92), and no client function branches on the selected mode (§1.2). As shipped,
selecting "Appwrite" produces plain HTTP calls to the Base URL — byte-identical to "Custom".

*Ambiguity:* does the Appwrite implementation talk to Appwrite from the browser (adapter), or sit
behind a server that exposes this same REST surface? Both satisfy the written requirements.
*Proposal:* author `appwrite-adapter.js` and uncomment index.html:89-92 — the comment at line 88
("Uncomment or include these when implementing the Appwrite backend mode") is an explicit
invitation, and the adapter can patch `window.fetch` exactly as `mock-api.js` does, chaining
correctly because it loads after it. Tracked in the `DECISIONS.md` backlog.

### 7.2 "Checkbox" vs. radio group in the mock's own documentation

mock-api.js:26 and mock-api.js:265 both describe a "Use in-browser mock API **checkbox**",
but index.html:24 ships a **radio** in a three-way group. The DOM id `mockMode` matches and
`.checked` works for both, so this is stale prose, not a functional defect. Recorded so that
nobody "fixes" the client to match the comment.

### 7.3 Response envelopes are inconsistent across routes

`/login` wraps the user (`{token, user:{...}}`, mock-api.js:190) but `/me` does **not**
(`{id, email, profile}`, mock-api.js:204); `/files` wraps in `files` (mock-api.js:211) and
`/files/:id` wraps in `file` (mock-api.js:220). There is no single house style to infer.
*Proposal:* reproduce the mock's shapes exactly, inconsistencies included. The client parses
none of it (§6), so matching the evaluator's expectations beats imposing a tidier scheme.

### 7.4 Default File ID `1` vs. seeded ids `file_001`

index.html:79 ships `value="1"`; seed-data.json:18 uses `"file_001"`. The first thing an
evaluator clicks after login is therefore `GET /files/1`.

*This is a live failure mode, not a cosmetic one.* If file ids are integers or UUIDs in Postgres,
the literal string `file_001` (or `1` against a `uuid` column) reaches the query layer and
Postgres raises `invalid input syntax`, producing a **500** where the contract demands **404** —
and, per §3, a 500 rendered as an HTML error page freezes the output pane entirely.
*Proposal:* use opaque `text` ids matching the seed (`file_001`…`file_006`), treat `:id` as an
untyped string, and return a clean JSON `404` for anything unmatched. `GET /files/1` must yield
`404 {"error":"File not found"}`.

### 7.5 Registration leaks account existence (409)

mock-api.js:150 returns `409 "An account with that email already exists"`, which is a
straightforward user-enumeration oracle — in tension with the spirit of R5.2, though R5.2's
letter covers only *failed login*. Suppressing it properly (always 201/202, verify by email)
requires a mail flow that is out of scope and would make the seeded-account workflow untestable.
*Proposal:* keep the mock's `409`, subject it to the same rate limiter as login, and document the
trade-off explicitly rather than quietly diverging from the reference in either direction.

### 7.6 Should logout require a valid session?

mock-api.js:193-197 returns `200` unconditionally — no token, garbage token, and already-revoked
token all succeed. An alternative reading is `401` for an unauthenticated logout.
*Proposal:* follow the mock — `200` always, idempotent. Rationale: the client clears its token
regardless of status (index.html:150), so a `401` conveys nothing to the user; an always-`200`
logout also refuses to confirm whether a presented token was valid.

### 7.7 Login with a missing field: `400` or `401`?

`/register` explicitly validates and returns `400` (mock-api.js:149). `/login` has no such
guard: a missing email makes `state.usersByEmail.get(undefined)` return `undefined`, `valid`
short-circuits falsy, and the mock returns **`401`** (mock-api.js:173-184) — while still
incrementing the lockout counter under the key `undefined`.
*Ambiguity:* the mock is internally inconsistent between its two entry points.
*Proposal:* `400` for a structurally invalid request (missing/non-string field) *without*
incrementing the failure counter, `401` for well-formed-but-wrong credentials. A `400` on a
missing field reveals nothing about registration status, so R5.2 is unaffected.

### 7.8 Download error bodies are plain text; every other route is JSON

mock-api.js:225-228 uses bare `new Response("Not authenticated", {status: 401})` rather than the
`json()` helper. The client tolerates both on this route (`res.text()`, index.html:179).
*Proposal:* return JSON error bodies here too, for consistency with R5.4 and with `curl`-based
checks. This is safe precisely because the download handler never calls `res.json()`.

### 7.9 Rate-limit key, and preflight/method interactions

Three under-specified points that the mock papers over because it runs in a single browser tab:

- **Key.** The mock keys lockout on **email alone** (mock-api.js:81, 168). A real backend keying
  on **IP alone** breaks evaluation: all three test accounts share `::1` on localhost, so locking
  out while probing Alice would also lock out Bob and Carol. *Proposal:* per-email lockout as the
  primary control (5 attempts / 60 s, mirroring mock-api.js:31-32) plus a looser per-IP ceiling,
  and document how to reset it.
- **Counter reset.** mock-api.js:181-182 zeroes `count` when it locks, so the post-lockout budget
  restarts at 5 rather than escalating. *Proposal:* mirror this — predictable for an evaluator.
- **Preflight.** Every login attempt is preceded by an `OPTIONS` (§1.3). A limiter counting all
  methods halves the effective budget and can 429 the preflight itself, which surfaces in the
  browser as an opaque CORS failure rather than a `429`. *Proposal:* exempt `OPTIONS`.

### 7.10 No upload affordance exists in the client

The client has no file input and no `POST /files` call. TASK.md:49-50 permits "seeded sample
files" as an alternative to an upload endpoint. *Proposal:* seed files; if an upload endpoint is
added it is a bonus, testable only via `curl`, and it must not alter any shape above.

### 7.11 Session lifetime is stated only by the mock

30 minutes, absolute (`SESSION_TTL_MS`, mock-api.js:30, applied at mock-api.js:189 and checked at
mock-api.js:134-137). Sliding vs. absolute expiry is not addressed anywhere.
*Proposal:* absolute 30-minute expiry, matching the mock; an expired token ⇒ `401` with the same
body as "no token" — the client cannot distinguish the two, and neither should an attacker.

### 7.12 Token format is described inconsistently

index.html:71 and 141 say "JWT"; the mock issues an opaque random string validated against a
server-side `Map` (mock-api.js:119-121, 129-139). The client only requires *a string in
`body.token`* that it can echo back as a Bearer credential (index.html:111, 142-144) — the format
is genuinely free. Resolved in `DECISIONS.md` ADR-0001.
