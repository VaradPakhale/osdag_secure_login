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

  // req.ip should be the real client when behind a proxy. Loopback only by
  // default: trusting arbitrary X-Forwarded-For would let anyone spoof their
  // way past the IP limiter. [ADR-0006]
  app.set('trust proxy', 'loopback');

  // CORS first: preflights must be answered before anything can reject them,
  // and OPTIONS must never reach the rate limiter. [ADR-0006]
  app.use(cors);

  app.use(cookieParser());

  // Only parses when Content-Type is JSON, so POST /logout — which the client
  // sends with no body and no Content-Type (web/index.html:149) — passes
  // through with req.body === {}. Malformed JSON throws and is rendered as a
  // JSON 400 by errorHandler. [ADR-0007]
  app.use(express.json({ limit: '100kb' }));

  // Routes are mounted at the root: the client concatenates base() + '/register'
  // with no prefix (web/index.html:116). API_CONTRACT.md §1.1.
  app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));

  app.use(authRouter);
  app.use(meRouter);
  app.use(filesRouter);

  // Terminal handlers, in this order. Both exist to guarantee a JSON body on
  // every response — see the comment in middleware/errors.js before deleting
  // either of them. [ADR-0007]
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
