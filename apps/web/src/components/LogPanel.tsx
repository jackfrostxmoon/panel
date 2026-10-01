import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  clearLogEntries,
  getLogEntries,
  getLogLevel,
  setLogLevel,
  subscribeLogs,
  syncLogLevelFromStorage,
  type LogEntry,
  type LogLevel,
} from '../lib/logger';

/**
 * In-page log viewer for the Sources page.
 *
 * Reads the logger's in-memory ring buffer (see `lib/logger.ts`) rather than
 * owning any state of its own, so it shows what every other part of the app
 * logged — API requests included — with no server round-trip. Renders in every
 * build; the console side of the logger stays level-gated, so a production
 * bundle is quiet until you open the panel.
 *
 * Intentionally dependency-free: level buttons, a text filter, a scope filter,
 * per-entry JSON context and copy/clear. Auto-scroll is opt-out, because a
 * panel that yanks you to the bottom while you are reading a stack trace is
 * worse than useless.
 */

const LEVELS: readonly Exclude<LogLevel, 'off'>[] = ['debug', 'info', 'warn', 'error'];

/** Time-only label; the panel shows relative order, not a calendar. */
function clockTime(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(
    d.getSeconds(),
  ).padStart(2, '0')}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

/** JSON with circular refs / BigInt tolerated — a logger must never crash the app it logs. */
function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(
      value,
      (_key, val) => {
        if (typeof val === 'bigint') return `${val.toString()}n`;
        if (typeof val === 'object' && val !== null) {
          if (seen.has(val)) return '[circular]';
          seen.add(val);
        }
        return val;
      },
      2,
    );
  } catch {
    return '[unserializable]';
  }
}

