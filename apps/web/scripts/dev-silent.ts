/**
 * Wrapper around `vite` that discards its stdout to keep the repo clean.
 *
 * Why this exists: when `bun run dev:web` is invoked by `concurrently` on
 * Windows, Bun's shell captures the long-running vite subprocess's
 * stdout/stderr to `<script-name>-stdout.log` /
 * `<script-name>-stderr.log` in the repo root (a Bun behavior for
 * keeping a child process alive after its parent has exited). The
 * `.gitignore` already excludes `*.log` so they don't get committed, but
 * they still clutter the working tree on every `bun run dev` cycle.
 *
 * Fix: spawn vite with stdout piped to `'ignore'` so Bun has no handle
 * to capture. Vite's stdout is mostly the "ready in N ms" banner and
 * HMR-update log lines, which are also streamed to the browser over
 * the WebSocket and visible in the browser dev tools — losing the
 * on-disk copy is a non-event.
 *
 * stderr is kept on `'inherit'` so real failures (port conflict, bad
 * config, plugin errors) still print inline and aren't silently dropped
 * alongside the noise.
 *
 * Ctrl+C / SIGTERM are forwarded to the child so it shuts down cleanly
 * when the user stops `bun run dev` from the terminal — the parent
 * process (this script) then exits with the child's exit code.
 */
import { spawn } from 'node:child_process';

const child = spawn('bun', ['run', 'dev'], {
  cwd: new URL('..', import.meta.url),
  stdio: ['inherit', 'ignore', 'inherit'],
  shell: process.platform === 'win32',
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

// Forward Ctrl+C to the child so it shuts down cleanly when the user
// stops `bun run dev` from the terminal.
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    if (!child.killed) child.kill(sig);
  });
}