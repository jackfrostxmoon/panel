import { useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { SourceBenchmarkResult } from '../api/client';
import { useBenchmarkSources, useSaveSourceOrder, useSourceImageHealth, useSourceOrder } from '../api/hooks';
import { ErrorState } from '../components/StateView';
import { IconArrowLeft } from '../components/icons';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { formatRelativeTime } from '../utils/format';

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
    setCheckedAt(data.checkedAt);
    setResults((prev) => {
      const next = { ...prev };
      for (const row of data.results) next[row.name] = row;
      return next;
    });
  }

  async function runAll() {
    if (probing || orderedSources.length === 0) return;
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
      for (const source of orderedSources) {
        try {
          absorb(await benchmark.mutateAsync(source.name));
        } catch (error) {
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
    } finally {
      setRunning(false);
    }
  }

  async function retryOne(name: string) {
    if (probing) return;
    absorb(await benchmark.mutateAsync(name));
  }

  function persistOrder(next: string[]) {
    setOrderError(null);
    saveSourceOrder.mutate(
      { order: next },
      {
        onError: (error) => {
          setOrderError(error instanceof Error ? error.message : 'Could not save source order.');
        },
      },
    );
  }

  /** Move one source by delta in the displayed order, then auto-save. */
  function moveSource(name: string, delta: -1 | 1) {
    if (saveSourceOrder.isPending) return;
    const codes = orderedSources.map((s) => s.name);
    const from = codes.indexOf(name);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= codes.length) return;
    const next = [...codes];
    const [moved] = next.splice(from, 1);
    if (moved !== undefined) next.splice(to, 0, moved);
    persistOrder(next);
  }

  /** Drop the dragged source before the drop target, then auto-save. */
  function dropOn(name: string) {
    const from = dragName.current;
    dragName.current = null;
    setDragOverName(null);
    if (!from || from === name || saveSourceOrder.isPending) return;
    const codes = orderedSources.map((s) => s.name);
    const fromIdx = codes.indexOf(from);
    const targetIdx = codes.indexOf(name);
    if (fromIdx < 0 || targetIdx < 0) return;
    const next = codes.filter((c) => c !== from);
    // Post-removal coordinates: a downward move shifts the target up one.
    next.splice(fromIdx < targetIdx ? targetIdx - 1 : targetIdx, 0, from);
    persistOrder(next);
  }

  if (health.isError && !hasResults) {
    return (
      <div className="page sources-page" aria-labelledby="sources-title">
        <ErrorState
          title="Could not load source status"
          message={health.error.message}
          onRetry={() => void health.refetch()}
        />
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
