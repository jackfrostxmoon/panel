import { useSyncExternalStore } from 'react';
import {
  incognitoSnapshot,
  subscribeIncognito,
  toggleIncognito,
} from '../utils/incognito';

/**
 * React view of the incognito flag. `enabled` flips for every component
 * subscribed here the moment the header switch is toggled.
 */
export function useIncognito(): { enabled: boolean; toggle: () => void } {
  const enabled = useSyncExternalStore(subscribeIncognito, incognitoSnapshot);
  return { enabled, toggle: toggleIncognito };
}
