/**
 * Minimal structured logger.
 *
 * Server-side logs carry debugging context (source, url, status, duration)
 * while client-facing error responses stay sanitised. JSON output in
 * production, human-readable in development.
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogContext {
  [key: string]: unknown;
}

const isProduction = process.env.NODE_ENV === 'production';

/** ANSI 256-color codes for the dev log line. Gray timestamp, colored level. */
const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  debug: '\x1b[36m', // cyan
  info: '\x1b[32m', // green
  warn: '\x1b[33m', // yellow
  error: '\x1b[31m', // red
};

function write(level: LogLevel, message: string, context?: LogContext): void {
  const entry = { level, msg: message, time: new Date().toISOString(), ...context };
  const line = isProduction
    ? JSON.stringify(entry)
    : `${C.dim}[${entry.time}]${C.reset} ${C[level]}${level.toUpperCase().padEnd(5)}${C.reset} ${message}${
        context && Object.keys(context).length > 0 ? ` ${JSON.stringify(context)}` : ''
      }`;

  switch (level) {
    case 'debug':
      if (!isProduction) console.info(line);
      break;
    case 'info':
      console.info(line);
      break;
    case 'warn':
      console.warn(line);
      break;
    case 'error':
      console.error(line);
      break;
  }
}

export const logger = {
  debug: (msg: string, ctx?: LogContext) => write('debug', msg, ctx),
  info: (msg: string, ctx?: LogContext) => write('info', msg, ctx),
  warn: (msg: string, ctx?: LogContext) => write('warn', msg, ctx),
  error: (msg: string, ctx?: LogContext) => write('error', msg, ctx),
};
