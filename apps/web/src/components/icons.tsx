/**
 * Shared inline SVG icon set — the single source of stroke icons for the app.
 * All icons inherit `currentColor`, use a 24-unit grid and a consistent
 * 2px round stroke, so they render crisply at any size and match in weight.
 */
import type { CSSProperties } from 'react';

interface IconProps {
  size?: number;
  className?: string;
  style?: CSSProperties;
}

function base(size: number, className?: string, style?: CSSProperties) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    className,
    style,
    'aria-hidden': true as const,
  };
}

export function IconCheck({ size = 16, className, style }: IconProps) {
  return (
    <svg {...base(size, className, style)}>
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

export function IconX({ size = 16, className, style }: IconProps) {
  return (
    <svg {...base(size, className, style)}>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

/** Hamburger — opens overlay/menu panels. */
export function IconMenu({ size = 16, className, style }: IconProps) {
  return (
    <svg {...base(size, className, style)}>
      <line x1="4" y1="7" x2="20" y2="7" />
      <line x1="4" y1="12" x2="20" y2="12" />
      <line x1="4" y1="17" x2="20" y2="17" />
    </svg>
  );
}

/** Eye — for visibility / show toggle labels. */
export function IconEye({ size = 16, className, style }: IconProps) {
  return (
    <svg {...base(size, className, style)}>
      <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

export function IconPlus({ size = 16, className, style }: IconProps) {
  return (
    <svg {...base(size, className, style)}>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

export function IconClock({ size = 16, className, style }: IconProps) {
  return (
    <svg {...base(size, className, style)}>
      <circle cx="12" cy="12" r="9" />
      <polyline points="12 7 12 12 15 14" />
    </svg>
  );
}

export function IconChevronDown({ size = 16, className, style }: IconProps) {
  return (
    <svg {...base(size, className, style)}>
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

export function IconChevronLeft({ size = 16, className, style }: IconProps) {
  return (
    <svg {...base(size, className, style)}>
      <polyline points="15 6 9 12 15 18" />
    </svg>
  );
}

export function IconChevronRight({ size = 16, className, style }: IconProps) {
  return (
    <svg {...base(size, className, style)}>
      <polyline points="9 6 15 12 9 18" />
    </svg>
  );
}

export function IconArrowLeft({ size = 16, className, style }: IconProps) {
  return (
    <svg {...base(size, className, style)}>
      <line x1="19" y1="12" x2="5" y2="12" />
      <polyline points="12 19 5 12 12 5" />
    </svg>
  );
}

export function IconArrowUp({ size = 16, className, style }: IconProps) {
  return (
    <svg {...base(size, className, style)}>
      <line x1="12" y1="19" x2="12" y2="5" />
      <polyline points="5 12 12 5 19 12" />
    </svg>
  );
}

export function IconArrowRight({ size = 16, className, style }: IconProps) {
  return (
    <svg {...base(size, className, style)}>
      <line x1="5" y1="12" x2="19" y2="12" />
      <polyline points="12 5 19 12 12 19" />
    </svg>
  );
}

export function IconArrowDown({ size = 16, className, style }: IconProps) {
  return (
    <svg {...base(size, className, style)}>
      <line x1="12" y1="5" x2="12" y2="19" />
      <polyline points="19 12 12 19 5 12" />
    </svg>
  );
}

export function IconPlay({ size = 16, className, style }: IconProps) {
  return (
    <svg {...base(size, className, style)} fill="currentColor" stroke="none">
      <polygon points="6 4 20 12 6 20" />
    </svg>
  );
}

export function IconPause({ size = 16, className, style }: IconProps) {
  return (
    <svg {...base(size, className, style)} fill="currentColor" stroke="none">
      <rect x="6" y="4" width="4" height="16" rx="1" />
      <rect x="14" y="4" width="4" height="16" rx="1" />
    </svg>
  );
}

export function IconGear({ size = 16, className, style }: IconProps) {
  return (
    <svg {...base(size, className, style)}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.09a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.09a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1z" />
    </svg>
  );
}

export function IconExpand({ size = 16, className, style }: IconProps) {
  return (
    <svg {...base(size, className, style)}>
      <polyline points="15 3 21 3 21 9" />
      <polyline points="9 21 3 21 3 15" />
      <line x1="21" y1="3" x2="14" y2="10" />
      <line x1="3" y1="21" x2="10" y2="14" />
    </svg>
  );
}

/** Bookmark icon; `filled` renders the solid state. */
export function IconBookmark({ size = 16, filled = false, className, style }: IconProps & { filled?: boolean }) {
  return (
    <svg {...base(size, className, style)} fill={filled ? 'currentColor' : 'none'}>
      <path d="M19 21l-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
    </svg>
  );
}

/** Folder icon. */
export function IconFolder({ size = 16, className, style }: IconProps) {
  return (
    <svg {...base(size, className, style)}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h10a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}

/** Star icon; `filled` renders the solid state. */
export function IconStar({ size = 16, filled = false, className, style }: IconProps & { filled?: boolean }) {
  return (
    <svg {...base(size, className, style)} fill={filled ? 'currentColor' : 'none'}>
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  );
}

export function IconClipboard({ size = 16, className, style }: IconProps) {
  return (
    <svg {...base(size, className, style)}>
      <rect x="8" y="2" width="8" height="4" rx="1" />
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
    </svg>
  );
}

export function IconBookOpen({ size = 16, className, style }: IconProps) {
  return (
    <svg {...base(size, className, style)}>
      <path d="M2 4h6a4 4 0 0 1 4 4v12a3 3 0 0 0-3-3H2z" />
      <path d="M22 4h-6a4 4 0 0 0-4 4v12a3 3 0 0 1 3-3h7z" />
    </svg>
  );
}

export function IconCheckCircle({ size = 16, className, style }: IconProps) {
  return (
    <svg {...base(size, className, style)}>
      <circle cx="12" cy="12" r="9" />
      <polyline points="8.5 12.5 11 15 15.5 9.5" />
    </svg>
  );
}

export function IconAlert({ size = 16, className, style }: IconProps) {
  return (
    <svg {...base(size, className, style)}>
      <circle cx="12" cy="12" r="9" />
      <line x1="12" y1="8" x2="12" y2="13" />
      <circle cx="12" cy="16.5" r="0.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function IconInbox({ size = 16, className, style }: IconProps) {
  return (
    <svg {...base(size, className, style)}>
      <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
      <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    </svg>
  );
}

/**
 * Cloud-with-down-arrow. Used by the chapter-download actions to mean
 * "pre-warm this chapter's images in the on-disk cache".
 */
export function IconDownload({ size = 16, className, style }: IconProps) {
  return (
    <svg {...base(size, className, style)}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

/** Square stop icon — used to abort an in-flight chapter download. */
export function IconStop({ size = 16, className, style }: IconProps) {
  return (
    <svg {...base(size, className, style)} fill="currentColor" stroke="none">
      <rect x="5" y="5" width="14" height="14" rx="1.5" />
    </svg>
  );
}

export function IconUndo({ size = 16, className, style }: IconProps) {
  return (
    <svg {...base(size, className, style)}>
      <polyline points="1 4 1 10 7 10" />
      <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
    </svg>
  );
}

export function IconRefresh({ size = 16, className, style }: IconProps) {
  return (
    <svg {...base(size, className, style)}>
      <polyline points="23 4 23 10 17 10" />
      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
    </svg>
  );
}

export function IconTrash({ size = 16, className, style }: IconProps) {
  return (
    <svg {...base(size, className, style)}>
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
      <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
    </svg>
  );
}

/** Vertical three-dot overflow menu trigger (a.k.a. kebab). */
export function IconMore({ size = 16, className, style }: IconProps) {
  return (
    <svg {...base(size, className, style)}>
      <circle cx="12" cy="6" r="1.25" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.25" fill="currentColor" stroke="none" />
      <circle cx="12" cy="18" r="1.25" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** Pencil — used for rename actions. */
export function IconPencil({ size = 16, className, style }: IconProps) {
  return (
    <svg {...base(size, className, style)}>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
    </svg>
  );
}