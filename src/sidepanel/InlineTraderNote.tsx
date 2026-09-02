import { useLayoutEffect, useRef, useState } from 'react';

import { MAX_ANNOTATION_LABEL_LENGTH } from '../domain/annotations';
import { useLocale } from '../i18n/LocaleProvider';

export interface InlineTraderNoteProps {
  label: string | undefined;
  onSave(label: string): void;
}

export function InlineTraderNote({ label, onSave }: InlineTraderNoteProps) {
  const { translate } = useLocale();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(label ?? '');
  const [invalid, setInvalid] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const editingRef = useRef(false);

  useLayoutEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const beginEditing = (): void => {
    setDraft(label ?? '');
    setInvalid(false);
    editingRef.current = true;
    setEditing(true);
  };

  const cancel = (): void => {
    editingRef.current = false;
    setDraft(label ?? '');
    setInvalid(false);
    setEditing(false);
  };

  const commit = (): void => {
    if (!editingRef.current) return;

    const next = draft.trim();
    if (next.length > MAX_ANNOTATION_LABEL_LENGTH) {
      setInvalid(true);
      inputRef.current?.focus();
      return;
    }

    editingRef.current = false;
    setInvalid(false);
    setEditing(false);
    onSave(next);
  };

  if (!editing) {
    const hasLabel = label !== undefined && label.length > 0;
    const accessibleName = hasLabel
      ? translate('card.editNote', { note: label })
      : translate('card.addNote');

    return (
      <button
        type="button"
        className={hasLabel ? 'trader-note-chip' : 'trader-note-add'}
        aria-label={accessibleName}
        title={hasLabel ? label : accessibleName}
        onClick={(event) => {
          event.stopPropagation();
          beginEditing();
        }}
      >
        {hasLabel ? label : translate('card.addNote')}
      </button>
    );
  }

  return (
    <span className="trader-note-editor">
      <input
        ref={inputRef}
        className="trader-note-input"
        aria-label={translate('card.traderNote')}
        aria-invalid={invalid}
        aria-describedby={invalid ? 'trader-note-error' : 'trader-note-help'}
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          if (invalid) setInvalid(false);
        }}
        onBlur={commit}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Enter') {
            event.preventDefault();
            commit();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            cancel();
          }
        }}
      />
      {invalid ? (
        <span id="trader-note-error" className="trader-note-error" role="alert">
          {translate('card.noteTooLong', {
            max: MAX_ANNOTATION_LABEL_LENGTH,
          })}
        </span>
      ) : (
        <span id="trader-note-help" className="trader-note-help">
          {translate('card.noteKeyboardHelp')}
        </span>
      )}
    </span>
  );
}
