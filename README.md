# Panel Reader

A production-quality, full-stack panel image viewer. Browse and search panel from an
external source, read chapters in a polished reader (vertical scroll or page-by-page),
bookmark titles, and resume where you left off — with bookmarks and reading progress
persisted in SQLite.

![Stack](https://img.shields.io/badge/Bun-1.4.1-black) ![TS](https://img.shields.io/badge/TypeScript-7.0.2-blue) ![Vite](https://img.shields.io/badge/Vite-8.2.1-purple) ![SQLite](https://img.shields.io/badge/SQLite-bun:sqlite-green)

---

## Table of contents

- [Requirements](#requirements)
- [Quick start](#quick-start-bun-only)
- [Local development](#local-development)
- [Technology versions](#technology-versions)
- [Environment variables](#environment-variables)
- [Database & migrations](#database--migrations)
- [Architecture](#architecture)
- [API reference](#api-reference)
- [The panel source abstraction](#the-panel-source-abstraction)
- [Adding another panel source](#adding-another-panel-source)
- [Caching strategy](#caching-strategy)
- [Security notes](#security-notes)
- [Testing](#testing)
- [Project structure](#project-structure)
- [Reader keyboard shortcuts](#reader-keyboard-shortcuts)
- [Panel Details Page — Professional UI/UX Enhancements](#panel-details-page--professional-uiux-enhancements)
- [Bookmarks Page — Modern Card Grid](#bookmarks-page--modern-card-grid)
- [Home Page — Search-Engine Landing](#home-page--search-engine-landing)
- [Legal note](#legal-note)

---

## Requirements

| Tool           | Version  | Why                                     |
| -------------- | -------- | --------------------------------------- |
| Bun            | ≥ 1.4.1  | runtime + package manager + embedded DB |

Node.js is **not** required (Bun covers everything), except optionally for running
ESLint outside the Bun runtime in an editor integration. No Docker, no database
server, no system services — the database is embedded and lives in `data/`.

## Quick start (Bun only)

```bash
bun install           # install workspace dependencies
bun run db:migrate    # create the local database file data/panel.db
bun run db:import     # load your data from manga_viewer_export.sql (optional)
bun run dev           # API (:3001) + Vite (:5173)
```

Then open **http://localhost:5173**. All data (database + cached images) lives
under `data/` — back it up or delete it like any folder. To reset everything:

```bash
rm data/panel.db && bun run db:migrate && bun run db:import
```

### LAN access with a bare IP (no port, Bun only)

One command builds the web app and serves API + frontend from a single Bun
process on port 80, so other devices on the same network just type your IP
(e.g. `http://192.168.100.196`) — no `:port`, no Docker:

```bash
bun run lan
```

The script prints your LAN address on start. Options:

```bash
bun run lan -- --force-build   # rebuild the web app
bun run lan -- --port 8080    # fallback if port 80 is blocked (then open http://<ip>:8080)
bun run lan -- --smol         # low-memory API runtime (smaller JS heap; `lan.bat minimal smol`)
```

Port precedence: `--port` flag > `LAN_PORT` env var > default 80. (The
generic `PORT` from `.env` is ignored by `bun run lan` so the dev default
`3001` can't silently win over port 80.)

To change the on-exit backup scope (default `minimal`), edit `lan.bat`:
`set "BACKUP_SCOPE=minimal"` → `set "BACKUP_SCOPE=full"` (or pass `lan.bat full`).

Manual equivalent: `bun run build`, then `PORT=80 bun run start`.
Notes: on Windows, allow the firewall prompt on first run (use an
Administrator terminal if binding port 80 fails); on macOS/Linux port 80
needs privileges (`sudo bun run lan`). All devices must be on the same
network (same Wi-Fi).

### Docker (optional)

The repo previously shipped `docker-compose.yml` + `Dockerfile` (database + all-in-one
image) as an alternative deployment path, but local development no longer needs it.
Those files have been removed from this checkout — they were backed up before deletion.

### Auto-start on Docker Desktop open

Docker Desktop has no per-project "open the container" setting, so the repo previously
shipped helper scripts (`docker-start.bat` / `docker-start.sh` / `docker-start-linux.sh`)
that launched Docker Desktop (if closed), waited for the daemon, then brought up the stack.
Those scripts have been removed from this checkout — they were backed up before deletion.

## Local development

```bash
# 1. Install dependencies (Bun workspaces)
bun install

# 2. Create the local database (embedded SQLite file data/panel.db) + load data
bun run db:migrate
bun run db:import     # from manga_viewer_export.sql; skip for an empty library

# 3. Start API (:3001) + Vite dev server (:5173), together
bun run dev
```

### Database (embedded — no Docker, no install)

The database is SQLite via Bun's built-in `bun:sqlite` — no server, no install.
Data lives in a single local file (`DATABASE_URL`, default `data/panel.db`),
created on first start. If the file can't be opened, the API process exits
with a clear error message instead of hanging.

```bash
bun run db:migrate           # apply migrations (run once after cloning)
bun run db:import            # load manga_viewer_export.sql into the local DB
bun run db:import -- --force # wipe data/panel.db and re-import from scratch
bun run db:studio            # Drizzle Studio — visual DB browser
```

Reset everything (destroys local data):

```bash
rm data/panel.db && bun run db:migrate && bun run db:import
```

Open **http://localhost:5173** (the Vite dev server proxies `/api` to the API).

Both dev servers bind `0.0.0.0` by default, so other devices on the LAN can reach
the app via `http://<your-computer-ip>:5173`. In development the API also allows
every CORS origin, so a phone or tablet on the same network works with zero
config. (Production/test restrict CORS to the `CORS_ORIGIN` allowlist.)

Run parts separately:

```bash
bun run dev:api     # Hono API with hot reload  → http://0.0.0.0:3001
bun run dev:web     # Vite dev server           → http://0.0.0.0:5173
```

Other scripts:

```bash
bun run typecheck   # bun check (TypeScript 7) across all packages
bun run lint        # oxlint (.oxlintrc.json)
bun run format      # Prettier
```

---

## Technology versions


All requested versions were verified against the npm registry / local toolchain on
2026-08-18:

| Requested    | Used          | Notes                                              |
| ------------ | ------------- | -------------------------------------------------- |
| TypeScript 7 | **7.0.2**     | native compiler; `tsc --version` → `7.0.2`         |
| Vite 8.2.1   | **8.2.1**     | exact match                                        |
| Bun 1.4.1    | **1.4.1**     | exact match (also pinned in the Docker base image) |
| SQLite      | **3.x** (bun:sqlite, embedded) | no server — single local file via Bun's built-in driver |

### TypeScript 7 note

TypeScript 7 is the native (Go-based) compiler and **ships no JavaScript API**.
That used to matter because `typescript-eslint` requires that API (which is why
the repo carried a `typescript@6.0.3` side-by-side pin). The linter has since
moved to [oxlint](https://oxc.rs/docs/guide/usage/linter.html), which needs no
TS JS API — so the pin was dropped and `tsc` is TypeScript **7.0.2** everywhere.

## Environment variables

All configuration lives in `.env` (copy from [`.env.example`](.env.example) — never
commit real values).

| Variable                              | Default                                              | Description                                     |
| ------------------------------------- | ---------------------------------------------------- | ----------------------------------------------- |
| `DATABASE_URL`                        | `data/panel.db`                                      | Local file for the embedded SQLite database (repo-root-relative) |
| `PORT`                                | `3001`                                               | API listen port (`80` inside the optional Docker image) |
| `CORS_ORIGIN`                         | `http://localhost:5173`                              | Allowed browser origins, comma-separated. **Dev/test: every origin is allowed by default** — production/test restrict to this list. |
| `NODE_ENV`                            | `development`                                        | `production` tightens logging + error responses |
| `SOURCE_MANGAKATANA_BASE_URL`         | `https://mangakatana.com`                            | Source base URL — also the SSRF allowlist root  |
| `SOURCE_MANGAKATANA_ENABLED`          | `true`                                               | Disable to take the source offline (503s)       |
| `SOURCE_NIHONKUNI_BASE_URL`           | `https://nihonkuni.com`                              | Source base URL — also the SSRF allowlist root  |
| `SOURCE_NIHONKUNI_ENABLED`            | `true`                                               | Disable to take the source offline (503s)       |
| `SOURCE_RAWKUMA_BASE_URL`             | `https://rawkuma.net`                                | Source base URL — also the SSRF allowlist root  |
| `SOURCE_RAWKUMA_ENABLED`              | `true`                                               | Disable to take the source offline (503s)       |
| `SOURCE_RAWSAKURA_BASE_URL`           | `https://rawsakura.org`                              | Source base URL — also the SSRF allowlist root  |
| `SOURCE_RAWSAKURA_ENABLED`            | `true`                                               | Disable to take the source offline (503s)       |
| `SOURCE_HIPERDEX_BASE_URL`            | `https://hiperdex.com`                               | Source base URL — also the SSRF allowlist root  |
| `SOURCE_HIPERDEX_ENABLED`             | `true`                                               | Disable to take the source offline (503s)       |
| `SOURCE_MANGAREAD_BASE_URL`           | `https://www.mangaread.org`                          | Source base URL — also the SSRF allowlist root  |
| `SOURCE_MANGAREAD_ENABLED`            | `true`                                               | Disable to take the source offline (503s)       |
| `SOURCE_TOONILY_BASE_URL`             | `https://toonily.com`                                | Source base URL — also the SSRF allowlist root  |
| `SOURCE_TOONILY_ENABLED`              | `true`                                               | Disable to take the source offline (503s)       |
| `SOURCE_RAWDEX_BASE_URL`              | `https://rawdex.net`                                 | Source base URL — also the SSRF allowlist root  |
| `SOURCE_RAWDEX_ENABLED`               | `true`                                               | Disable to take the source offline (503s)       |
| `SOURCE_RAWUWU_BASE_URL`              | `https://rawuwu.net`                                 | Source base URL — also the SSRF allowlist root  |
| `SOURCE_RAWUWU_ENABLED`               | `true`                                               | Disable to take the source offline (503s)       |
| `SHARE_LAN_ADDRESS`                   | _(auto-detected)_                                    | Override the LAN IP reported by `/api/health` for shareable links (QR codes / copy-link). Set it if Docker/WSL/VMware virtual adapters shadow the real one. |
| `SOURCE_REQUEST_TIMEOUT_MS`           | `15000`                                              | Hard timeout for every outbound source request  |
| `SOURCE_REQUEST_RETRY_COUNT`          | `2`                                                  | Retries on transient failures (timeout/429/5xx); each attempt gets a fresh `timeoutMs` budget |
| `SOURCE_REQUEST_RETRY_BASE_DELAY_MS`  | `500`                                                | Base delay (ms) for the first retry; doubles + jitter per attempt |
| `SOURCE_MAX_TEXT_BYTES`               | `3145728`                                            | Max HTML/JSON/sitemap response size (3 MiB)         |
| `SOURCE_MAX_IMAGE_BYTES`              | `8388608`                                            | Max proxied image size (8 MiB)                      |
| `CACHE_TTL_SEARCH_MS`                 | `120000`                                             | In-memory TTL for search results                |
| `CACHE_TTL_PANEL_MS`                  | `600000`                                             | TTL for panel metadata                          |
| `CACHE_TTL_CHAPTERS_MS`               | `300000`                                             | TTL for chapter lists                           |
| `CACHE_TTL_PAGES_MS`                  | `1800000`                                            | TTL for chapter page lists                      |
| `CACHE_MAX_ENTRIES`                   | `100`                                                | Max entries in the in-memory source-response cache |
| `VITE_API_BASE_URL`                   | _(empty)_                                            | Override API origin for the web build (rare)    |
| `IMAGE_CACHE_DIR`                     | `data/.imagecache`                                   | On-disk cache for proxied cover/chapter images  |
| `IMAGE_CACHE_MAX_FRACTION`            | `0.5`                                                | Max fraction of available disk the cache may use (clamped between min/max bytes) |
| `IMAGE_CACHE_MIN_BYTES`               | `268435456`                                          | Cache cap lower bound (256 MiB)                 |
| `IMAGE_CACHE_MAX_BYTES`               | `8589934592`                                         | Cache cap upper bound (8 GiB)                   |
| `IMAGE_PROXY_CONCURRENCY`             | `2`                                                  | Max concurrent upstream image-proxy fetches (disk hits bypass) |
| `IMAGE_FETCH_ISOLATED`              | `true`                                               | Stream upstream image misses in an isolated child process (contains native RSS spikes); `false` = legacy in-process path |

## Database & migrations

Drizzle ORM + SQLite (embedded via `bun:sqlite`). Migrations are plain SQL in
`database/migrations/`.

```bash
bun run db:generate   # create a new migration after editing src/db/schema.ts
bun run db:migrate    # apply pending migrations to data/panel.db
bun run db:import      # load manga_viewer_export.sql into the local DB
bun run db:studio     # Drizzle Studio — visual DB browser
```

Reset everything (destroys local data):

```bash
rm data/panel.db && bun run db:migrate && bun run db:import
```

Schema overview:

```text
panel (metadata cache; unique per source+source_id and global_id)
  ├── chapters             # per-panel chapter cache
  │     └── chapter_bookmarks   # unique per (panel, chapter)
  ├── bookmarks            # unique per panel
  └── reading_progress     # unique per (panel, chapter), FK → chapters
```

---

## Architecture

Bun workspace monorepo with a strict dependency direction: **web → API → sources → DB**.

| Layer | Technology | Details |
|-------|------------|---------|
| **Frontend**<br/>(`apps/web`) | React 19 + Vite 8 | TanStack Query, React Router 7, Design system CSS, Reader (vertical / paged / gallery) |
| **Backend**<br/>(`apps/api`) | Hono on Bun | REST + JSON → routes (HTTP), services (use cases: PanelService, BookmarkService, ChapterBookmarkService, ProgressService), sources (one adapter per site), repositories (Drizzle), middleware (CORS, rate-limit, security), db (schema, client) |
| **Infrastructure** | SQLite (embedded via bun:sqlite) | local `data/panel.db` file (persistent) |
| **Shared**<br/>(`packages/shared`) | TypeScript | Domain types, ApiResponse, PanelSource interface, id helpers |

```text
┌─────────────────────────┐     REST/JSON      ┌──────────────────────────────┐
│   Frontend (apps/web)   │ ─────────────────► │      Backend (apps/api)      │
│  React 19 + Vite 8      │                    │  Hono on Bun                 │
│  TanStack Query         │                    │  routes/ (HTTP)              │
│  React Router 7         │                    │  services/ (use cases)       │
│  Design system CSS      │                    │  ├─ PanelService             │
│  Reader (vertical/      │                    │  ├─ BookmarkService          │
│  paged/gallery)         │                    │  ├─ ChapterBookmarkService   │
└─────────────────────────┘                    │  └─ ProgressService          │
                                               │  sources/                    │
                                               │  └─ 9 source adapters        │
┌─────────────────────────┐  imports types     │  repositories/ (Drizzle)     │
│ packages/shared         │ ◄───────────────── │  middleware/ (CORS, rate-    │
│ types + contracts       │                    │  limit, security)            │
└─────────────────────────┘                    │  db/ (schema, client)        │
                                               └──────────────┬───────────────┘
                                                              │
                                                              ▼
                                               ┌──────────────────────────────┐
                                               │  SQLite (embedded, bun:sqlite) │
                                                │     local data/panel.db        │
                                               └──────────────┬───────────────┘
                                                              ▲
                                                              │
                                               ┌──────────────┴───────────────┐
                                               │  Panel sites                 │
                                               │  (external, untrusted HTML)  │
                                               └──────────────────────────────┘
```

- **Frontend** never touches the source website — all reads go through the API.
- **PanelService** is the only entry point into source adapters. It adds TTL caching and
  in-flight deduplication on top of raw adapters.
- **Repositories** own all SQL; services own all business rules; routes only parse/validate
  HTTP input. The DB's `panel`/`chapters` tables are a metadata cache that also anchors
  bookmarks and progress, so user data survives source outages.
- **`packages/shared`** holds the domain types, the API envelope contract and the
  `PanelSource` interface — the frontend and backend literally share the same types.

## API reference

Every endpoint returns the envelope
`{ "success": true, "data": … }` or `{ "success": false, "error": { "code", "message" } }`.

| Method | Path                                | Description                                                                            |
| ------ | ----------------------------------- | -------------------------------------------------------------------------------------- |
| GET    | `/api/health`                       | Liveness + DB + enabled sources                                                        |
| GET    | `/api/panel/search?q=&page=&source=` | Search (`source=mk,nk` picks sources; default = first enabled)                        |
| GET    | `/api/panel/latest?page=&source=`   | Latest updates (`source=` filter as above)                                             |
| GET    | `/api/panel/resolve?url=`           | Map a pasted source page URL to a global panel id                                       |
| GET    | `/api/panel/:id`                    | Panel details (`:id` is a global id like `mk:solo-leveling.21708`)                     |
| GET    | `/api/panel/:id/chapters`           | Chapter list (ascending)                                                               |
| GET    | `/api/chapter/:id`                  | Chapter metadata                                                                       |
| GET    | `/api/chapter/:id/pages`            | Reader payload: pages, dimensions, prev/next chapter, cover                            |
| GET    | `/api/source-image?source=&u=`      | Image proxy for hotlink-protected source CDNs (allowlist-validated inside the adapter) |
| GET    | `/api/bookmarks`                    | All bookmarks (with continue-reading progress)                                         |
| GET    | `/api/bookmarks/by-panel/:panelId`  | Bookmark state for a panel (or `null`)                                                 |
| POST   | `/api/bookmarks`                    | Add bookmark (idempotent; body: `panelId`, `title`, `coverUrl`, `source`, `sourceUrl`) |
| DELETE | `/api/bookmarks/:id`                | Remove bookmark                                                                        |
| GET    | `/api/chapter-bookmarks?panelId=`   | Chapter bookmarks for a panel                                                          |
| POST   | `/api/chapter-bookmarks`            | Bookmark one chapter                                                                   |
| POST   | `/api/chapter-bookmarks/batch`      | Bookmark many chapters at once                                                         |
| DELETE | `/api/chapter-bookmarks?panelId=[&chapterId=]` | Remove one chapter bookmark, or clear all for the panel                     |
| GET    | `/api/progress/:panelId/:chapterId` | Saved progress (or `null`)                                                             |
| GET    | `/api/progress/recent?limit=`       | Recently-read entries for “continue reading”                                           |
| PUT    | `/api/progress`                     | Save progress (body: `panelId`, `chapterId`, `page`, optional display metadata)        |

**Global ids** — `mk:solo-leveling.21708` (panel) and `mk:solo-leveling.21708~c200`
(chapter). The prefix routes to a source adapter (`mk` = MangaKatana, `nk` = NihonKuni,
`rk` = Rawkuma, `rs` = RawSakura, `hd` = Hiperdex, `mr` = MangaRead, `tn` = Toonily,
`rd` = RawDex, `ru` = RawUwU, `rl` = RoliaScan); the `~` separates the chapter token so ids survive a single URL path
segment.

### Library & user-data endpoints

| Method | Path                                | Description                                                                            |
| ------ | ----------------------------------- | -------------------------------------------------------------------------------------- |
| GET    | `/api/bookmark-folders`             | All bookmark folders/collections                                                        |
| GET    | `/api/bookmark-folders/default`     | The default "Reading list" folder (created lazily, never deletable)                     |
| POST   | `/api/bookmark-folders`             | Create a folder                                                                          |
| PATCH  | `/api/bookmark-folders/:id`         | Rename a folder                                                                          |
| DELETE | `/api/bookmark-folders/:id`         | Delete a folder (not the default)                                                        |
| POST   | `/api/bookmark-folders/:id/items`   | Add a bookmark to a folder (many-to-many)                                                |
| DELETE | `/api/bookmark-folders/:id/items/:bookmarkId` | Remove a bookmark from a folder                                               |
| GET    | `/api/ratings/by-panel/:panelId`    | Star rating for a panel (or `null`)                                                      |
| PUT    | `/api/ratings`                      | Upsert a 1–5 star rating                                                                 |
| DELETE | `/api/ratings/:panelId`             | Remove a rating                                                                          |
| GET    | `/api/tags`                         | All user-defined tags                                                                    |
| POST   | `/api/tags`                         | Create a tag (lowercased on write)                                                       |
| DELETE | `/api/tags/:id`                     | Delete a tag                                                                             |
| GET    | `/api/tags/by-panel/:panelId`       | Tags applied to a panel                                                                  |
| PUT    | `/api/tags/by-panel/:panelId`       | Replace the tag set of a panel                                                           |
| GET    | `/api/reading-list`                 | Reading-list entries (`want_to_read` / `reading` / `completed`)                          |
| GET    | `/api/reading-list/by-panel/:panelId` | Reading-list status for a panel                                                        |
| PUT    | `/api/reading-list`                 | Set a panel's reading-list status                                                        |
| DELETE | `/api/reading-list/:panelId`        | Remove from the reading list                                                             |

### Image proxy & cache endpoints

| Method | Path                                | Description                                                                            |
| ------ | ----------------------------------- | -------------------------------------------------------------------------------------- |
| GET    | `/api/source-image/cover?source=&u=` | Cover variant (longer cache lifetime)                                                  |
| GET    | `/api/source-image/chapter?source=&u=&p=` | Reader-page variant (`p` = page index → stable per-chapter cache key)              |
| GET    | `/api/source-image/cache`           | Image-cache stats (entries, bytes, cap)                                                 |
| POST   | `/api/source-image/cache/tags-size` | Per-panel totals (cover + chapter pages) for a set of provenance tags, in one request   |
| DELETE | `/api/source-image/cache/legacy`    | Prune legacy (pre-tag-format) cache entries invisible to the per-tag views              |
| DELETE | `/api/source-image/cache`           | Evict the whole on-disk image cache                                                     |
| GET    | `/api/health/detailed`              | Per-source stats (cache hits, errors, last fetch) + image-cache info                    |
| GET    | `/api/progress/unread-counts`       | Unread chapter counts per bookmarked panel                                              |
| DELETE | `/api/progress`                     | Clear progress for a panel (or everything)                                              |
| POST   | `/api/progress/bulk`                | Mark many chapters read/unread at once                                                  |

---

## The panel source abstraction

`packages/shared/src/source.ts` defines the interface the whole app depends on:

```ts
interface PanelSource {
  readonly name: string; // "mk" — also the global-id prefix
  readonly label: string; // "MangaKatana"
  readonly baseUrl: string;
  readonly enabled: boolean;

  search(query: string, page?: number): Promise<SourceSearchResult>;
  latest(page?: number): Promise<SourceSearchResult>;
  getPanel(nativePanelId: string): Promise<Panel>;
  getChapters(nativePanelId: string): Promise<Chapter[]>;
  getChapterPages(nativeChapterId: string): Promise<ChapterPages>;
  buildPanelUrl(nativePanelId: string): string;
  buildChapterUrl(nativeChapterId: string): string;
}
```

Methods receive **native** source ids and return entities with **global** ids prefixed. The
`SourceRegistry` (`apps/api/src/sources/registry.ts`) maps prefixes to adapters; routes and
services never import a concrete source class.

Ten adapters ship today, each split the same way (adapter + pure parser):

- **MangaKatana** (`apps/api/src/sources/mangakatana/`):
  - `MangaKatanaSource.ts` — URLs, fetching, id mapping, error translation;
  - `parser.ts` — pure HTML→data functions.
- **NihonKuni** (`apps/api/src/sources/nihonkuni/`, nihonkuni.com — custom-built raw site):
  - `NihonKuniSource.ts` — URLs, fetching, id mapping, error translation;
  - `parser.ts` — pure HTML→data functions.
- **Rawkuma** (`apps/api/src/sources/rawkuma/`, rawkuma.net — WordPress + custom HTMX theme):
  - `RawkumaSource.ts` — URLs, fetching, id mapping, error translation;
  - `parser.ts` — pure HTML→data functions.
- **RawSakura** (`apps/api/src/sources/rawsakura/`, rawsakura.org):
  - `RawSakuraSource.ts` — URLs, fetching, id mapping, error translation;
  - `parser.ts` — pure JSON/HTML→data functions (JSON API payloads, list pages, reader).
- **Hiperdex** (`apps/api/src/sources/hiperdex/`, hiperdex.com — React SPA + SSR JSON-LD):
  - `HiperdexSource.ts` — URLs, fetching, id mapping, error translation;
  - `parser.ts` — pure HTML/JSON-LD/XML sitemap parsing functions.
- **MangaRead** (`apps/api/src/sources/mangaread/`, www.mangaread.org — WordPress Madara):
  - `MangaReadSource.ts` — URLs, fetching, id mapping, error translation;
  - `parser.ts` — pure HTML→data functions (archive, search, chapter list, reader).
- **Toonily** (`apps/api/src/sources/toonily/`, toonily.com — WordPress Madara):
  - `ToonilySource.ts` — URLs, fetching, id mapping, error translation, plus image
    proxying (`fetchImage`) for its hotlink-protected CDN (`static.tnlycdn.com`);
  - `parser.ts` — pure HTML→data functions.
- **RawDex** (`apps/api/src/sources/rawdex/`, rawdex.net — WordPress Madara + custom
  "rawdex-nova" theme):
  - `RawdexSource.ts` — URLs, fetching, id mapping, error translation;
  - `parser.ts` — pure HTML→data functions (cards, meta list, chapter rows, reader).
- **RawUwU** (`apps/api/src/sources/rawuwu/`, rawuwu.net — same engine as RawSakura):
  - `RawUwUSource.ts` — URLs, fetching, id mapping, error translation;
  - `parser.ts` — pure JSON/HTML→data functions (SPA API payloads, list pages, reader).

All selectors live in each parser so a site redesign touches exactly one file. Sources
whose CDNs block direct browser access (hotlink protection) implement `fetchImage` and
are served through the API's image proxy (`GET /api/source-image`) — URL validation still
happens inside each adapter's SSRF-safe HTTP client.

Defensive parsing details worth knowing:

- The MangaKatana parser matches obfuscated image-array variable names generically (pick the
  longest array of image URLs), never by name; per-page intrinsic dimensions (`cds`) are
  parsed to reserve layout space.
- The NihonKuni parser decodes the base64 `data-enc` title, reads covers from both the
  `background-image` style and `data-bg` forms, treats `.1234567890` chapter-id suffixes as
  cache-busters (not decimals), and pulls the full chapter list from the reader sidebar
  (`getChapters` fetches the latest chapter's reader page, falling back to the ~192-chapter
  slice the detail page embeds).
- The Rawkuma parser reads author/status from the JSON-LD `ComicSeries` block (the only place
  they exist), extracts the full chapter list directly from the detail page (server-rendered,
  real ISO dates), keeps the WordPress post id in every chapter token — a wrong post id serves
  a _different_ series, so it is semantically required — and reads prev/next navigation from
  the reader's `aria-label` links (discarding `href="#"` edge links and cross-panel hrefs).
- Missing fields degrade to `null`/`[]`; an unrecognized page type becomes
  `PANEL_NOT_FOUND` / `CHAPTER_NOT_FOUND` instead of a crash.

## Adding another panel source

1. Implement `PanelSource` in `apps/api/src/sources/<name>/` (mirror an existing
   adapter folder: adapter + parser).
2. Register it in `createSourceRegistry()` in `apps/api/src/sources/registry.ts`:
   ```ts
   registry.register(new YourSource(config.sources.yourSource));
   ```
3. Add its configuration block to `AppConfig`, the env schema in `config.ts`, and
   `.env.example`.
4. Add its prefix + label to `SOURCE_LABELS` in `apps/web/src/utils/format.ts`.
5. Done — routes, services, database and reader never change.

The registry can also disable a source at runtime (env flag) — a broken or banned source
stops serving with `503 SOURCE_DISABLED` while the rest of the app keeps working.

## Caching strategy

All source reads go through `PanelService`, which applies two layers:

1. **In-memory TTL cache** (`lib/cache.ts`) — per-entity keys with per-endpoint TTLs
   (search 2 min, panel 10 min, chapters 5 min, pages 30 min). Keeps the external site from
   being hammered by repeat reads and fast page flips.
2. **In-flight deduplication** — concurrent identical requests (e.g. React StrictMode
   double-fetch) share one upstream call.
3. **Database metadata cache** — bookmarks/progress upsert source metadata into the embedded DB,
   so user data renders even when the source is down.

Search is intentionally short-lived; chapter _pages_ are long-lived because source page
URLs are tokenized but stable. There is no cache invalidation machinery — TTL expiry is the
strategy, and it is configurable per endpoint via environment variables.

### Retry strategy

Outbound source requests (HTML pages, JSON endpoints, **and** proxied cover/chapter images)
are retried on transient failures — timeout, connection/DNS/TLS errors, and HTTP 429 or 5xx —
before surfacing a `SOURCE_TIMEOUT` / `SOURCE_UNAVAILABLE` error. Each attempt gets a fresh
`timeoutMs` budget, and retries sleep in jittered exponential backoff (`base * 2^attempt`,
±50%) so concurrent requests don't thunder-herd. Definitive failures (other 4xx, redirects
out of the allowlist) are never retried. Configurable via `SOURCE_REQUEST_RETRY_COUNT`
(default 2) and `SOURCE_REQUEST_RETRY_BASE_DELAY_MS` (default 500).

## Security notes

- **No unrestricted proxy**: the API fetches only http(s) URLs whose hostname matches the
  configured source host (or a subdomain, e.g. the `i1.mangakatana.com` image CDN).
  Redirects are re-validated against the allowlist. Native ids are URL-encoded into path
  segments, so hostile ids cannot change host or inject paths (SSRF).
- **Input validation** with Zod on every body/query; ids must parse as
  `source:native` to be accepted.
- **Rate limiting** (per-IP sliding window) on all `/api/*` routes.
- **SQL injection** prevented by Drizzle parameterized queries throughout.
- **Safe responses**: clients never receive stack traces or driver messages; everything is
  mapped to typed error codes (`SOURCE_TIMEOUT`, `PANEL_NOT_FOUND`, …).
- **CORS** restricted to configured origins; secure headers (CSP, X-Frame-Options, etc.)
  via `hono/secure-headers`.
- **Respect for the source**: no CAPTCHA/paywall/anti-bot bypass mechanisms; a reasonable
  UA and conservative request volume only.

---

## Testing

The web package has a **Vitest** suite of pure-logic unit tests (node environment — no DOM,
no DB). Components are verified via typecheck + lint + manual `bun run dev`.

```bash
bun run test        # vitest run (apps/web) — navigation, shortcuts, chapter markers, format
bun run test:watch  # or: cd apps/web && bun run test:watch
bun run typecheck   # bun check across shared, api and web
bun run lint        # oxlint (.oxlintrc.json)
```

Existing specs: `apps/web/src/reader/navigation.test.ts`, `reader/shortcuts.test.ts`,
`utils/chapterMarkers.test.ts`, `utils/format.test.ts`. Config lives in
`apps/web/vitest.config.ts`.

### Test file lifecycle — delete after passing

Test files are **temporary verification artifacts, not deliverables**. The workflow for
any change that adds a test is:

1. Write the `*.test.ts` spec (pure logic only, node environment — no DOM/DB).
2. Run it green: `bun run test` (plus `bun run typecheck` and `bun run lint`).
3. **Delete every test file created during the change** once it has run successfully.

Do not commit new test files — the repo intentionally ships no test fixtures, and the
"Known gaps" policy in `plans/PROJECT_STRUCTURE.md` reflects that (no API/component tests by
design). The four historical specs listed above are grandfathered.

## Project structure

```
.
├── apps/
│   ├── api/                  # Hono API on Bun (Drizzle ORM, source adapters)
│   │   ├── src/
│   │   │   ├── db/           # schema.ts, client.ts, migrate.ts
│   │   │   ├── lib/          # errors, cache, guarded http client, url helpers, logger
│   │   │   ├── middleware/   # error handler, rate limit, request log
│   │   │   ├── repositories/ # data access (panel cache, bookmarks, chapter bookmarks,
│   │   │   │                 #   progress, reading list)
│   │   │   ├── routes/       # REST endpoints (panel, chapters, bookmarks, bookmark folders,
│   │   │   │                 #   chapter-bookmarks, ratings, tags, progress, reading list,
│   │   │   │                 #   source-image, health)
│   │   │   ├── services/     # business logic (panel, bookmark, bookmark folder,
│   │   │   │                 #   chapter bookmark, rating, tag, progress, reading list)
│   │   │   ├── sources/      # PanelSource registry + 9 adapters (mk nk rk rs hd mr tn rd ru rl)
│   │   └── drizzle.config.ts
│   └── web/                  # React 19 + Vite 8 + TanStack Query
│       ├── public/           # favicon.svg + loading/ spinner assets
│       ├── src/
│       │   ├── api/          # typed client + query hooks
│       │   ├── components/   # cards, layout, dialogs, toasts, states, share/QR, folders,
    │       │   │                 #   tags, star rating, reading-list status
    │       │   ├── hooks/        # useDelayedLoading, useChapterDownloader, useActiveFolderContents
│       │   ├── pages/        # Home, Search, Latest, Details, Bookmarks, Reader, NotFound
│       │   ├── reader/       # readers (vertical/paged/gallery), toolbar, settings panel,
│       │   │                 #   shortcuts + pure-logic unit tests
│       │   ├── utils/        # format helpers, source labels, image-proxy URL helper,
│       │   │                 #   bookmark export, search history, recently viewed
│       │   └── styles/       # design tokens + component/page/reader CSS
│       └── vite.config.ts    # /api proxy → :3001 (+ vitest.config.ts)
├── packages/shared/src/      # Types, ApiResponse, PanelSource, id helpers
└── .env.example
```

## Reader keyboard shortcuts

The reader exposes a focused set of keyboard shortcuts, surfaced in an accessible
help dialog backed by a typed, categorized catalogue (`reader/shortcuts.ts`) that
resolves itself for the active reading direction (LTR/RTL).

### Navigation

#### Paged mode

| Key                 | Action        |
| ------------------- | ------------- |
| `←` / `A`           | Previous page |
| `→` / `D` / `Space` | Next page     |
| `↑` / `W`           | Previous page |
| `↓` / `S`           | Next page     |
| Mouse wheel         | Previous / next page (one notch = one page; a scrollable page is panned first) |

#### Gallery mode

| Key       | Action              |
| --------- | ------------------- |
| `←` / `A` | Previous chapter    |
| `→` / `D` | Next chapter        |
| `Space`   | Next page           |
| `↑` / `W` | Scroll up one page  |
| `↓` / `S` | Scroll down one page |

#### Vertical mode

| Key                 | Action                |
| ------------------- | --------------------- |
| `←` / `A`           | Previous chapter      |
| `→` / `D` / `Space` | Next chapter          |
| `↑` / `W`           | Previous page(s) (see "Keyboard scroll" in reading settings) |
| `↓` / `S`           | Next page(s) (see "Keyboard scroll" in reading settings)   |
| `Shift+W` / `Shift+↑` | Smooth scroll up   |
| `Shift+S` / `Shift+↓` | Smooth scroll down |

### Reader controls

| Key   | Action                      |
| ----- | --------------------------- |
| `Esc` | Exit reader (back to panel) |
| `Q`   | Toggle reading settings     |
| `F`   | Cycle reading mode          |
| `1` / `2` / `3` | Set reading mode — vertical · gallery · pages |
| `E`   | Toggle fullscreen           |
| `V`   | Bookmark this chapter       |
| `C`   | Toggle fit to height in paged mode / fit to width in vertical mode (shows an info toast elsewhere) |

Arrow and letter keys swap between left-to-right and right-to-left (panel)
reading directions; `Space` always advances (to the next page in paged/gallery
modes, to the next chapter in vertical mode). In vertical and gallery modes,
`←`/`A` and `→`/`D` hop to the previous/next chapter instead of turning pages.
In vertical and gallery modes, `W`/`S` (or `↑`/`↓`) navigate: in vertical mode
they scroll or jump — the number of pages per keypress is configurable in the
reading settings ("Keyboard scroll"; the default `Native` smooth-scrolls by
80% of the viewport with easing, or pick 1–3 quantised pages per keypress,
which behave exactly like mouse-wheel notches) — while gallery mode keeps an
eased step-scroll of 80% of the viewport.
In vertical mode only, `Shift+W` / `Shift+S` (or
`Shift+↑` / `Shift+↓`) scroll continuously while held — release to stop.

### Latest page pagination

The latest-updates grid supports keyboard paging (mirrors the reader's navigation
keys). Bindings are exposed on the links via `aria-keyshortcuts` and are skipped
while typing in an input or with modifier keys held.

| Key            | Action        |
| -------------- | ------------- |
| `←` / `A`      | Previous page |
| `→` / `D`      | Next page     |

Reading settings live in a **sidebar** — a full-height panel that slides in from the
right edge of the reader. It opens from the gear icon (⚙) in the toolbar (or `Escape`
to dismiss); a click on the backdrop or pressing `Escape` closes it. Options are
presented as accessible, keyboard-navigable groups — each choice is an ARIA
radio group with arrow-key support, the progress-bar and image-gap toggles are proper
switches, and a _Reset to defaults_ action restores every preference:

| Setting                | Options                               |
| ---------------------- | ------------------------------------- |
| Current page           | Dropdown to jump to any page          |
| Chapter                | Dropdown to switch to another chapter |
| Reading mode           | Vertical scroll · Page by page · Gallery grid    |
| Page direction (paged) | Right → left · Left → right           |
| Background             | Dark · Light · High-contrast         |
| Data saver             | On/off (sequential + preload-1 + no prefetch) |
| Image brightness       | Slider 30–150 % (default 100 %)       |
| Image width            | Slider 20–100 % (default 60 %) · custom pixel width/height |
| Image loading          | Sequential (lazy as you scroll, default) · Parallel (fetch every page immediately) |
| Preload ahead          | 1 · 3 · 5 pages (vertical + sequential only) |
| Scroll speed           | Slow · Normal · Fast (Shift+W / Shift+S) |
| Progress bar           | On · Off (default **on**)             |
| Image gap              | On · Off (default **off**)            |
| Clear toolbar space    | On · Off (default **on**) — top padding so the first page clears the toolbar |

The panel also exposes two jump selectors: a dropdown for jumping to any page
in the current chapter, and a dropdown for switching to any chapter of the panel.
A **Keyboard shortcuts** section at the bottom of the panel shows the full
catalogue (resolved for the active reading direction). Preferences persist to
`localStorage` (`settings.ts`) and are restored on the next visit. The panel
adapts its surface to the chosen dark/light reading background.

Other reader polish: vertical, page-by-page or gallery-grid mode, right-to-left or
left-to-right, dark/light background, image width presets plus custom pixel sizes,
an adjustable **image brightness** filter, an optional **image gap** between pages
(off by default), **auto-hiding controls** (the toolbar slides away on scroll-down
and reappears on scroll-up), fullscreen, lazy-loaded images with reserved aspect
ratios, error placeholders with retry, swipe + tap zones on touch devices (edge
zones jump between chapters in scroll modes), and a "continue from page N" prompt
with saved progress.

## Panel Details Page — Professional UI/UX Enhancements

The panel details page (`PanelDetailsPage.tsx`) has been significantly enhanced with a
professional, orderly design that improves visual hierarchy, accessibility, and user
experience:

### Visual Hierarchy & Layout

- **Semantic HTML5 structure** with proper `<header>`, `<section>`, `<nav>`, `<dl>`, `<ol>` elements
- **Responsive grid layout** for the hero section (240px cover + flexible info panel)
- **Progressive disclosure** for genres (shows first 6, with "Show more/less" toggle)
- **Consistent spacing system** using design tokens (`--space-*` scale)
- **Clear section separation** with borders and generous margins

### Enhanced Components

#### Cover & Hero Section

- Larger cover image (240px) with subtle hover elevation effect
- Status badge positioned on cover (bottom-left) with color-coded variants
- Smooth transitions on hover for depth perception

#### Metadata Display

- Definition list (`<dl>`) with labeled groups for Authors, Status, Source
- Responsive layout: stacked on mobile, side-by-side on desktop (≥640px)
- External link indicator SVG for source links
- Color-coded status pills with semantic backgrounds

#### Action Buttons

- Primary actions prominently styled with `btn--lg` variant
- Icon + text layout with subtext for context (chapter title, page number)
- "Continue reading" shows progress badge with animated icon
- "Start reading" shows first chapter title as subtext

#### Chapter Filter & List

- Search input with leading icon and clear button
- Chapter numbers displayed (`#1`, `#2`, etc.) for quick scanning
- "In progress" badge with clock icon for chapters with saved progress
- Chevron indicator with hover animation
- Focus-visible states for keyboard navigation
- Clean card-based container with subtle borders

#### Synopsis Section

- Card-style wrapper with padded content area
- Improved typography (1.7 line-height, 75ch max-width)
- Proper heading hierarchy

### Accessibility Improvements

- Comprehensive ARIA labels and landmarks
- Semantic heading structure (h1 → h2 → h2)
- Breadcrumb navigation with `aria-current="page"`
- Visually hidden labels for icon-only controls
- Focus management with visible outlines
- Live regions for status updates
- Keyboard-navigable interactive elements

### Loading States

- **Progress bar animations** replace static skeleton blocks — every loading state
  shows an animated shimmer/indeterminate progress bar:
  - **Panel details**: layout-matching skeleton blocks with a continuous shimmer sweep
  - **Chapters loading**: centered indeterminate progress bar with a glowing fill
  - **Chapter images**: inline progress bar overlay centered in the reserved image area
- Per-section skeletons (hero, synopsis, chapters) maintain layout stability
- A shared `ProgressBar` component centralizes the animation

### Responsive Design

- **Desktop (≥768px)**: Full two-column hero, side-by-side metadata
- **Tablet (480-767px)**: Reduced cover (140px), stacked metadata
- **Mobile (<480px)**: Single-column hero, full-width cover, touch-friendly targets

### Design Tokens Used

All styling leverages the centralized token system (`tokens.css`):

- Colors: `--accent`, `--surface-*`, `--text-*`, `--border*`
- Spacing: `--space-1` through `--space-8`
- Radius: `--radius-sm` through `--radius-full`
- Shadows: `--shadow-sm` through `--shadow-lg`
- Motion: `--duration-fast/med`, `--ease-out`
- Typography: `--font-size-*`, `--font-weight-*`

## Bookmarks Page — Modern Card Grid

The bookmarks page (`BookmarksPage.tsx`) was redesigned as a modern, mobile-friendly
card grid that matches the footprint of the latest-page cards:

### Layout & Footprint

- **Responsive grid** with the same dimensions as the latest page: 5 columns on desktop,
  3 columns on mobile — identical card width and height
- Covers keep the shared 3:4 aspect ratio; the card body holds only title + meta so the
  total card height stays consistent with the panel cards
- **Sort controls** in the page header: Recently added / In progress / Title

### Actions

- Desktop actions (Continue / Open / Remove) overlay the cover as a slide-up bar, revealed
  on hover or keyboard focus — the cover stays clean and the card stays compact
- On mobile / touch devices the actions drop into the card flow below the cover (cover →
  title/meta → actions), so they never obstruct the artwork
- Remove becomes a compact icon-only button on desktop and a labeled full-width button on
  mobile, with an accessible name and confirm dialog

### States

- Skeleton grid while loading, error state with retry, and an empty state linking to search

## Home Page — Search-Engine Landing

The home page (`HomePage.tsx`) is a distraction-free, search-engine-style landing surface:

### Hero

- Ambient gradient glow (viewport-scaled ellipses) behind a large clamp-scaled title with a
  gradient accent wordmark
- Feature badge ("No ads. No accounts. Just panel."), tagline, and a single prominent search bar
- Primary "Browse latest" and ghost "My bookmarks" quick actions
- The hero block is centered in the viewport (minus header/footer), so the page reads like a
  minimal start page; the glow is clipped horizontally so it never creates scrollbars

## Legal note

This is a **reader** for publicly accessible panel pages. It is your responsibility to
respect the source site's terms of service, robots rules, access restrictions and
applicable copyright law, and to support official releases of the content you enjoy. The
code deliberately avoids any CAPTCHA/paywall/anti-bot bypass and does not run an
unrestricted proxy.
# panel
