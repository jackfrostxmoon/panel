import type { Chapter } from '@panel/shared';
import {
  cloneElement,
  useEffect,
  isValidElement,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import {
  DEFAULT_IMAGE_BRIGHTNESS,
  DEFAULT_READER_SETTINGS,
  IMAGE_BRIGHTNESS_MAX,
  IMAGE_BRIGHTNESS_MIN,
  IMAGE_BRIGHTNESS_STEP,
  IMAGE_WIDTH_MAX,
  IMAGE_WIDTH_MIN,
  IMAGE_WIDTH_STEP,
  PRELOAD_AHEAD_MAX,
  PRELOAD_AHEAD_MIN,
  PRELOAD_AHEAD_STEP,
  type ImageLoadMode,
  type PreloadAhead,
  type ReaderBackground,
  type ReaderSettings,
  type ReadingDirection,
  type ReadingMode,
  type ScrollSpeed,
  type SpreadOddPolicy,
  type GlidePreset,
} from './settings';
import {
  SHORTCUT_CATEGORIES,
  resolveShortcuts,
  type Shortcut,
  type ShortcutCategory,
} from './shortcuts';
import { api } from '../api/client';
import { useImageConcurrency, useSetImageConcurrency } from '../api/hooks';
import {
  READER_STYLE_MAX_NAME,
  clearLegacyLocalPresets,
  deleteStylePreset,
  downloadStyleExport,
  loadLegacyLocalPresets,
  normalizeStyleName,
  parseStyleImport,
  replaceStylePresets,
  sanitizeStylePresets,
  saveStylePreset,
  type ReaderStylePreset,
} from './settingStyles';


/**
 * Reader settings sidebar — a full-height panel that slides in from the right
 * edge of the reader. A click on the backdrop or the Escape key dismisses it.
 *
 * Accessibility: each choice group is a `radiogroup` with arrow-key navigation
 * and an `aria-checked` option; the boolean toggle is a true switch; all
 * controls expose `focus-visible` rings.
 */
export function ReaderSettingsPanel({
  settings,
  onUpdate,
  onClose,
  open,
  page,
  pageCount,
  onPageSelect,
  chapters,
  currentChapterId,
  onChapterSelect,
}: {
  settings: ReaderSettings;
  onUpdate: (patch: Partial<ReaderSettings>) => void;
  onClose: () => void;
  /** Whether the sidebar is open (controls the slide transform + backdrop). */
  open: boolean;
  /** 0-based current page, for the page counter + jump-to-page dropdown. */
  page: number;
  pageCount: number;
  onPageSelect: (page: number) => void;
  /** Chapter list of the current panel, for the chapter dropdown. */
  chapters: Chapter[];
  currentChapterId: string;
  onChapterSelect: (chapterId: string) => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [activeTab, setActiveTab] = useState<'simple' | 'advanced'>('simple');
  const [presets, setPresets] = useState<ReaderStylePreset[]>([]);
  const [selectedPreset, setSelectedPreset] = useState('');
  const [draftName, setDraftName] = useState('');
  /** Whether the "new style" name field is expanded (toggled by the + button). */
  const [adding, setAdding] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  /** True while a style list is being written to the server JSON file. */
  const [persisting, setPersisting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  /**
   * Server-side image-proxy concurrency (see `useImageConcurrency`).
   * Refresh on open so the presets reflect the live value; the pending
   * mutation value wins while a save is in flight so the control flips
   * instantly instead of waiting for the round-trip.
   */
  const concurrencyQuery = useImageConcurrency();
  const saveConcurrency = useSetImageConcurrency();
  const { refetch: refetchConcurrency } = concurrencyQuery;
  useEffect(() => {
    if (open) void refetchConcurrency();
    // oxlint-disable-next-line react/exhaustive-deps
  }, [open ]);
  const pendingConcurrency = saveConcurrency.isPending ? saveConcurrency.variables : undefined;
  const concurrencyInfo = concurrencyQuery.data;
  const displayConcurrency =
    pendingConcurrency !== undefined
      ? (pendingConcurrency ?? concurrencyInfo?.defaultConcurrency ?? 16)
      : (concurrencyInfo?.concurrency ?? 16);
  const concurrencyMin = concurrencyInfo?.min ?? 1;
  const concurrencyMax = concurrencyInfo?.max ?? 32;
  const concurrencyError =
    saveConcurrency.error?.message ??
    (concurrencyQuery.isError ? 'Could not reach the server.' : null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      let list: ReaderStylePreset[];
      try {
        const server = sanitizeStylePresets(await api.getReaderStyles());
        // One-time migration of pre-server styles kept in localStorage:
        // adopt them when the server file is still empty, then drop the
        // legacy copy so it can't shadow later saves.
        const legacy = server.length === 0 ? loadLegacyLocalPresets() : [];
        if (legacy.length === 0) {
          list = server;
        } else {
          list = sanitizeStylePresets(await api.saveReaderStyles(legacy));
          clearLegacyLocalPresets();
        }
      } catch {
        // Server unreachable — fall back to the legacy local copy, if any.
        list = loadLegacyLocalPresets();
      }
      if (cancelled) return;
      setPresets(list);
      setImportError(null);
      if (!list.some((p) => p.name === selectedPreset)) {
        setSelectedPreset(list[0]?.name ?? '');
      }
    })();
    return () => {
      cancelled = true;
    };
    // oxlint-disable-next-line react/exhaustive-deps
  }, [open ]);

  const refreshPresets = (list: ReaderStylePreset[], keep?: string) => {
    setPresets(list);
    const target = keep ?? selectedPreset;
    setSelectedPreset(list.some((p) => p.name === target) ? target : (list[0]?.name ?? ''));
  };

  /**
   * Write the list to the server JSON file and refresh state. Serializes
   * writes (via `persisting`) so two rapid saves can't clobber each other.
   * Returns false on failure (error message already set).
   */
  const persistList = async (list: ReaderStylePreset[], keep?: string): Promise<boolean> => {
    setPersisting(true);
    try {
      refreshPresets(sanitizeStylePresets(await api.saveReaderStyles(list)), keep);
      setImportError(null);
      return true;
    } catch (error) {
      setImportError(error instanceof Error ? error.message : 'Could not save styles.');
      return false;
    } finally {
      setPersisting(false);
    }
  };

  /** Persist the draft name as a style, then collapse the add form. */
  const saveDraft = () => {
    const clean = normalizeStyleName(draftName);
    if (!clean) {
      setImportError('Enter a name for this style.');
      return;
    }
    void persistList(saveStylePreset(clean, settings, presets), clean).then((saved) => {
      if (!saved) return;
      setDraftName(clean);
      setAdding(false);
    });
  };

  useEffect(() => {
    if (!open) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', handleKey, true);
    return () => document.removeEventListener('keydown', handleKey, true);
  }, [open, onClose]);

  // When the panel closes, blur any input inside it so keyboard shortcuts
  // don't reach a hidden range/number input (e.g. the image-width slider)
  // and cause rapid value changes / layout glitching while reading.
  useEffect(() => {
    if (open) return;
    const active = document.activeElement as HTMLElement | null;
    if (active && panelRef.current?.contains(active)) {
      active.blur();
    }
  }, [open]);

  const shortcutGroups = useMemo(() => {
    const resolved = resolveShortcuts(settings.direction, settings.mode);
    return SHORTCUT_CATEGORIES.map((category) => ({
      category,
      shortcuts: resolved.filter((shortcut) => shortcut.category === category),
    }));
  }, [settings.direction, settings.mode]);

  return (
    <>
      <div
        className={`reader-settings-backdrop${open ? ' reader-settings-backdrop--visible' : ''}`}
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        className={`reader-settings reader-settings--sidebar${settings.background === 'light' ? ' reader-settings--light' : ''}${open ? ' reader-settings--open' : ''}`}
        ref={panelRef}
        /* inert (not aria-hidden): a closed panel must also be unfocusable,
           otherwise focus retained inside it triggers the blocked-aria-hidden
           browser warning. */
        inert={!open}
      >
        <header className="reader-settings__header">
          <div>
            <h2 id="reader-settings-title" className="reader-settings__title">
              Reading settings
            </h2>
            <p className="reader-settings__subtitle">Tailor the reader to your taste</p>
          </div>
          <button
            type="button"
            className="reader-settings__close"
            onClick={onClose}
            aria-label="Close settings"
            title="Close (Esc)"
          >
            <CloseIcon />
          </button>
        </header>

        <div
          className="reader-settings__tabs"
          role="tablist"
          aria-label="Settings categories"
        >
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'simple'}
            className={`reader-settings__tab${activeTab === 'simple' ? ' reader-settings__tab--active' : ''}`}
            onClick={() => setActiveTab('simple')}
          >
            Simple
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'advanced'}
            className={`reader-settings__tab${activeTab === 'advanced' ? ' reader-settings__tab--active' : ''}`}
            onClick={() => setActiveTab('advanced')}
          >
            Advanced
          </button>
        </div>

        <div className="reader-settings__body">
          {activeTab === 'simple' ? (
            <>
          <SettingGroup
            id="rs-styles"
            title="Styles"
            hint="Save current setup as a named style. Apply, delete, import/export as JSON."
          >
            <div className="reader-settings__styles-head">
              <Select
                value={selectedPreset}
                onChange={(value) => {
                  setSelectedPreset(value);
                  setDraftName(value);
                  // Picking a style applies it immediately — no separate
                  // Apply step. (Programmatic selection changes from
                  // save/delete/import don't fire this; only user picks.)
                  const preset = presets.find((p) => p.name === value);
                  if (preset) onUpdate({ ...preset.settings });
                }}
                options={presets.map((preset) => ({ value: preset.name, label: preset.name }))}
                label="Saved styles"
                disabled={presets.length === 0}
              />
              <button
                type="button"
                className="reader-settings__add-btn"
                onClick={() => {
                  if (adding) {
                    setAdding(false);
                  } else {
                    setDraftName('');
                    setAdding(true);
                  }
                }}
                aria-expanded={adding}
                aria-label={adding ? 'Cancel adding a style' : 'Save current settings as a new style'}
                title={adding ? 'Cancel' : 'Save current settings as a new style'}
              >
                {adding ? <CloseIcon /> : <PlusIcon />}
              </button>
            </div>
            {presets.length === 0 && !adding && (
              <p className="reader-settings__sub-hint">No saved styles yet.</p>
            )}
            {adding && (
              <div className="reader-settings__style-form">
                <input
                  type="text"
                  className="reader-settings__number-input"
                  style={{ textAlign: 'left' }}
                  aria-label="Style name"
                  placeholder="Style name"
                  value={draftName}
                  maxLength={READER_STYLE_MAX_NAME}
                  autoFocus
                  onChange={(event) => setDraftName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      saveDraft();
                    }
                  }}
                />
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={saveDraft}
                  disabled={persisting || !draftName.trim()}
                >
                  {persisting ? 'Saving…' : 'Save'}
                </button>
              </div>
            )}
            {!adding && selectedPreset && presets.length > 0 && (
              <div className="reader-settings__style-actions">
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() => {
                    if (selectedPreset) downloadStyleExport(presets, selectedPreset);
                  }}
                >
                  Export
                </button>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() => {
                    void persistList(deleteStylePreset(selectedPreset, presets));
                  }}
                  disabled={persisting}
                >
                  Delete
                </button>
              </div>
            )}
            {!adding && (
              <details className="reader-settings__backup">
                <summary className="reader-settings__backup-toggle">Import / export</summary>
                <div className="reader-settings__backup-actions">
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => {
                      if (presets.length > 0) downloadStyleExport(presets);
                    }}
                    disabled={presets.length === 0}
                  >
                    Export all
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => fileRef.current?.click()}
                    disabled={persisting}
                  >
                    Import
                  </button>
                  <input
                    ref={fileRef}
                    type="file"
                    accept="application/json,.json"
                    hidden
                    aria-label="Import styles from JSON file"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      event.target.value = '';
                      if (!file) return;
                      void file.text().then(
                        (raw) => {
                          let imported: ReaderStylePreset[];
                          try {
                            imported = parseStyleImport(raw);
                          } catch (error) {
                            setImportError(error instanceof Error ? error.message : 'Import failed.');
                            return;
                          }
                          const merged = new Map<string, ReaderStylePreset>();
                          for (const p of presets) merged.set(p.name, p);
                          for (const p of imported) merged.set(p.name, p);
                          void persistList(replaceStylePresets([...merged.values()]), imported[0]?.name);
                        },
                        () => setImportError('Could not read that file.'),
                      );
                    }}
                  />
                </div>
              </details>
            )}
            {importError && (
              <p className="reader-settings__sub-hint" role="alert">
                {importError}
              </p>
            )}
          </SettingGroup>

          <SettingGroup
            id="rs-page"
            title="Current page"
            hint="Jump straight to any page in this chapter."
          >
            <Select
              value={String(page)}
              onChange={(value) => onPageSelect(Number(value))}
              options={Array.from({ length: pageCount }, (_, index) => ({
                value: String(index),
                label: `Page ${index + 1}`,
              }))}
              label="Go to page"
              disabled={pageCount <= 0}
            />
          </SettingGroup>

          <SettingGroup
            id="rs-chapter"
            title="Chapter"
            hint="Switch to another chapter of this panel."
            disabled={chapters.length === 0}
          >
            <Select
              value={currentChapterId}
              onChange={onChapterSelect}
              options={chapters.map((chapter) => ({ value: chapter.id, label: chapter.title }))}
              label="Go to chapter"
            />
          </SettingGroup>

          <SettingGroup
            id="rs-mode"
            title="Reading mode"
            hint={
              settings.mode === 'vertical'
                ? 'Keep scrolling through all pages'
                : settings.mode === 'gallery'
                  ? 'Browse pages arranged in a grid'
                  : 'Turn one page at a time'
            }
          >
            <Segmented<ReadingMode>
              labelledBy="rs-mode"
              options={[
                { value: 'vertical', label: 'Vertical', icon: <IconVertical /> },
                { value: 'gallery', label: 'Gallery', icon: <IconGallery /> },
                { value: 'paged', label: 'Pages', icon: <IconPages /> },
              ]}
              value={settings.mode}
              onChange={(mode) => onUpdate({ mode })}
            />
          </SettingGroup>

          <SettingGroup
            id="rs-background"
            title="Background"
            hint="Light keeps the page bright; dark is easier for night reading."
          >
            <Segmented<ReaderBackground>
              labelledBy="rs-background"
              options={[
                { value: 'dark', label: 'Dark', icon: <IconDark /> },
                { value: 'light', label: 'Light', icon: <IconLight /> },
                { value: 'high-contrast', label: 'Contrast', icon: <IconContrast /> },
              ]}
              value={settings.background}
              onChange={(background) => onUpdate({ background })}
            />
          </SettingGroup>

          <SettingGroup
            id="rs-dataSaver"
            title="Data saver"
            hint="Loads pages one at a time as you reach them and skips background prefetch. Best for metered connections."
          >
            <Switch
              checked={settings.dataSaver}
              labelledBy="rs-dataSaver"
              onChange={(dataSaver) => onUpdate({ dataSaver })}
            />
            <label id="rs-dataSaver" className="reader-settings__switch-label">
              Limit image loading to save data
            </label>
          </SettingGroup>

          <SettingGroup
            id="rs-brightness"
            title="Image brightness"
            hint="Dim bright pages for night reading or boost washed-out scans."
          >
            <RangeField
              label="Image brightness"
              value={settings.imageBrightness}
              min={IMAGE_BRIGHTNESS_MIN}
              max={IMAGE_BRIGHTNESS_MAX}
              step={IMAGE_BRIGHTNESS_STEP}
              onChange={(imageBrightness) => onUpdate({ imageBrightness })}
              onReset={() => onUpdate({ imageBrightness: DEFAULT_IMAGE_BRIGHTNESS })}
            />
          </SettingGroup>

          <SettingGroup
            id="rs-width"
            title="Image width"
            hint="How much of the frame each page fills on screen."
          >
            <RangeField
              label="Image width"
              value={settings.imageWidth}
              min={IMAGE_WIDTH_MIN}
              max={IMAGE_WIDTH_MAX}
              step={IMAGE_WIDTH_STEP}
              format={(w) => `${w}%`}
              defaultValue={DEFAULT_READER_SETTINGS.imageWidth}
              onChange={(imageWidth) => onUpdate({ imageWidth })}
              onReset={() => onUpdate({ imageWidth: DEFAULT_READER_SETTINGS.imageWidth })}
            />
          </SettingGroup>

          <div
            className="reader-settings__row"
            data-disabled={settings.mode !== 'paged' || undefined}
          >
            <span className="reader-settings__row-copy">
              <span id="rs-fitHeight" className="reader-settings__row-title">
                Fit to height
              </span>
              <span className="reader-settings__row-hint">
                {settings.mode === 'paged'
                  ? 'Fit the page to the screen height so the whole image is visible without scrolling.'
                  : 'Only available in page (F) reading mode.'}
              </span>
            </span>
            <Switch
              checked={settings.fitToHeight}
              labelledBy="rs-fitHeight"
              onChange={(fitToHeight) => {
                if (settings.mode === 'paged') onUpdate({ fitToHeight });
              }}
            />
          </div>

          <div className="reader-settings__row">
            <span className="reader-settings__row-copy">
              <span id="rs-progressBar" className="reader-settings__row-title">
                Progress bar
              </span>
              <span className="reader-settings__row-hint">
                Show or hide the progress bar at the bottom of the reader.
              </span>
            </span>
            <Switch
              checked={settings.showProgressBar}
              labelledBy="rs-progressBar"
              onChange={(showProgressBar) => onUpdate({ showProgressBar })}
            />
          </div>

          <div className="reader-settings__row">
            <span className="reader-settings__row-copy">
              <span id="rs-imageGap" className="reader-settings__row-title">
                Image gap
              </span>
              <span className="reader-settings__row-hint">
                Add spacing between pages when reading.
              </span>
            </span>
            <Switch
              checked={settings.imageGap}
              labelledBy="rs-imageGap"
              onChange={(imageGap) => onUpdate({ imageGap })}
            />
          </div>

          <div className="reader-settings__row">
            <span className="reader-settings__row-copy">
              <span id="rs-scrollbar" className="reader-settings__row-title">
                Vertical scroll bar
              </span>
              <span className="reader-settings__row-hint">
                Show the scrollbar on the reading surface.
              </span>
            </span>
            <Switch
              checked={settings.showScrollbar}
              labelledBy="rs-scrollbar"
              onChange={(showScrollbar) => onUpdate({ showScrollbar })}
            />
          </div>

          <div className="reader-settings__row">
            <span className="reader-settings__row-copy">
              <span id="rs-clearToolbarSpace" className="reader-settings__row-title">
                Clear toolbar space
              </span>
              <span className="reader-settings__row-hint">
                Add padding so pages clear the fixed toolbar and footer on desktop and mobile.
              </span>
            </span>
            <Switch
              checked={settings.clearToolbarSpace}
              labelledBy="rs-clearToolbarSpace"
              onChange={(clearToolbarSpace) => onUpdate({ clearToolbarSpace })}
            />
          </div>
            </>
          ) : (
            <>
          <SettingGroup
            id="rs-imageLoad"
            title="Image loading"
            hint="All at once preloads every page for instant turns (uses more data). While scrolling fetches pages only as you reach them."
          >
            <Segmented<ImageLoadMode>
              labelledBy="rs-imageLoad"
              options={[
                { value: 'parallel', label: 'All at once', icon: <IconBolt /> },
                { value: 'sequential', label: 'While scrolling', icon: <IconScrollDown /> },
              ]}
              value={settings.imageLoad}
              onChange={(imageLoad) => onUpdate({ imageLoad })}
            />
          </SettingGroup>

          {settings.imageLoad === 'sequential' && (
            <SettingGroup
              id="rs-preloadAhead"
              title="Preload ahead"
              hint="While scrolling, how many upcoming pages stay pre-fetched. Higher means fewer waits but more data. Pick a preset or type a custom 1–50 value."
            >
              <Segmented<string>
                labelledBy="rs-preloadAhead"
                options={[
                  { value: '1', label: '1' },
                  { value: '3', label: '3' },
                  { value: '5', label: '5' },
                ]}
                value={String(settings.preloadAhead)}
                onChange={(value) => onUpdate({ preloadAhead: Number(value) as PreloadAhead })}
              />
              <div className="reader-settings__size-row">
                <NumberField
                  label="Custom"
                  value={settings.preloadAhead}
                  min={PRELOAD_AHEAD_MIN}
                  max={PRELOAD_AHEAD_MAX}
                  step={PRELOAD_AHEAD_STEP}
                  unit="pages"
                  onChange={(preloadAhead) =>
                    onUpdate({
                      preloadAhead:
                        preloadAhead ?? DEFAULT_READER_SETTINGS.preloadAhead,
                    })
                  }
                />
              </div>
            </SettingGroup>
          )}

          <SettingGroup
            id="rs-downloadConcurrency"
            title="Download concurrency"
            hint="How many images the server fetches from the source at once. Higher warms All at once chapters faster but spikes memory and can trip source rate limits. Applies server-wide immediately and survives restarts."
          >
            <Segmented<string>
              labelledBy="rs-downloadConcurrency"
              options={[
                { value: '6', label: '6' },
                { value: '10', label: '10' },
                { value: '12', label: '12' },
                { value: '16', label: '16' },
              ]}
              value={String(displayConcurrency)}
              onChange={(value) => saveConcurrency.mutate(Number(value))}
            />
            <div className="reader-settings__size-row">
              <NumberField
                label="Custom"
                value={displayConcurrency}
                min={concurrencyMin}
                max={concurrencyMax}
                step={1}
                unit="fetches"
                onChange={(concurrency) => {
                  if (concurrency !== null) saveConcurrency.mutate(concurrency);
                }}
              />
            </div>
            {concurrencyInfo?.customConcurrency != null && (
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => saveConcurrency.mutate(null)}
              >
                Reset to server default ({concurrencyInfo.defaultConcurrency})
              </button>
            )}
            {concurrencyError && (
              <p className="reader-settings__sub-hint" role="alert">
                {concurrencyError}
              </p>
            )}
          </SettingGroup>

          <SettingGroup
            id="rs-direction"
            title="Page direction"
            hint="Which way pages turn; panel is traditionally read right to left."
            disabled={settings.mode === 'gallery'}
          >
            <Segmented<ReadingDirection>
              labelledBy="rs-direction"
              options={[
                { value: 'rtl', label: 'Right → left', icon: <IconRtl /> },
                { value: 'ltr', label: 'Left → right', icon: <IconLtr /> },
              ]}
              value={settings.direction}
              onChange={(direction) => onUpdate({ direction })}
            />
          </SettingGroup>

          <SettingGroup
            id="rs-imageSizePx"
            title="Pixel size"
            hint="Fix the width and/or height in pixels. Set one to scale proportionally; set both to fit the box. Leave blank to use the preset above."
          >
            <div className="reader-settings__size-row">
              <NumberField
                label="Width"
                value={settings.imageWidthPx}
                min={1}
                max={4096}
                step={50}
                onChange={(imageWidthPx) => onUpdate({ imageWidthPx })}
              />
              <NumberField
                label="Height"
                value={settings.imageHeightPx}
                min={1}
                max={4096}
                step={50}
                onChange={(imageHeightPx) => onUpdate({ imageHeightPx })}
              />
            </div>
            <button
              type="button"
              className="reader-settings__clear"
              onClick={() => onUpdate({ imageWidthPx: null, imageHeightPx: null })}
              disabled={settings.imageWidthPx === null && settings.imageHeightPx === null}
            >
              Clear pixel size
            </button>
          </SettingGroup>

          <SettingGroup
            id="rs-zoom"
            title="Zoom"
            hint="Pinch-to-zoom magnifies the current page around the pinch point. 1.0 = fit to the reader."
          >
            <RangeField
              label="Zoom"
              value={settings.zoomLevel}
              min={0.5}
              max={4}
              step={0.1}
              format={(zoomLevel) => `${zoomLevel.toFixed(1)}×`}
              defaultValue={DEFAULT_READER_SETTINGS.zoomLevel}
              onChange={(zoomLevel) => onUpdate({ zoomLevel })}
              onReset={() => onUpdate({ zoomLevel: DEFAULT_READER_SETTINGS.zoomLevel })}
            />
            <p className="reader-settings__sub-hint">
              Two-finger pinch on the reader stage zooms in/out; drag to pan while zoomed.
            </p>
          </SettingGroup>

          <div className="reader-settings__row">
            <span className="reader-settings__row-copy">
              <span id="rs-scrollSpeed" className="reader-settings__row-title">
                Scroll speed
              </span>
              <span className="reader-settings__row-hint">
                How fast hold-to-smooth-scroll moves — Shift+W / Shift+S, or plain W/S when smooth-scroll keys is on.
              </span>
            </span>
            <Segmented<ScrollSpeed>
              labelledBy="rs-scrollSpeed"
              options={[
                { value: 'slow', label: 'Slow', icon: <IconSlow /> },
                { value: 'normal', label: 'Normal', icon: <IconNormal /> },
                { value: 'fast', label: 'Fast', icon: <IconFast /> },
              ]}
              value={settings.scrollSpeed}
              onChange={(scrollSpeed) => onUpdate({ scrollSpeed })}
            />
          </div>

          <div className="reader-settings__row">
            <span className="reader-settings__row-copy">
              <span id="rs-smoothScrollKeys" className="reader-settings__row-title">
                Smooth-scroll keys
              </span>
              <span className="reader-settings__row-hint">
                Hold W/S or ↑/↓ to smooth-scroll at the speed above, without holding Shift. Vertical mode only.
              </span>
            </span>
            <Switch
              checked={settings.smoothScrollKeys}
              labelledBy="rs-smoothScrollKeys"
              onChange={(smoothScrollKeys) => onUpdate({ smoothScrollKeys })}
            />
          </div>

          <SettingGroup
            id="rs-glide"
            title="Glide scroll"
            hint="How quickly keyboard/page scroll glides between positions. Faster = snappier; smoother = gentler."
          >
            <Segmented<GlidePreset>
              labelledBy="rs-glide"
              options={[
                { value: 'instant', label: 'Instant' },
                { value: 'quick', label: 'Quick' },
                { value: 'normal', label: 'Normal' },
                { value: 'smooth', label: 'Smooth' },
              ]}
              value={settings.glidePreset}
              onChange={(glidePreset) => onUpdate({ glidePreset })}
            />
          </SettingGroup>

          {/* --- Tier 1 QOL additions ------------------------------------------- */}

          <SettingGroup
            id="rs-doublePage"
            title="Double-page spread"
            hint={
              settings.mode === 'paged'
                ? 'Render two pages side by side like a printed book. Only available in page mode.'
                : 'Only available in page (F) reading mode.'
            }
            disabled={settings.mode !== 'paged'}
          >
            <Segmented<boolean>
              labelledBy="rs-doublePage"
              options={[
                { value: false, label: 'Single', icon: <IconPages /> },
                { value: true, label: 'Spread', icon: <IconSpread /> },
              ]}
              value={settings.doublePage}
              onChange={(doublePage) => onUpdate({ doublePage })}
            />
            {settings.doublePage && (
              <Segmented<SpreadOddPolicy>
                labelledBy="rs-spreadOdd"
                options={[
                  { value: 'blank', label: 'Blank page' },
                  { value: 'duplicate', label: 'Stretch' },
                  { value: 'single', label: 'Single' },
                ]}
                value={settings.spreadOddPolicy}
                onChange={(spreadOddPolicy) => onUpdate({ spreadOddPolicy })}
              />
            )}
            {settings.doublePage && (
              <Switch
                checked={settings.autoLandscapeSingle}
                labelledBy="rs-autoLandscape"
                onChange={(autoLandscapeSingle) => onUpdate({ autoLandscapeSingle })}
              />
            )}
            {settings.doublePage && (
              <label id="rs-autoLandscape" className="reader-settings__switch-label">
                Show landscape pages full-width automatically (T3-6)
              </label>
            )}
          </SettingGroup>

          <SettingGroup
            id="rs-autoScroll"
            title="Auto-scroll"
            hint="Hands-free page turning. Advances one page on a timer; pause at the last page instead of looping."
          >
            <NumberField
              label="Delay per page (ms)"
              value={settings.autoScrollDelayMs}
              min={500}
              max={15000}
              step={250}
              onChange={(autoScrollDelayMs) => onUpdate({ autoScrollDelayMs })}
            />
            <button
              type="button"
              className="btn btn--ghost btn--sm reader-settings__clear"
              onClick={() => onUpdate({ autoScrollDelayMs: null })}
              disabled={settings.autoScrollDelayMs === null}
            >
              Disable
            </button>
            <p className="reader-settings__sub-hint">
              Toggle hands-free playback from the toolbar while reading.
            </p>
          </SettingGroup>

          <SettingGroup
            id="rs-wheel"
            title="Wheel scroll"
            hint="Mouse-wheel behaviour in vertical mode. Smaller values give finer control."
            disabled={settings.mode !== 'vertical'}
          >
            <Segmented<number>
              labelledBy="rs-wheel"
              options={[
                { value: 0, label: 'Native' },
                { value: 1, label: '1 page' },
                { value: 2, label: '2 pages' },
                { value: 3, label: '3 pages' },
              ]}
              value={settings.wheelPagesPerNotch}
              onChange={(wheelPagesPerNotch) => onUpdate({ wheelPagesPerNotch })}
            />
            <p className="reader-settings__sub-hint">
              Only available in vertical mode. 0 = let the browser handle the wheel.
            </p>
          </SettingGroup>

          <SettingGroup
            id="rs-keys"
            title="Keyboard scroll"
            hint="W/S and ↑/↓ behaviour in vertical mode. Page values act like mouse-wheel notches."
            disabled={settings.mode !== 'vertical'}
          >
            <Segmented<number>
              labelledBy="rs-keys"
              options={[
                { value: 0, label: 'Native' },
                { value: 1, label: '1 page' },
                { value: 2, label: '2 pages' },
                { value: 3, label: '3 pages' },
              ]}
              value={settings.keyPagesPress}
              onChange={(keyPagesPress) => onUpdate({ keyPagesPress })}
            />
            <p className="reader-settings__sub-hint">
              Only available in vertical mode. 0 = smooth native scrolling.
            </p>
          </SettingGroup>

          <h3 id="reader-settings-shortcuts" className="reader-settings__shortcuts-title">
            Keyboard shortcuts
          </h3>
          {shortcutGroups.map(({ category, shortcuts }) => (
            <ShortcutsGroup key={category} category={category} shortcuts={shortcuts} />
          ))}
            </>
          )}
        </div>

        <footer className="reader-settings__footer">
          <button
            type="button"
            className="btn btn--ghost btn--sm reader-settings__reset"
            onClick={() => onUpdate(DEFAULT_READER_SETTINGS)}
          >
            Reset to defaults
          </button>
        </footer>
      </div>
    </>
  );
}
/* ---------------------------------------------------------------------- */
/* Building blocks                                                         */
/* ---------------------------------------------------------------------- */

