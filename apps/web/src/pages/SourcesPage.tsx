import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { SourceBenchmarkResult } from '../api/client';
import { useBenchmarkSources, useSaveSourceOrder, useSourceImageHealth, useSourceOrder } from '../api/hooks';
import { LogPanel } from '../components/LogPanel';
import { ErrorState } from '../components/StateView';
import { IconArrowLeft } from '../components/icons';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { log as rootLog } from '../lib/logger';
import { formatRelativeTime } from '../utils/format';

/** Page-scoped log. Every trace line on this page carries this scope. */
const pageLog = rootLog.child('sources');

/**
 * Minimum recent image errors before the passive stats call a source
 * degraded. Mirrors the old site-wide banner's threshold: a single
 * transient blip must not flag a source, but repeated failures do.
 */
const IMAGE_ERROR_THRESHOLD = 3;

/**
 * Sources: per-source health + on-demand live benchmark. The passive table
 * (`/api/health/detailed`) is polled in the background and never touches
 * the sources themselves; "Run benchmark" hits every enabled source's live
 * `latest(1)` listing, so it is manual-only and never auto-runs.
 *
 * Reached from the home page widget next to "Open cache settings".
 */
export function SourcesPage() {
  useDocumentTitle('Sources');
  const health = useSourceImageHealth();
  const benchmark = useBenchmarkSources();
  const [logPanelOpen, setLogPanelOpen] = useState(false);
  const [mountedAt] = useState(() => Date.now());
  const [results, setResults] = useState<Record<string, SourceBenchmarkResult>>({});
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  /**
   * True for the whole sequential run. The mutation's `isPending` alone
   * can't guard it — it flickers false in the gap between one source's
   * request settling and the next starting, inviting a double run.
   */
  const [running, setRunning] = useState(false);
  const probing = benchmark.isPending || running;

  /**
   * Display order editor. The saved order (pending mutation wins so rows
   * jump instantly) ranks the health rows; unsaved/unknown codes keep
   * their server relative order at the end. Persisted server-side to
   * `data/display/sources.json` — the source pills and the Latest/Search
   * default follow it.
   */
  const sourceOrderQuery = useSourceOrder();
  const saveSourceOrder = useSaveSourceOrder();
  const [orderError, setOrderError] = useState<string | null>(null);
  const [dragOverName, setDragOverName] = useState<string | null>(null);
  const dragName = useRef<string | null>(null);
  const savedOrder = sourceOrderQuery.data?.order ?? [];
  const effectiveOrder =
    saveSourceOrder.isPending && saveSourceOrder.variables
      ? saveSourceOrder.variables.order
      : savedOrder;
  const rank = useMemo(
    () => new Map(effectiveOrder.map((code, i) => [code, i] as const)),
    [effectiveOrder],
  );
  const orderedSources = useMemo(
    () =>
      [...(health.data?.sources ?? [])].sort(
        (a, b) =>
          (rank.get(a.name) ?? Number.MAX_SAFE_INTEGER) -
          (rank.get(b.name) ?? Number.MAX_SAFE_INTEGER),
      ),
    // health.data?.sources is the only stable reference here; an inline
    // `?? []` fallback would re-mint on every render and re-sort each time.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [health.data?.sources, rank],
  );
  const hasResults = Object.keys(results).length > 0;

  /** Merge one benchmark response into the per-source result map. */
  function absorb(data: { checkedAt: string; results: SourceBenchmarkResult[] }) {
    const merged = data.results.map((row) => row.name);
    pageLog.debug('absorb', {
      checkedAt: data.checkedAt,
      returned: data.results.length,
      sources: merged,
      ok: data.results.filter((r) => r.ok).length,
      down: data.results.filter((r) => !r.ok).map((r) => r.name),
    });
    setCheckedAt(data.checkedAt);
    setResults((prev) => {
      const next = { ...prev };
      for (const row of data.results) next[row.name] = row;
      return next;
    });
  }

  async function runAll() {
    if (probing || orderedSources.length === 0) {
      // Both guards are silent no-ops for the user, so they get a trace line —
      // this is the first thing to check when "Run benchmark" appears dead.
      pageLog.warn('run rejected', {
        reason: probing ? 'a run is already in progress' : 'no sources to probe',
        probing,
        sourceCount: orderedSources.length,
      });
      return;
    }
    const plan = orderedSources.map((s) => s.name);
    const runStartedAt = performance.now();
    pageLog.info('benchmark run start', {
      total: plan.length,
      // The order the probes fire in — this is the arrangement the user set.
      plan,
      enabled: orderedSources.filter((s) => s.enabled).map((s) => s.name),
      disabled: orderedSources.filter((s) => !s.enabled).map((s) => s.name),
      reRun: hasResults,
    });
    setRunning(true);
    try {
      // One source at a time: a single fan-out request puts the slowest
      // source's wall time (plus the upstream thundering herd) on one HTTP
      // response, which the server/proxy can hang up on. Sequential probes
      // stay small, paint rows progressively, and isolate failures — a sick
      // source records a Down row instead of sinking the whole run.
      //
      // Probed in the displayed order, so the run follows the arrangement
      // the user set with the grip/↑↓ (rows paint top-down in probe order).
      for (const [index, source] of orderedSources.entries()) {
        const probeStartedAt = performance.now();
        pageLog.debug('probe start', {
          index: index + 1,
          total: plan.length,
          source: source.name,
          enabled: source.enabled,
        });
        try {
          absorb(await benchmark.mutateAsync(source.name));
          pageLog.debug('probe done', {
            index: index + 1,
            total: plan.length,
            source: source.name,
            durationMs: Math.round(performance.now() - probeStartedAt),
          });
        } catch (error) {
          pageLog.warn('probe request threw — recording a synthetic Down row', {
            index: index + 1,
            total: plan.length,
            source: source.name,
            durationMs: Math.round(performance.now() - probeStartedAt),
            message: error instanceof Error ? error.message : String(error),
          });
          const at = new Date().toISOString();
          absorb({
            checkedAt: at,
            results: [
              {
                name: source.name,
                label: source.label,
                baseUrl: source.baseUrl,
                enabled: source.enabled,
                ok: false,
                latencyMs: null,
                items: null,
                errorCode: 'NETWORK_ERROR',
                errorMessage: error instanceof Error ? error.message : 'Probe request failed.',
                checkedAt: at,
              },
            ],
          });
        }
      }
      const latencies = orderedSources
        .map((s) => results[s.name]?.latencyMs)
        .filter((ms): ms is number => ms !== null && ms !== undefined);
      pageLog.info('benchmark run finished', {
        total: plan.length,
        durationMs: Math.round(performance.now() - runStartedAt),
        ok: plan.filter((name) => results[name]?.ok).length,
        down: plan.filter((name) => results[name] && !results[name]?.ok),
        slowest: latencies.length > 0 ? Math.max(...latencies) : null,
      });
    } finally {
      setRunning(false);
      pageLog.debug('running flag cleared');
    }
  }

  async function retryOne(name: string) {
    if (probing) {
      pageLog.warn('retry ignored — a probe is already in flight', { source: name });
      return;
    }
    const startedAt = performance.now();
    pageLog.info('single-source probe', { source: name });
    try {
      absorb(await benchmark.mutateAsync(name));
      pageLog.info('single-source probe finished', {
        source: name,
        durationMs: Math.round(performance.now() - startedAt),
      });
    } catch (error) {
      // Deliberately not swallowed: the row's Retry button has no error
      // surface, so the throw lands in the console and the log panel.
      pageLog.error('single-source probe failed', {
        source: name,
        durationMs: Math.round(performance.now() - startedAt),
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  function persistOrder(next: string[]) {
    setOrderError(null);
    pageLog.debug('persist order', {
      next,
      changed: next.join(',') !== effectiveOrder.join(','),
    });
    saveSourceOrder.mutate(
      { order: next },
      {
        onError: (error) => {
          const message = error instanceof Error ? error.message : 'Could not save source order.';
          pageLog.error('persist order failed', { next, message });
          setOrderError(message);
        },
        onSuccess: (saved) => {
          pageLog.debug('persist order settled', { requested: next, saved: saved.order });
        },
      },
    );
  }

  /** Move one source by delta in the displayed order, then auto-save. */
  function moveSource(name: string, delta: -1 | 1) {
    if (saveSourceOrder.isPending) {
      pageLog.warn('move ignored — an order save is still in flight', { source: name, delta });
      return;
    }
    const codes = orderedSources.map((s) => s.name);
    const from = codes.indexOf(name);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= codes.length) {
      pageLog.debug('move out of range', { source: name, delta, from, to, count: codes.length });
      return;
    }
    const next = [...codes];
    const [moved] = next.splice(from, 1);
    if (moved !== undefined) next.splice(to, 0, moved);
    pageLog.debug('move', { source: name, delta, from, to, next });
    persistOrder(next);
  }

  /** Drop the dragged source before the drop target, then auto-save. */
  function dropOn(name: string) {
    const from = dragName.current;
    dragName.current = null;
    setDragOverName(null);
    if (!from || from === name || saveSourceOrder.isPending) {
      pageLog.debug('drop ignored', { dragged: from, target: name, saving: saveSourceOrder.isPending });
      return;
    }
    const codes = orderedSources.map((s) => s.name);
    const fromIdx = codes.indexOf(from);
    const targetIdx = codes.indexOf(name);
    if (fromIdx < 0 || targetIdx < 0) {
      pageLog.warn('drop could not resolve indices', { dragged: from, target: name, fromIdx, targetIdx });
      return;
    }
    const next = codes.filter((c) => c !== from);
    // Post-removal coordinates: a downward move shifts the target up one.
    next.splice(fromIdx < targetIdx ? targetIdx - 1 : targetIdx, 0, from);
    pageLog.debug('drop', { dragged: from, target: name, fromIdx, targetIdx, next });
    persistOrder(next);
  }

  /**
   * Lifecycle trace for the page: mount, the incoming health payload, the
   * effective rank map, and re-sorts. Effects keyed on the data references
   * fire when that data actually changes, not on every render, so the count
   * of these lines is a genuine count of state transitions.
   */
  // Mount/unmount only, so the values it reads are captured once through a ref
  // rather than tracked as dependencies (which would re-fire on every poll).
  const mountSnapshot = useRef({
    healthLoading: health.isLoading,
    healthError: health.error?.message ?? null,
    orderLoading: sourceOrderQuery.isLoading,
    savedOrder,
  });
  useEffect(() => {
    pageLog.info('sources page mounted', mountSnapshot.current);
    return () => pageLog.info('sources page unmounted');
  }, []);

  useEffect(() => {
    const data = health.data;
    if (!data) return;
    pageLog.debug('health payload changed', {
      status: data.status,
      count: data.sources.length,
      sources: data.sources.map((s) => ({
        name: s.name,
        enabled: s.enabled,
        requests: s.requests,
        errors: s.errors,
        avgLatencyMs: s.avgLatencyMs,
        imageErrors: s.imageErrors,
        imageBlocked: s.imageBlocked,
      })),
    });
  }, [health.data]);

  useEffect(() => {
    // rank changes => orderedSources was re-sorted, i.e. the saved order
    // landed (or was reset).
    pageLog.debug('rank map changed', {
      order: effectiveOrder,
      ranks: Object.fromEntries(rank),
    });
  }, [rank, effectiveOrder]);

  useEffect(() => {
    pageLog.debug('display order computed', {
      order: orderedSources.map((s) => s.name),
      movedByUser: effectiveOrder.length > 0,
    });
  }, [orderedSources, effectiveOrder]);

  useEffect(() => {
    pageLog.debug('benchmark results changed', {
      checkedAt,
      count: Object.keys(results).length,
      ok: Object.values(results).filter((r) => r.ok).length,
      down: Object.values(results).filter((r) => !r.ok).map((r) => r.name),
    });
  }, [results, checkedAt]);

  /**
   * While the panel is open the page stays mounted for long stretches with no
   * visible activity, so a periodic heartbeat makes it obvious the app is
   * alive and the health poll is still landing.
   */
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!logPanelOpen) return;
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, [logPanelOpen]);

  useEffect(() => {
    if (!logPanelOpen) return;
    pageLog.debug('heartbeat', {
      sinceMs: Date.now() - mountedAt,
      healthFetching: health.isFetching,
      benchmarking: probing,
      savingOrder: saveSourceOrder.isPending,
      resultCount: Object.keys(results).length,
    });
  }, [now, logPanelOpen, mountedAt, health.isFetching, probing, saveSourceOrder.isPending, results]);

  if (health.isError && !hasResults) {
    return (
      <div className="page sources-page" aria-labelledby="sources-title">
        <ErrorState
          title="Could not load source status"
          message={health.error.message}
          onRetry={() => void health.refetch()}
        />
        {/* The panel stays available on the error state: "the API is down" is
            exactly when you want the log that proves it. */}
        <LogPanel open={logPanelOpen} onOpenChange={setLogPanelOpen} />
      </div>
    );
  }

  return (
    <div className="page sources-page" aria-labelledby="sources-title">
      <header className="page-header page-header--split">
        <div className="cache-settings__title-group">
          <Link to="/" className="cache-settings__back-link" aria-label="Back to home">
            <IconArrowLeft size={16} />
            <span>Back</span>
          </Link>
          <h1 id="sources-title" className="cache-settings__title">Sources</h1>
          <p className="cache-settings__subtitle">
            Live status of every configured source. The table below is passive telemetry —
            run the benchmark to probe each source&apos;s live listing right now. Drag a
            row by its grip (or use ↑ ↓) to reorder sources: the order sets the source
            pills, the Latest/Search default, and the sequence the benchmark probes.
          </p>
        </div>
        <div className="cache-settings__actions">
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => persistOrder([])}
            disabled={saveSourceOrder.isPending || savedOrder.length === 0}
            title="Reset the source order to the built-in default"
          >
            Reset order
          </button>
          <button
            type="button"
            className="btn btn--primary btn--sm"
            onClick={() => void runAll()}
            disabled={probing || health.isLoading}
          >
            {probing ? 'Benchmarking…' : hasResults ? 'Re-run benchmark' : 'Run benchmark'}
          </button>
        </div>
      </header>

      {benchmark.isError && (
        <p className="sources-page__error" role="alert">
          Benchmark failed: {benchmark.error.message}
        </p>
      )}

      {checkedAt && (
        <p className="sources-page__checked">
          Last benchmark: <time dateTime={checkedAt}>{new Date(checkedAt).toLocaleString()}</time>
        </p>
      )}

      {health.isLoading && !hasResults ? (
        <p className="cache-settings__empty">Loading source status…</p>
      ) : orderedSources.length === 0 && !hasResults ? (
        <p className="cache-settings__empty">No sources are configured.</p>
      ) : (
        <>
          {orderError && (
            <p className="sources-page__error" role="alert">
              Could not save source order: {orderError}
            </p>
          )}
          <ul className="sources-list" role="list">
            {orderedSources.map((source, i) => {
            const probe = results[source.name] ?? null;
            return (
              <li
                key={source.name}
                className={`sources-row${dragOverName === source.name ? ' sources-row--drop' : ''}`}
                onDragOver={(e) => {
                  e.preventDefault();
                  if (dragOverName !== source.name) setDragOverName(source.name);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  dropOn(source.name);
                }}
                onDragLeave={() => {
                  if (dragOverName === source.name) setDragOverName(null);
                }}
              >
                <div className="sources-row__head">
                  <span
                    className="sources-row__grip"
                    draggable
                    onDragStart={(e) => {
                      dragName.current = source.name;
                      e.dataTransfer.effectAllowed = 'move';
                      try {
                        e.dataTransfer.setData('text/plain', source.name);
                      } catch {
                        // setData is best-effort (dragover/drop use the ref).
                      }
                    }}
                    onDragEnd={() => {
                      dragName.current = null;
                      setDragOverName(null);
                    }}
                    title={`Drag to reorder ${source.label}`}
                    aria-hidden="true"
                  >
                    ⋮⋮
                  </span>
                  <span className="sources-row__title">
                    <strong>{source.label}</strong>
                    <span className="sources-row__code">{source.name}</span>
                  </span>
                  <span className="sources-row__order-btns">
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      onClick={() => moveSource(source.name, -1)}
                      disabled={i === 0 || saveSourceOrder.isPending}
                      aria-label={`Move ${source.label} up`}
                      title={`Move ${source.label} up`}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      onClick={() => moveSource(source.name, 1)}
                      disabled={i === orderedSources.length - 1 || saveSourceOrder.isPending}
                      aria-label={`Move ${source.label} down`}
                      title={`Move ${source.label} down`}
                    >
                      ↓
                    </button>
                  </span>
                  <SourcePill
                    enabled={source.enabled}
                    probe={probe}
                    imageBlocked={source.imageBlocked}
                    imageErrors={source.imageErrors}
                  />
                </div>
                <p className="sources-row__url">{source.baseUrl}</p>
                <SourceDetail
                  enabled={source.enabled}
                  probe={probe}
                  requests={source.requests}
                  errors={source.errors}
                  avgLatencyMs={source.avgLatencyMs}
                  lastRequestAt={source.lastRequestAt}
                  imageAttempts={source.imageAttempts}
                  imageErrors={source.imageErrors}
                  imageBlocked={source.imageBlocked}
                />
                <div className="sources-row__actions">
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => void retryOne(source.name)}
                    disabled={!source.enabled || probing}
                    title={source.enabled ? `Probe ${source.label} now` : `${source.label} is disabled`}
                  >
                    {probing ? 'Probing…' : 'Retry this source'}
                  </button>
                </div>
              </li>
            );
          })}
          </ul>
        </>
      )}

      <LogPanel open={logPanelOpen} onOpenChange={setLogPanelOpen} />
    </div>
  );
}

