-- 001_init.sql — users, files, sessions, login_attempts
--
-- Design notes that are load-bearing (see ../../DECISIONS.md):
--   * files.id is `text`, holding the seed's opaque ids (file_001 ...).   [ADR-0003]
--   * sessions stores ONLY sha256(token) as bytea — never the token.     [ADR-0001]
--   * login_attempts is keyed by a string that encodes its own dimension
--     ('email:...' or 'ip:...') so one table serves both limiters.       [ADR-0006]

BEGIN;

-- ---------------------------------------------------------------- users ----
CREATE TABLE users (
    id            text        PRIMARY KEY,
    -- email as the user typed it, preserved for display
    email         text        NOT NULL,
    -- lower(trim(email)); the uniqueness + lookup key, so Alice@ and alice@
    -- can never become two accounts.                                 [ADR-0010]
    email_norm    text        NOT NULL UNIQUE,
    password_hash text        NOT NULL,
    full_name     text        NOT NULL DEFAULT '',
    display_name  text        NOT NULL DEFAULT '',
    bio           text        NOT NULL DEFAULT '',
    role          text        NOT NULL DEFAULT 'user',
    created_at    timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- files ----
CREATE TABLE files (
    id          text        PRIMARY KEY,
    owner_id    text        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    file_name   text        NOT NULL,
    mime_type   text        NOT NULL,
    size_bytes  bigint      NOT NULL CHECK (size_bytes >= 0),
    -- basename of the blob under STORAGE_DIR; never comes from user input
    -- and never leaves the server.                                    [ADR-0009]
    storage_key text        NOT NULL,
    uploaded_at timestamptz NOT NULL DEFAULT now()
);

-- Every file read is scoped by owner_id in the WHERE clause (R3.2), so this
-- index is on the actual access path, not decoration.
CREATE INDEX files_owner_id_idx ON files (owner_id);

-- ------------------------------------------------------------- sessions ----
CREATE TABLE sessions (
    -- raw 32-byte sha256 digest of the bearer token. A stolen dump of this
    -- table yields nothing replayable.                                [ADR-0001]
    token_hash bytea       PRIMARY KEY,
    user_id    text        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    -- absolute expiry, set once at login; never extended.
    expires_at timestamptz NOT NULL
);

CREATE INDEX sessions_user_id_idx    ON sessions (user_id);
CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);

-- -------------------------------------------------------- login_attempts ----
-- Fixed-window failure counter. Persisted rather than in-memory so a restart
-- cannot be used to shed a lockout — which is exactly why the documented
-- reset is a SQL statement and not "restart the server".              [ADR-0006]
CREATE TABLE login_attempts (
    key               text        PRIMARY KEY,   -- 'email:alice@example.com' | 'ip:::1'
    failures          integer     NOT NULL DEFAULT 0 CHECK (failures >= 0),
    window_started_at timestamptz NOT NULL DEFAULT now()
);

COMMIT;