/** Accessible radiogroup of segmented options with arrow-key navigation. */
type Option<V extends string | number | boolean> = { value: V; label: string; icon?: ReactNode };

function Segmented<V extends string | number | boolean>({
  options,
  value,
  onChange,
  disabled,
  labelledBy,
}: {
  options: Option<V>[];
  value: V;
  onChange: (value: V) => void;
  disabled?: boolean;
  labelledBy: string;
}) {
  const groupRef = useRef<HTMLDivElement>(null);

  function handleKey(event: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    if (disabled) return;
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    const backwards = event.key === 'ArrowLeft' || event.key === 'ArrowUp';
    const step = backwards ? -1 : 1;
    const next = (index + step + options.length) % options.length;
    onChange(options[next]!.value);
    groupRef.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]').item(next)?.focus();
  }

  return (
    <div
      ref={groupRef}
      className="segmented"
      role="radiogroup"
      aria-labelledby={labelledBy}
      aria-disabled={disabled || undefined}
    >
      {options.map((option, index) => {
        const active = option.value === value;
        return (
          <button
            key={String(option.value)}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            tabIndex={active ? 0 : -1}
            className={`segmented__option${active ? ' segmented__option--active' : ''}`}
            onClick={() => {
              if (!active && !disabled) onChange(option.value);
            }}
            onKeyDown={(event) => handleKey(event, index)}
          >
            {option.icon && (
              <span className="segmented__icon" aria-hidden="true">
                {option.icon}
              </span>
            )}
            <span>{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * Bounded slider with a live readout and a reset affordance.
 *
 * The slider commits to the parent only on pointer release (or on every
 * keyboard nudge), not on every drag step. Firing `onChange` per pointer
 * move would re-render the entire reader and reapply
 * `filter: brightness(...)` to every visible image at ~60Hz, which
 * stutters badly on mobile. The local readout below the slider still
 * moves live during the drag; the parent only sees the final value.
 */
function RangeField({
  value,
  onChange,
  onReset,
  label,
  min,
  max,
  step,
  format,
  defaultValue = DEFAULT_IMAGE_BRIGHTNESS,
}: {
  value: number;
  onChange: (value: number) => void;
  /** Called by the reset button; omit to hide it. */
  onReset?: () => void;
  label: string;
  min: number;
  max: number;
  step: number;
  /** Readout formatting; defaults to a plain percentage. */
  format?: (value: number) => string;
  /** Value the reset button restores (and when it disables). */
  defaultValue?: number;
}) {
  const [localValue, setLocalValue] = useState(value);
  // Whether a pointer drag is currently in flight. Read by the input
  // handler (to decide commit vs. defer) and by the global pointerup
  // listener (to actually commit).
  const draggingRef = useRef(false);
  // Always-current mirrors so the global pointerup handler can read the
  // latest state without re-attaching listeners on every change.
  const localValueRef = useRef(localValue);
  localValueRef.current = localValue;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // External value changes (e.g. clicking the reset button) should still
  // reach the slider — unless the user is mid-drag, in which case their
  // in-flight value wins until they release the pointer.
  useEffect(() => {
    if (!draggingRef.current) setLocalValue(value);
  }, [value]);

  // Window-level pointerup so the commit fires no matter where the user
  // releases — even if the pointer has slid off the slider entirely.
  useEffect(() => {
    const commit = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      onChangeRef.current(localValueRef.current);
    };
    window.addEventListener('pointerup', commit);
    window.addEventListener('pointercancel', commit);
    return () => {
      window.removeEventListener('pointerup', commit);
      window.removeEventListener('pointercancel', commit);
    };
  }, []);

  // Commit an in-flight drag when the tab hides or the field unmounts
  // (e.g. closing mid-drag): the parent only sees pointerup commits.
  useEffect(() => {
    const flush = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      onChangeRef.current(localValueRef.current);
    };
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, []);

  const handleInput = (event: React.ChangeEvent<HTMLInputElement>) => {
    const next = Number(event.target.value);
    setLocalValue(next);
    // Keyboard nudges (or any non-drag input) commit immediately — each
    // one is a discrete user intent, not a continuous drag.
    if (!draggingRef.current) onChangeRef.current(next);
  };

  return (
    <div className="reader-settings__range-row">
      <input
        type="range"
        className="reader-settings__range"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={localValue}
        onChange={handleInput}
        onPointerDown={() => {
          draggingRef.current = true;
        }}
      />
      <span className="reader-settings__range-value">
        {format ? format(localValue) : `${localValue}%`}
      </span>
      {onReset && (
        <button
          type="button"
          className="reader-settings__range-reset"
          onClick={onReset}
          disabled={localValue === defaultValue}
          aria-label={`Reset ${label.toLowerCase()}`}
          title="Reset"
        >
          Reset
        </button>
      )}
    </div>
  );
}

/** Labelled group wrapper — renders the title, helper copy and controls. */ function SettingGroup({
  id,
  title,
  hint,
  disabled,
  children,
}: {
  id: string;
  title: string;
  hint: string;
  disabled?: boolean;
  children: ReactNode;
}) {
  const control =
    isValidElement(children) && disabled !== undefined
      ? cloneElement(children as ReactElement<{ disabled?: boolean }>, { disabled })
      : children;

  return (
    <div className="reader-settings__group" data-disabled={disabled || undefined}>
      <div className="reader-settings__group-head">
        <span id={id} className="reader-settings__group-title">
          {title}
        </span>
      </div>
      <p className="reader-settings__group-hint">{hint}</p>
      {control}
    </div>
  );
}

/** Polished on/off switch used for boolean settings. */
function Switch({
  checked,
  onChange,
  labelledBy,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  labelledBy: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelledBy}
      className={`switch${checked ? ' switch--on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span className="switch__thumb" />
    </button>
  );
}

/** Accessible native dropdown used for the page / chapter jump selectors. */
function Select({
  value,
  onChange,
  options,
  label,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  label: string;
  disabled?: boolean;
}) {
  return (
    <select
      className="reader-settings__select"
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

/**
 * Pixel-size stepper: a number input framed by − / + buttons. An empty value is
 * sent as `null` so the caller can fall back to the automatic layout preset.
 */
function NumberField({
  value,
  onChange,
  label,
  min = 1,
  max,
  step = 10,
  unit = 'px',
}: {
  value: number | null;
  onChange: (value: number | null) => void;
  label: string;
  min?: number;
  max?: number;
  step?: number;
  /** Unit shown beside the input (`px` for sizes, `pages` for preload). */
  unit?: string;
}) {
  const id = useId();
  const clamp = (n: number) =>
    Math.min(max ?? Number.MAX_SAFE_INTEGER, Math.max(min, Math.trunc(n)));

  const stepFrom = (current: number | null, delta: number) => clamp((current ?? min) + delta);

  const stepBtn = (delta: number, labelText: string, glyph: string) => (
    <button
      type="button"
      className="reader-settings__number-btn"
      aria-label={labelText}
      onClick={() => onChange(stepFrom(value, delta))}
    >
      {glyph}
    </button>
  );

  return (
    <label className="reader-settings__field">
      <span className="reader-settings__field-label">{label}</span>
      <span className="reader-settings__number">
        {stepBtn(-step, `Decrease ${label.toLowerCase()}`, '−')}
        <input
          id={id}
          type="number"
          className="reader-settings__number-input"
          aria-labelledby={id}
          value={value ?? ''}
          min={min}
          max={max}
          inputMode="numeric"
          onChange={(event) => {
            const raw = event.target.value;
            if (raw === '') {
              onChange(null);
              return;
            }
            const parsed = Number(raw);
            if (Number.isNaN(parsed)) return;
            onChange(clamp(parsed));
          }}
        />
        <span className="reader-settings__number-unit" aria-hidden="true">
          {unit}
        </span>
        {stepBtn(step, `Increase ${label.toLowerCase()}`, '+')}
      </span>
    </label>
  );
}
/* ---------------------------------------------------------------------- */
/* Icons (inline SVG, stroke = currentColor for adaptive theming)          */
/* ---------------------------------------------------------------------- */

type IconProps = { className?: string };

const svgProps = {
  viewBox: '0 0 24 24',
  width: '15',
  height: '15',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

const IconVertical = (_: IconProps) => (
  <svg {...svgProps}>
    <path d="M12 3v14" />
    <path d="m8 7 4-4 4 4" />
    <path d="M8 21l4-4 4 4" />
  </svg>
);

const IconPages = (_: IconProps) => (
  <svg {...svgProps}>
    <rect x="3" y="4" width="11" height="16" rx="1.5" />
    <path d="M8 4v16" />
    <path d="M14 8h6v12a1 1 0 0 1-1 1h-5" />
  </svg>
);

const IconGallery = (_: IconProps) => (
  <svg {...svgProps}>
    <rect x="3" y="4" width="5" height="5" rx="0.5" />
    <rect x="10" y="4" width="5" height="5" rx="0.5" />
    <rect x="3" y="11" width="5" height="5" rx="0.5" />
    <rect x="10" y="11" width="5" height="5" rx="0.5" />
  </svg>
);

const IconRtl = (_: IconProps) => (
  <svg {...svgProps}>
    <path d="M20 12H6m4-5-5 5 5 5" />
  </svg>
);

const IconLtr = (_: IconProps) => (
  <svg {...svgProps}>
    <path d="M4 12h14m-4-5 5 5-5 5" />
  </svg>
);

const IconDark = (_: IconProps) => (
  <svg {...svgProps}>
    <circle cx="12" cy="12" r="4.5" />
    <path d="M12 2.5V5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3l2 2M16.7 16.7l2 2M18.7 5.3l-2 2M7.3 16.7l-2 2" />
  </svg>
);

const IconLight = (_: IconProps) => (
  <svg {...svgProps}>
    <circle cx="12" cy="12" r="5.5" />
  </svg>
);

const IconContrast = (_: IconProps) => (
  <svg {...svgProps}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 3.5v17" />
    <path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill="currentColor" stroke="none" />
  </svg>
);

const IconBolt = (_: IconProps) => (
  <svg {...svgProps}>
    <path d="M13 2 4.5 13.5H11L9.5 22 19 10h-6.5z" />
  </svg>
);

/** "While scrolling" — downward arrows. */
const IconScrollDown = (_: IconProps) => (
  <svg {...svgProps}>
    <path d="M12 3v12" />
    <path d="m7 11 5 5 5-5" />
    <path d="M5 21h14" />
  </svg>
);

/** "Slow" — short arrow, low speed. */
const IconSlow = (_: IconProps) => (
  <svg {...svgProps}>
    <path d="M6 12h6" />
    <path d="m9 9 3 3-3 3" />
    <circle cx="18" cy="12" r="1.4" />
  </svg>
);

/** "Normal" — medium arrow. */
const IconNormal = (_: IconProps) => (
  <svg {...svgProps}>
    <path d="M4 12h10" />
    <path d="m8 8 4 4-4 4" />
    <circle cx="19" cy="12" r="1.4" />
  </svg>
);

/** "Fast" — long arrow with motion lines. */
const IconFast = (_: IconProps) => (
  <svg {...svgProps}>
    <path d="M2 12h14" />
    <path d="m10 8 6 4-6 4" />
    <path d="m4 7 2 1M6 5l2 1" />
    <circle cx="21" cy="12" r="1.4" />
  </svg>
);

const CloseIcon = (_: IconProps) => (
  <svg {...svgProps}>
    <path d="m6 6 12 12M18 6 6 18" />
  </svg>
);

/** Plus glyph for the "save current settings as a new style" toggle. */
const PlusIcon = (_: IconProps) => (
  <svg {...svgProps}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);

/** Two pages side by side — a book spread. */
const IconSpread = (_: IconProps) => (
  <svg {...svgProps}>
    <rect x="2" y="5" width="7" height="14" rx="1" />
    <rect x="15" y="5" width="7" height="14" rx="1" />
    <line x1="12.5" y1="5" x2="12.5" y2="19" />
  </svg>
);

/** One category of shortcuts rendered as a labelled table. */
function ShortcutsGroup({
  category,
  shortcuts,
}: {
  category: ShortcutCategory;
  shortcuts: Shortcut[];
}) {
  return (
    <div className="shortcuts-group">
      <h3 className="shortcuts-group__title">{category}</h3>
      <table className="shortcuts-table">
        <tbody>
          {shortcuts.map((shortcut) => (
            <tr key={shortcut.id}>
              <td className="shortcuts-table__keys">
                {shortcut.keys.map((k) => (
                  <kbd key={k.code}>
                    {k.modifier && (
                      <>
                        <span className="shortcuts-table__kbd-mod">{k.modifier}</span>
                        <span className="shortcuts-table__kbd-sep">+</span>
                      </>
                    )}
                    {k.label}
                  </kbd>
                ))}
              </td>
              <td className="shortcuts-table__action">{shortcut.label}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
