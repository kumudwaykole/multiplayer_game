import { loadConfig } from './config/env.js';
import { createLogger } from './observability/logger.js';
import { startServer } from './server.js';

const config = loadConfig();
const logger = createLogger(config.logLevel, config.env === 'development');

const server = await startServer(config, logger).catch((err: unknown) => {
  logger.fatal({ err }, 'failed to start');
  process.exit(1);
});

let exiting = false;
function shutdown(signal: NodeJS.Signals): void {
  if (exiting) return;
  exiting = true;
  // Planned shutdown is bounded; whatever is left after the timeout is
  // handled by restart reconciliation on the next boot.
  const force = setTimeout(() => {
    logger.error('shutdown timed out, exiting');
    process.exit(1);
  }, config.shutdownTimeoutMs);
  force.unref();
  server
    .stop(signal)
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      logger.error({ err }, 'shutdown failed');
      process.exit(1);
    });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandled rejection'));
