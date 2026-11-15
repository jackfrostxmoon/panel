import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  useBookmarkFolders,
  useBookmarksSettings,
  useCreateBookmarkFolder,
  useDeleteBookmarkFolder,
  useRenameBookmarkFolder,
  useSaveBookmarksSettings,
} from '../api/hooks';
import { DEFAULT_BOOKMARKS_PAGE_SETTINGS } from '@panel/shared';
import {
  IconEye,
  IconFolder,
  IconMenu,
  IconMore,
  IconPencil,
  IconRefresh,
  IconStar,
  IconTrash,
} from './icons';
import { Switch } from './Switch';
import { useDisplaySettings } from '../hooks/useDisplaySettings';
import { useToast } from './Toast';
import { ConfirmDialog } from './ConfirmDialog';

/**
 * Sentinel id for "show every bookmark across every folder". The string
 * is non-UUID so it can never collide with a real folder id from the API.
 */
export const ALL_BOOKMARKS_ID = '__all__';

/**
 * Bookmark folder selector (T2-8 + default-folder): a hamburger trigger
 * in the bookmarks toolbar that opens a dropdown listing the folders.
 *
 * Each row is a one-line click target (pick the folder). Row actions —
 * Set default / Rename / Delete — live behind a small kebab button on
 * the right that opens a popover anchored to the kebab. The popover
 * uses `position: fixed` so it escapes the panel's scroll gutter — no
 * clipping at the list edges, no scroll-to-reveal dance.
 */
