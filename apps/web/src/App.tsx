import { lazy, Suspense } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AppLayout } from './components/AppLayout';
import { ToastProvider } from './components/Toast';
import { NotFoundPage } from './pages/NotFoundPage';
import { useWarmCovers } from './utils/imageCache';

// Route-level code splitting: the reader (heaviest screen) and secondary
// pages load on demand. Home stays on its own chunk too so `/read/*` never
// pays for the landing hero, search bar, and rails.
const HomePage = lazy(() =>
  import('./pages/HomePage').then((m) => ({ default: m.HomePage })),
);

// Route-level code splitting: the reader (heaviest screen) and secondary
// pages load on demand.
const SearchPage = lazy(() =>
  import('./pages/SearchPage').then((m) => ({ default: m.SearchPage })),
);
const LatestPage = lazy(() =>
  import('./pages/LatestPage').then((m) => ({ default: m.LatestPage })),
);
const PanelDetailsPage = lazy(() =>
  import('./pages/PanelDetailsPage').then((m) => ({ default: m.PanelDetailsPage })),
);
const BookmarksPage = lazy(() =>
  import('./pages/BookmarksPage').then((m) => ({ default: m.BookmarksPage })),
);
const ReaderPage = lazy(() =>
  import('./pages/ReaderPage').then((m) => ({ default: m.ReaderPage })),
);
const CacheSettingsPage = lazy(() =>
  import('./pages/CacheSettingsPage').then((m) => ({ default: m.CacheSettingsPage })),
);
const SourcesPage = lazy(() =>
  import('./pages/SourcesPage').then((m) => ({ default: m.SourcesPage })),
);

const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: (failureCount, error) => {
          // Don't hammer a failing source on client-visible 4xx errors.
          if (error instanceof Error && 'status' in error) {
            const status = (error as { status: number }).status;
            if (status >= 400 && status < 500) return false;
          }
          return failureCount < 2;
        },
        /**
         * Back off between retries instead of firing them back-to-back. A
         * flaky source/CDN already feels slow; immediate retries just make it
         * worse. Exponential with jitter, capped at 30s.
         */
        retryDelay: (attempt) =>
          Math.min(30_000, 500 * Math.pow(2, attempt) + Math.random() * 250),
        refetchOnWindowFocus: false,
      },
    },
  });

/**
 * Renders inside <QueryClientProvider> so it can read the query cache.
 * Warms the on-disk image cache on mount: preload covers the user is most
 * likely to see next (latest page + bookmarks + cached searches). Pure
 * client-side — it only turns already-cached JSON data into preloaded
 * images, it never issues a new API request.
 */
/**
 * Legacy redirect: pre-Panel builds linked details pages at `/manga/:id`
 * (browser bookmarks, shared links, QR codes). Keep resolving them —
 * including the `?from=` origin hint — so old links don't land on the
 * not-found page.
 */
function LegacyMangaRedirect() {
  const { id = '' } = useParams();
  const { search } = useLocation();
  return <Navigate to={`/panel/${encodeURIComponent(id)}${search}`} replace />;
}

function AppContent() {
  useWarmCovers();
  return (
    <BrowserRouter>
      <Routes>
        {/* The reader takes over the whole viewport — no app chrome. */}
        <Route
          path="/read/:chapterId"
          element={
            <Suspense fallback={null}>
              <ReaderPage />
            </Suspense>
          }
        />
        <Route element={<AppLayout />}>
          <Route
            index
            element={
              <Suspense fallback={null}>
                <HomePage />
              </Suspense>
            }
          />
          <Route
            path="search"
            element={
              <Suspense fallback={null}>
                <SearchPage />
              </Suspense>
            }
          />
          <Route
            path="latest"
            element={
              <Suspense fallback={null}>
                <LatestPage />
              </Suspense>
            }
          />
          <Route
            path="panel/:id"
            element={
              <Suspense fallback={null}>
                <PanelDetailsPage />
              </Suspense>
            }
          />
          <Route
            path="bookmarks"
            element={
              <Suspense fallback={null}>
                <BookmarksPage />
              </Suspense>
            }
          />
          <Route
            path="settings/cache"
            element={
              <Suspense fallback={null}>
                <CacheSettingsPage />
              </Suspense>
            }
          />
          <Route
            path="sources"
            element={
              <Suspense fallback={null}>
                <SourcesPage />
              </Suspense>
            }
          />
          <Route path="manga/:id" element={<LegacyMangaRedirect />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <AppContent />
      </ToastProvider>
    </QueryClientProvider>
  );
}
