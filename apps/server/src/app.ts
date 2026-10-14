import express, { type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import type { Logger } from 'pino';
import { csrfAndOrigin, errorHandler, loadSession, notFound, requestId } from './http/middleware.js';
import { createRouter, type RouteDeps } from './http/routes.js';

export interface AppDeps extends RouteDeps {
  logger: Logger;
}

/** Custom word lists can be up to 32 KiB of UTF-8. */
export const JSON_BODY_LIMIT = '32kb';

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', deps.config.trustProxy);

  app.use(requestId);
  app.use(
    pinoHttp({
      logger: deps.logger,
      genReqId: (_req, res) => (res as express.Response).locals.requestId,
      autoLogging: { ignore: (req) => req.url?.startsWith('/api/health') ?? false },
      // Only method, path and status: no query strings, cookies or bodies.
      serializers: {
        req: (req: { id: string; method: string; url: string }) => ({
          id: req.id,
          method: req.method,
          path: req.url.split('?')[0],
        }),
        res: (res: { statusCode: number }) => ({ status: res.statusCode }),
      },
    }),
  );
  app.use(helmet());
  app.use(express.json({ limit: JSON_BODY_LIMIT, strict: true }));
  app.use('/api', loadSession(deps.sessions, deps.config));
  app.use('/api', csrfAndOrigin(deps.config));
  app.use('/api', createRouter(deps));
  app.use('/api', () => notFound());
  app.use(errorHandler(deps.logger));
  return app;
}