export function BookmarkFolderSelector({
  activeFolderId,
  defaultFolderId,
  onPick,
  onSetDefault,
  menuActions,
}: {
  /** The currently active folder, or `null` for the user's default folder. */
  activeFolderId: string | null;
  /** The folder id the user has set as their default (or the system one
   *  if none). Highlighted in the panel and shown in the trigger label. */
  defaultFolderId: string | null;
  onPick: (folderId: string | null) => void;
  /** Promote a folder to the user's default. Pass `null` to reset to the
   *  system All bookmarks. The page persists the choice in localStorage. */
  onSetDefault: (folderId: string | null) => void;
  /**
   * Extra menu rows rendered at the panel foot (e.g. bookmark
   * import/export). Receives a `close` callback so actions can dismiss
   * the panel after running.
   */
  menuActions?: (close: () => void) => ReactNode;
}) {
  const folders = useBookmarkFolders();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const kebabRefs = useRef(new Map<string, HTMLElement | null>());
  const { toast } = useToast();
  const createFolder = useCreateBookmarkFolder();
  const renameFolder = useRenameBookmarkFolder();
  const deleteFolder = useDeleteBookmarkFolder();
  const { settings: displaySettings, update: updateDisplaySettings } =
    useDisplaySettings();
  const bookmarksSettingsQuery = useBookmarksSettings();
  const saveBookmarksSettings = useSaveBookmarksSettings();
  /** "Sort by latest update" — persisted server-side with the other
   *  bookmarks-page preferences; same pending-wins pattern as the page
   *  toggles so the switch flips instantly. Defaults on. */
  const sortByLatestUpdate =
    saveBookmarksSettings.isPending && saveBookmarksSettings.variables
      ? (saveBookmarksSettings.variables.sortByLatestUpdate ?? true)
      : (bookmarksSettingsQuery.data?.sortByLatestUpdate ?? true);
  /**
   * "Ask where to save" — persisted server-side alongside the other
   * bookmarks toggles. Controls whether the details page pops the
   * "Choose folders" dialog after a bookmark is added (only when there is
   * more than one folder to pick from). Off = the bookmark lands in All
   * bookmarks without interrupting; the manual folder button is untouched.
   */
  const autoOpenFolderPicker =
    saveBookmarksSettings.isPending && saveBookmarksSettings.variables
      ? (saveBookmarksSettings.variables.autoOpenFolderPicker ?? true)
      : (bookmarksSettingsQuery.data?.autoOpenFolderPicker ?? true);
  const handleSortByLatestUpdateChange = (checked: boolean) => {
    const base =
      saveBookmarksSettings.isPending && saveBookmarksSettings.variables
        ? saveBookmarksSettings.variables
        : (bookmarksSettingsQuery.data ?? DEFAULT_BOOKMARKS_PAGE_SETTINGS);
    saveBookmarksSettings.mutate({ ...base, sortByLatestUpdate: checked });
  };
  const handleAutoOpenFolderPickerChange = (checked: boolean) => {
    const base =
      saveBookmarksSettings.isPending && saveBookmarksSettings.variables
        ? saveBookmarksSettings.variables
        : (bookmarksSettingsQuery.data ?? DEFAULT_BOOKMARKS_PAGE_SETTINGS);
    saveBookmarksSettings.mutate({ ...base, autoOpenFolderPicker: checked });
  };

  /** True while a bookmark card is being dragged (T2-8). Suppresses the
   *  outside-click close so the menu stays open as the user drags a card
   *  across the page looking for a folder target. */
  const dragInProgressRef = useRef(false);

  // Close on outside pointerdown or Escape. Drag events also fire
  // pointerdown on the source element — without this check, starting a
  // bookmark card drag would close the menu before the user can drop.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (event.isPrimary === false) return;
      if (dragInProgressRef.current) return;
      const target = event.target as Node | null;
      if (target && rootRef.current && rootRef.current.contains(target)) return;
      setOpen(false);
      setOpenMenuId(null);
    }
    function onDragStart(event: DragEvent) {
      if (event.dataTransfer?.types.includes('text/x-bookmark-id')) {
        dragInProgressRef.current = true;
      }
    }
    function onDragEnd() {
      dragInProgressRef.current = false;
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        if (openMenuId) setOpenMenuId(null);
        else setOpen(false);
      }
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('dragstart', onDragStart);
    document.addEventListener('dragend', onDragEnd);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('dragstart', onDragStart);
      document.removeEventListener('dragend', onDragEnd);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, openMenuId]);

  const handleCreate = async () => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    try {
      await createFolder.mutateAsync({ name: trimmed });
      setNewName('');
      setCreating(false);
      toast(`Folder "${trimmed}" created`, 'success');
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Could not create folder.', 'error');
    }
  };

  const handleRename = async (id: string) => {
    const trimmed = renameValue.trim();
    if (!trimmed) return;
    try {
      await renameFolder.mutateAsync({ id, name: trimmed });
      setRenamingId(null);
      setRenameValue('');
      toast('Folder renamed', 'success');
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Could not rename folder.', 'error');
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteFolder.mutateAsync(id);
      if (activeFolderId === id) onPick(null);
      if (defaultFolderId === id) onSetDefault(null);
      setPendingDelete(null);
      toast('Folder deleted', 'success');
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Could not delete folder.', 'error');
    }
  };

  const close = () => {
    setOpen(false);
    setCreating(false);
    setRenamingId(null);
    setRenameValue('');
    setOpenMenuId(null);
  };

  const allFolders = folders.data?.folders ?? [];
  const systemDefault = allFolders.find((f) => f.isDefault) ?? null;
  const customFolders = allFolders.filter((f) => !f.isDefault);

  const triggerName = (() => {
    if (activeFolderId === ALL_BOOKMARKS_ID) return 'All bookmarks';
    if (activeFolderId) {
      const found = allFolders.find((f) => f.id === activeFolderId);
      return found?.name ?? 'Folder';
    }
    if (defaultFolderId === ALL_BOOKMARKS_ID) return 'All bookmarks';
    const found = allFolders.find((f) => f.id === defaultFolderId);
     return found?.name ?? systemDefault?.name ?? 'All bookmarks';
  })();

  /** Registers the kebab DOM node so the popover can anchor to it. */
  const setKebabRef = (key: string) => (el: HTMLElement | null) => {
    if (el) kebabRefs.current.set(key, el);
    else kebabRefs.current.delete(key);
  };

  /** Compute fixed coordinates for the kebab popover. Uses getBoundingClientRect
   *  (viewport coords) so `position: fixed` lines up perfectly. Flips above
   *  the kebab when the row sits near the bottom of the viewport. */
  const computePopoverPosition = (key: string, height: number) => {
    const el = kebabRefs.current.get(key);
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const margin = 8;
    const popoverWidth = 180;
    const spaceBelow = window.innerHeight - rect.bottom - margin;
    const spaceAbove = rect.top - margin;
    const flip = spaceBelow < height && spaceAbove > spaceBelow;
    const maxLeft = window.innerWidth - popoverWidth - margin;
    const desiredLeft = rect.right - popoverWidth;
    const left = Math.max(margin, Math.min(desiredLeft, maxLeft));
    const top = flip ? rect.top - height - 4 : rect.bottom + 4;
    return { top, left };
  };

  return (
    <div ref={rootRef} className="bookmark-folder-selector">
      <button
        type="button"
        className={`btn bookmark-folder-selector__trigger${open ? ' bookmark-folder-selector__trigger--open' : ''}`}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`Folders — active: ${triggerName}`}
        title={triggerName}
        onClick={() => setOpen((v) => !v)}
      >
        <IconMenu size={16} />
        <span className="bookmark-folder-selector__trigger-name">{triggerName}</span>
      </button>

      {open && (
        <div className="bookmark-folder-selector__panel" role="menu" aria-label="Bookmark folders">
          <div className="bookmark-folder-selector__head">
            <h2>Folders</h2>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => setCreating((v) => !v)}
              aria-expanded={creating}
            >
              {creating ? 'Cancel' : '+ New'}
            </button>
          </div>

          {creating && (
            <form
              className="bookmark-folder-selector__create"
              onSubmit={(e) => {
                e.preventDefault();
                void handleCreate();
              }}
            >
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Folder name"
                autoFocus
              />
              <button type="submit" className="btn btn--primary btn--sm">
                Create
              </button>
            </form>
          )}

          <ul className="bookmark-folder-selector__list">
            <FolderRow
              menuKey={ALL_BOOKMARKS_ID}
              name="All bookmarks"
              isActive={activeFolderId === ALL_BOOKMARKS_ID}
              isDefault={defaultFolderId === ALL_BOOKMARKS_ID}
              kebabRef={setKebabRef(ALL_BOOKMARKS_ID)}
              popoverOpen={openMenuId === ALL_BOOKMARKS_ID}
              popoverPosition={
                openMenuId === ALL_BOOKMARKS_ID ? computePopoverPosition(ALL_BOOKMARKS_ID, 90) : null
              }
              onToggleKebab={() =>
                setOpenMenuId((current) => (current === ALL_BOOKMARKS_ID ? null : ALL_BOOKMARKS_ID))
              }
              onCloseKebab={() => setOpenMenuId(null)}
              onPick={() => {
                onPick(ALL_BOOKMARKS_ID);
                close();
              }}
              onSetDefault={() => {
                if (defaultFolderId === ALL_BOOKMARKS_ID) {
                  onSetDefault(null);
                  toast('Default reset to All bookmarks', 'success');
                } else {
                  onSetDefault(ALL_BOOKMARKS_ID);
                  toast('"All bookmarks" is now your default folder', 'success');
                }
                setOpenMenuId(null);
              }}
            />
            {customFolders.map((folder) => (
              <FolderRow
                key={folder.id}
                menuKey={folder.id}
                name={folder.name}
                isActive={activeFolderId === folder.id}
                isDefault={defaultFolderId === folder.id}
                kebabRef={setKebabRef(folder.id)}
                popoverOpen={openMenuId === folder.id}
                popoverPosition={
                  openMenuId === folder.id ? computePopoverPosition(folder.id, 120) : null
                }
                onToggleKebab={() =>
                  setOpenMenuId((current) => (current === folder.id ? null : folder.id))
                }
                onCloseKebab={() => setOpenMenuId(null)}
                onPick={() => {
                  onPick(folder.id);
                  close();
                }}
                onSetDefault={() => {
                  if (defaultFolderId === folder.id) {
                    onSetDefault(null);
                  toast('Default reset to All bookmarks', 'success');
                  } else {
                    onSetDefault(folder.id);
                    toast(`"${folder.name}" is now your default folder`, 'success');
                  }
                  setOpenMenuId(null);
                }}
                onRename={() => {
                  setRenamingId(folder.id);
                  setRenameValue(folder.name);
                  setOpenMenuId(null);
                }}
                onDelete={() => {
                  setPendingDelete(folder.id);
                  setOpenMenuId(null);
                }}
                renameForm={
                  renamingId === folder.id ? (
                    <form
                      className="bookmark-folder-selector__rename"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void handleRename(folder.id);
                      }}
                    >
                      <input
                        type="text"
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        autoFocus
                      />
                      <button type="submit" className="btn btn--primary btn--sm">
                        Save
                      </button>
                    </form>
                  ) : null
                }
              />
            ))}
          </ul>

          {menuActions && (
            <div
              className="bookmark-folder-selector__foot"
              role="group"
              aria-label="Bookmark actions"
            >
              {menuActions(close)}
            </div>
          )}

          <div className="bookmark-folder-selector__display">
            <span id="cover-badges-label" className="bookmark-folder-selector__display-label">
              <IconEye size={13} aria-hidden="true" />
              Cover badges
            </span>
            <Switch
              checked={!displaySettings.hideCoverBadges}
              onChange={(checked) => updateDisplaySettings({ hideCoverBadges: !checked })}
              labelledBy="cover-badges-label"
            />
          </div>

          <div className="bookmark-folder-selector__display bookmark-folder-selector__display--flush">
            <span id="sort-latest-update-label" className="bookmark-folder-selector__display-label">
              <IconRefresh size={13} aria-hidden="true" />
              Sort by latest update
            </span>
            <Switch
              checked={sortByLatestUpdate}
              onChange={handleSortByLatestUpdateChange}
              labelledBy="sort-latest-update-label"
            />
          </div>

          <div className="bookmark-folder-selector__display bookmark-folder-selector__display--flush">
            <span id="ask-where-to-save-label" className="bookmark-folder-selector__display-label">
              <IconFolder size={13} aria-hidden="true" />
              Ask where to save
            </span>
            <Switch
              checked={autoOpenFolderPicker}
              onChange={handleAutoOpenFolderPickerChange}
              labelledBy="ask-where-to-save-label"
            />
          </div>
        </div>
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete folder?"
         message="Its bookmarks stay in All bookmarks — only this folder is removed."
        confirmLabel="Delete"
        danger
        onConfirm={() => {
          if (pendingDelete) void handleDelete(pendingDelete);
        }}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}

