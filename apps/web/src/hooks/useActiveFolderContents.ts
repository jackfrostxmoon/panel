import { useBookmarkFolderContents } from '../api/hooks';

/** Returns the contents of the active folder (default = All bookmarks). */
export function useActiveFolderContents(folderId: string | null) {
  return useBookmarkFolderContents(folderId);
}