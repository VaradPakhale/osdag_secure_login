import cookieParser from 'cookie-parser';
import express from 'express';
import { cors } from './middleware/cors.js';
import { errorHandler, notFoundHandler } from './middleware/errors.js';
import { authRouter } from './routes/auth.js';
import { filesRouter } from './routes/files.js';
import { meRouter } from './routes/me.js';

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');

  // CORS first: preflights answered before anything can reject them, and
  // OPTIONS never reaches the rate limiter. [ADR-0006]
  app.use(cors);
  app.use(cookieParser());

  // Only parses when Content-Type is JSON, so POST /logout — no body, no
  // Content-Type (web/index.html:149) — passes through with req.body === {}.
  app.use(express.json({ limit: '100kb' }));

  app.get('/health', (req, res) => res.status(200).json({ status: 'ok', backend: 'appwrite' }));

  app.use(authRouter);
  app.use(meRouter);
  app.use(filesRouter);

  // Both exist to guarantee a JSON body on every response, and to stop any
  // Appwrite error object escaping unmapped. See middleware/errors.js before
  // deleting either. [ADR-0007, ADR-0002]
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