export function LogPanel({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const entries = useSyncExternalStore(subscribeLogs, getLogEntries, getLogEntries);
  const level = useSyncExternalStore(subscribeLogs, getLogLevel, getLogLevel);
  const [minLevel, setMinLevel] = useState<Exclude<LogLevel, 'off'>>('debug');
  const [text, setText] = useState('');
  const [scope, setScope] = useState('');
  const [stickToBottom, setStickToBottom] = useState(true);
  const [copied, setCopied] = useState(false);
  const listRef = useRef<HTMLOListElement>(null);

  // Another tab raised or lowered the console level — follow it, same as the
  // display-settings hooks do for their localStorage-backed state.
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.storageArea !== localStorage) return;
      if (e.key === null || e.key === 'panel-log:level:v1') syncLogLevelFromStorage();
    }
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  // Keyboard: Esc folds the panel, Ctrl/Cmd+Shift+L toggles it. Both are
  // ignore-echoes of the reader shortcut model and stay out of the way.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const combo = (e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'l';
      if (combo) {
        e.preventDefault();
        onOpenChange(!open);
        return;
      }
      if (e.key === 'Escape' && open) onOpenChange(false);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onOpenChange]);

  const scopes = useMemo(() => {
    const set = new Set<string>();
    for (const e of entries) if (e.scope) set.add(e.scope);
    return [...set].sort();
  }, [entries]);

  const filtered = useMemo(() => {
    const floor = LEVELS.indexOf(minLevel);
    const needle = text.trim().toLowerCase();
    return entries.filter((e) => {
      // `off` as a floor means "no filtering" — the button set starts at debug.
      if (LEVELS.indexOf(e.level) < floor) return false;
      if (scope && e.scope !== scope) return false;
      if (!needle) return true;
      return (
        e.msg.toLowerCase().includes(needle) ||
        e.scope.toLowerCase().includes(needle) ||
        (e.context ? safeStringify(e.context).toLowerCase().includes(needle) : false)
      );
    });
  }, [entries, minLevel, text, scope]);

  const counts = useMemo(() => {
    const c = { debug: 0, info: 0, warn: 0, error: 0 };
    for (const e of filtered) c[e.level]++;
    return c;
  }, [filtered]);

  // Newest last, and scroll to the end only while pinned to the bottom.
  const visible = useMemo(() => filtered.slice(-400), [filtered]);

  useEffect(() => {
    if (!stickToBottom) return;
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [visible, stickToBottom]);

  const copyJson = useCallback(() => {
    const payload = visible.map((e) => ({
      time: e.time,
      level: e.level,
      scope: e.scope,
      msg: e.msg,
      context: e.context ?? null,
    }));
    const text_ = JSON.stringify(payload, null, 2);
    // Clipboard API needs a secure context; on plain-HTTP LAN access it throws,
    // so fall back to a hidden textarea + execCommand.
    if (navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(text_).then(
        () => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        },
        () => setCopied(false),
      );
      return;
    }
    const ta = document.createElement('textarea');
    ta.value = text_;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
    document.body.removeChild(ta);
  }, [visible]);

  const errorCount = counts.error;
  const warnCount = counts.warn;

  if (!open) {
    return (
      <button
        type="button"
        className="log-panel__toggle"
        onClick={() => onOpenChange(true)}
        title="Open the activity log (Ctrl+Shift+L)"
        aria-expanded={false}
        aria-label="Open the activity log"
      >
        <span aria-hidden="true">▤</span> Log
        {(errorCount > 0 || warnCount > 0) && (
          <span className="log-panel__badge" aria-live="polite">
            {errorCount > 0 ? `${errorCount} err` : `${warnCount} warn`}
          </span>
        )}
      </button>
    );
  }

  return (
    <section className="log-panel" aria-label="Activity log">
      <header className="log-panel__head">
        <strong className="log-panel__title">Activity log</strong>
        <span className="log-panel__counts">
          <span className="log-panel__count log-panel__count--debug">{counts.debug} debug</span>
          <span className="log-panel__count log-panel__count--info">{counts.info} info</span>
          <span className="log-panel__count log-panel__count--warn">{counts.warn} warn</span>
          <span className="log-panel__count log-panel__count--error">{counts.error} error</span>
        </span>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={copyJson}
          disabled={visible.length === 0}
          title="Copy the visible entries as JSON"
        >
          {copied ? 'Copied' : 'Copy JSON'}
        </button>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => clearLogEntries()}
          disabled={entries.length === 0}
          title="Clear the log buffer"
        >
          Clear
        </button>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => onOpenChange(false)}
          title="Close the log panel (Esc)"
          aria-label="Close the activity log"
        >
          ✕
        </button>
      </header>

      <div className="log-panel__controls">
        <label className="log-panel__field">
          <span className="log-panel__field-label">Min level</span>
          <select
            className="log-panel__select"
            value={minLevel}
            onChange={(e) => setMinLevel(e.target.value as Exclude<LogLevel, 'off'>)}
          >
            {LEVELS.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label className="log-panel__field">
          <span className="log-panel__field-label">Console level</span>
          <select
            className="log-panel__select"
            value={level}
            onChange={(e) => setLogLevel(e.target.value as LogLevel)}
            title="Controls what reaches the browser console. Persisted in localStorage."
          >
            {(['off', ...LEVELS] as const).map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label className="log-panel__field">
          <span className="log-panel__field-label">Scope</span>
          <select
            className="log-panel__select"
            value={scope}
            onChange={(e) => setScope(e.target.value)}
          >
            <option value="">all</option>
            {scopes.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="log-panel__field log-panel__field--grow">
          <span className="log-panel__field-label">Filter</span>
          <input
            className="log-panel__input"
            type="search"
            value={text}
            placeholder="message, scope or context"
            onChange={(e) => setText(e.target.value)}
          />
        </label>
        <label className="log-panel__check">
          <input
            type="checkbox"
            checked={stickToBottom}
            onChange={(e) => setStickToBottom(e.target.checked)}
          />
          <span>Follow</span>
        </label>
      </div>

      <ol className="log-panel__list" ref={listRef} role="log" aria-live="off">
        {visible.length === 0 && (
          <li className="log-panel__empty">
            {entries.length === 0
              ? 'Nothing logged yet. Interact with the page — every API call is traced.'
              : 'No entries match the current filter.'}
          </li>
        )}
        {visible.map((entry) => (
          <LogRow key={entry.seq} entry={entry} />
        ))}
      </ol>

      <footer className="log-panel__foot">
        <span>
          showing {visible.length} of {entries.length} buffered
          {filtered.length < entries.length ? ` · ${entries.length - filtered.length} filtered out` : ''}
        </span>
        <span className="log-panel__foot-hint">Esc closes · Ctrl+Shift+L toggles</span>
      </footer>
    </section>
  );
}

/** One entry: level, scope, message, and an expandable context blob. */
function LogRow({ entry }: { entry: LogEntry }) {
  const [open, setOpen] = useState(false);
  const hasContext = entry.context !== undefined;
  return (
    <li className={`log-panel__row log-panel__row--${entry.level}`}>
      <button
        type="button"
        className="log-panel__row-head"
        onClick={() => hasContext && setOpen((v) => !v)}
        aria-expanded={open}
        disabled={!hasContext}
        title={hasContext ? (open ? 'Hide context' : 'Show context') : undefined}
      >
        <span className="log-panel__time">{clockTime(entry.time)}</span>
        <span className="log-panel__level">{entry.level}</span>
        {entry.scope && <span className="log-panel__scope">{entry.scope}</span>}
        <span className="log-panel__msg">{entry.msg}</span>
        {hasContext && <span className="log-panel__chev">{open ? '▾' : '▸'}</span>}
      </button>
      {open && hasContext && <pre className="log-panel__context">{safeStringify(entry.context)}</pre>}
    </li>
  );
}