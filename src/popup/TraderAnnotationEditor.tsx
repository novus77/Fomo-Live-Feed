import { useState } from 'react';

import {
  ANNOTATION_COLORS,
  MAX_ANNOTATION_LABEL_LENGTH,
  type AnnotationColor,
  type TraderAnnotationV1,
} from '../domain/annotations';

/**
 * Per-trader annotation editor (plan Task 10 Step 1, spec section 5.3/7.3).
 *
 * All user-authored values render as TEXT (spec section 9): the label is a
 * controlled text input and the color swatches are buttons with fixed labels.
 * The editor trims labels, enforces MAX_ANNOTATION_LABEL_LENGTH, and only
 * offers the exported color allowlist; the storage layer re-validates the
 * same rules before persisting.
 */

export type EditorLabelResult =
  | { ok: true; label: string }
  | { ok: false; reason: string };

/** Trims the input; an empty result clears the stored label. */
export function parseEditorLabel(input: string): EditorLabelResult {
  const trimmed = input.trim();

  if (trimmed.length > MAX_ANNOTATION_LABEL_LENGTH) {
    return {
      ok: false,
      reason:
        'Label must be at most ' +
        MAX_ANNOTATION_LABEL_LENGTH +
        ' characters.',
    };
  }

  return { ok: true, label: trimmed };
}

export interface TraderAnnotationEditorProps {
  annotation: TraderAnnotationV1 | undefined;
  onSaveLabel(label: string): void;
  onSelectColor(color: AnnotationColor): void;
  onTogglePin(pinned: boolean): void;
  onToggleMute(muted: boolean): void;
  onDelete(): void;
}

export function TraderAnnotationEditor(props: TraderAnnotationEditorProps) {
  const { annotation, onSaveLabel, onSelectColor, onTogglePin, onToggleMute, onDelete } =
    props;

  const [draft, setDraft] = useState(annotation?.label ?? '');
  const [error, setError] = useState<string | null>(null);

  const pinned = annotation?.pinned === true;
  const muted = annotation?.muted === true;

  const handleSave = (): void => {
    const result = parseEditorLabel(draft);

    if (!result.ok) {
      setError(result.reason);

      return;
    }

    setError(null);
    onSaveLabel(result.label);
  };

  const handleDraftChange = (value: string): void => {
    setDraft(value);

    if (error !== null) {
      setError(null);
    }
  };

  return (
    <div className="annotation-editor">
      <label className="annotation-field">
        <span className="annotation-field-label">Label</span>
        <input
          type="text"
          value={draft}
          maxLength={MAX_ANNOTATION_LABEL_LENGTH}
          aria-label="Trader label"
          onChange={(event) => {
            handleDraftChange(event.target.value);
          }}
        />
      </label>

      <div className="annotation-row">
        <span className="annotation-field-label">Color</span>
        <div className="annotation-swatches">
          {ANNOTATION_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              className={
                'annotation-swatch' +
                (annotation?.color === color ? ' annotation-swatch-active' : '')
              }
              style={{ backgroundColor: color }}
              aria-label={'Color ' + color}
              aria-pressed={annotation?.color === color}
              onClick={() => {
                onSelectColor(color);
              }}
            />
          ))}
        </div>
      </div>

      <div className="annotation-row">
        <button
          type="button"
          className="annotation-toggle"
          aria-pressed={pinned}
          onClick={() => {
            onTogglePin(!pinned);
          }}
        >
          {pinned ? 'Unpin trader' : 'Pin trader'}
        </button>
        <button
          type="button"
          className="annotation-toggle"
          aria-pressed={muted}
          onClick={() => {
            onToggleMute(!muted);
          }}
        >
          {muted ? 'Unmute trader' : 'Mute trader'}
        </button>
      </div>

      <p className="annotation-note">
        Muting hides future toasts for this trader but keeps their history.
      </p>

      {error !== null && <p className="annotation-error">{error}</p>}

      <div className="annotation-actions">
        <button type="button" className="annotation-save" onClick={handleSave}>
          Save label
        </button>
        <button type="button" className="annotation-delete" onClick={onDelete}>
          Remove label
        </button>
      </div>
    </div>
  );
}
