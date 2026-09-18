import { useEffect } from 'react';

/**
 * Set the browser tab title. Pass `null` to fall back to the app default
 * ("Panel Reader"), or a string to render it with a suffix.
 *
 * Restores the default on unmount so navigating away from a detail page
 * doesn't leave the previous panel's title in the tab.
 */
export function useDocumentTitle(title: string | null, suffix = ' · Panel Reader') {
  useEffect(() => {
    const previous = document.title;
    document.title = title ? `${title}${suffix}` : 'Panel Reader';
    return () => {
      document.title = previous;
    };
  }, [title, suffix]);
}