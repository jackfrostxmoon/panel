import { useEffect, useRef, useState } from 'react';
import { useSetPanelTags, useTagsByPanel } from '../api/hooks';
import { useToast } from './Toast';
import { IconX } from './icons';
import { useIncognito } from '../hooks/useIncognito';

/** Renders just the tag chips as `<li>` items (no list wrapper, no label) —
 *  used to fold the panel's tags into the genres row of the details page.
 *  The add/toggle chip is rendered separately by the caller. */
export function TagChipItems({ panelId }: { panelId: string }) {
  const tags = useTagsByPanel(panelId);
  const setTags = useSetPanelTags();
  const { toast } = useToast();
  const { enabled: incognito } = useIncognito();

  if (incognito || tags.isLoading) return null;

  const remove = (name: string) => {
    setTags.mutate(
      {
        panelId,
        names: (tags.data ?? []).filter((tag) => tag.name !== name).map((tag) => tag.name),
      },
      {
        onError: (error) => toast(error.message, 'error'),
      },
    );
  };

  return (
    <>
      {(tags.data ?? []).map((tag) => (
        <li key={tag.id}>
          <span className="tag-editor__chip" role="listitem">
            {tag.name.replace(/[,;]+/g, '').trim()}
            <button
              type="button"
              className="tag-editor__remove"
              aria-label={`Remove tag ${tag.name}`}
              disabled={setTags.isPending}
              onClick={() => remove(tag.name)}
            >
              <IconX size={12} />
            </button>
          </span>
        </li>
      ))}
    </>
  );
}

/**
 * Custom-tag editor (T3-4): chips for the current tags plus an input that
 * adds (and creates on demand) new ones. Clicking a chip removes that tag.
 * The whole set is sent as a replacement on every change.
 *
 * `toggleOnly` renders just the + Add tag toggle / input form (no label or
 *   chips). Used to place the toggle as the tail chip of the genres row
 *   while keeping the tags list where it is.
 */
export function TagEditor({
  panelId,
  toggleOnly = false,
}: {
  panelId: string;
  toggleOnly?: boolean;
}) {
  const tags = useTagsByPanel(panelId);
  const setTags = useSetPanelTags();
  const { toast } = useToast();
  const [draft, setDraft] = useState('');
  /** The add-tag form starts collapsed; a "+ Add tag" chip expands it. */
  const [adding, setAdding] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const { enabled: incognito } = useIncognito();

  useEffect(() => {
    if (adding) inputRef.current?.focus();
  }, [adding]);

  const commit = (names: string[]) => {
    setTags.mutate(
      { panelId, names },
      {
        onError: (error) => toast(error.message, 'error'),
      },
    );
  };

  const addDraft = () => {
    const name = draft.trim().replace(/[,;]+/g, '').trim();
    if (!name) return;
    const existing = (tags.data ?? []).map((t) => t.name);
    if (existing.some((n) => n.toLowerCase() === name.toLowerCase())) {
      setDraft('');
      return;
    }
    commit([...existing, name]);
    setDraft('');
    setAdding(false);
  };

  const collapse = () => {
    setDraft('');
    setAdding(false);
  };

  const remove = (name: string) => {
    commit((tags.data ?? []).filter((t) => t.name !== name).map((t) => t.name));
  };

  // Incognito: tags are hidden with the other user-data controls.
  if (incognito) return null;

  const chipsList = (
    <ul className="tag-editor__chips" role="list" aria-labelledby="tag-editor-label">
      {(tags.data ?? []).map((tag) => (
        <li key={tag.id}>
          <span className="tag-editor__chip" role="listitem">
            {tag.name.replace(/[,;]+/g, '').trim()}
            <button
              type="button"
              className="tag-editor__remove"
              aria-label={`Remove tag ${tag.name}`}
              disabled={setTags.isPending}
              onClick={() => remove(tag.name)}
            >
              <IconX size={12} />
            </button>
          </span>
        </li>
      ))}
      {(tags.data ?? []).length === 0 && !tags.isLoading && (
        <li>
          <span className="tag-editor__empty">No tags yet</span>
        </li>
      )}
    </ul>
  );

  const toggle = adding ? (
    <form
      className="tag-editor__form"
      onSubmit={(e) => {
        e.preventDefault();
        addDraft();
      }}
    >
      <input
        ref={inputRef}
        type="text"
        className="tag-editor__input"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') collapse();
        }}
        placeholder="Add a tag…"
        aria-label="New tag name"
        maxLength={32}
      />
      <button type="submit" className="btn btn--ghost btn--sm" disabled={!draft.trim()}>
        Add
      </button>
      <button
        type="button"
        className="tag-editor__collapse"
        aria-label="Cancel adding a tag"
        onClick={collapse}
      >
        <IconX size={14} />
      </button>
    </form>
  ) : (
    <button
      type="button"
      className="genre-chip genre-chip--toggle tag-editor__toggle"
      onClick={() => setAdding(true)}
      aria-expanded={adding}
    >
      + Add tag
    </button>
  );

  if (toggleOnly) {
    return <>{toggle}</>;
  }

  return (
    <div className="tag-editor">
      <div className="genre-list-header">
        <span className="genre-list-label" id="tag-editor-label">
          Tags
        </span>
        {(tags.data ?? []).length > 0 && (
          <span className="genre-count">{(tags.data ?? []).length}</span>
        )}
      </div>
      <div className="tag-editor__row">
        {chipsList}
        {toggle}
      </div>
    </div>
  );
}