/** Status pill: disabled → benchmark result → passive image signal → not checked. */
function SourcePill({
  enabled,
  probe,
  imageBlocked,
  imageErrors,
}: {
  enabled: boolean;
  probe: SourceBenchmarkResult | null;
  imageBlocked: number;
  imageErrors: number;
}) {
  if (!enabled) {
    return <span className="status-pill">Disabled</span>;
  }
  if (probe) {
    return probe.ok ? (
      <span className="status-pill status-pill--up">Healthy</span>
    ) : (
      <span className="status-pill status-pill--down">Down</span>
    );
  }
  if (imageBlocked > 0 || imageErrors >= IMAGE_ERROR_THRESHOLD) {
    return <span className="status-pill status-pill--hiatus">Degraded</span>;
  }
  return <span className="status-pill">Not checked</span>;
}

/** Per-row detail: benchmark outcome when probed, otherwise passive telemetry. */
function SourceDetail({
  enabled,
  probe,
  requests,
  errors,
  avgLatencyMs,
  lastRequestAt,
  imageAttempts,
  imageErrors,
  imageBlocked,
}: {
  enabled: boolean;
  probe: SourceBenchmarkResult | null;
  requests: number;
  errors: number;
  avgLatencyMs: number | null;
  lastRequestAt: string | null;
  imageAttempts: number;
  imageErrors: number;
  imageBlocked: number;
}) {
  if (!enabled) {
    return <p className="sources-row__meta">This source is disabled in the server configuration.</p>;
  }
  if (probe && !probe.ok) {
    return (
      <p className="sources-row__meta sources-row__meta--down">
        {probe.errorMessage ?? 'Probe failed.'}
        {probe.latencyMs !== null && <> · after {formatLatency(probe.latencyMs)}</>}
      </p>
    );
  }
  const parts: string[] = [];
  if (probe?.ok) {
    parts.push(`live listing in ${formatLatency(probe.latencyMs ?? 0)}`);
    parts.push(`${probe.items ?? 0} items`);
  }
  parts.push(`${requests} requests · ${errors} errors`);
  parts.push(avgLatencyMs !== null ? `avg ${formatLatency(avgLatencyMs)}` : 'avg —');
  if (lastRequestAt) parts.push(`last request ${formatRelativeTime(lastRequestAt)}`);
  if (imageAttempts > 0) {
    parts.push(
      imageBlocked > 0
        ? `${imageBlocked} images blocked`
        : imageErrors > 0
          ? `${imageErrors} image errors`
          : 'images ok',
    );
  } else if (imageBlocked > 0 || imageErrors >= IMAGE_ERROR_THRESHOLD) {
    parts.push('images failing');
  }
  return <p className="sources-row__meta">{parts.join(' · ')}</p>;
}

function formatLatency(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}