/**
 * One folder row: click target (pick) + kebab + optional inline rename
 * form. The kebab popover renders via `position: fixed` (set inline from
 * the parent's precomputed coordinates) so it escapes the panel's scroll
 * gutter without needing a portal.
 */
function FolderRow({
  // menuKey is kept on the signature for future menu-instance targeting;
  // today every kebab popover is per-row and the position math reads the
  // ref directly, so we don't use it here.
  menuKey: _menuKey,
  name,
  isActive,
  isDefault,
  kebabRef,
  popoverOpen,
  popoverPosition,
  onToggleKebab,
  onCloseKebab,
  onPick,
  onSetDefault,
  onRename,
  onDelete,
  renameForm,
}: {
  menuKey: string;
  name: string;
  isActive: boolean;
  isDefault: boolean;
  kebabRef: (el: HTMLElement | null) => void;
  popoverOpen: boolean;
  popoverPosition: { top: number; left: number } | null;
  onToggleKebab: () => void;
  onCloseKebab: () => void;
  onPick: () => void;
  onSetDefault?: () => void;
  onRename?: () => void;
  onDelete?: () => void;
  renameForm?: ReactNode;
}) {
  const hasActions = Boolean(onSetDefault || onRename || onDelete);
  return (
    <li
      className={`bookmark-folder-selector__row${
        isActive ? ' bookmark-folder-selector__row--active' : ''
      }`}
    >
      {renameForm ? (
        renameForm
      ) : (
        <>
          <button
            type="button"
            role="menuitem"
            className="bookmark-folder-selector__pick"
            onClick={onPick}
          >
            <span className="bookmark-folder-selector__name">{name}</span>
          </button>
          {hasActions && (
            <div className="bookmark-folder-selector__row-actions">
              {isDefault && (
                <button
                  type="button"
                  ref={kebabRef}
                  className="bookmark-folder-selector__star-btn"
                  aria-label={`${name} — your default folder. Open actions.`}
                  title={`${name} is your default folder`}
                  aria-haspopup="menu"
                  aria-expanded={popoverOpen}
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleKebab();
                  }}
                >
                  <IconStar size={14} filled />
                </button>
              )}
              {!isDefault && (
                <button
                  type="button"
                  ref={kebabRef}
                  className="bookmark-folder-selector__kebab"
                  aria-label={`Actions for ${name}`}
                  aria-haspopup="menu"
                  aria-expanded={popoverOpen}
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleKebab();
                  }}
                >
                  <IconMore size={16} />
                </button>
              )}
              {popoverOpen && popoverPosition && (
                <div
                  className="bookmark-folder-selector__menu"
                  role="menu"
                  aria-label={`Actions for ${name}`}
                  style={{ top: popoverPosition.top, left: popoverPosition.left }}
                  onClick={(e) => e.stopPropagation()}
                >
                  {onSetDefault && (
                    <button
                      type="button"
                      role="menuitem"
                      className="bookmark-folder-selector__menu-item"
                      onClick={() => {
                        onSetDefault();
                        onCloseKebab();
                      }}
                    >
                      <IconStar size={14} filled={isDefault} />
                      {isDefault ? 'Unset default' : 'Set as default'}
                    </button>
                  )}
                  {onRename && (
                    <button
                      type="button"
                      role="menuitem"
                      className="bookmark-folder-selector__menu-item"
                      onClick={() => {
                        onRename();
                        onCloseKebab();
                      }}
                    >
                      <IconPencil size={14} />
                      Rename
                    </button>
                  )}
                  {onDelete && (
                    <button
                      type="button"
                      role="menuitem"
                      className="bookmark-folder-selector__menu-item bookmark-folder-selector__menu-item--danger"
                      onClick={() => {
                        onDelete();
                        onCloseKebab();
                      }}
                    >
                      <IconTrash size={14} />
                      Delete
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </li>
  );
}
