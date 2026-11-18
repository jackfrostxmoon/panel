import { useCallback, type ReactElement } from 'react';
import type { ReadingListStatus } from '@panel/shared';
import { IconBookOpen, IconCheckCircle, IconClipboard, IconX } from './icons';
import { useIncognito } from '../hooks/useIncognito';

const STATUSES: ReadingListStatus[] = ['want_to_read', 'reading', 'completed'];

const STATUS_LABEL: Record<ReadingListStatus, string> = {
  want_to_read: 'Want to Read',
  reading: 'Reading',
  completed: 'Completed',
};

const STATUS_ICON: Record<ReadingListStatus, ReactElement> = {
  want_to_read: <IconClipboard size={14} />,
  reading: <IconBookOpen size={14} />,
  completed: <IconCheckCircle size={14} />,
};

/** Small segmented control that sets the reading-list status for one panel (T1-5). */
export function ReadingListStatusControl({
  panelId,
  current,
  onUpsert,
  onRemove,
  disabled,
}: {
  panelId: string;
  current: ReadingListStatus | null;
  onUpsert: (input: { panelId: string; status: ReadingListStatus }) => void;
  onRemove: () => void;
  disabled?: boolean;
}) {
  const handleSelect = useCallback(
    (status: ReadingListStatus) => {
      if (disabled) return;
      onUpsert({ panelId, status });
    },
    [disabled, panelId, onUpsert],
  );

  const { enabled: incognito } = useIncognito();

  const handleRemove = useCallback(() => {
    if (disabled) return;
    onRemove();
  }, [disabled, onRemove]);

  // Incognito: the reading list is hidden with the other user-data controls.
  if (incognito) return null;

  return (
    <div className="reading-list-status" role="group" aria-label="Reading list status">
      {STATUSES.map((status) => {
        const active = status === current;
        return (
          <button
            key={status}
            type="button"
            className={`reading-list-status__btn${active ? ' reading-list-status__btn--active' : ''}`}
            disabled={disabled}
            aria-label={`Set status to ${STATUS_LABEL[status]}`}
            title={STATUS_LABEL[status]}
            onClick={() => handleSelect(status)}
          >
            {STATUS_ICON[status]}
          </button>
        );
      })}
      {current && (
        <button
          type="button"
          className="reading-list-status__btn reading-list-status__btn--remove"
          disabled={disabled}
          aria-label="Remove from reading list"
          title="Remove from reading list"
          onClick={handleRemove}
        >
          <IconX size={14} />
        </button>
      )}
    </div>
  );
}