/**
 * Browser-side structured logger.
 *
 * The API already has a logger (`apps/api/src/lib/logger.ts`); this is its
 * web-side twin so both ends of a request log the same shape (level, ISO
 * timestamp, message, structured context).
 *
 * Two independent things happen here:
 *
 *  1. **Console output** — gated by the active level, which defaults to
 *     `debug` in dev and `error` in a production build. The dev line is
 *     ANSI-coloured and greppable; production writes a plain object so
 *     nothing depends on terminal escape codes.
 *  2. **A ring buffer** — the last `BUFFER_LIMIT` entries are always kept,
 *     regardless of level. This is what the Sources page log panel reads, so
 *     diagnostics survive a level bump or a cleared console. It is a plain
 *     in-memory array: no server round-trip, nothing persisted.
 *
 * The level is overridable at runtime via `localStorage['panel-log:level:v1']`
 * (`off` | `error` | `warn` | `info` | `debug`). That exists so a level can be
 * raised on a LAN device — a phone hitting `bun run dev` — without a rebuild.
 * `setLogLevel()` persists and notifies subscribers so open panels re-render.
 */

export type LogLevel = 'off' | 'error' | 'warn' | 'info' | 'debug';

/** Severity order, lowest first. `off` is above everything. */
const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  off: 100,
};

const LEVEL_STORAGE_KEY = 'panel-log:level:v1';

/** How many entries the ring buffer holds before dropping the oldest. */
const BUFFER_LIMIT = 500;

/** ANSI 256-color codes for the dev console line. Gray timestamp, colored level. */
const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  debug: '\x1b[36m', // cyan
  info: '\x1b[32m', // green
  warn: '\x1b[33m', // yellow
  error: '\x1b[31m', // red
} as const;

export interface LogContext {
  [key: string]: unknown;
}

export interface LogEntry {
  seq: number;
  level: Exclude<LogLevel, 'off'>;
  /** Scope prefix, e.g. `sources` or `api`. Empty string for unscoped logs. */
  scope: string;
  msg: string;
  time: string;
  context?: LogContext;
}

function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && value in LEVEL_ORDER;
}

function defaultLevel(): LogLevel {
  return import.meta.env.DEV ? 'debug' : 'error';
}

/** The level in force right now: storage override, else the build default. */
function readLevel(): LogLevel {
  try {
    const raw = window.localStorage.getItem(LEVEL_STORAGE_KEY);
    if (isLogLevel(raw)) return raw;
  } catch {
    // Private mode / storage disabled — fall through to the build default.
  }
  return defaultLevel();
}

let activeLevel: LogLevel = readLevel();

/**
 * Modules that read the level before the DOM exists (Vite dev pre-bundling,
 * an early `client.ts` import) must not blow up on `localStorage`.
 */
function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Monotonic sequence number — stable key for React lists, immune to clock skew. */
let sequence = 0;

/** Ring buffer. Plain array; `splice` on overflow keeps it O(limit) worst case. */
const buffer: LogEntry[] = [];

/**
 * Immutable copy handed to `useSyncExternalStore`.
 *
 * `useSyncExternalStore` compares snapshots with `Object.is`, so returning the
 * mutated `buffer` directly would never trigger a re-render. Every mutation
 * replaces this with a fresh shallow copy instead.
 */
let snapshot: readonly LogEntry[] = [];

const subscribers = new Set<() => void>();

function notify() {
  for (const fn of subscribers) fn();
}

/** True when `level` passes the active threshold. `off` never passes. */
function enabled(level: Exclude<LogLevel, 'off'>): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[activeLevel];
}

function push(entry: LogEntry): void {
  buffer.push(entry);
  if (buffer.length > BUFFER_LIMIT) buffer.splice(0, buffer.length - BUFFER_LIMIT);
  snapshot = [...buffer];
  notify();
}

function formatContext(context?: LogContext): string {
  if (!context || Object.keys(context).length === 0) return '';
  try {
    return ` ${JSON.stringify(context)}`;
  } catch {
    // Non-serializable context (circular refs, BigInt) must not kill the log.
    return ' [unserializable context]';
  }
}

function write(
  level: Exclude<LogLevel, 'off'>,
  scope: string,
  msg: string,
  context?: LogContext,
): void {
  const time = new Date().toISOString();
  const entry: LogEntry = { seq: ++sequence, level, scope, msg, time };
  if (context && Object.keys(context).length > 0) entry.context = context;
  push(entry);
  if (!enabled(level)) return;

  if (import.meta.env.PROD) {
    // Plain object: no escape codes, no reliance on console formatting.
    const method = level === 'error' ? console.error : level === 'warn' ? console.warn : console.info;
    method.call(console, { level, msg, time, ...context });
    return;
  }

  const scopeLabel = scope ? `${scope}: ` : '';
  const line = `${C.dim}[${time}]${C.reset} ${C[level]}${level.toUpperCase().padEnd(5)}${C.reset} ${scopeLabel}${msg}${formatContext(context)}`;
  switch (level) {
    case 'debug':
      console.info(line);
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

/** A logger bound to a scope prefix, e.g. `log.child('sources').info(...)`. */
export interface ScopedLogger {
  debug(msg: string, ctx?: LogContext): void;
  info(msg: string, ctx?: LogContext): void;
  warn(msg: string, ctx?: LogContext): void;
  error(msg: string, ctx?: LogContext): void;
  child(scope: string): ScopedLogger;
}

function makeLogger(scope: string): ScopedLogger {
  const emit = (level: Exclude<LogLevel, 'off'>, msg: string, ctx?: LogContext) => {
    write(level, scope, msg, ctx);
  };
  return {
    debug: (msg, ctx) => emit('debug', msg, ctx),
    info: (msg, ctx) => emit('info', msg, ctx),
    warn: (msg, ctx) => emit('warn', msg, ctx),
    error: (msg, ctx) => emit('error', msg, ctx),
    child: (child: string) => makeLogger(scope ? `${scope}.${child}` : child),
  };
}

/** Unscoped root logger. Prefer `log.child('<area>')` in app code. */
export const log: ScopedLogger = makeLogger('');

/** Current level, including `off`. */
export function getLogLevel(): LogLevel {
  return activeLevel;
}

/** True when a `debug` call would be emitted to the console. Used to skip expensive work. */
export function isDebugEnabled(): boolean {
  return enabled('debug');
}

/** Persist a new level and re-emit an entry so panels show the change. */
export function setLogLevel(level: LogLevel): void {
  activeLevel = level;
  try {
    storage()?.setItem(LEVEL_STORAGE_KEY, level);
  } catch {
    // Storage unavailable — the level still applies for this page session.
  }
  notify();
}

/** Immutable snapshot of the ring buffer, oldest first. */
export function getLogEntries(): readonly LogEntry[] {
  return snapshot;
}

/** Empties the ring buffer. Console output is untouched. */
export function clearLogEntries(): void {
  buffer.length = 0;
  snapshot = [];
  notify();
}

/**
 * Subscribe to buffer/level changes. Returns the unsubscribe function.
 * Called from a `useSyncExternalStore`-style hook in the log panel.
 */
export function subscribeLogs(fn: () => void): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

/** Read the persisted level at module load; also re-reads after another tab writes it. */
export function syncLogLevelFromStorage(): void {
  const next = readLevel();
  if (next === activeLevel) return;
  activeLevel = next;
  notify();
}