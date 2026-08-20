import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { query, queryOne } from '../db.js';
import { requireAuth } from '../middleware/auth.js';

export const filesRouter = express.Router();

const STORAGE_ROOT = path.resolve(config.storageDir);

function toFileDto(row) {
  return {
    id: row.id,
    ownerId: row.owner_id,
    fileName: row.file_name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    uploadedAt: row.uploaded_at.toISOString(),
  };
}

/**
 * Resolve a file for the *authenticated* caller, distinguishing 403 from 404.
 * [R3.2, R3.3]
 *
 * Two queries, and the split is the point:
 *
 *   1. The data query carries `owner_id = $2` in its WHERE clause. Another
 *      user's row is never loaded into this process at all — this is not
 *      fetch-then-filter, where a wrong `if` leaks the row it already holds.
 *
 *   2. Only on a miss do we ask whether the id exists, and that query selects
 *      the literal `1` — no columns, so it cannot leak anything beyond the
 *      existence bit that R3.3 explicitly requires us to disclose.
 *
 * Returns { status, file? }.
 */
async function resolveOwnedFile(fileId, userId) {
  const owned = await queryOne(
    `SELECT id, owner_id, file_name, mime_type, size_bytes, storage_key, uploaded_at
       FROM files
      WHERE id = $1
        AND owner_id = $2`,
    [fileId, userId]
  );

  if (owned) return { status: 200, file: owned };

  const exists = await queryOne(`SELECT 1 FROM files WHERE id = $1`, [fileId]);

  // Exists but is not ours -> 403. Does not exist -> 404. The task requires
  // these to be distinct (R3.3); the cost is that 403 confirms an id is real,
  // which is why ids are opaque and non-sequential. [ADR-0003]
  return exists ? { status: 403 } : { status: 404 };
}

const FORBIDDEN = { error: 'You do not have access to this file' };
const NOT_FOUND = { error: 'File not found' };

// ---------------------------------------------------------------------------
// GET /files
// ---------------------------------------------------------------------------
filesRouter.get('/files', requireAuth, async (req, res, next) => {
  try {
    // Ownership is the WHERE clause. There is no "fetch all then filter" path
    // to get wrong, and no query parameter that could widen it. [R3.2]
    const { rows } = await query(
      `SELECT id, owner_id, file_name, mime_type, size_bytes, uploaded_at
         FROM files
        WHERE owner_id = $1
        ORDER BY uploaded_at ASC, id ASC`,
      [req.auth.userId]
    );

    // Wrapped in `files` — web/mock-api.js:211. Empty list is 200 + [], not 404.
    return res.status(200).json({ files: rows.map(toFileDto) });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /files/:id/download
// ---------------------------------------------------------------------------
// Registered before /files/:id for readability; Express would not confuse them
// anyway, since the segment counts differ.
filesRouter.get('/files/:id/download', requireAuth, async (req, res, next) => {
  try {
    const { status, file } = await resolveOwnedFile(req.params.id, req.auth.userId);

    // Same isolation rules as the metadata route — R5.4 means every protected
    // route, not just the one R3.3 names.
    if (status === 403) return res.status(403).json(FORBIDDEN);
    if (status === 404) return res.status(404).json(NOT_FOUND);

    // storage_key is server-assigned and never user input, but resolve-and-check
    // anyway: this is the one place a path reaches the filesystem, and the cost
    // of the assertion is nothing next to the cost of being wrong. [ADR-0009]
    const absolutePath = path.resolve(STORAGE_ROOT, file.storage_key);
    if (absolutePath !== path.join(STORAGE_ROOT, path.basename(absolutePath))) {
      console.error('[files] storage_key escaped STORAGE_DIR:', file.storage_key);
      return res.status(500).json({ error: 'Internal server error' });
    }

    let stat;
    try {
      stat = await fs.promises.stat(absolutePath);
    } catch {
      // Metadata without bytes is a seeding fault, not a missing file from the
      // caller's point of view — say so plainly in the log, stay generic on the
      // wire. Usually means storage/ was wiped: `npm run seed` regenerates it.
      console.error('[files] blob missing on disk for', file.id, '->', absolutePath);
      return res.status(500).json({ error: 'Internal server error' });
    }

    // Content-Length comes from the FILE, not from the database column, so it
    // is true by construction. A stale row cannot produce a malformed response
    // where the client waits for bytes that never arrive. [ADR-0013]
    if (stat.size !== Number(file.size_bytes)) {
      console.warn(
        `[files] size drift on ${file.id}: db=${file.size_bytes} disk=${stat.size} ` +
          `— serving the disk size; re-run \`npm run seed\` to resync`
      );
    }

    res.setHeader('Content-Type', file.mime_type);
    res.setHeader('Content-Length', String(stat.size));
    // The client ignores this and saves as 'file-<id>' (web/index.html:186);
    // it is here for curl and for correctness.
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${file.file_name.replace(/"/g, '')}"; ` +
        `filename*=UTF-8''${encodeURIComponent(file.file_name)}`
    );

    // No encoding argument, deliberately: the stream emits raw Buffers. Passing
    // an encoding here would decode the bytes to a utf8 string and corrupt
    // every PDF, PNG, JPEG and DOCX we serve. [ADR-0013]
    const stream = fs.createReadStream(absolutePath);
    stream.on('error', (err) => {
      console.error('[files] stream error for', file.id, '-', err.message);
      if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
      else res.destroy(err);
    });
    return stream.pipe(res);
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /files/:id
// ---------------------------------------------------------------------------
filesRouter.get('/files/:id', requireAuth, async (req, res, next) => {
  try {
    // :id is an untyped string, passed as a query parameter. The client's field
    // defaults to "1" (web/index.html:79), which must produce a clean 404 — on
    // an integer or uuid column it would be a Postgres cast error, i.e. a 500
    // where R3.3 requires a 404. [ADR-0003]
    const { status, file } = await resolveOwnedFile(req.params.id, req.auth.userId);

    if (status === 403) return res.status(403).json(FORBIDDEN);
    if (status === 404) return res.status(404).json(NOT_FOUND);

    // Wrapped in `file` — web/mock-api.js:220. storage_key is intentionally
    // not in the DTO: it is an internal detail.
    return res.status(200).json({ file: toFileDto(file) });
  } catch (err) {
    return next(err);
  }
});
