import { render, screen } from '@testing-library/react';
import { PumpStatusIndicator } from '../../src/sidepanel/PumpStatusIndicator';

const localeState = vi.hoisted(() => ({ locale: 'en' as 'en' | 'zh-CN' }));

vi.mock('../../src/i18n/LocaleProvider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/i18n/LocaleProvider')>();
  const { translate } = await import('../../src/i18n/catalog');
  return {
    ...actual,
    useLocale: () => ({
      locale: localeState.locale,
      setLocale: () => {},
      translate: (key: Parameters<typeof translate>[1]) => translate(localeState.locale, key),
    }),
  };
});

describe('PumpStatusIndicator', () => {
  beforeEach(() => { localeState.locale = 'en'; });

  it.each([
    ['en', 'live', 'Live', 'History gap', 'Recovery reached the 24-hour limit'],
    ['en', 'catching-up', 'Catching up', 'History gap', 'Recovery reached the 24-hour limit'],
    ['en', 'disconnected', 'Disconnected', 'History gap', 'Recovery reached the 24-hour limit'],
    ['zh-CN', 'live', '实时', '历史缺口', '补齐已达到 24 小时时限'],
    ['zh-CN', 'catching-up', '正在补齐', '历史缺口', '补齐已达到 24 小时时限'],
    ['zh-CN', 'disconnected', '未连接', '历史缺口', '补齐已达到 24 小时时限'],
  ] as const)('keeps %s %s status distinct from a bounded historical warning', (locale, status, statusLabel, gapLabel, reason) => {
    localeState.locale = locale;
    const lastGapAt = Date.parse('2026-10-03T01:02:03Z');
    const { container } = render(<PumpStatusIndicator status={status} hasUnresolvedGap gap={{
      schemaVersion: 1, hasUnresolvedGap: true, lastGapAt, reason: 'age-limit',
    }} />);
    const indicator = screen.getByRole('status', { name: `Pump: ${statusLabel} · ${gapLabel}` });
    expect(indicator).toHaveAttribute('title', `Pump: ${statusLabel} · ${gapLabel} · ${reason} · ${new Date(lastGapAt).toLocaleString()}`);
    expect(indicator).toHaveClass(`pump-status-${status}`);
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(container.querySelectorAll('.pump-status-gap-mark')).toHaveLength(1);
    expect(container.textContent).toBe('!');
  });

  it('explains the historical warning separately from current live delivery', () => {
    render(<PumpStatusIndicator status="live" hasUnresolvedGap gap={{ schemaVersion: 1,
      hasUnresolvedGap: true, lastGapAt: 100, reason: 'endpoint-ended' }} />);
    expect(screen.getByRole('status', { name: 'Pump: Live · History gap' }).getAttribute('title'))
      .toContain('The endpoint ended before the previous checkpoint');
  });
  it('shows a compact accessible live status without visible copy', () => {
    const { container } = render(<PumpStatusIndicator status="live" />);

    expect(screen.getByRole('status', { name: 'Pump: Live' })).toHaveAttribute('title', 'Pump: Live');
    expect(container.querySelector('.source-icon-pump')).toBeInTheDocument();
    expect(container.querySelector('.pump-status-dot')).toBeInTheDocument();
  });

  it('keeps live status while exposing a separate unresolved history-gap warning', () => {
    const { container } = render(
      <PumpStatusIndicator status="live" hasUnresolvedGap />,
    );

    expect(screen.getByRole('status', { name: 'Pump: Live · History gap' }))
      .toHaveAttribute('title', 'Pump: Live · History gap');
    expect(container.querySelector('.pump-status-gap-mark')).toHaveTextContent('!');
  });
});
