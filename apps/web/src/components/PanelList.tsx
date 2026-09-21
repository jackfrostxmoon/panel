import type { MouseEvent, ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { CardLayout } from '@panel/shared';
import type { PreviewCover } from './coverPreview';
import { IconGrid, IconList } from './icons';

export type { PreviewCover } from './coverPreview';

/** Compact vertical list that replaces the cover-card grid in list layout. */
export function PanelList({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <ul className={className ? `panel-list ${className}` : 'panel-list'} role="list">{children}</ul>;
}

/**
 * One row of the compact list: title with a dim meta line stacked beneath
 * it (progress · latest chapter), optional badges, and trailing actions.
 * Hovering the title opens the floating cover preview.
 */
export function PanelListRow({
  cover,
  title,
  to,
  meta,
  badges,
  actions,
  bookmarked,
  draggable,
  onDragStart,
  onDragEnd,
  onPreviewShow,
  onPreviewHide,
  className,
}: {
  cover: PreviewCover;
  title: string;
  to: string;
  /** Progress / latest-chapter lines rendered under the title. */
  meta?: ReactNode;
  /** Status / source / folder pills rendered after the title. */
  badges?: ReactNode;
  /** Trailing buttons (continue, folder, open, remove…). */
  actions?: ReactNode;
  /** Highlight the row when the panel is already bookmarked. */
  bookmarked?: boolean;
  draggable?: boolean;
  onDragStart?: (event: React.DragEvent<HTMLLIElement>) => void;
  onDragEnd?: () => void;
  onPreviewShow?: (cover: PreviewCover, clientX: number, clientY: number) => void;
  onPreviewHide?: () => void;
  /** Extra class on the `<li>` (e.g. dragging state). */
  className?: string;
}) {
  const handleTitleEnter = (event: MouseEvent<HTMLAnchorElement>) => {
    onPreviewShow?.(cover, event.clientX, event.clientY);
  };

  return (
    <li
      className={`panel-list__row${bookmarked ? ' panel-list__row--bookmarked' : ''}${className ? ` ${className}` : ''}`}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
    >
      <div className="panel-list__main">
        <h3 className="panel-list__title">
          <Link
            to={to}
            className="panel-list__title-link"
            onMouseEnter={handleTitleEnter}
            onMouseLeave={() => onPreviewHide?.()}
          >
            {title}
          </Link>
        </h3>
        {meta && <div className="panel-list__meta">{meta}</div>}
      </div>
      {badges && <div className="panel-list__badges">{badges}</div>}
      {actions && <div className="panel-list__actions">{actions}</div>}
    </li>
  );
}

/**
 * Cards/List segmented control for page toolbars. Persists through the
 * page's own settings mutation (same pattern as the infinite-scroll switch).
 */
export function CardLayoutToggle({
  value,
  onChange,
  labelId,
}: {
  value: CardLayout;
  onChange: (next: CardLayout) => void;
  /** Id of the visible label for aria-labelledby. */
  labelId: string;
}) {
  return (
    <span className="search-filters__switch">
      <span className="search-filters__label" id={labelId}>
        Layout
      </span>
      <span className="layout-toggle" role="group" aria-labelledby={labelId}>
        <button
          type="button"
          className={`layout-toggle__btn${value === 'cards' ? ' layout-toggle__btn--active' : ''}`}
          aria-pressed={value === 'cards'}
          aria-label="Card layout"
          title="Card layout"
          onClick={() => onChange('cards')}
        >
          <IconGrid size={14} />
        </button>
        <button
          type="button"
          className={`layout-toggle__btn${value === 'list' ? ' layout-toggle__btn--active' : ''}`}
          aria-pressed={value === 'list'}
          aria-label="List layout"
          title="List layout"
          onClick={() => onChange('list')}
        >
          <IconList size={14} />
        </button>
      </span>
    </span>
  );
}
