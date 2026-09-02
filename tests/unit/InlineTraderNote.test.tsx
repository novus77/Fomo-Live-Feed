import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { LocaleContextValue } from '../../src/i18n/LocaleProvider';
import { InlineTraderNote } from '../../src/sidepanel/InlineTraderNote';

vi.mock('../../src/i18n/LocaleProvider', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/i18n/LocaleProvider')>();
  const { translate } = await import('../../src/i18n/catalog');
  const useLocale = (): LocaleContextValue => ({
    locale: 'en',
    setLocale: () => {},
    translate: (key, values) => translate('en', key, values),
  });
  return { ...actual, useLocale };
});

describe('InlineTraderNote', () => {
  it('shows a discoverable add control for an empty note', () => {
    render(<InlineTraderNote label={undefined} onSave={vi.fn()} />);

    expect(screen.getByRole('button', { name: '＋Note' })).toBeInTheDocument();
  });

  it('edits an existing note and saves a trimmed value with Enter', () => {
    const onSave = vi.fn();
    render(<InlineTraderNote label="Whale" onSave={onSave} />);

    fireEvent.click(screen.getByRole('button', { name: 'Edit trader note: Whale' }));
    const input = screen.getByRole('textbox', { name: 'Trader note' });
    expect(input).toHaveValue('Whale');

    fireEvent.change(input, { target: { value: '  Momentum  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onSave).toHaveBeenCalledWith('Momentum');
  });

  it('cancels with Escape without saving', () => {
    const onSave = vi.fn();
    render(<InlineTraderNote label="Whale" onSave={onSave} />);

    fireEvent.click(screen.getByRole('button', { name: 'Edit trader note: Whale' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Changed' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Edit trader note: Whale' })).toBeInTheDocument();
  });

  it('saves on blur and clears with whitespace', () => {
    const onSave = vi.fn();
    render(<InlineTraderNote label="Whale" onSave={onSave} />);

    fireEvent.click(screen.getByRole('button', { name: 'Edit trader note: Whale' }));
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.blur(input);

    expect(onSave).toHaveBeenCalledWith('');
  });

  it('keeps an over-length draft editable and does not save it', () => {
    const onSave = vi.fn();
    render(<InlineTraderNote label="Whale" onSave={onSave} />);

    fireEvent.click(screen.getByRole('button', { name: 'Edit trader note: Whale' }));
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'x'.repeat(41) },
    });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Note must be at most 40 characters',
    );
    expect(screen.getByRole('textbox')).toHaveFocus();
  });
});
