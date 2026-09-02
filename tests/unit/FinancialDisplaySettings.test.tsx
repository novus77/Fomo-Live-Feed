import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_FINANCIAL_DISPLAY } from '../../src/domain/settings';
import type { LocaleContextValue } from '../../src/i18n/LocaleProvider';
import { FinancialDisplaySettings } from '../../src/popup/FinancialDisplaySettings';

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

describe('FinancialDisplaySettings', () => {
  it('renders three independent financial role groups', () => {
    render(
      <FinancialDisplaySettings
        value={DEFAULT_FINANCIAL_DISPLAY}
        theme="dark"
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByRole('group', { name: 'Buy amount' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Sell amount' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Market cap' })).toBeInTheDocument();
  });

  it('emits only the role and property being changed', () => {
    const onChange = vi.fn();
    render(
      <FinancialDisplaySettings
        value={DEFAULT_FINANCIAL_DISPLAY}
        theme="dark"
        onChange={onChange}
      />,
    );

    fireEvent.change(screen.getByRole('slider', { name: 'Buy amount font size' }), {
      target: { value: '16' },
    });
    expect(onChange).toHaveBeenLastCalledWith({
      buyAmount: { fontSizePx: 16 },
    });

    fireEvent.change(screen.getByLabelText('Sell amount custom color'), {
      target: { value: '#ff6577' },
    });
    expect(onChange).toHaveBeenLastCalledWith({
      sellAmount: { color: '#FF6577' },
    });
  });

  it('supports presets, theme color, per-role reset, and reset all', () => {
    const onChange = vi.fn();
    render(
      <FinancialDisplaySettings
        value={{
          ...DEFAULT_FINANCIAL_DISPLAY,
          buyAmount: { fontSizePx: 16, color: '#18D79C' },
        }}
        theme="dark"
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Buy amount small' }));
    expect(onChange).toHaveBeenLastCalledWith({ buyAmount: { fontSizePx: 11 } });

    fireEvent.click(screen.getByRole('button', { name: 'Buy amount theme color' }));
    expect(onChange).toHaveBeenLastCalledWith({ buyAmount: { color: 'theme' } });

    fireEvent.click(screen.getByRole('button', { name: 'Reset buy amount' }));
    expect(onChange).toHaveBeenLastCalledWith({
      buyAmount: DEFAULT_FINANCIAL_DISPLAY.buyAmount,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Reset all financial display' }));
    expect(onChange).toHaveBeenLastCalledWith(DEFAULT_FINANCIAL_DISPLAY);
  });

  it('warns without blocking a low-contrast custom color', () => {
    render(
      <FinancialDisplaySettings
        value={{
          ...DEFAULT_FINANCIAL_DISPLAY,
          marketCap: { fontSizePx: 13, color: '#090D13' },
        }}
        theme="dark"
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByText('This color may be difficult to read.')).toBeInTheDocument();
    expect(screen.getByLabelText('Market cap custom color')).toHaveValue('#090d13');
  });
});
