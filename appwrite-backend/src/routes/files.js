import express from 'express';
import { Query } from 'node-appwrite';
import { config } from '../config.js';
import { adminDatabases, sessionScoped } from '../lib/appwrite.js';
import { CONTRACT } from '../lib/contract-errors.js';
import { requireAuth } from '../middleware/auth.js';

export const filesRouter = express.Router();

const DB_ID = () => config.appwrite.databaseId;
const FILES = () => config.appwrite.filesCollectionId;
const BUCKET = () => config.appwrite.bucketId;

function toFileDto(doc) {
  return {
    id: doc.$id,
    ownerId: doc.ownerId,
    fileName: doc.fileName,
    mimeType: doc.mimeType,
    sizeBytes: doc.sizeBytes,
    uploadedAt: doc.uploadedAt,
  };
}

/**
 * Appwrite id syntax: ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,35}$
 *
 * The client's File ID box defaults to "1" and a reviewer may type anything.
 * An id Appwrite would reject outright must come back as a clean 404, not as a
 * 400 from the SDK leaking through — same requirement that made file ids opaque
 * text in custom-backend. [ADR-0003]
 */
const APPWRITE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,35}$/;

/**
 * Resolve a file for the authenticated caller, distinguishing 403 from 404.
 * [R3.2, R3.3]
 *
 * The read is made with the USER'S OWN Appwrite session. If the document
 * belongs to someone else, Appwrite's document-level permissions refuse it —
 * we do not write an ownership check, and there is no `WHERE ownerId = ...`
 * anywhere in this file. That is ADR-0002's whole claim, and it is what makes
 * README question 4 answerable honestly.
 *
 * The existence probe on a miss is the one thing Appwrite cannot give us:
 * it answers "not yours" and "not there" identically (404, so as not to
 * disclose existence), while R3.3 demands they be DISTINCT. So the probe uses
 * the admin client — reading nothing but whether the id exists, never any
 * field of the document. See the isolation table in the README.
 */
async function resolveOwnedFile(fileId, sessionSecret) {
  if (!APPWRITE_ID.test(fileId)) return { status: 404 };

  const { databases } = sessionScoped(sessionSecret);

  try {
    const doc = await databases.getDocument(DB_ID(), FILES(), fileId);
    return { status: 200, file: doc };
  } catch (err) {
    if (err?.code !== 404 && err?.code !== 401) throw err;
  }

  // Existence only. Selects no user data — just whether the id is real.
  try {
    await adminDatabases().getDocument(DB_ID(), FILES(), fileId);
    return { status: 403 }; // exists, but the user's own session was refused
  } catch {
    return { status: 404 };
  }
}

// ---------------------------------------------------------------------------
// GET /files
// ---------------------------------------------------------------------------
filesRouter.get('/files', requireAuth, async (req, res, next) => {
  req.contractContext = 'files';
  try {
    // No ownerId filter. The user's session sees exactly the documents
    // Appwrite's read permissions grant them — isolation is enforced by the
    // platform, not by this query. [ADR-0002, R3.2]
    const { databases } = sessionScoped(req.auth.sessionSecret);
    const { documents } = await databases.listDocuments(DB_ID(), FILES(), [
      Query.orderAsc('uploadedAt'),
      Query.limit(100),
    ]);

    return res.status(200).json({ files: documents.map(toFileDto) });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /files/:id/download
// ---------------------------------------------------------------------------
filesRouter.get('/files/:id/download', requireAuth, async (req, res, next) => {
  req.contractContext = 'files';
  try {
    const { status, file } = await resolveOwnedFile(req.params.id, req.auth.sessionSecret);
    if (status === 403) return res.status(403).json(CONTRACT.fileForbidden().body);
    if (status === 404) return res.status(404).json(CONTRACT.fileNotFound().body);

    // Bytes are fetched with the user's session too, so bucket file permissions
    // apply on top of the document permissions.
    const { storage } = sessionScoped(req.auth.sessionSecret);

    let bytes;
    try {
      // Returns an ArrayBuffer; wrap as a Buffer and never touch it as a
      // string — a utf8 round-trip corrupts every byte above 0x7F. [ADR-0013]
      const raw = await storage.getFileDownload(BUCKET(), file.storageFileId);
      bytes = Buffer.from(raw);
    } catch (err) {
      if (err?.code === 404) return res.status(404).json(CONTRACT.fileNotFound().body);
      if (err?.code === 401 || err?.code === 403) {
        return res.status(403).json(CONTRACT.fileForbidden().body);
      }
      throw err;
    }

    res.setHeader('Content-Type', file.mimeType);
    // From the bytes we actually hold, so it cannot disagree with the body. [ADR-0013]
    res.setHeader('Content-Length', String(bytes.length));
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${String(file.fileName).replace(/"/g, '')}"; ` +
        `filename*=UTF-8''${encodeURIComponent(file.fileName)}`
    );

    return res.status(200).end(bytes);
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /files/:id
// ---------------------------------------------------------------------------
filesRouter.get('/files/:id', requireAuth, async (req, res, next) => {
  req.contractContext = 'files';
  try {
    const { status, file } = await resolveOwnedFile(req.params.id, req.auth.sessionSecret);
    if (status === 403) return res.status(403).json(CONTRACT.fileForbidden().body);
    if (status === 404) return res.status(404).json(CONTRACT.fileNotFound().body);

    return res.status(200).json({ file: toFileDto(file) });
  } catch (err) {
    return next(err);
  }
});
