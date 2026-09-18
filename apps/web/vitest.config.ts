import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Pure-logic unit tests only — no DOM, no DB. Components are verified via
    // typecheck + lint + manual `bun run dev` (per AGENTS.md).
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
  },
});