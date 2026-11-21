/**
 * Theme boot — runs synchronously before the React module scripts execute
 * (classic <head> script, no defer), so the saved light theme applies before
 * the first paint and there is no dark flash.
 *
 * Kept as an external file (not an inline <script>) so the served app can
 * enforce `script-src 'self'` in its Content-Security-Policy (see the
 * secureHeaders call in apps/api/src/app.ts) without weakening it to
 * 'unsafe-inline'.
 */
try {
  if (localStorage.getItem('panel-reader:theme:v1') === 'light') {
    document.documentElement.dataset.theme = 'light';
  }
} catch {}
