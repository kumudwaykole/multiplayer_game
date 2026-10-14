import { pino, type Logger } from 'pino';

/**
 * Structured logs. Cookies, words, guesses, chat text and custom word lists
 * are redacted wherever they appear.
 */
export function createLogger(level: string, pretty: boolean): Logger {
  return pino({
    level,
    redact: {
      paths: [
        'req.headers.cookie',
        'req.headers["x-csrf-token"]',
        'res.headers["set-cookie"]',
        '*.word',
        '*.answer',
        '*.text',
        '*.customWords',
        '*.candidates',
        '*.token',
      ],
      censor: '[redacted]',
    },
    ...(pretty ? { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss.l' } } } : {}),
  });
}
