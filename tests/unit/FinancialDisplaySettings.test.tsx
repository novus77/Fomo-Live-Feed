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
  it('links each financial role tab to a labelled tab panel with roving tab focus', () => {
    const { container } = render(
      <FinancialDisplaySettings
        value={DEFAULT_FINANCIAL_DISPLAY}
        theme="dark"
        onChange={vi.fn()}
      />,
    );
    const tabs = screen.getAllByRole('tab');

    expect(tabs).toHaveLength(3);
    for (const [index, tab] of tabs.entries()) {
      const panelId = tab.getAttribute('aria-controls');
      const panel = panelId === null ? null : document.getElementById(panelId);

      expect(tab).toHaveAttribute('id');
      expect(tab).toHaveAttribute('tabindex', index === 0 ? '0' : '-1');
      expect(panel).not.toBeNull();
      expect(panel).toHaveAttribute('role', 'tabpanel');
      expect(panel).toHaveAttribute('aria-labelledby', tab.id);
      expect(panel).toHaveProperty('hidden', index !== 0);
    }

    expect(container.querySelectorAll('[role="tabpanel"]')).toHaveLength(3);
  });

  it('moves role selection and focus with horizontal tab keyboard controls', () => {
    render(
      <FinancialDisplaySettings
        value={DEFAULT_FINANCIAL_DISPLAY}
        theme="dark"
        onChange={vi.fn()}
      />,
    );
    const buy = screen.getByRole('tab', { name: 'Buy amount' });
    const sell = screen.getByRole('tab', { name: 'Sell amount' });
    const marketCap = screen.getByRole('tab', { name: 'Market cap' });

    buy.focus();
    fireEvent.keyDown(buy, { key: 'ArrowRight' });
    expect(sell).toHaveFocus();
    expect(sell).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(sell, { key: 'ArrowRight' });
    expect(marketCap).toHaveFocus();

    fireEvent.keyDown(marketCap, { key: 'ArrowRight' });
    expect(buy).toHaveFocus();

    fireEvent.keyDown(buy, { key: 'ArrowLeft' });
    expect(marketCap).toHaveFocus();

    fireEvent.keyDown(marketCap, { key: 'Home' });
    expect(buy).toHaveFocus();

    fireEvent.keyDown(buy, { key: 'End' });
    expect(marketCap).toHaveFocus();
    expect(buy).toHaveAttribute('tabindex', '-1');
    expect(marketCap).toHaveAttribute('tabindex', '0');
  });

  it('uses one compact editor while keeping three independent roles', () => {
    render(
      <FinancialDisplaySettings
        value={DEFAULT_FINANCIAL_DISPLAY}
        theme="dark"
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByRole('tablist', { name: 'Financial display' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Buy amount' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('group', { name: 'Buy amount' })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Sell amount' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Sell amount' }));
    expect(screen.getByRole('group', { name: 'Sell amount' })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Buy amount' })).not.toBeInTheDocument();
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

    fireEvent.click(screen.getByRole('tab', { name: 'Sell amount' }));
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

    fireEvent.click(screen.getByRole('tab', { name: 'Market cap' }));
    expect(screen.getByText('This color may be difficult to read.')).toBeInTheDocument();
    expect(screen.getByLabelText('Market cap custom color')).toHaveValue('#090d13');
  });

  it('uses WCAG contrast against the dark event-card background', () => {
    const { rerender } = render(
      <FinancialDisplaySettings
        value={{
          ...DEFAULT_FINANCIAL_DISPLAY,
          buyAmount: { fontSizePx: 13, color: '#555555' },
        }}
        theme="dark"
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByText('This color may be difficult to read.')).toBeInTheDocument();

    rerender(
      <FinancialDisplaySettings
        value={{
          ...DEFAULT_FINANCIAL_DISPLAY,
          buyAmount: { fontSizePx: 13, color: '#FF0000' },
        }}
        theme="dark"
        onChange={vi.fn()}
      />,
    );

    expect(screen.queryByText('This color may be difficult to read.')).not.toBeInTheDocument();
  });

  it('uses WCAG contrast against the light event-card background', () => {
    render(
      <FinancialDisplaySettings
        value={{
          ...DEFAULT_FINANCIAL_DISPLAY,
          buyAmount: { fontSizePx: 13, color: '#00FF00' },
        }}
        theme="light"
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByText('This color may be difficult to read.')).toBeInTheDocument();
  });
});
